import { describe, expect, test } from "vitest";
import { authenticatedBackend, createBackend } from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup(type: "basic" | "repository" = "basic") {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "agent-language-owner");
	const projectId = await owner.mutation(api.projects.create, {
		type,
		name: "Languages",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
	const writer = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Language manager",
		scopes: ["read", "languages-write"],
	});
	const reader = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose", "dictionary-write"],
	});
	function request(
		token: string,
		method = "GET",
		body?: unknown,
		path = "/languages",
	) {
		return t.fetch(`/api/agent/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}
	return { t, owner, projectId, writer, reader, request };
}

describe("agent language management", () => {
	test("lists 1,000 Basic target languages plus the Source without scanning retained identities", async () => {
		const s = await setup();
		const project = await s.owner.query(api.projects.get, {
			projectId: s.projectId,
		});
		const collectionId = project.managedCollectionId;
		if (!collectionId) throw Error("Missing managed collection");
		const firstMembershipId = await s.t.run(async (ctx) => {
			let firstMembershipId: Id<"contentCollectionLocales"> | undefined;
			for (let index = 0; index < 1000; index++) {
				const localeId = await ctx.db.insert("locales", {
					projectId: s.projectId,
					code: `zz-${index}`,
					label: `Language ${index}`,
					isSource: false,
					createdAt: Date.now(),
				});
				const membershipId = await ctx.db.insert("contentCollectionLocales", {
					projectId: s.projectId,
					collectionId,
					localeId,
					active: true,
				});
				firstMembershipId ??= membershipId;
			}
			// Retained project identities outside this collection do not affect its active list.
			await ctx.db.insert("locales", {
				projectId: s.projectId,
				code: "old",
				label: "Retained",
				isSource: false,
				createdAt: Date.now(),
			});
			return firstMembershipId;
		});
		const response = await s.request(s.writer.token);
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			languages: Array<{ code: string }>;
		};
		expect(result.languages).toHaveLength(1001);
		expect(result.languages[0]?.code).toBe("en");
		expect(result.languages.some((language) => language.code === "old")).toBe(
			false,
		);
		if (!firstMembershipId) throw Error("Missing membership");
		await s.t.run((ctx) => ctx.db.patch(firstMembershipId, { active: false }));
		const after = await s.request(s.writer.token);
		expect(after.status).toBe(200);
		const retained = (await after.json()) as {
			languages: Array<{ code: string }>;
		};
		expect(retained.languages).toHaveLength(1000);
		expect(
			retained.languages.some((language) => language.code === "zz-0"),
		).toBe(false);
	});

	test("requires deliberate scope, keeps reviewers separate, and respects revocation", async () => {
		const s = await setup();
		const input = { code: "fr", label: "French" };
		expect((await s.request(s.reader.token, "POST", input)).status).toBe(401);
		await expect(
			s.owner.mutation(api.apiTokens.create, {
				projectId: s.projectId,
				name: "Invalid reviewer",
				scopes: ["read", "review", "languages-write"],
			}),
		).rejects.toThrow("reviewer token");
		const reviewer = await s.owner.mutation(api.apiTokens.create, {
			projectId: s.projectId,
			name: "Reviewer",
			scopes: ["read", "review"],
		});
		expect((await s.request(reviewer.token, "POST", input)).status).toBe(401);
		const response = await s.request(s.writer.token, "POST", input);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { localeId: Id<"locales"> };
		const read = await s.request(s.reader.token);
		expect(await read.json()).toMatchObject({
			projectType: "basic",
			canWrite: false,
			introductionTargets: [],
			languages: [
				{ code: "en", isSource: true, canEditCode: false, canEditLabel: false },
				{
					id: result.localeId,
					code: "fr",
					label: "French",
					canEditCode: false,
				},
			],
		});
		const project = await s.request(
			s.writer.token,
			"GET",
			undefined,
			"/projects/current",
		);
		expect(await project.json()).toMatchObject({
			capabilities: {
				languages: {
					canWrite: true,
					writeScope: "languages-write",
					codeEditing: true,
					addition: "direct",
				},
			},
		});
		await s.owner.mutation(api.apiTokens.revoke, { tokenId: s.writer.tokenId });
		expect(
			(await s.request(s.writer.token, "POST", { code: "de" })).status,
		).toBe(401);
	});

	test("adds, edits, and re-enables Basic identities without replacing them", async () => {
		const s = await setup();
		const added = await s.request(s.writer.token, "POST", {
			code: "pt_br",
			label: "Portuguese",
		});
		expect(added.status).toBe(200);
		const created = (await added.json()) as {
			localeId: Id<"locales">;
			membershipRevision: number;
		};
		const path = `/languages/${created.localeId}`;
		const edit = {
			expectedCode: "pt-BR",
			expectedLabel: "Portuguese",
			code: "pt",
			label: "Português",
		};
		expect((await s.request(s.writer.token, "PATCH", edit, path)).status).toBe(
			200,
		);
		const stale = await s.request(s.writer.token, "PATCH", edit, path);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			code: "CONFLICT",
			error: expect.stringContaining("changed"),
		});
		const duplicate = await s.request(s.writer.token, "POST", {
			code: "pt",
			label: "Other name",
		});
		expect(duplicate.status).toBe(409);
		const repeated = await s.request(s.writer.token, "POST", { code: "pt" });
		expect(await repeated.json()).toMatchObject({
			localeId: created.localeId,
			membershipRevision: created.membershipRevision,
		});
		const project = await s.owner.query(api.projects.get, {
			projectId: s.projectId,
		});
		if (!project.managedCollectionId) throw Error("Missing managed collection");
		await s.owner.mutation(api.contentCollections.removeLocale, {
			projectId: s.projectId,
			collectionId: project.managedCollectionId,
			localeId: created.localeId,
		});
		const removedEdit = {
			expectedCode: "pt",
			expectedLabel: "Português",
			code: "pt-PT",
			label: "Hidden edit",
		};
		const removed = await s.request(s.writer.token, "PATCH", removedEdit, path);
		expect(removed.status).toBe(404);
		expect(await removed.json()).toMatchObject({ code: "NOT_FOUND" });
		await expect(
			s.owner.mutation(api.locales.updateMetadata, {
				projectId: s.projectId,
				localeId: created.localeId,
				...removedEdit,
			}),
		).rejects.toThrow("Add the language again");
		expect(await s.t.run((ctx) => ctx.db.get(created.localeId))).toMatchObject({
			code: "pt",
			label: "Português",
		});
		const restored = await s.request(s.writer.token, "POST", {
			code: "pt",
			label: "Portuguese (Portugal)",
		});
		expect(restored.status).toBe(200);
		expect(await restored.json()).toMatchObject({ localeId: created.localeId });
		expect(await s.t.run((ctx) => ctx.db.get(created.localeId))).toMatchObject({
			code: "pt",
			label: "Portuguese (Portugal)",
		});
	});

	test("reports invalid fields and isolates projects and unrelated write scopes", async () => {
		const s = await setup();
		const other = await s.owner.mutation(api.projects.create, {
			type: "basic",
			name: "Other",
			sourceLocaleCode: "en",
		});
		const [foreign] = await s.owner.query(api.locales.list, {
			projectId: other,
		});
		if (!foreign) throw Error("Missing foreign source");
		const crossProject = await s.request(
			s.writer.token,
			"PATCH",
			{
				code: "en",
				label: "Oops",
				expectedCode: "en",
				expectedLabel: foreign.label,
			},
			`/languages/${foreign._id}`,
		);
		expect(crossProject.status).toBe(404);
		expect(await crossProject.json()).toMatchObject({ code: "NOT_FOUND" });
		const invalidCode = await s.request(s.writer.token, "POST", {
			code: "not a code",
		});
		expect(invalidCode.status).toBe(400);
		expect(await invalidCode.json()).toMatchObject({
			code: "VALIDATION",
			error: expect.stringContaining("code"),
		});
		expect(
			(
				await s.request(
					s.writer.token,
					"POST",
					{ expectedRevision: 0, terms: [] },
					"/dictionary/terms",
				)
			).status,
		).toBe(401);
		expect(
			(
				await s.request(s.writer.token, "POST", {
					code: "fr",
					catalogPath: "lib/fr.arb",
				})
			).status,
		).toBe(400);
		const preflight = await s.t.fetch("/api/agent/v1/languages/example", {
			method: "OPTIONS",
		});
		expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
			"PATCH",
		);
	});

	test("configures repository proposals without creating unbound locales and guards later edits", async () => {
		const s = await setup("repository");
		const input = {
			code: "fr",
			label: "French",
			catalogPath: "lib/l10n/app_fr.arb",
			runtimeLocale: "fr-FR",
		};
		expect(
			(await s.request(s.writer.token, "POST", { code: "fr", label: "French" }))
				.status,
		).toBe(400);
		const response = await s.request(s.writer.token, "POST", input);
		expect(response.status).toBe(200);
		const added = (await response.json()) as {
			kind: "introductionTarget";
			targetId: Id<"localeIntroductionTargets">;
			updatedAt: number;
		};
		expect(added.kind).toBe("introductionTarget");
		expect(
			await s.owner.query(api.locales.list, { projectId: s.projectId }),
		).toHaveLength(1);
		expect(
			(await s.request(s.writer.token, "POST", { ...input, label: "Français" }))
				.status,
		).toBe(409);
		const updated = await s.request(s.writer.token, "POST", {
			...input,
			label: "Français",
			expectedUpdatedAt: added.updatedAt,
		});
		expect(updated.status).toBe(200);
		const listing = await s.request(s.writer.token);
		expect(await listing.json()).toMatchObject({
			projectType: "repository",
			languages: [{ code: "en", canEditCode: false, canEditLabel: true }],
			introductionTargets: [
				{
					id: added.targetId,
					localeCode: "fr",
					label: "Français",
					catalogPath: input.catalogPath,
					runtimeLocale: input.runtimeLocale,
				},
			],
		});
		const [source] = await s.owner.query(api.locales.list, {
			projectId: s.projectId,
		});
		if (!source) throw Error("Missing source");
		const edit = {
			expectedCode: "en",
			expectedLabel: "English",
			code: "en",
			label: "Source English",
		};
		expect(
			(
				await s.request(
					s.writer.token,
					"PATCH",
					edit,
					`/languages/${source._id}`,
				)
			).status,
		).toBe(200);
		const invalid = await s.request(
			s.writer.token,
			"PATCH",
			{ ...edit, expectedLabel: edit.label, code: "en-US" },
			`/languages/${source._id}`,
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({
			code: "VALIDATION",
			error: expect.stringContaining("Repository language codes"),
		});
	});
});
