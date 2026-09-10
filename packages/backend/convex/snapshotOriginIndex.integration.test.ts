import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";

beforeEach(() =>
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	}),
);
afterEach(() => vi.useRealTimers());

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "snapshot-owner");
	const projectId = await createProject(owner);
	const [source] = await owner.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing source");
	const fr = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	for (const [localeId, code] of [
		[source._id, "en"],
		[fr, "fr"],
	] as const)
		await owner.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	async function ingest(
		commit: string,
		keys: string[],
		baseline?: string,
		divergent = false,
	) {
		const result = await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(baseline
				? {
						lineage: {
							baselineCommit: baseline,
							relationship: divergent
								? ("divergent" as const)
								: ("descendant" as const),
							mergeBase: baseline,
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
		if (!result.snapshotId) throw new Error("Missing snapshot");
		return result.snapshotId;
	}
	return { t, owner, projectId, fr, ingest };
}

test("automatic origins survive edits and generation replacement without altering review metadata", async () => {
	const { t, owner, projectId, fr, ingest } = await setup();
	const initial = await ingest("initial", ["existing"]);
	const later = await ingest("later", ["existing", "added"], "initial");
	await t.run(async (ctx) => {
		for (const table of [
			"catalogProjectionMessages",
			"catalogWorkspaceNavigationRows",
		] as const)
			for (const row of await ctx.db.query(table).collect())
				await ctx.db.patch(row._id, { firstSeenProjectionId: undefined });
	});
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw new Error("No catalog");
	const projectionId = overview.projectionId;
	for (const snapshotId of [initial, later])
		await owner.mutation(api.snapshotOriginIndex.prepare, {
			projectId,
			projectionId,
			snapshotId,
		});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(
		await owner.query(api.snapshotOriginIndex.status, {
			projectId,
			projectionId,
			snapshotIds: [initial, later],
		}),
	).toMatchObject({ ready: true });
	const origins = await t.run(async (ctx) =>
		(await ctx.db.query("catalogMessageOrigins").collect()).map((row) => [
			row.messageId,
			row.firstSeenProjectionId,
		]),
	);
	expect(origins).toHaveLength(2);
	const original = await t.run(async (ctx) => {
		const rows = await ctx.db.query("catalogWorkspaceNavigationRows").collect();
		expect(rows.every((row) => row.firstSeenProjectionId)).toBe(true);
		return ctx.db.query("snapshotOriginIndexes").first();
	});
	if (!original) throw new Error("No origin index");
	const workspace = await readWorkspaceKeyCards(owner, projectId);
	const target = workspace.keys
		.find((key) => key.id === "existing")
		?.values.find((value) => value.localeId === fr);
	if (!target?.gitValueFingerprint) throw new Error("No target");
	await owner.mutation(api.catalogWorkspace.commit, {
		projectId,
		messageId: "existing",
		localeId: fr,
		intent: { kind: "save", value: "Modified translation" },
		expectedGitValueFingerprint: target.gitValueFingerprint,
		expectedGitValueRevision: target.gitValueRevision,
		expectedWorkspaceRevision: target.workspaceRevision,
		expectedSourceFingerprint: target.expectedSourceFingerprint,
	});
	const edited = await t.run(async (ctx) =>
		ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_messageId", (q) =>
				q
					.eq("projectId", projectId)
					.eq("projectionId", projectionId)
					.eq("messageId", "existing"),
			)
			.unique(),
	);
	expect(edited?.firstSeenProjectionId).toBe(
		origins.find(([messageId]) => messageId === "existing")?.[1],
	);

	await ingest("third", ["existing", "added"], "later");
	const next = await owner.query(api.catalogBrowse.overview, { projectId });
	if (next.kind !== "ready") throw new Error("No catalog");
	expect(
		(
			await owner.query(api.snapshotOriginIndex.status, {
				projectId,
				projectionId: next.projectionId,
				snapshotIds: [initial],
			})
		).ready,
	).toBe(false);
	await owner.mutation(api.snapshotOriginIndex.prepare, {
		projectId,
		projectionId: next.projectionId,
		snapshotId: initial,
	});
	await t.mutation(internal.snapshotOriginIndex.step, {
		indexId: original._id,
		jobId: original.jobId,
	});
	expect(
		(
			await owner.query(api.snapshotOriginIndex.status, {
				projectId,
				projectionId: next.projectionId,
				snapshotIds: [initial],
			})
		).ready,
	).toBe(false);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const rows = await t.run(async (ctx) =>
		ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q.eq("projectId", projectId).eq("projectionId", next.projectionId),
			)
			.collect(),
	);
	expect(rows.every((row) => row.firstSeenProjectionId)).toBe(true);
	expect(
		(
			await owner.query(api.snapshotOriginIndex.status, {
				projectId,
				projectionId: next.projectionId,
				snapshotIds: [initial],
			})
		).ready,
	).toBe(true);
});

