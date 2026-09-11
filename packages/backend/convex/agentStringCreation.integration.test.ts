import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { TokenScope } from "./lib";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "authoring-owner");
	const projectId = await owner.mutation(api.projects.create, {
		name: "Marketing",
		type: "basic",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
	const project = await owner.query(api.projects.get, { projectId });
	if (!project.managedCollectionId) throw Error("Missing workspace");
	const createToken = (scopes: TokenScope[]) =>
		owner.mutation(api.apiTokens.create, { projectId, name: "Agent", scopes });
	const post = (token: string | undefined, body: unknown) =>
		t.fetch("/api/agent/v1/workspace/strings", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
	return {
		t,
		owner,
		projectId,
		collectionId: project.managedCollectionId,
		createToken,
		post,
	};
}

describe("agent Basic string creation", () => {
	test("creates source text with agent attribution, names and limits; retries cannot overwrite", async () => {
		const s = await setup();
		const writer = await s.createToken(["read", "strings-write"]);
		const response = await s.post(writer.token, {
			key: "store.subtitle",
			sourceValue: "Build more",
			name: "Store subtitle",
			context: "App Store",
			characterLimit: 30,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			key: "store.subtitle",
			sourceRevision: 1,
		});
		const page = await s.owner.query(api.managedContent.page, {
			projectId: s.projectId,
			collectionId: s.collectionId,
		});
		expect(page.items).toMatchObject([
			{
				key: "store.subtitle",
				name: "Store subtitle",
				sourceValue: "Build more",
				characterLimit: 30,
			},
		]);
		const history = await s.t.run((ctx) =>
			ctx.db
				.query("managedSourceRevisions")
				.withIndex("by_message", (q) =>
					q
						.eq("collectionId", s.collectionId)
						.eq("messageId", "store.subtitle"),
				)
				.collect(),
		);
		expect(history).toMatchObject([
			{
				actor: { kind: "agent", id: writer.tokenId },
				sourceRevision: 1,
				name: "Store subtitle",
			},
		]);
		expect(
			await s.t.run((ctx) => ctx.db.query("managedTargets").collect()),
		).toEqual([]);
		const duplicate = await s.post(writer.token, {
			key: "store.subtitle",
			sourceValue: "Replace",
		});
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toMatchObject({ code: "CONFLICT" });
		const unnamed = await s.post(writer.token, {
			sourceValue: "Another string",
		});
		expect(unnamed.status).toBe(200);
		const created: { key: string } = await unnamed.json();
		expect(created.key).toBeTruthy();
		const unnamedPage = await s.owner.query(api.managedContent.page, {
			projectId: s.projectId,
			collectionId: s.collectionId,
			focusKey: created.key,
		});
		expect(unnamedPage.items[0]?.name).toBeNull();
		const discovery = await s.t.fetch("/api/agent/v1/projects/current", {
			headers: { Authorization: `Bearer ${writer.token}` },
		});
		expect(await discovery.json()).toMatchObject({
			capabilities: {
				strings: { writeScope: "strings-write", canCreate: true },
			},
		});
	});

	test("reads an exact Basic source without target languages and isolates projects", async () => {
		const s = await setup();
		const writer = await s.createToken(["read", "strings-write"]);
		await s.post(writer.token, {
			key: "store.subtitle",
			sourceValue: "Build",
			name: "Subtitle",
			context: "Store",
			characterLimit: 30,
		});
		const get = (token: string, query: string) =>
			s.t.fetch(`/api/agent/v1/workspace/strings${query}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
		const source = await get(writer.token, "?key=store.subtitle");
		expect(source.status).toBe(200);
		expect(await source.json()).toMatchObject({
			string: {
				key: "store.subtitle",
				messageId: "store.subtitle",
				name: "Subtitle",
				sourceValue: "Build",
				context: "Store",
				characterLimit: 30,
				sourceRevision: 1,
			},
		});
		const reader = await s.createToken(["read"]);
		expect((await get(reader.token, "?key=store.subtitle")).status).toBe(200);
		expect(await (await get(reader.token, "?key=missing")).json()).toEqual({
			string: null,
		});
		const otherProjectId = await s.owner.mutation(api.projects.create, {
			name: "Other",
			type: "basic",
			sourceLocaleCode: "en",
		});
		const other = await s.owner.mutation(api.apiTokens.create, {
			projectId: otherProjectId,
			name: "Other reader",
			scopes: ["read"],
		});
		expect(
			await (await get(other.token, "?key=store.subtitle")).json(),
		).toEqual({ string: null });
		for (const query of [
			"",
			"?key=",
			`?key=${"a".repeat(257)}`,
			"?key=one&key=two",
			`?key=store.subtitle&projectId=${s.projectId}`,
		])
			expect((await get(reader.token, query)).status).toBe(400);
	});

	test("discovery reflects the human project review setting", async () => {
		const s = await setup();
		const token = await s.createToken(["read"]);
		const discover = async () =>
			(
				await s.t.fetch("/api/agent/v1/projects/current", {
					headers: { Authorization: `Bearer ${token.token}` },
				})
			).json();
		expect(await discover()).toMatchObject({ agentReview: { enabled: false } });
		await s.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: s.projectId,
			enabled: true,
		});
		expect(await discover()).toMatchObject({ agentReview: { enabled: true } });
	});

	test("requires an explicit live authoring token and cannot be combined with reviewer authority", async () => {
		const s = await setup();
		const body = { sourceValue: "Build" };
		expect((await s.post(undefined, body)).status).toBe(401);
		expect((await s.post("invalid", body)).status).toBe(401);
		for (const scopes of [
			["read", "propose"],
			["read", "review"],
		] satisfies TokenScope[][]) {
			const token = await s.createToken(scopes);
			expect((await s.post(token.token, body)).status).toBe(401);
		}
		await expect(
			s.createToken(["read", "review", "strings-write"]),
		).rejects.toThrow("reviewer token");
		const writer = await s.createToken(["strings-write"]);
		await s.owner.mutation(api.apiTokens.revoke, { tokenId: writer.tokenId });
		expect((await s.post(writer.token, body)).status).toBe(401);
		expect(
			await s.t.run((ctx) => ctx.db.query("managedMessages").collect()),
		).toEqual([]);
	});

	test("rejects inline translations, invalid input and repository source authoring without partial writes", async () => {
		const s = await setup();
		const writer = await s.createToken(["strings-write"]);
		for (const body of [
			{ sourceValue: "Build", translations: [] },
			{ sourceValue: "Build", projectId: s.projectId },
			{ sourceValue: "Build", name: 42 },
			{ sourceValue: "Build", characterLimit: "30" },
			{ sourceValue: "" },
			{ sourceValue: "Build", characterLimit: 3 },
		]) {
			expect((await s.post(writer.token, body)).status).toBe(400);
		}
		expect(
			(await s.post(writer.token, { sourceValue: "a".repeat(256 * 1024 + 1) }))
				.status,
		).toBe(413);
		expect(
			(await s.post(writer.token, { sourceValue: "a".repeat(1024 * 1024) }))
				.status,
		).toBe(413);
		expect(
			await s.t.run((ctx) => ctx.db.query("managedMessages").collect()),
		).toEqual([]);
		const repository = await createProject(s.owner);
		const repoToken = await s.owner.mutation(api.apiTokens.create, {
			projectId: repository,
			name: "Repo",
			scopes: ["read", "strings-write"],
		});
		const response = await s.post(repoToken.token, { sourceValue: "Build" });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "UNSUPPORTED",
			error: expect.stringContaining("sync a snapshot"),
		});
		const discovery = await s.t.fetch("/api/agent/v1/projects/current", {
			headers: { Authorization: `Bearer ${repoToken.token}` },
		});
		expect(await discovery.json()).toMatchObject({
			capabilities: { strings: { canCreate: false } },
		});
	});
});
