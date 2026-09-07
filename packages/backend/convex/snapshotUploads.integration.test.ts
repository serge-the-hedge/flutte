import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib";

const prefix = "/api/repository-adapter/v1/";
async function post(t: Backend, token: string, path: string, body: unknown) {
	return await t.fetch(prefix + path, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"X-Blabla-CLI-Protocol": "1",
			"X-Blabla-CLI-Version": "0.1.0",
		},
		body: JSON.stringify(body),
	});
}
async function setup() {
	const t = createBackend();
	const user = await authenticatedBackend(t, "upload-editor");
	const projectId = await createProject(user);
	const source = (await user.query(api.locales.list, { projectId })).find(
		(locale) => locale.code === "en",
	);
	if (!source) throw new Error("Missing source");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "intl_en.arb",
	});
	const token = (
		await user.mutation(api.apiTokens.create, {
			projectId,
			name: "sync",
			scopes: ["snapshot-submission"],
		})
	).token;
	return { t, user, projectId, token };
}
const file = {
	catalogPath: "intl_en.arb",
	content: '{"@@locale":"en","greeting":"Hello"}',
};
async function begin(t: Backend, token: string) {
	const response = await post(t, token, "snapshot-uploads", {
		repository: "repo",
		commit: "commit",
		expectedFiles: 1,
	});
	expect(response.status).toBe(200);
	return (await response.json()).sessionId as Id<"snapshotUploadSessions">;
}

describe("file manifest uploads", () => {
	test("publishes original blobs, preserves inline manifest identity, and retries finalization", async () => {
		const { t, user, token, projectId } = await setup();
		const sessionId = await begin(t, token);
		const body = {
			sessionId,
			...file,
			contentHash: await sha256Hex(file.content),
		};
		expect((await post(t, token, "snapshot-uploads/file", body)).status).toBe(
			200,
		);
		expect((await post(t, token, "snapshot-uploads/file", body)).status).toBe(
			200,
		);
		const uploaded = await t.run(
			async (ctx) =>
				await ctx.db
					.query("snapshotUploadFiles")
					.withIndex("by_session_and_catalogPath", (q) =>
						q.eq("sessionId", sessionId),
					)
					.unique(),
		);
		if (!uploaded) throw new Error("Expected uploaded catalog");
		const response = await post(t, token, "snapshot-uploads/finalize", {
			sessionId,
		});
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(receipt.run.status).toBe("succeeded");
		const baseline = await user.query(api.snapshots.getBaseline, { projectId });
		expect(baseline?.manifestHash).toBe(
			await sha256Hex(JSON.stringify([[file.catalogPath, file.content]])),
		);
		await t.mutation(internal.snapshotUploads.cleanup, { sessionId });
		const evidence = await t.run(
			async (ctx) =>
				await ctx.db
					.query("sourceSnapshotFiles")
					.withIndex("by_storageId", (q) =>
						q.eq("storageId", uploaded.storageId),
					)
					.first(),
		);
		expect(evidence?.storageId).toBe(uploaded?.storageId);
		expect(
			await t.run(async (ctx) => await ctx.storage.getUrl(uploaded.storageId)),
		).not.toBeNull();
		const retry = await post(t, token, "snapshot-uploads/finalize", {
			sessionId,
		});
		expect(retry.status).toBe(200);
		expect((await retry.json()).run.id).toBe(receipt.run.id);
	});
	test("rejects missing files, wrong hashes, and a different token; expires unowned blobs", async () => {
		const { t, user, token, projectId } = await setup();
		const sessionId = await begin(t, token);
		expect(
			(await post(t, token, "snapshot-uploads/finalize", { sessionId })).status,
		).toBe(400);
		expect(
			(
				await post(t, token, "snapshot-uploads/file", {
					sessionId,
					...file,
					contentHash: "wrong",
				})
			).status,
		).toBe(400);
		const other = (
			await user.mutation(api.apiTokens.create, {
				projectId,
				name: "other",
				scopes: ["snapshot-submission"],
			})
		).token;
		expect(
			(
				await post(t, other, "snapshot-uploads/file", {
					sessionId,
					...file,
					contentHash: await sha256Hex(file.content),
				})
			).status,
		).toBe(400);
		expect(
			(
				await post(t, token, "snapshot-uploads/file", {
					sessionId,
					...file,
					contentHash: await sha256Hex(file.content),
				})
			).status,
		).toBe(200);
		const uploaded = await t.run(async (ctx) => {
			await ctx.db.patch(sessionId, { expiresAt: 0 });
			return await ctx.db
				.query("snapshotUploadFiles")
				.withIndex("by_session_and_catalogPath", (q) =>
					q.eq("sessionId", sessionId),
				)
				.unique();
		});
		if (!uploaded) throw new Error("Expected uploaded catalog");
		await t.mutation(internal.snapshotUploads.cleanup, { sessionId });
		expect(
			await t.run(async (ctx) => await ctx.db.system.get(uploaded.storageId)),
		).toBeNull();
		expect(
			await user.query(api.snapshots.getBaseline, { projectId }),
		).toBeNull();
	});
});

test("does not reclaim a finalization within the platform action runtime", async () => {
	const { t, token, projectId } = await setup();
	const sessionId = await begin(t, token);
	expect(
		(
			await post(t, token, "snapshot-uploads/file", {
				sessionId,
				...file,
				contentHash: await sha256Hex(file.content),
			})
		).status,
	).toBe(200);
	const session = await t.run(async (ctx) => await ctx.db.get(sessionId));
	if (!session) throw new Error("Expected upload");
	const args = { sessionId, projectId, tokenId: session.tokenId };
	await t.mutation(internal.snapshotUploads.claim, args);
	await t.run(
		async (ctx) =>
			await ctx.db.patch(sessionId, {
				processingAt: Date.now() - 20 * 60 * 1000,
			}),
	);
	await expect(
		t.mutation(internal.snapshotUploads.claim, args),
	).rejects.toThrow("already being finalized");
});
