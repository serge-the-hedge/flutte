import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

beforeEach(() =>
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	}),
);
afterEach(() => vi.useRealTimers());

test("prepared snapshot cohorts skip unrelated keys and merge in current catalog order", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "indexed-snapshot-owner");
	const projectId = await createProject(owner);
	const [en] = await owner.query(api.locales.list, { projectId });
	if (!en) throw new Error("Missing source");
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
	async function ingest(commit: string, keys: string[], previous?: string) {
		const result = await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(previous
				? {
						lineage: {
							baselineCommit: previous,
							relationship: "descendant" as const,
							mergeBase: previous,
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
	const original = Array.from({ length: 80 }, (_, index) => `original${index}`);
	await ingest("first", original);
	const second = await ingest(
		"second",
		[...original, "lateA", "lateB"],
		"first",
	);
	const third = await ingest(
		"third",
		["lateB", ...original, "third", "lateA"],
		"second",
	);
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw new Error("Missing catalog");
	const args = {
		projectId,
		projectionId: overview.projectionId,
		localeIds: [fr],
	};
	await expect(
		owner.query(api.catalogBrowse.page, {
			...args,
			introducedSnapshotIds: [third],
		}),
	).rejects.toThrow("Snapshot filtering is still being prepared");
	// This fixture exercises the read plan independently of the preparation job.
	for (const snapshotId of [second, third])
		await t.run(async (ctx) => {
			const origin = await ctx.db
				.query("catalogProjections")
				.withIndex("by_project_and_snapshot_and_status", (q) =>
					q
						.eq("projectId", projectId)
						.eq("snapshotId", snapshotId)
						.eq("status", "published"),
				)
				.first();
			if (!origin) throw new Error("Missing origin");
			await ctx.db.insert("snapshotOriginIndexes", {
				projectId,
				snapshotId,
				originProjectionId: origin._id,
				projectionId: overview.projectionId,
				status: "ready",
				cursor: null,
				processed: origin.expectedKeyCount,
				expected: origin.expectedKeyCount,
				jobId: snapshotId,
				updatedAt: Date.now(),
			});
		});
	const sparse = await owner.query(api.catalogBrowse.page, {
		...args,
		introducedSnapshotIds: [third],
	});
	expect(sparse.keys.map((key) => key.messageId)).toEqual(["third"]);
	expect(sparse.nextAfter).toBeNull();
	const both = [second, third];
	const merged = await owner.query(api.catalogBrowse.page, {
		...args,
		introducedSnapshotIds: both,
	});
	expect(merged.keys.map((key) => key.messageId)).toEqual([
		"lateB",
		"third",
		"lateA",
	]);
	expect(merged.nextAfter).toBeNull();
	const continued = await owner.query(api.catalogBrowse.page, {
		...args,
		introducedSnapshotIds: both,
		after: 0,
	});
	expect(continued.keys.map((key) => key.messageId)).toEqual([
		"third",
		"lateA",
	]);
	const countArgs = {
		...args,
		revision: overview.revision,
		introducedSnapshotIds: both,
	};
	const counts = await owner.query(api.catalogBrowse.scopeCounts, countArgs);
	expect(counts.cursor).not.toBeNull();
	const remaining = await owner.query(api.catalogBrowse.scopeCounts, {
		...countArgs,
		cursor: counts.cursor ?? undefined,
	});
	expect(
		counts.counts.unconfirmedImport + remaining.counts.unconfirmedImport,
	).toBe(3);
	expect(remaining.cursor).toBeNull();
	await expect(
		owner.query(api.catalogBrowse.scopeCounts, {
			...countArgs,
			introducedSnapshotIds: [third],
			cursor: counts.cursor ?? undefined,
		}),
	).rejects.toThrow("Invalid snapshot count cursor");
	// Unknown origins also seek their own index rather than scan earlier keys.
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_messageId", (q) =>
				q
					.eq("projectId", projectId)
					.eq("projectionId", overview.projectionId)
					.eq("messageId", "lateA"),
			)
			.unique();
		if (!row) throw new Error("Missing navigation row");
		await ctx.db.patch(row._id, { firstSeenProjectionId: undefined });
	});
	const unknown = await owner.query(api.catalogBrowse.page, {
		...args,
		introducedOriginUnknown: true,
	});
	expect(unknown.keys.map((key) => key.messageId)).toEqual(["lateA"]);
	expect(unknown.nextAfter).toBeNull();
});
