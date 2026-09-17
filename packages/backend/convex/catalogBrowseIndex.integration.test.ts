import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";

beforeEach(() =>
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	}),
);
afterEach(() => vi.useRealTimers());
async function fixture() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "focus-index");
	const projectId = await createProject(owner);
	const [en] = await owner.query(api.locales.list, { projectId });
	if (!en) throw Error("Missing source");
	const fr = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	for (const [localeId, code] of [
		[en._id, "en"],
		[fr, "fr"],
	] as const)
		await owner.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	const original = Array.from(
		{ length: 128 },
		(_, index) => `ordinary_${index}`,
	);
	for (const [commit, keys] of [
		["initial", original],
		["new", [...original, "new_key"]],
	] as const)
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(commit === "new"
				? {
						lineage: {
							baselineCommit: "initial",
							relationship: "descendant" as const,
							mergeBase: "initial",
						},
					}
				: {}),
			files: ["en", "fr"].map((code) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({
					"@@locale": code,
					...Object.fromEntries(keys.map((key) => [key, `${code} ${key}`])),
				}),
			})),
		});
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw Error("Missing catalog");
	const projectionId = overview.projectionId;
	const args = { projectId, projectionId, localeIds: [fr] };
	async function save(messageId: string, source: boolean, value?: string) {
		const [key] = await owner.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: projectionId,
			messageIds: [messageId],
		});
		const current = key?.values.find(
			(row) => row.localeId === (source ? en._id : fr),
		);
		if (!current?.gitValueFingerprint) throw Error("Missing value");
		await owner.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId,
			localeId: source ? en._id : fr,
			intent:
				value === undefined ? { kind: "confirm" } : { kind: "save", value },
			expectedGitValueFingerprint: current.gitValueFingerprint,
			expectedGitValueRevision: current.gitValueRevision,
			expectedWorkspaceRevision: current.workspaceRevision,
			expectedSourceFingerprint: current.expectedSourceFingerprint,
		});
	}
	return { t, owner, projectId, overview, args, save };
}
test("sparse focus and default counts use the prepared index while English edits retain classification", async () => {
	const f = await fixture();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const before = await f.owner.query(api.catalogBrowse.readiness, {
		projectId: f.projectId,
	});
	if (before.kind !== "ready") throw Error("Not ready");
	expect(before.optimizationNeeded).toBe(false);
	const page = await f.owner.query(api.catalogBrowse.page, {
		...f.args,
		scope: "introduced",
	});
	expect(page.keys.map((row) => row.messageId)).toEqual(["new_key"]);
	expect(page.nextAfter).toBeNull();
	const counts = await f.owner.query(api.catalogBrowse.scopeCounts, {
		...f.args,
		classificationRevision: before.classificationRevision,
	});
	expect(counts.cursor).toBeNull();
	expect(counts.counts.introduced).toBe(1);
	expect(counts.counts.unconfirmedImport).toBe(129);
	const readSummary = () =>
		f.t.run((ctx) =>
			ctx.db
				.query("catalogBrowseStates")
				.withIndex("by_projectId", (q) => q.eq("projectId", f.projectId))
				.unique(),
		);
	let previousSummary = await readSummary();
	for (const value of ["First English edit", "Second English edit"]) {
		await f.save("new_key", true, value);
		const after = await f.owner.query(api.catalogBrowse.readiness, {
			projectId: f.projectId,
		});
		expect(after.kind).toBe("ready");
		if (after.kind !== "ready") throw Error("Not ready");
		expect(after.classificationRevision).toBe(before.classificationRevision);
		expect(after.revision).toBeUndefined();
		const summary = await readSummary();
		if (value === "Second English edit")
			expect(summary).toEqual(previousSummary);
		previousSummary = summary;
	}
	const strict = await f.owner.query(api.catalogBrowse.overview, {
		projectId: f.projectId,
	});
	if (strict.kind !== "ready") throw Error("Not ready");
	expect(strict.revision).toBeGreaterThan(f.overview.revision);
	// A rebuilt cache in the same projection must not reuse an old revision-zero identity.
	await f.t.run(async (ctx) => {
		const summary = await ctx.db
			.query("catalogBrowseStates")
			.withIndex("by_projectId", (q) => q.eq("projectId", f.projectId))
			.unique();
		if (summary) await ctx.db.delete(summary._id);
	});
	await f.owner.mutation(api.catalogBrowseIndex.ensurePrepared, {
		projectId: f.projectId,
	});
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const rebuilt = await f.owner.query(api.catalogBrowse.readiness, {
		projectId: f.projectId,
	});
	if (rebuilt.kind !== "ready") throw Error("Not ready");
	expect(rebuilt.classificationRevision).toBe(before.classificationRevision);
	expect(rebuilt.classificationGeneration).not.toBe(
		before.classificationGeneration,
	);
	const stale = await f.owner.query(api.catalogBrowse.scopeCounts, {
		...f.args,
		classificationRevision: before.classificationRevision,
		classificationGeneration: before.classificationGeneration,
	});
	expect(stale.stale).toBe(true);
});
test("target reviews update indexed focus and aggregate counts atomically", async () => {
	const f = await fixture();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const before = await f.owner.query(api.catalogBrowse.readiness, {
		projectId: f.projectId,
	});
	if (before.kind !== "ready") throw Error("Not ready");
	await f.save("new_key", false);
	const after = await f.owner.query(api.catalogBrowse.readiness, {
		projectId: f.projectId,
	});
	if (after.kind !== "ready") throw Error("Not ready");
	expect(after.classificationRevision).toBeGreaterThan(
		before.classificationRevision ?? -1,
	);
	const page = await f.owner.query(api.catalogBrowse.page, {
		...f.args,
		scope: "introduced",
	});
	expect(page.keys).toEqual([]);
	expect(page.nextAfter).toBeNull();
	const counts = await f.owner.query(api.catalogBrowse.scopeCounts, {
		...f.args,
		classificationRevision: after.classificationRevision,
	});
	expect(counts.cursor).toBeNull();
	expect(counts.counts).toMatchObject({
		introduced: 0,
		settled: 1,
		unconfirmedImport: 128,
	});
});
test("legacy preparation preserves fallback reads and counts with writes ahead and behind its cursor", async () => {
	const f = await fixture();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	await f.t.run(async (ctx) => {
		const state = await ctx.db
			.query("catalogBrowseStates")
			.withIndex("by_projectId", (q) => q.eq("projectId", f.projectId))
			.unique();
		if (state) await ctx.db.delete(state._id);
		const rows = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q.eq("projectId", f.projectId).eq("projectionId", f.args.projectionId),
			)
			.take(130);
		for (const row of rows)
			await ctx.db.patch(row._id, {
				hasWaiting: undefined,
				hasStale: undefined,
				hasUnconfirmedImport: undefined,
				hasIntroduced: undefined,
				hasChangedInGit: undefined,
			});
	});
	const fallback = await f.owner.query(api.catalogBrowse.page, {
		...f.args,
		scope: "introduced",
	});
	expect(fallback.keys).toEqual([]);
	expect(fallback.nextAfter).not.toBeNull();
	await f.owner.mutation(api.catalogBrowseIndex.ensurePrepared, {
		projectId: f.projectId,
	});
	await f.t.mutation(internal.catalogBrowseIndex.backfill, {
		projectId: f.projectId,
		projectionId: f.args.projectionId,
	});
	await f.save("ordinary_0", false);
	await f.save("ordinary_100", false);
	const ready = await f.owner.query(api.catalogBrowse.readiness, {
		projectId: f.projectId,
	});
	if (ready.kind !== "ready") throw Error("Not ready");
	const firstCounts = await f.owner.query(api.catalogBrowse.scopeCounts, {
		...f.args,
		classificationRevision: ready.classificationRevision,
	});
	expect(firstCounts.cursor).not.toBeNull();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	let total = firstCounts.counts.unconfirmedImport;
	let cursor = firstCounts.cursor;
	while (cursor) {
		const next = await f.owner.query(api.catalogBrowse.scopeCounts, {
			...f.args,
			classificationRevision: ready.classificationRevision,
			cursor,
		});
		expect(next.stale).toBe(false);
		total += next.counts.unconfirmedImport;
		cursor = next.cursor;
	}
	expect(total).toBe(127);
	const complete = await f.owner.query(api.catalogBrowse.scopeCounts, {
		...f.args,
		classificationRevision: ready.classificationRevision,
	});
	expect(complete.cursor).toBeNull();
	expect(complete.counts).toMatchObject({
		unconfirmedImport: 127,
		settled: 2,
		introduced: 1,
	});
	const page = await f.owner.query(api.catalogBrowse.page, {
		...f.args,
		scope: "introduced",
	});
	expect(page.keys.map((row) => row.messageId)).toEqual(["new_key"]);
	expect(page.nextAfter).toBeNull();
});