test("small legacy catalogs prepare in bounded 128-key batches", async () => {
	const { t, owner, projectId, ingest } = await setup();
	const snapshotId = await ingest(
		"large",
		Array.from({ length: 256 }, (_, i) => `key${i}`),
	);
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw new Error("No catalog");
	await t.run(async (ctx) => {
		for (const table of [
			"catalogProjectionMessages",
			"catalogWorkspaceNavigationRows",
		] as const)
			for (const row of await ctx.db.query(table).collect())
				await ctx.db.patch(row._id, { firstSeenProjectionId: undefined });
	});
	await owner.mutation(api.snapshotOriginIndex.prepare, {
		projectId,
		projectionId: overview.projectionId,
		snapshotId,
	});
	const index = await t.run(async (ctx) =>
		ctx.db.query("snapshotOriginIndexes").first(),
	);
	if (!index) throw new Error("No index");
	await t.mutation(internal.snapshotOriginIndex.step, {
		indexId: index._id,
		jobId: index.jobId,
	});
	const progress = await owner.query(api.snapshotOriginIndex.status, {
		projectId,
		projectionId: overview.projectionId,
		snapshotIds: [snapshotId],
	});
	expect(progress.snapshots[0]?.processed).toBe(128);
	await t.mutation(internal.snapshotOriginIndex.step, {
		indexId: index._id,
		jobId: index.jobId,
	});
	expect(
		(
			await owner.query(api.snapshotOriginIndex.status, {
				projectId,
				projectionId: overview.projectionId,
				snapshotIds: [snapshotId],
			})
		).ready,
	).toBe(true);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
});

test("missing retained evidence fails visibly and failed preparation can be retried", async () => {
	const { t, owner, projectId, ingest } = await setup();
	const snapshotId = await ingest("initial", ["existing"]);
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw new Error("No catalog");
	const removed = await t.run(async (ctx) => {
		const row = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_isSource", (q) =>
				q
					.eq("projectionId", overview.projectionId)
					.eq("messageId", "existing")
					.eq("isSource", true),
			)
			.unique();
		if (!row) throw new Error("No source");
		await ctx.db.delete(row._id);
		const { _id, _creationTime, ...fields } = row;
		return fields;
	});
	const args = { projectId, projectionId: overview.projectionId, snapshotId };
	await owner.mutation(api.snapshotOriginIndex.prepare, args);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const failed = await owner.query(api.snapshotOriginIndex.status, {
		projectId,
		projectionId: overview.projectionId,
		snapshotIds: [snapshotId],
	});
	expect(failed).toMatchObject({
		ready: false,
		snapshots: [
			{
				status: "failed",
				failure: "This snapshot no longer retains complete source evidence.",
			},
		],
	});
	await t.run(async (ctx) => {
		await ctx.db.insert("catalogProjectionMessages", removed);
	});
	await owner.mutation(api.snapshotOriginIndex.prepare, args);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(
		(
			await owner.query(api.snapshotOriginIndex.status, {
				projectId,
				projectionId: overview.projectionId,
				snapshotIds: [snapshotId],
			})
		).ready,
	).toBe(true);
});
