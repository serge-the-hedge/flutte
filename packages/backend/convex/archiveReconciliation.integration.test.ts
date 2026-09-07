import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function bindTwoLocales(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Expected source Locale.");
	const targetId = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await user.action(api.locales.bind, {
		localeId: targetId,
		catalogPath: "de.arb",
	});
	return { sourceId: source._id, targetId };
}

async function readActiveCatalog(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	return await user.query(api.catalogProjection.getActive, { projectId });
}

async function readArchiveReconciliation(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	return await user.query(api.archiveReconciliation.getActive, { projectId });
}

describe("Archive Reconciliation", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("pages archive values and automatic restorations within a pinned transition", async () => {
		const user = await authenticatedBackend(t, "archive-pages");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const fr = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
		});
		await user.action(api.locales.bind, {
			localeId: fr,
			catalogPath: "fr.arb",
		});
		const full = ["en", "de", "fr"].map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				...Object.fromEntries(
					Array.from({ length: 60 }, (_, i) => [`key_${i}`, `${code} ${i}`]),
				),
			}),
		}));
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "full",
			files: full,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "empty",
			lineage: {
				baselineCommit: "full",
				relationship: "descendant",
				mergeBase: "full",
			},
			files: ["en", "de", "fr"].map((code) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({ "@@locale": code }),
			})),
		});
		const first = await user.query(api.archiveReconciliation.getActive, {
			projectId,
		});
		if (!first) throw new Error("Expected archive");
		expect(first.isDone).toBe(false);
		await expect(
			user.query(api.archiveReconciliation.getActive, {
				projectId,
				cursor: first.continueCursor,
			}),
		).rejects.toThrow("projectionId");
		const archiveOrder = new Set(first.keys.map((key) => key.id));
		let count = first.keys.reduce((sum, key) => sum + key.values.length, 0);
		let page = first;
		while (!page.isDone) {
			page = await user.query(api.archiveReconciliation.get, {
				projectId,
				projectionId: first.projectionId,
				cursor: page.continueCursor,
			});
			for (const key of page.keys) archiveOrder.add(key.id);
			count += page.keys.reduce((sum, key) => sum + key.values.length, 0);
		}
		expect(count).toBe(180);
		expect([...archiveOrder]).toEqual(
			Array.from({ length: 60 }, (_, i) => `key_${i}`),
		);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "restored",
			lineage: {
				baselineCommit: "empty",
				relationship: "descendant",
				mergeBase: "empty",
			},
			files: full.map((file) =>
				file.catalogPath === "en.arb"
					? file
					: {
							...file,
							content: JSON.stringify({
								"@@locale": file.catalogPath.slice(0, 2),
							}),
						},
			),
		});
		const restored = await user.query(api.catalogProjection.getRestorations, {
			projectId,
		});
		if (!restored) throw new Error("Expected restorations");
		expect(restored.isDone).toBe(false);
		const remaining = await user.query(api.catalogProjection.getRestorations, {
			projectId,
			projectionId: restored.projectionId,
			cursor: restored.continueCursor,
		});
		expect(remaining?.isDone).toBe(true);
		expect([
			...new Set(
				[...restored.keys, ...(remaining?.keys ?? [])].map((key) => key.id),
			),
		]).toEqual(Array.from({ length: 60 }, (_, i) => `key_${i}`));
		expect(
			restored.keys.reduce((sum, key) => sum + key.values.length, 0) +
				(remaining?.keys.reduce((sum, key) => sum + key.values.length, 0) ?? 0),
		).toBe(120);
		expect(
			(
				await user.query(api.archiveReconciliation.get, {
					projectId,
					projectionId: first.projectionId,
				})
			)?.snapshotId,
		).toBe(first.snapshotId);
	});

	test("archives absent source keys and target Locales without losing evidence", async () => {
		const user = await authenticatedBackend(t, "archive-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","retained":"Keep","removed":"Remove","@removed":{"description":"source metadata"}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","retained":"Behalten","removed":"Entfernen","@removed":{"description":"target metadata"}}',
				},
			],
		});
		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","retained":"Keep"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","retained":"Behalten"}',
				},
			],
		});

		const active = await readActiveCatalog(user, projectId);
		const archives = await readArchiveReconciliation(user, projectId);

		expect(active).toMatchObject({ snapshotId: next.snapshotId });
		expect(active?.keys.map((key) => key.id)).toEqual(["retained"]);
		expect(active?.keys[0]?.values.map((value) => value.localeCode)).toEqual([
			"en",
			"de",
		]);
		expect(archives).toMatchObject({
			snapshotId: next.snapshotId,
			previousSnapshotId: baseline.snapshotId,
			locales: [],
			keys: [
				{
					id: "removed",
					keyArchived: true,
					values: [
						{
							localeCode: "en",
							keyArchived: true,
							evidenceSnapshotId: baseline.snapshotId,
							value: "Remove",
							metadataCatalogPath: "en.arb",
						},
						{
							localeCode: "de",
							keyArchived: true,
							localeArchived: false,
							evidenceSnapshotId: baseline.snapshotId,
							value: "Entfernen",
							metadataCatalogPath: "de.arb",
						},
					],
				},
			],
		});
		const archivedSource = archives?.keys
			.find((key) => key.id === "removed")
			?.values.find((value) => value.localeCode === "en");
		if (!archivedSource) throw new Error("Expected archived source evidence.");
		expect(
			await user.action(api.snapshots.catalogText, {
				snapshotId: archivedSource.evidenceSnapshotId,
				localeCode: archivedSource.localeCode,
			}),
		).toContain('"@removed":{"description":"source metadata"}');

		const preview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","preview":"Preview"}',
				},
			],
		});
		expect(preview.snapshotId).not.toBeNull();
		expect((await readActiveCatalog(user, projectId))?.snapshotId).toBe(
			next.snapshotId,
		);
		expect((await readArchiveReconciliation(user, projectId))?.snapshotId).toBe(
			next.snapshotId,
		);

		const failed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "missing-source",
			lineage: {
				baselineCommit: "next",
				relationship: "descendant",
				mergeBase: "next",
			},
			files: [{ catalogPath: "de.arb", content: '{"@@locale":"de"}' }],
		});
		expect(failed.snapshotId).toBeNull();
		expect((await readArchiveReconciliation(user, projectId))?.snapshotId).toBe(
			next.snapshotId,
		);

		// Rebinding after a Preview was recorded must not change the evidence it
		// later projects. The replay below reuses its Snapshot Identity, so it
		// must stage the original absent Locale rather than inspecting this path.
		await user.action(api.locales.bind, {
			localeId: targetId,
			catalogPath: "moved/de.arb",
		});
		const promotedPreview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			lineage: {
				baselineCommit: "next",
				relationship: "descendant",
				mergeBase: "next",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","preview":"Preview"}',
				},
			],
		});
		expect(promotedPreview.snapshotId).toBe(preview.snapshotId);
		expect((await readActiveCatalog(user, projectId))?.snapshotId).toBe(
			preview.snapshotId,
		);
		expect(await readArchiveReconciliation(user, projectId)).toMatchObject({
			snapshotId: preview.snapshotId,
			previousSnapshotId: next.snapshotId,
			locales: [{ localeId: targetId, catalogPath: "de.arb" }],
		});

		const history = await user.query(api.archiveReconciliation.list, {
			projectId,
			paginationOpts: { cursor: null, numItems: 10 },
		});
		const nextArchive = history.page.find(
			(entry) => entry.snapshotId === next.snapshotId,
		);
		if (!nextArchive) throw new Error("Expected the prior archive transition.");
		const historicalArchive = await user.query(api.archiveReconciliation.get, {
			projectId,
			projectionId: nextArchive.projectionId,
		});
		expect(historicalArchive?.snapshotId).toBe(next.snapshotId);
		expect(historicalArchive?.keys).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "removed", keyArchived: true }),
			]),
		);
	});

	test("does not repeat an Archive Reconciliation for a still-absent target Locale", async () => {
		const user = await authenticatedBackend(t, "archive-repeat-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","id":"One"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","id":"Eins"}' },
			],
		});
		const firstAbsent = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "first-absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","id":"One"}' },
			],
		});
		const stillAbsent = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "still-absent",
			lineage: {
				baselineCommit: "first-absent",
				relationship: "descendant",
				mergeBase: "first-absent",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","id":"One"}' },
			],
		});

		expect(firstAbsent.snapshotId).not.toBeNull();
		expect(await readArchiveReconciliation(user, projectId)).toMatchObject({
			snapshotId: stillAbsent.snapshotId,
			locales: [],
			keys: [],
		});
		expect(
			(await readActiveCatalog(user, projectId))?.keys[0]?.values.map(
				(value) => value.localeCode,
			),
		).toEqual(["en"]);
	});

	test("retains one target value when its key and Locale disappear together", async () => {
		const user = await authenticatedBackend(t, "archive-intersection-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","gone":"Gone"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","gone":"Weg"}' },
			],
		});
		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","live":"Live"}' },
			],
		});

		expect(await readArchiveReconciliation(user, projectId)).toMatchObject({
			snapshotId: next.snapshotId,
			locales: [{ localeCode: "de" }],
			keys: [
				{
					id: "gone",
					keyArchived: true,
					values: [
						{ localeCode: "en", keyArchived: true, localeArchived: false },
						{ localeCode: "de", keyArchived: true, localeArchived: true },
					],
				},
			],
		});
	});

	test("keeps source-key and Locale identities when Git reintroduces them", async () => {
		const user = await authenticatedBackend(t, "archive-return-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","returning":"One"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","returning":"Eins"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","other":"Other"}' },
			],
		});
		const restored = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "returned",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","returning":"One"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","returning":"Neu"}',
				},
			],
		});

		const active = await readActiveCatalog(user, projectId);
		expect(active).toMatchObject({ snapshotId: restored.snapshotId });
		expect(active?.keys).toEqual([
			expect.objectContaining({
				id: "returning",
				values: expect.arrayContaining([
					expect.objectContaining({ localeId: targetId, localeCode: "de" }),
				]),
			}),
		]);
	});

	test("restores archived target history only for a byte-identical English re-add", async () => {
		const user = await authenticatedBackend(t, "archive-restore-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","returning":"Keep me","@returning":{"description":"source metadata"}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","returning":"Bewahre mich","@returning":{"description":"target metadata"}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const stillAbsent = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "still-absent",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		await user.action(api.locales.bind, {
			localeId: targetId,
			catalogPath: "next/de.arb",
		});
		const restored = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "returned",
			lineage: {
				baselineCommit: "still-absent",
				relationship: "descendant",
				mergeBase: "still-absent",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","returning":"Keep me","@returning":{"description":"new source metadata"}}',
				},
				{ catalogPath: "next/de.arb", content: '{"@@locale":"de"}' },
			],
		});

		if (!baseline.snapshotId)
			throw new Error("Expected the Baseline Snapshot.");
		const active = await readActiveCatalog(user, projectId);
		expect(active).toMatchObject({ snapshotId: restored.snapshotId });
		expect(active?.keys).toEqual([
			expect.objectContaining({
				id: "returning",
				values: expect.arrayContaining([
					expect.objectContaining({
						localeId: targetId,
						localeCode: "de",
						value: "Bewahre mich",
						materialized: true,
						metadataCatalogPath: "de.arb",
						metadataSnapshotId: baseline.snapshotId,
						restoredFromSnapshotId: baseline.snapshotId,
					}),
				]),
			}),
		]);
		expect(
			await user.query(api.catalogProjection.getRestorations, { projectId }),
		).toMatchObject({
			snapshotId: restored.snapshotId,
			previousSnapshotId: stillAbsent.snapshotId,
			keys: [
				{
					id: "returning",
					origin: "automatic_restore",
					values: [
						{
							localeId: targetId,
							value: "Bewahre mich",
							restoredFromSnapshotId: baseline.snapshotId,
							origin: "automatic_restore",
						},
					],
				},
			],
		});
		const carried = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "carried",
			lineage: {
				baselineCommit: "returned",
				relationship: "descendant",
				mergeBase: "returned",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","returning":"Keep me","@returning":{"description":"new source metadata"}}',
				},
				{ catalogPath: "next/de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const carriedTarget = (await readActiveCatalog(user, projectId))?.keys
			.find((key) => key.id === "returning")
			?.values.find((value) => value.localeId === targetId);
		expect(carriedTarget).toMatchObject({
			value: "Bewahre mich",
			materialized: true,
			metadataCatalogPath: "de.arb",
			metadataSnapshotId: baseline.snapshotId,
			restoredFromSnapshotId: baseline.snapshotId,
		});
		expect(
			await user.query(api.catalogProjection.getRestorations, { projectId }),
		).toMatchObject({ snapshotId: carried.snapshotId, keys: [] });
	});

	test("restores nothing when an English re-add differs by one byte", async () => {
		const user = await authenticatedBackend(t, "archive-changed-readd-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","key":"Same"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","key":"Gleich"}' },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const changed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "changed",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","key":"Same "}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});

		const active = await readActiveCatalog(user, projectId);
		expect(active).toMatchObject({ snapshotId: changed.snapshotId });
		const target = active?.keys[0]?.values.find(
			(value) => value.localeId === targetId,
		);
		expect(target).toMatchObject({ value: "", materialized: true });
		expect(target).not.toHaveProperty("restoredFromSnapshotId");
		expect(
			await user.query(api.catalogProjection.getRestorations, { projectId }),
		).toMatchObject({ snapshotId: changed.snapshotId, keys: [] });
	});

	test("keeps an unchanged Git target stale when its re-added English changed", async () => {
		const user = await authenticatedBackend(t, "archive-stale-readd-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","key":"Same"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","key":"Gleich"}' },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "changed",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","key":"Same "}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","key":"Gleich"}' },
			],
		});

		const key = (await readActiveCatalog(user, projectId))?.keys.find(
			(value) => value.id === "key",
		);
		const target = key?.values.find((value) => value.localeId === targetId);
		const source = key?.values.find((value) => value.isSource);
		expect(target).toMatchObject({ value: "Gleich", materialized: false });
		expect(target).not.toHaveProperty("restoredFromSnapshotId");
		expect(target?.sourceFingerprint).not.toBe(source?.sourceFingerprint);
	});

	test("keeps a target value Git re-added alongside identical English", async () => {
		const user = await authenticatedBackend(t, "archive-git-target-wins-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","returning":"Keep me"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","returning":"Alte Übersetzung"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const returned = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "returned",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","returning":"Keep me"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","returning":"Neu aus Git"}',
				},
			],
		});

		const active = await readActiveCatalog(user, projectId);
		expect(active).toMatchObject({ snapshotId: returned.snapshotId });
		const target = active?.keys
			.find((key) => key.id === "returning")
			?.values.find((value) => value.localeId === targetId);
		expect(target).toMatchObject({
			value: "Neu aus Git",
			materialized: false,
		});
		expect(target).not.toHaveProperty("restoredFromSnapshotId");
		expect(
			await user.query(api.catalogProjection.getRestorations, { projectId }),
		).toMatchObject({ snapshotId: returned.snapshotId, keys: [] });
	});

	test("creates an idempotent Restore Proposal without unarchiving the key", async () => {
		const user = await authenticatedBackend(t, "restore-proposal-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","recover":"Recover me","@recover":{"description":"source metadata"}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","recover":"Stelle mich wieder her","@recover":{"description":"target metadata"}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});

		if (!baseline.snapshotId)
			throw new Error("Expected the Baseline Snapshot.");
		const requested = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "recover",
		});
		const repeated = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "recover",
		});
		expect(repeated).toEqual({
			proposalId: requested.proposalId,
			reused: true,
		});
		expect((await readActiveCatalog(user, projectId))?.keys).toEqual([]);
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: requested.proposalId,
			}),
		).toMatchObject({
			messageId: "recover",
			status: "open",
			source: {
				value: "Recover me",
				evidenceSnapshotId: baseline.snapshotId,
			},
			targets: [
				{
					localeId: targetId,
					value: "Stelle mich wieder her",
					metadataCatalogPath: "de.arb",
					evidenceSnapshotId: baseline.snapshotId,
				},
			],
		});
		const outsider = await authenticatedBackend(t, "restore-proposal-outsider");
		await expect(
			outsider.mutation(api.restoreProposals.request, {
				projectId,
				messageId: "recover",
			}),
		).rejects.toThrow();
		await expect(
			outsider.query(api.restoreProposals.get, {
				projectId,
				proposalId: requested.proposalId,
			}),
		).rejects.toThrow();
	});

	test("resolves Restore Proposals from the next accepted English observation", async () => {
		const user = await authenticatedBackend(
			t,
			"restore-proposal-observation-owner",
		);
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","land":"Land this","supersede":"Old source"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","land":"Landung","supersede":"Alt"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const landed = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "land",
		});
		const superseded = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "supersede",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "still-missing",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: landed.proposalId,
			}),
		).toMatchObject({ status: "open" });
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: superseded.proposalId,
			}),
		).toMatchObject({ status: "open" });

		const observed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "observed",
			lineage: {
				baselineCommit: "still-missing",
				relationship: "descendant",
				mergeBase: "still-missing",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","land":"Land this","supersede":"Moved elsewhere"}',
				},
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: landed.proposalId,
			}),
		).toMatchObject({
			status: "landed",
			observedSnapshotId: observed.snapshotId,
		});
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: superseded.proposalId,
			}),
		).toMatchObject({
			status: "superseded",
			observedSnapshotId: observed.snapshotId,
		});
	});

	test("resolves a bulk recovery without limiting open Restore Proposals", async () => {
		const user = await authenticatedBackend(t, "bulk-restore-proposal-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const keys = Array.from({ length: 9 }, (_, index) => `recover_${index}`);
		const sourceCatalog = JSON.stringify({
			"@@locale": "en",
			...Object.fromEntries(keys.map((key) => [key, `English ${key}`])),
		});
		const targetCatalog = JSON.stringify({
			"@@locale": "de",
			...Object.fromEntries(keys.map((key) => [key, `Deutsch ${key}`])),
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: sourceCatalog },
				{ catalogPath: "de.arb", content: targetCatalog },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const proposals = [] as { proposalId: Id<"sourceProposals"> }[];
		for (const messageId of keys) {
			proposals.push(
				await user.mutation(api.restoreProposals.request, {
					projectId,
					messageId,
				}),
			);
		}
		const observed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "returned",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{ catalogPath: "en.arb", content: sourceCatalog },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		for (const proposal of proposals) {
			expect(
				await user.query(api.restoreProposals.get, {
					projectId,
					proposalId: proposal.proposalId,
				}),
			).toMatchObject({
				status: "landed",
				observedSnapshotId: observed.snapshotId,
			});
		}
	});

	test("keeps the accepted proposal observation when competing staging is discarded", async () => {
		const user = await authenticatedBackend(
			t,
			"competing-restore-proposal-owner",
		);
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","recover":"Recover me"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","recover":"Stelle mich wieder her"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const proposal = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "recover",
		});
		const competingProjectionId = await user.mutation(
			internal.catalogProjection.begin,
			{
				projectId,
				repository: "repo",
				commit: "competing",
				manifestHash: "competing-manifest",
				expectedKeyCount: 0,
				expectedMessageCount: 0,
				expectedByteLength: 0,
			},
		);
		const observation = {
			proposalId: proposal.proposalId,
			messageId: "recover",
			value: "Recover me",
		};
		await user.mutation(
			internal.catalogProjection.declareSourceProposalObservations,
			{
				projectId,
				projectionId: competingProjectionId,
				expectedSourceProposalObservationCount: 1,
				expectedSourceProposalObservationByteLength: new TextEncoder().encode(
					JSON.stringify(observation),
				).byteLength,
			},
		);
		await user.mutation(
			internal.catalogProjection.stageSourceProposalObservationBatch,
			{
				projectId,
				projectionId: competingProjectionId,
				observations: [observation],
				isFinal: true,
			},
		);

		const accepted = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "accepted",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","recover":"Recover me"}',
				},
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		await user.mutation(internal.catalogProjection.discard, {
			projectId,
			projectionId: competingProjectionId,
		});

		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: proposal.proposalId,
			}),
		).toMatchObject({
			status: "landed",
			observedSnapshotId: accepted.snapshotId,
		});
	});

	test("resolves a Restore Proposal when immutable Preview evidence is promoted", async () => {
		const user = await authenticatedBackend(
			t,
			"preview-restore-proposal-owner",
		);
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","recover":"Keep me"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","recover":"Bewahre mich"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "absent",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const proposal = await user.mutation(api.restoreProposals.request, {
			projectId,
			messageId: "recover",
		});
		const previewFiles = [
			{
				catalogPath: "en.arb",
				content: '{"@@locale":"en","recover":"Keep me"}',
			},
			{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
		];
		const preview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files: previewFiles,
		});
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: proposal.proposalId,
			}),
		).toMatchObject({ status: "open" });
		const promoted = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			lineage: {
				baselineCommit: "absent",
				relationship: "descendant",
				mergeBase: "absent",
			},
			files: previewFiles,
		});
		expect(promoted.snapshotId).toBe(preview.snapshotId);
		expect(
			await user.query(api.restoreProposals.get, {
				projectId,
				proposalId: proposal.proposalId,
			}),
		).toMatchObject({
			status: "landed",
			observedSnapshotId: promoted.snapshotId,
		});
	});

	test("requires project-view permission to read archive history", async () => {
		const owner = await authenticatedBackend(t, "archive-owner-only");
		const projectId = await createProject(owner);
		await bindTwoLocales(owner, projectId);
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","gone":"Gone"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","gone":"Weg"}' },
			],
		});
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","live":"Live"}' },
			],
		});
		const active = await readArchiveReconciliation(owner, projectId);
		if (!active) throw new Error("Expected an active Archive Reconciliation.");
		const outsider = await authenticatedBackend(t, "archive-outsider");

		await expect(
			outsider.query(api.archiveReconciliation.getActive, { projectId }),
		).rejects.toThrow();
		await expect(
			outsider.query(api.archiveReconciliation.get, {
				projectId,
				projectionId: active.projectionId,
			}),
		).rejects.toThrow();
		await expect(
			outsider.query(api.archiveReconciliation.list, {
				projectId,
				paginationOpts: { cursor: null, numItems: 10 },
			}),
		).rejects.toThrow();
	});
});
