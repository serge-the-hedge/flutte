import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { sha256Hex } from "./lib";
import { finalizeUpload } from "./snapshotUploads";

const prefix = "/api/repository-adapter/v1/";
const sourceFile = {
	catalogPath: "en.arb",
	content: '{"@@locale":"en","greeting":"Hello"}',
};
const targetFile = {
	catalogPath: "de.arb",
	content: '{"@@locale":"de","greeting":"Hallo"}',
};
const files = [sourceFile, targetFile];
const descendant = {
	baselineCommit: "initial",
	relationship: "descendant" as const,
	mergeBase: "initial",
};

async function post(t: Backend, token: string, path: string, body: unknown) {
	// Refill the real transport quota without running scheduled workers.
	vi.setSystemTime(Date.now() + 61_000);
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
	const t = createBackend({ transactionLimits: true });
	const user = await authenticatedBackend(t, "preview-owner", 60 * 60_000);
	const projectId = await createProject(user);
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing Source Locale");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: sourceFile.catalogPath,
	});
	const targetId = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await user.action(api.locales.bind, {
		localeId: targetId,
		catalogPath: targetFile.catalogPath,
	});
	const { token } = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "preview capture",
		scopes: ["snapshot-submission"],
	});
	return { t, user, projectId, sourceId: source._id, token };
}

async function upload(
	t: Backend,
	token: string,
	options: {
		commit: string;
		previewOnly?: boolean;
		lineage?: typeof descendant;
		files?: typeof files;
	},
) {
	const submitted = options.files ?? files;
	const response = await post(t, token, "snapshot-uploads", {
		repository: "repo",
		commit: options.commit,
		previewOnly: options.previewOnly,
		lineage: options.lineage,
		expectedFiles: submitted.length,
	});
	expect(response.status).toBe(200);
	const begin = await response.json();
	expect(begin.previewOnly).toBe(options.previewOnly ?? false);
	const sessionId = begin.sessionId as Id<"snapshotUploadSessions">;
	for (const file of submitted) {
		expect(
			(
				await post(t, token, "snapshot-uploads/file", {
					sessionId,
					...file,
					contentHash: await sha256Hex(file.content),
				})
			).status,
		).toBe(200);
	}
	return sessionId;
}

async function finalize(
	t: Backend,
	token: string,
	sessionId: Id<"snapshotUploadSessions">,
) {
	const response = await post(t, token, "snapshot-uploads/finalize", {
		sessionId,
	});
	expect(response.status).toBe(200);
	return await response.json();
}

/** Compare accepted state, including actual Workspace and review-related rows,
 * rather than deriving publication from the Snapshot's current kind alone. */
async function acceptedState(t: Backend, projectId: Id<"projects">) {
	return await t.run(async (ctx) => {
		const project = await ctx.db.get(projectId);
		return {
			project,
			baseline: project?.baselineSnapshotId
				? await ctx.db.get(project.baselineSnapshotId)
				: null,
			locales: await ctx.db.query("locales").take(100),
			projections: await ctx.db.query("catalogProjections").take(100),
			messages: await ctx.db.query("catalogProjectionMessages").take(100),
			workspace: await ctx.db.query("catalogWorkspaceValueHeads").take(100),
			decisions: await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.take(100),
			proposals: await ctx.db
				.query("catalogWorkspaceSourceProposalHeads")
				.take(100),
			navigation: await ctx.db
				.query("catalogWorkspaceNavigationRows")
				.take(100),
			bindings: await ctx.db.query("localeBindingRealizations").take(100),
		};
	});
}

beforeEach(() =>
	vi.useFakeTimers({
		toFake: [
			"Date",
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
		],
	}),
);
afterEach(() => vi.useRealTimers());

