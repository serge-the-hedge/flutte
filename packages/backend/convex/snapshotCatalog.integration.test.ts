import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
	async function browse(
		snapshotIds?: Id<"sourceSnapshots">[],
		introducedOriginUnknown?: boolean,
	) {
		const overview = await owner.query(api.catalogBrowse.overview, {
			projectId,
		});
		if (overview.kind !== "ready") throw new Error("Expected ready catalog");
		const result = await owner.query(api.catalogBrowse.page, {
			projectId,
			projectionId: overview.projectionId,
			introducedSnapshotIds: snapshotIds,
			introducedOriginUnknown,
		});
		return { overview, keys: result.keys.map((key) => key.messageId) };
	}
	return { t, owner, projectId, fr, ingest, browse };
}

const paginationOpts = { cursor: null, numItems: 32 };

test("snapshot selection preserves initial and original introduction through removal and restoration", async () => {
	const { owner, projectId, fr, ingest, browse } = await setup();
	const first = await ingest("first", ["initial"]);
	const second = await ingest("second", ["initial", "new"], "first");
	await ingest("third", ["initial"], "second");
	const fourth = await ingest("fourth", ["initial", "new"], "third");
	const preview = await ingest(
		"preview",
		["initial", "new", "previewOnly"],
		"fourth",
		true,
	);
	expect((await browse([first])).keys).toEqual(["initial"]);
	expect((await browse([second])).keys).toEqual(["new"]);
	expect((await browse([fourth])).keys).toEqual([]);
	expect((await browse([first, second])).keys).toEqual(["initial", "new"]);
	await expect(browse([preview])).rejects.toThrow(
		"Choose an accepted snapshot",
	);
	const { overview } = await browse();
	const counts = await owner.query(api.catalogBrowse.scopeCounts, {
		projectId,
		projectionId: overview.projectionId,
		revision: overview.revision,
		localeIds: [fr],
		introducedSnapshotIds: [second],
	});
	expect(counts.counts).toMatchObject({ introduced: 1, unconfirmedImport: 1 });
	const snapshots = await owner.query(api.snapshotCatalog.list, {
		projectId,
		paginationOpts,
	});
	const older = await owner.query(api.snapshotCatalog.list, {
		projectId,
		paginationOpts: { cursor: snapshots.continueCursor, numItems: 32 },
	});
	const snapshotRows = [...snapshots.page, ...older.page];
	expect(snapshotRows.map((row) => row.snapshotId)).toEqual([
		fourth,
		expect.any(String),
		second,
		first,
	]);
	expect(
		snapshotRows.find((row) => row.snapshotId === first)?.initialCatalog,
	).toBe(true);
	expect(
		snapshotRows.find((row) => row.snapshotId === second)?.initialCatalog,
	).toBe(false);
});

test("optional names are project-authorized metadata with conflict protection", async () => {
	const { t, owner, projectId, ingest, browse } = await setup();
	const snapshotId = await ingest("first", ["initial"]);
	const before = await browse();
	await owner.mutation(api.snapshotCatalog.rename, {
		projectId,
		snapshotId,
		name: "  Summer launch  ",
		expectedName: null,
	});
	expect(
		(
			await owner.query(api.snapshotCatalog.getSelected, {
				projectId,
				snapshotIds: [snapshotId],
			})
		)[0]?.name,
	).toBe("Summer launch");
	expect((await browse()).overview.revision).toBe(before.overview.revision);
	await expect(
		owner.mutation(api.snapshotCatalog.rename, {
			projectId,
			snapshotId,
			name: "Other",
			expectedName: null,
		}),
	).rejects.toThrow("name changed");
	await expect(
		owner.mutation(api.snapshotCatalog.rename, {
			projectId,
			snapshotId,
			name: "bad\nname",
			expectedName: "Summer launch",
		}),
	).rejects.toThrow("one line");
	const outsider = await authenticatedBackend(t, "snapshot-outsider");
	await expect(
		outsider.query(api.snapshotCatalog.list, { projectId, paginationOpts }),
	).rejects.toThrow();
	await expect(
		outsider.mutation(api.snapshotCatalog.rename, {
			projectId,
			snapshotId,
			name: "hack",
			expectedName: "Summer launch",
		}),
	).rejects.toThrow();
	const otherProject = await createProject(owner, { slug: "other-project" });
	await expect(
		owner.query(api.snapshotCatalog.getSelected, {
			projectId: otherProject,
			snapshotIds: [snapshotId],
		}),
	).rejects.toThrow("Choose an accepted snapshot");
	await owner.mutation(api.snapshotCatalog.rename, {
		projectId,
		snapshotId,
		name: " ",
		expectedName: "Summer launch",
	});
	expect(
		(
			await owner.query(api.snapshotCatalog.getSelected, {
				projectId,
				snapshotIds: [snapshotId],
			})
		)[0]?.name,
	).toBe(null);
});

