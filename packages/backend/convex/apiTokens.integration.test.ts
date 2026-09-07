import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

// Captured from the retired SHA-256 implementation. Do not compute this fixture
// with hashToken: existing stored digests must survive a hashing refactor.
const legacyToken = "loc_0123456789abcdef0123456789abcdef0123456789abcdef";
const legacyDigest =
	"sha256:11c8f1d703c17ddf2ee4e22fbf2c4aa3d6b145b1b7dbaeb475ce8f731db1f03d";

function currentProject(t: Backend, token: string) {
	return t.fetch("/api/agent/v1/projects/current", {
		headers: { Authorization: `Bearer ${token}` },
	});
}

describe("API token compatibility and access", () => {
	test("a stored legacy digest authenticates the current endpoint until revoked", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const tokenId = await t.run((ctx) =>
			ctx.db.insert("apiTokens", {
				projectId,
				name: "Existing workspace connection",
				tokenHash: legacyDigest,
				scopes: ["read"],
				createdByUserId: "owner",
				createdAt: 1,
			}),
		);

		const response = await currentProject(t, legacyToken);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			projectId,
			sourceLocale: "en",
		});
		expect((await currentProject(t, `${legacyToken}0`)).status).toBe(401);
		const [listed] = await owner.query(api.apiTokens.list, { projectId });
		expect(listed?._id).toBe(tokenId);
		expect(listed).not.toHaveProperty("tokenHash");
		expect(listed?.lastUsedAt).toEqual(expect.any(Number));

		await owner.mutation(api.apiTokens.revoke, { tokenId });
		expect((await currentProject(t, legacyToken)).status).toBe(401);
	});

	test("new tokens authenticate, but cannot read an archived project", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const { token } = await owner.mutation(api.apiTokens.create, {
			projectId,
			name: "Current workspace connection",
			scopes: ["read"],
		});
		const response = await currentProject(t, token);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ projectId });

		await owner.mutation(api.projects.archive, { projectId });
		const archived = await currentProject(t, token);
		expect(archived.status).toBe(400);
		expect(await archived.json()).toEqual({
			code: "NOT_FOUND",
			error: "Project not found.",
		});
	});

	test("historical Change Sets remain bounded, project-scoped evidence with a migration path", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const otherProjectId = await createProject(owner, {
			slug: "other-project",
		});
		const { token } = await owner.mutation(api.apiTokens.create, {
			projectId,
			name: "Historical reader",
			scopes: ["read"],
		});
		const { token: otherToken } = await owner.mutation(api.apiTokens.create, {
			projectId: otherProjectId,
			name: "Other project's reader",
			scopes: ["read"],
		});
		const changeSetId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("changeSets", {
				projectId,
				title: "Preserved translations",
				author: { kind: "agent", id: "historical-agent" },
				authorKind: "agent",
				authorId: "historical-agent",
				status: "applied",
				baseSnapshotVersion: 1,
				createdAt: 1,
				updatedAt: 2,
				summary: {
					filesChanged: 1,
					fieldsChanged: 50,
					additions: 50,
					deletions: 0,
				},
			});
			for (let index = 0; index < 50; index++) {
				await ctx.db.insert("changeSetItems", {
					projectId,
					changeSetId: id,
					kind: "translation_value",
					fieldPath: `message_${index}`,
					previousValue: null,
					nextValue: `Historical text ${index}`,
					status: "accepted",
					createdAt: 1,
				});
			}
			return id;
		});
		const read = (credential: string) =>
			t.fetch(`/api/agent/v1/change-sets/${changeSetId}`, {
				headers: { Authorization: `Bearer ${credential}` },
			});
		const response = await read(token);
		expect(response.status).toBe(200);
		const evidence = await response.json();
		expect(evidence).toMatchObject({
			_id: changeSetId,
			status: "applied",
			retired: true,
			migration: expect.stringContaining("Create a Translation Task"),
		});
		expect(evidence.items).toHaveLength(50);
		expect(evidence.items[0]).toMatchObject({
			previousValue: null,
			nextValue: "Historical text 0",
		});
		expect(evidence).not.toHaveProperty("reviewUrl");
		const denied = await read(otherToken);
		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({ code: "NOT_FOUND" });

		await t.run((ctx) =>
			ctx.db.insert("changeSetItems", {
				projectId,
				changeSetId,
				kind: "translation_value",
				fieldPath: "too_many",
				previousValue: null,
				nextValue: "Extra historical value",
				status: "accepted",
				createdAt: 1,
			}),
		);
		const oversized = await read(token);
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ code: "LIMIT_EXCEEDED" });
	});
});