describe("explicit preview-only capture", () => {
	test("captures complete immutable evidence without a Baseline or repository setup, then normal sync can publish it", async () => {
		const { t, user, projectId, token } = await setup();
		const context = await t.fetch(`${prefix}snapshot-context`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Blabla-CLI-Protocol": "1",
				"X-Blabla-CLI-Version": "0.1.0",
			},
		});
		expect(await context.json()).toMatchObject({
			supportsPreviewSnapshots: true,
		});
		const before = await acceptedState(t, projectId);
		const sessionId = await upload(t, token, {
			commit: "initial",
			previewOnly: true,
		});
		const preview = await finalize(t, token, sessionId);
		expect(preview).toMatchObject({
			previewOnly: true,
			run: { status: "succeeded", snapshotKind: "preview", summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(before);
		const evidence = await user.query(api.snapshots.get, {
			snapshotId: preview.run.snapshotId,
		});
		expect(evidence.files).toHaveLength(2);
		const capturedFiles = await t.run((ctx) =>
			ctx.db
				.query("sourceSnapshotFiles")
				.withIndex("by_snapshot", (q) =>
					q.eq("snapshotId", preview.run.snapshotId),
				)
				.take(3),
		);
		for (const captured of capturedFiles) {
			const content = await t.run(async (ctx) =>
				(await ctx.storage.get(captured.storageId))?.text(),
			);
			expect(content).toBe(
				files.find((file) => file.catalogPath === captured.catalogPath)
					?.content,
			);
		}
		expect(await finalize(t, token, sessionId)).toMatchObject({
			previewOnly: true,
			run: { snapshotId: preview.run.snapshotId, summary: null },
		});
		const normalId = await upload(t, token, { commit: "initial" });
		const normal = await finalize(t, token, normalId);
		expect(normal).toMatchObject({
			previewOnly: false,
			run: {
				snapshotId: preview.run.snapshotId,
				snapshotKind: "baseline",
				summary: { outcome: "initial" },
			},
		});
		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(preview.run.snapshotId);
		expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({
			repository: "repo",
		});
		// The old preview receipt remains an operation receipt after promotion.
		expect(await finalize(t, token, sessionId)).toMatchObject({
			previewOnly: true,
			run: { summary: null },
		});
	});

	test("descendant async capture and watchdog retry preserve Workspace, Source proposals, bindings and review evidence", async () => {
		const { t, user, projectId, sourceId, token } = await setup();
		const initialId = await upload(t, token, { commit: "initial" });
		await finalize(t, token, initialId);
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const value = workspace.keys[0]?.values.find(
			(item) => item.localeId === sourceId,
		);
		if (!value?.gitValueFingerprint) throw new Error("Missing Source value");
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			localeId: sourceId,
			messageId: "greeting",
			intent: { kind: "save", value: "Hi" },
			expectedGitValueFingerprint: value.gitValueFingerprint,
			expectedGitValueRevision: value.gitValueRevision,
			expectedWorkspaceRevision: value.workspaceRevision,
		});
		const before = await acceptedState(t, projectId);
		const sessionId = await upload(t, token, {
			commit: "feature",
			previewOnly: true,
			lineage: descendant,
			files: [
				{
					...sourceFile,
					content: '{"@@locale":"en","greeting":"Hi","new":"New"}',
				},
				targetFile,
			],
		});
		expect(
			await (
				await post(t, token, "snapshot-uploads/finalize", {
					sessionId,
					async: true,
				})
			).json(),
		).toMatchObject({ previewOnly: true, finalization: { status: "queued" } });
		const session = await t.run((ctx) => ctx.db.get(sessionId));
		if (!session) throw new Error("Missing session");
		const identity = { sessionId, projectId, tokenId: session.tokenId };
		// Model a stopped processing action whose job no longer exists.
		await t.run((ctx) =>
			ctx.db.patch(sessionId, { processingJobId: undefined }),
		);
		await t.mutation(internal.snapshotUploads.watchFinalization, identity);
		expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
			previewOnly: true,
			processingAttempts: 2,
		});
		await t.action(internal.snapshotUploads.processFinalization, identity);
		const receipt = await (
			await post(t, token, "snapshot-uploads/status", { sessionId })
		).json();
		expect(receipt).toMatchObject({
			previewOnly: true,
			run: { status: "succeeded", snapshotKind: "preview", summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(before);
		expect(
			(
				await user.query(api.snapshots.get, {
					snapshotId: receipt.run.snapshotId,
				})
			).lineage,
		).toEqual(descendant);
		const retryId = await upload(t, token, {
			commit: "feature",
			previewOnly: true,
			lineage: descendant,
			files: [
				{
					...sourceFile,
					content: '{"@@locale":"en","greeting":"Hi","new":"New"}',
				},
				targetFile,
			],
		});
		expect(await finalize(t, token, retryId)).toMatchObject({
			previewOnly: true,
			run: { reused: true, snapshotId: receipt.run.snapshotId, summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(before);
	});

	test("reuses current and past accepted identities without relabeling lineage or repairing a missing projection", async () => {
		const { t, projectId, token } = await setup();
		const firstId = await upload(t, token, { commit: "initial" });
		const initial = await finalize(t, token, firstId);
		const nextId = await upload(t, token, {
			commit: "next",
			lineage: descendant,
		});
		const current = await finalize(t, token, nextId);
		for (const commit of ["initial", "next"]) {
			const before = await acceptedState(t, projectId);
			const captureId = await upload(t, token, {
				commit,
				previewOnly: true,
				lineage: descendant,
			});
			expect(await finalize(t, token, captureId)).toMatchObject({
				previewOnly: true,
				run: {
					reused: true,
					summary: null,
					snapshotId:
						commit === "initial"
							? initial.run.snapshotId
							: current.run.snapshotId,
				},
			});
			expect(await acceptedState(t, projectId)).toEqual(before);
		}
		// An accepted identity needing repair is still read-only in preview mode.
		await t.run((ctx) =>
			ctx.db.patch(projectId, { activeCatalogProjectionId: undefined }),
		);
		const beforeRepair = await acceptedState(t, projectId);
		const repairId = await upload(t, token, {
			commit: "next",
			previewOnly: true,
			lineage: descendant,
		});
		expect(await finalize(t, token, repairId)).toMatchObject({
			previewOnly: true,
			run: { reused: true, summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(beforeRepair);
	});

	test("a racing normal publication of the same identity cannot promote or alter the preview operation", async () => {
		const { t, user, projectId, token } = await setup();
		await finalize(t, token, await upload(t, token, { commit: "initial" }));
		const sessionId = await upload(t, token, {
			commit: "feature",
			previewOnly: true,
			lineage: descendant,
		});
		const session = await t.run((ctx) => ctx.db.get(sessionId));
		if (!session) throw new Error("Missing preview session");
		let racedState: Awaited<ReturnType<typeof acceptedState>> | undefined;
		const receipt = await t.action(async (ctx) => {
			const runMutation: ActionCtx["runMutation"] = async (mutation, args) => {
				if (
					!racedState &&
					getFunctionName(mutation) === "snapshots:finalizeIngestion"
				) {
					await user.action(api.snapshots.ingest, {
						projectId,
						repository: "repo",
						commit: "feature",
						lineage: descendant,
						files,
					});
					racedState = await acceptedState(t, projectId);
				}
				return ctx.runMutation(mutation, args);
			};
			return await finalizeUpload(
				{ ...ctx, runMutation },
				{ sessionId, projectId, tokenId: session.tokenId },
			);
		});
		expect(racedState).toBeDefined();
		expect(receipt).toMatchObject({
			previewOnly: true,
			run: { reused: true, snapshotKind: "baseline", summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(racedState);
		const retryId = await upload(t, token, {
			commit: "feature",
			previewOnly: true,
			lineage: descendant,
		});
		expect(await finalize(t, token, retryId)).toMatchObject({
			previewOnly: true,
			run: { snapshotId: receipt.run.snapshotId, summary: null },
		});
		expect(await acceptedState(t, projectId)).toEqual(racedState);
	});

	test("transactional finalization rejects a projection attached to preview intent", async () => {
		const { t, projectId, token } = await setup();
		const normal = await finalize(
			t,
			token,
			await upload(t, token, { commit: "initial" }),
		);
		const sessionId = await upload(t, token, {
			commit: "initial",
			previewOnly: true,
		});
		const session = await t.run((ctx) => ctx.db.get(sessionId));
		const project = await t.run((ctx) => ctx.db.get(projectId));
		if (!session || !project?.activeCatalogProjectionId)
			throw new Error("Missing operation state");
		const before = await acceptedState(t, projectId);
		await expect(
			t.mutation(internal.snapshots.finalizeIngestion, {
				projectId,
				repository: "repo",
				commit: "initial",
				manifestHash: await sha256Hex(
					JSON.stringify(
						[...files]
							.sort((a, b) => a.catalogPath.localeCompare(b.catalogPath))
							.map((file) => [file.catalogPath, file.content]),
					),
				),
				previewOnly: true,
				projectionId: project.activeCatalogProjectionId,
				actor: { kind: "repositoryAdapter", id: session.tokenId },
				diagnostics: [],
				absentTargetLocales: [],
				unboundLocaleFiles: [],
				files: [],
			}),
		).rejects.toThrow(
			"A preview-only capture cannot publish a catalog projection.",
		);
		expect(normal.run.snapshotId).toBe(before.project?.baselineSnapshotId);
		expect(await acceptedState(t, projectId)).toEqual(before);
	});

	test.each([null, "true", 1, {}])(
		"rejects malformed mode %j before creating a session",
		async (previewOnly) => {
			const { t, token } = await setup();
			const response = await post(t, token, "snapshot-uploads", {
				repository: "repo",
				commit: "preview",
				expectedFiles: 2,
				previewOnly,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: "previewOnly must be a boolean.",
			});
			expect(
				await t.run((ctx) => ctx.db.query("snapshotUploadSessions").take(1)),
			).toEqual([]);
		},
	);

	test("rejects release capture combined with preview without creating an upload", async () => {
		const { t, user, projectId, token } = await setup();
		await finalize(t, token, await upload(t, token, { commit: "initial" }));
		const record = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		const countBefore = await t.run((ctx) =>
			ctx.db.query("snapshotUploadSessions").take(100),
		);
		const response = await post(t, token, "snapshot-uploads", {
			repository: "repo",
			commit: "preview",
			expectedFiles: 2,
			previewOnly: true,
			kind: "release",
			releaseRecordId: record.recordId,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "A Release delivery upload cannot be preview-only.",
		});
		expect(
			await t.run((ctx) => ctx.db.query("snapshotUploadSessions").take(100)),
		).toEqual(countBefore);
	});
});