test("historical origins require explicit bounded recovery and leave review facts unchanged", async () => {
	const { t, owner, projectId, fr, ingest, browse } = await setup();
	const first = await ingest("first", ["initial"]);
	const second = await ingest("second", ["initial", "new"], "first");
	await t.run(async (ctx) => {
		for (const row of await ctx.db
			.query("catalogProjectionPublicationStates")
			.collect())
			await ctx.db.delete(row._id);
		for (const table of [
			"catalogProjectionMessages",
			"catalogWorkspaceNavigationRows",
		] as const) {
			for (const row of await ctx.db.query(table).collect())
				await ctx.db.patch(row._id, { firstSeenProjectionId: undefined });
		}
	});
	expect(
		(await owner.query(api.snapshotCatalog.list, { projectId, paginationOpts }))
			.page,
	).toHaveLength(2);
	expect((await browse([first, second])).keys).toEqual([]);
	expect((await browse(undefined, true)).keys).toEqual(["initial", "new"]);
	await expect(browse([first], true)).rejects.toThrow(
		"Choose snapshots or strings",
	);
	const before = await browse();
	const initial = await owner.query(api.snapshotCatalog.previewOrigins, {
		projectId,
		snapshotId: first,
		paginationOpts,
	});
	expect(initial.page).toEqual([{ messageId: "initial" }]);
	expect(initial.initialCatalog).toBe(true);
	const introduced = await owner.query(api.snapshotCatalog.previewOrigins, {
		projectId,
		snapshotId: second,
		paginationOpts,
	});
	expect(introduced.page).toEqual([{ messageId: "new" }]);
	expect((await browse([second])).keys).toEqual([]);
	await expect(
		owner.mutation(api.snapshotCatalog.applyOrigins, {
			projectId,
			snapshotId: second,
			projectionId: introduced.projectionId,
			messageIds: ["initial"],
		}),
	).rejects.toThrow("does not prove");
	const args = {
		projectId,
		snapshotId: second,
		projectionId: introduced.projectionId,
		messageIds: ["new"],
	};
	expect(await owner.mutation(api.snapshotCatalog.applyOrigins, args)).toEqual({
		applied: 1,
		alreadyRecorded: 0,
	});
	expect(await owner.mutation(api.snapshotCatalog.applyOrigins, args)).toEqual({
		applied: 0,
		alreadyRecorded: 1,
	});
	expect((await browse([second])).keys).toEqual(["new"]);
	expect((await browse(undefined, true)).keys).toEqual(["initial"]);
	const after = await browse();
	const unknownCounts = await owner.query(api.catalogBrowse.scopeCounts, {
		projectId,
		projectionId: after.overview.projectionId,
		revision: after.overview.revision,
		localeIds: [fr],
		introducedOriginUnknown: true,
	});
	expect(unknownCounts.counts.unconfirmedImport).toBe(1);
	expect(after.overview.revision).toBe(before.overview.revision + 1);
	expect(after.overview.ordinaryImports).toEqual(
		before.overview.ordinaryImports,
	);
	const previewAgain = await owner.query(api.snapshotCatalog.previewOrigins, {
		projectId,
		snapshotId: second,
		paginationOpts,
	});
	expect(previewAgain.page).toEqual([{ messageId: "new" }]);
	expect(
		await t.run(
			async (ctx) =>
				await ctx.db.query("catalogProjectionPublicationStates").collect(),
		),
	).toEqual([]);
});

test("snapshot filters read compact publication evidence even with large historical identities", async () => {
	const { t, owner, projectId, ingest, browse } = await setup();
	const first = await ingest("first", ["initial"]);
	const { overview } = await browse();
	const source = await t.run(async (ctx) => {
		const snapshot = await ctx.db.get(first);
		const projection = await ctx.db.get(overview.projectionId);
		if (!snapshot || !projection) throw new Error("Missing fixture evidence");
		const {
			_id: _snapshotId,
			_creationTime: _snapshotTime,
			...snapshotFields
		} = snapshot;
		const {
			_id: _projectionId,
			_creationTime: _projectionTime,
			...projectionFields
		} = projection;
		return { snapshotFields, projectionFields };
	});
	const selected = [first];
	// Twelve full identity pairs exceed the transaction read budget. Each compact
	// publication record contains only project/projection/snapshot IDs and status.
	for (let index = 0; index < 12; index++) {
		selected.push(
			await t.run(async (ctx) => {
				const repository = "x".repeat(900 * 1024);
				const snapshotId = await ctx.db.insert("sourceSnapshots", {
					...source.snapshotFields,
					repository,
					commit: `large-${index}`,
				});
				const projectionId = await ctx.db.insert("catalogProjections", {
					...source.projectionFields,
					repository,
					snapshotId,
					commit: `large-${index}`,
				});
				await ctx.db.insert("catalogProjectionPublicationStates", {
					projectId,
					projectionId,
					snapshotId,
					status: "published",
				});
				return snapshotId;
			}),
		);
	}
	expect((await browse(selected)).keys).toEqual(["initial"]);
	expect(
		await owner.query(api.snapshotCatalog.getSelected, {
			projectId,
			snapshotIds: selected.slice(1, 5),
		}),
	).toHaveLength(4);
	await expect(
		owner.query(api.snapshotCatalog.getSelected, {
			projectId,
			snapshotIds: selected.slice(1, 6),
		}),
	).rejects.toThrow("4 snapshot labels");
	const names = await owner.query(api.snapshotCatalog.list, {
		projectId,
		paginationOpts,
	});
	expect(names.page.length).toBeLessThanOrEqual(4);
	await t.run(async (ctx) => {
		for (const row of await ctx.db
			.query("catalogProjectionPublicationStates")
			.collect())
			await ctx.db.delete(row._id);
	});
	await expect(browse(selected)).rejects.toThrow(
		"Choose fewer older snapshots.",
	);
});
