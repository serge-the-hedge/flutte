import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import { appendTranslationHistory } from "./translationHistoryWrite";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const user = await authenticatedBackend(t, "history-owner");
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const sourceId = locales.find((locale) => locale.isSource)?._id;
	if (!sourceId) throw new Error("Missing source");
	const localeId = await user.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	await user.action(api.locales.bind, {
		localeId: sourceId,
		catalogPath: "en.arb",
	});
	await user.action(api.locales.bind, { localeId, catalogPath: "fr.arb" });
	let previousCommit: string | undefined;
	async function ingest(commit: string, value = "Bonjour") {
		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(previousCommit
				? {
						lineage: {
							baselineCommit: previousCommit,
							relationship: "descendant" as const,
							mergeBase: previousCommit,
						},
					}
				: {}),
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","greeting":"Hello"}',
				},
				{
					catalogPath: "fr.arb",
					content: JSON.stringify({ "@@locale": "fr", greeting: value }),
				},
			],
		});
		previousCommit = commit;
		return result;
	}
	await ingest("baseline");
	const scope = { projectId, messageId: "greeting", localeId };
	async function commit(
		intent:
			| { kind: "save"; value: string }
			| { kind: "confirm" }
			| { kind: "intentionalBlank"; reason: string },
	) {
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const target = workspace.keys[0]?.values.find(
			(value) => value.localeId === localeId,
		);
		if (!target?.gitValueFingerprint) throw new Error("Missing target");
		return await user.mutation(api.catalogWorkspace.commit, {
			...scope,
			intent,
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
	}
	const history = (cursor?: string) =>
		user.query(api.translationHistory.list, { ...scope, cursor });
	return { t, user, scope, sourceId, ingest, commit, history };
}

describe("translation history", () => {
	test("retains saves, confirmations and intentional blanks independently of Git observations", async () => {
		const s = await setup();
		await s.commit({ kind: "confirm" });
		await s.commit({ kind: "save", value: "Salut" });
		await s.commit({
			kind: "intentionalBlank",
			reason: "No greeting in this layout",
		});
		const result = await s.history();
		expect(result.events.map((event) => [event.kind, event.value])).toEqual([
			["saved", ""],
			["saved", "Salut"],
			["confirmed", "Bonjour"],
			["git", "Bonjour"],
		]);
		expect(result.events[0]).toMatchObject({
			intentionalBlankReason: "No greeting in this layout",
			actorLabel: "Test user history-owner",
		});
		expect(result.nextCursor).toBeNull();
		await s.ingest("updated", "Coucou");
		const updated = await s.history();
		expect(updated.events[0]).toMatchObject({
			kind: "git",
			value: "Coucou",
			snapshot: { commit: "updated" },
		});
		expect(updated.events.some((event) => event.value === "Salut")).toBe(true);
		await s.ingest("quiet", "Coucou");
		expect(
			(await s.history()).events
				.filter((event) => event.kind === "git")
				.map((event) => event.snapshot?.commit),
		).toEqual(["updated", "baseline"]);
	});

	test("preserves the surviving legacy value before overwrite and discloses unavailable older manual edits", async () => {
		const s = await setup();
		await s.commit({ kind: "save", value: "Ancien" });
		await s.t.run(async (ctx) => {
			for (const row of await ctx.db
				.query("catalogWorkspaceValueHistory")
				.collect())
				await ctx.db.delete(row._id);
		});
		expect((await s.history()).events[0]).toMatchObject({
			kind: "retained",
			value: "Ancien",
		});
		await s.commit({ kind: "save", value: "Nouveau" });
		const result = await s.history();
		expect(result.events.map((event) => [event.kind, event.value])).toEqual([
			["saved", "Nouveau"],
			["retained", "Ancien"],
			["git", "Bonjour"],
		]);
		expect(result.olderManualHistoryUnavailable).toBe(true);
	});

	test("paginates equal-time events without gaps and rejects cursors or locales from another scope", async () => {
		const s = await setup();
		await s.t.run(async (ctx) => {
			for (let i = 0; i < 19; i++)
				await appendTranslationHistory(ctx, {
					...s.scope,
					kind: "saved",
					value: `Value ${i}`,
					sourceFingerprint: "source",
					actor: { kind: "user", id: "history-owner" },
					recordedAt: Date.now() + 1000,
				});
		});
		const events: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await s.history(cursor);
			expect(page.events.length).toBeLessThanOrEqual(8);
			events.push(...page.events.map((event) => event.value));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(events).toEqual([
			...Array.from({ length: 19 }, (_, i) => `Value ${18 - i}`),
			"Bonjour",
		]);
		const first = await s.history();
		if (!first.nextCursor) throw new Error("Expected cursor");
		await expect(
			s.user.query(api.translationHistory.list, {
				...s.scope,
				messageId: "other",
				cursor: first.nextCursor,
			}),
		).rejects.toThrow("Invalid translation history cursor");
		await expect(s.history("{")).rejects.toThrow(
			"Invalid translation history cursor",
		);
		await expect(
			s.user.query(api.translationHistory.list, {
				...s.scope,
				localeId: s.sourceId,
			}),
		).rejects.toThrow("Target language not found");
		const outsider = await authenticatedBackend(s.t, "history-outsider");
		await expect(
			outsider.query(api.translationHistory.list, s.scope),
		).rejects.toThrow("Insufficient project permissions");
		await s.t.run(async (ctx) => {
			await ctx.db.insert("projectMembers", {
				projectId: s.scope.projectId,
				userId: "history-outsider",
				role: "viewer",
				createdAt: Date.now(),
			});
		});
		expect(
			(await outsider.query(api.translationHistory.list, s.scope)).events,
		).toHaveLength(8);
	});

	test("continues through quiet snapshots with bounded pages and preserves a legacy head retired by Git", async () => {
		const s = await setup();
		await s.commit({ kind: "save", value: "Local legacy text" });
		await s.t.run(async (ctx) => {
			for (const row of await ctx.db
				.query("catalogWorkspaceValueHistory")
				.collect())
				await ctx.db.delete(row._id);
		});
		await s.ingest("replacement", "Replaced in Git");
		for (let i = 0; i < 14; i++)
			await s.ingest(`quiet-${i}`, "Replaced in Git");
		const first = await s.history();
		expect(first.events).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		const next = await s.history(first.nextCursor ?? undefined);
		expect(next.events.map((event) => [event.kind, event.value])).toEqual([
			["git", "Replaced in Git"],
			["retained", "Local legacy text"],
			["git", "Bonjour"],
		]);
		expect(next.nextCursor).toBeNull();
	});

	test("reads Basic revisions through the same interface", async () => {
		const t = createBackend({ transactionLimits: true });
		const user = await authenticatedBackend(t, "basic-history-owner");
		const projectId = await user.mutation(api.projects.create, {
			name: "Marketing",
			slug: "marketing-history",
			sourceLocaleCode: "en",
			type: "basic",
		});
		const project = await t.run((ctx) => ctx.db.get(projectId));
		if (!project?.managedCollectionId) throw new Error("Missing collection");
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
		});
		await user.mutation(api.contentCollections.addLocale, {
			projectId,
			collectionId: project.managedCollectionId,
			code: "fr",
		});
		const messageId = await user.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId: project.managedCollectionId,
			sourceValue: "Hello",
			translations: [{ localeId, value: "Bonjour" }],
		});
		const history = await user.query(api.translationHistory.list, {
			projectId,
			messageId,
			localeId,
		});
		expect(history).toMatchObject({
			events: [{ value: "Bonjour", kind: "saved" }],
			nextCursor: null,
			olderManualHistoryUnavailable: false,
		});
	});
});
