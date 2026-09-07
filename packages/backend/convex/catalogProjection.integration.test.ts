import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Ingestion stages the complete Catalog Navigation Index for each accepted
// generation, so the real-catalog tests budget for that bounded extra work.
vi.setConfig({ testTimeout: 120_000 });

import de from "../fixtures/arb/intl_de.arb?raw";
import en from "../fixtures/arb/intl_en.arb?raw";
import es from "../fixtures/arb/intl_es.arb?raw";
import fr from "../fixtures/arb/intl_fr.arb?raw";
import ru from "../fixtures/arb/intl_ru.arb?raw";
import zh from "../fixtures/arb/intl_zh.arb?raw";
import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readAllCatalogPages,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const catalogs = { en, de, es, fr, ru, zh } as const;
type LocaleCode = keyof typeof catalogs;
const pathFor = (code: LocaleCode) => `lib/l10n/intl_${code}.arb`;

function withCatalogValue(
	content: string,
	messageId: string,
	value: string,
): string {
	const catalog = JSON.parse(content) as Record<string, unknown>;
	catalog[messageId] = value;
	return JSON.stringify(catalog);
}

async function readActiveCatalog(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	return await readAllCatalogPages(user, projectId);
}

async function readGitChanges(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const first = await user.query(api.catalogProjection.getGitChanges, {
		projectId,
	});
	if (!first) return null;
	const keys = new Map(first.keys.map((key) => [key.id, key]));
	let page = first;
	while (!page.isDone) {
		const next = await user.query(api.catalogProjection.getGitChanges, {
			projectId,
			projectionId: first.projectionId,
			cursor: page.continueCursor,
		});
		if (!next) throw new Error("Missing pinned Git changes");
		page = next;
		for (const key of page.keys) {
			const previous = keys.get(key.id);
			keys.set(
				key.id,
				previous
					? { ...key, values: [...previous.values, ...key.values] }
					: key,
			);
		}
	}
	return { ...first, keys: [...keys.values()] };
}

async function bindTwoLocales(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Expected source Locale");
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

describe("catalog projection", () => {
	let t: Backend;

	beforeEach(() => {
		// Scheduled reclamation workers must never fire on real timers while
		// an ingest action is mid-flight: convex-test runs one function at a
		// time, and a timer callback interleaving with the action's storage
		// writes would crash the run. Freeze timers and drain explicitly.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		t = createBackend();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("pages Git changes against their published generation", async () => {
		const user = await authenticatedBackend(t, "paged-git-changes");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const files = (version: number) =>
			["en", "de"].map((code) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({
					"@@locale": code,
					...Object.fromEntries(
						Array.from({ length: 40 }, (_, i) => [
							`key_${i}`,
							`${code} ${i} v${version}`,
						]),
					),
				}),
			}));
		for (const version of [1, 2, 3]) {
			await user.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: `version-${version}`,
				files: files(version),
				...(version === 1
					? {}
					: {
							lineage: {
								baselineCommit: `version-${version - 1}`,
								relationship: "descendant" as const,
								mergeBase: `version-${version - 1}`,
							},
						}),
			});
			if (version !== 2) continue;
			const first = await user.query(api.catalogProjection.getGitChanges, {
				projectId,
			});
			if (!first) throw new Error("Missing Git changes");
			expect(first.isDone).toBe(false);
			const complete = await readGitChanges(user, projectId);
			expect(complete?.keys.map((key) => key.id)).toEqual(
				Array.from({ length: 40 }, (_, i) => `key_${i}`),
			);
			expect(complete?.keys.every((key) => key.values.length === 2)).toBe(true);
			await expect(
				user.query(api.catalogProjection.getGitChanges, {
					projectId,
					cursor: first.continueCursor,
				}),
			).rejects.toThrow("projectionId");
			await user.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: "later",
				files: files(3),
				lineage: {
					baselineCommit: "version-2",
					relationship: "descendant",
					mergeBase: "version-2",
				},
			});
			const continued = await user.query(api.catalogProjection.getGitChanges, {
				projectId,
				projectionId: first.projectionId,
				cursor: first.continueCursor,
			});
			expect(continued?.projectionId).toBe(first.projectionId);
			expect(
				continued?.keys.every((key) =>
					key.values.every((value) => value.current.value.endsWith("v2")),
				),
			).toBe(true);
			break;
		}
	});

	test("pins catalog continuations while another Baseline is published", async () => {
		const user = await authenticatedBackend(t, "paged-catalog");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const files = ["en", "de"].map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				...Object.fromEntries(
					Array.from({ length: 40 }, (_, i) => [`key_${i}`, `${code} ${i}`]),
				),
			}),
		}));
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "example/repo",
			commit: "page-one",
			files,
		});
		const first = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		expect(first?.isDone).toBe(false);
		if (!first) throw new Error("Expected catalog");
		await expect(
			user.query(api.catalogProjection.getActive, {
				projectId,
				cursor: first.continueCursor,
			}),
		).rejects.toThrow("projectionId");
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "example/repo",
			commit: "page-two",
			lineage: {
				baselineCommit: "page-one",
				relationship: "descendant",
				mergeBase: "page-one",
			},
			files: files.map((file) => ({
				...file,
				content: file.content.replace("en 0", "Changed"),
			})),
		});
		const next = await user.query(api.catalogProjection.getActive, {
			projectId,
			projectionId: first.projectionId,
			cursor: first.continueCursor,
		});
		expect(next?.projectionId).toBe(first.projectionId);
		expect(next?.snapshotId).toBe(first.snapshotId);
		expect(
			(await readAllCatalogPages(user, projectId))?.keys.map((key) => key.id),
		).toEqual(Array.from({ length: 40 }, (_, i) => `key_${i}`));
	});

	test("has no active Baseline Catalog before a Baseline Snapshot is accepted", async () => {
		const user = await authenticatedBackend(t, "projection-no-baseline");
		const projectId = await createProject(user);

		expect(await readActiveCatalog(user, projectId)).toBeNull();
	});

	test("projects the Baseline Snapshot in Catalog Order with provenance", async () => {
		const user = await authenticatedBackend(t, "projection-owner");
		const projectId = await createProject(user);
		const locales = await user.query(api.locales.list, { projectId });
		const enLocale = locales.find((locale) => locale.code === "en");
		if (!enLocale) throw new Error("Expected the source Locale.");
		await user.action(api.locales.bind, {
			localeId: enLocale._id,
			catalogPath: pathFor("en"),
		});
		for (const code of ["de", "es", "fr", "ru", "zh"] as const) {
			const localeId = await user.mutation(api.locales.create, {
				projectId,
				code,
			});
			await user.action(api.locales.bind, {
				localeId,
				catalogPath: pathFor(code),
			});
		}

		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "github.com/brickit-app/brickit-flutter",
			commit: "projection-baseline",
			files: (Object.keys(catalogs) as LocaleCode[]).map((code) => ({
				catalogPath: pathFor(code),
				content: catalogs[code],
			})),
		});
		const catalog = await readActiveCatalog(user, projectId);

		expect(catalog?.snapshotId).toBe(result.snapshotId);
		expect(catalog?.keys).toHaveLength(1434);
		expect(catalog?.keys.slice(0, 3).map((key) => key.id)).toEqual([
			"aboutapp_brickit",
			"about_app_disclaimer",
			"aboutapp_insta",
		]);
		const appName = catalog?.keys.find((key) => key.id === "aboutapp_brickit");
		expect(appName?.values.map((value) => value.localeCode)).toEqual([
			"en",
			"de",
			"es",
			"fr",
			"ru",
			"zh",
		]);
		expect(appName?.values[1]).toMatchObject({
			value: "Brickit",
			snapshotId: result.snapshotId,
			sourceFingerprint:
				"5d1070b4fef7ee899c0d9c79fd189e740beb9736638b4e014c350d9fc9bf9112",
		});

		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "github.com/brickit-app/brickit-flutter",
			commit: "projection-next",
			lineage: {
				baselineCommit: "projection-baseline",
				relationship: "descendant",
				mergeBase: "projection-baseline",
			},
			files: (Object.keys(catalogs) as LocaleCode[]).map((code) => ({
				catalogPath: pathFor(code),
				content:
					code === "en"
						? withCatalogValue(
								catalogs[code],
								"aboutapp_brickit",
								"Brickit Next",
							)
						: code === "de"
							? withCatalogValue(
									catalogs[code],
									"aboutapp_brickit",
									"Brickit Weiter",
								)
							: catalogs[code],
			})),
		});
		expect(await readGitChanges(user, projectId)).toMatchObject({
			snapshotId: next.snapshotId,
			previousSnapshotId: result.snapshotId,
			keys: [
				{
					id: "aboutapp_brickit",
					values: [
						{ current: { value: "Brickit Next" } },
						{ current: { value: "Brickit Weiter" } },
					],
				},
			],
		});
	});

	test("materializes a missing target entry with source metadata", async () => {
		const user = await authenticatedBackend(t, "projection-materialize");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "one",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","hello":"Hi {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
				},
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		const catalog = await readActiveCatalog(user, projectId);
		const value = catalog?.keys[0]?.values.find(
			(row) => row.localeCode === "de",
		);
		expect(value).toMatchObject({
			value: "",
			materialized: true,
			metadataCatalogPath: "en.arb",
		});
		expect(catalog?.keys[0]?.messageSignature).toEqual({
			declaredPlaceholderNames: ["name"],
			declaredPlaceholderNamesComplete: true,
			declaredPlaceholderNameCount: 1,
			argumentNames: ["name"],
			argumentNamesComplete: true,
		});
	});

	test("publishes an empty Baseline Snapshot as an empty working catalog", async () => {
		const user = await authenticatedBackend(t, "projection-empty-catalog");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "empty",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});

		expect(result.snapshotId).not.toBeNull();
		expect(await readActiveCatalog(user, projectId)).toMatchObject({
			snapshotId: result.snapshotId,
			keys: [],
		});
	});

	test("keeps existing target metadata and derives a catalog-wide Message Signature", async () => {
		const user = await authenticatedBackend(t, "projection-signature");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "one",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","hello":"Hi {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","hello":"Hallo {name} {extra}"}',
				},
			],
		});
		const catalog = await readActiveCatalog(user, projectId);
		const german = catalog?.keys[0]?.values.find(
			(value) => value.localeCode === "de",
		);

		expect(german).toMatchObject({
			value: "Hallo {name} {extra}",
			materialized: false,
			argumentNamesComplete: true,
			argumentNameCount: 2,
		});
		expect(german).not.toHaveProperty("metadataCatalogPath");
		expect(catalog?.keys[0]?.messageSignature).toEqual({
			declaredPlaceholderNames: ["name"],
			declaredPlaceholderNamesComplete: true,
			declaredPlaceholderNameCount: 1,
			argumentNames: ["name", "extra"],
			argumentNamesComplete: true,
		});
	});

	test("publishes representable Git contracts when active fact detail overflows", async () => {
		const user = await authenticatedBackend(t, "projection-fact-overflow");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const names = Array.from({ length: 129 }, (_, index) => `argument${index}`);
		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "overflow",
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({
						"@@locale": "en",
						hello: "Hello",
						"@hello": {
							placeholders: Object.fromEntries(
								names.map((name) => [name, { type: "String" }]),
							),
						},
					}),
				},
				{
					catalogPath: "de.arb",
					content: JSON.stringify({
						"@@locale": "de",
						hello: names.map((name) => `{${name}}`).join(""),
					}),
				},
			],
		});
		const catalog = await readActiveCatalog(user, projectId);

		expect(result.snapshotId).not.toBeNull();
		expect(catalog?.keys[0]?.messageSignature).toMatchObject({
			declaredPlaceholderNamesComplete: false,
			declaredPlaceholderNameCount: 129,
			argumentNamesComplete: false,
		});
		expect(
			catalog?.keys[0]?.messageSignature.declaredPlaceholderNames,
		).toHaveLength(128);
		expect(catalog?.keys[0]?.messageSignature.argumentNames).toHaveLength(128);
	});

	test("keeps a Preview isolated, then promotes it from immutable evidence", async () => {
		const user = await authenticatedBackend(t, "projection-promotion");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baselineFiles = [
			{ catalogPath: "en.arb", content: '{"@@locale":"en","hello":"Hello"}' },
			{ catalogPath: "de.arb", content: '{"@@locale":"de","hello":"Hallo"}' },
		];
		const previewFiles = [
			{ catalogPath: "en.arb", content: '{"@@locale":"en","hello":"Welcome"}' },
			{
				catalogPath: "de.arb",
				content: '{"@@locale":"de","hello":"Willkommen"}',
			},
		];
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: baselineFiles,
		});
		const preview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files: previewFiles,
		});

		expect((await readActiveCatalog(user, projectId))?.snapshotId).toBe(
			baseline.snapshotId,
		);
		await user.action(api.locales.bind, {
			localeId: targetId,
			catalogPath: "moved-de.arb",
		});
		const resumed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files: previewFiles,
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});
		const active = await readActiveCatalog(user, projectId);
		const changes = await readGitChanges(user, projectId);

		expect(resumed).toEqual(preview);
		expect(active?.snapshotId).toBe(preview.snapshotId);
		expect(
			active?.keys[0]?.values.find((value) => value.localeCode === "de"),
		).toMatchObject({
			value: "Willkommen",
			localeId: targetId,
			catalogPath: "de.arb",
		});
		expect(changes).toMatchObject({
			snapshotId: preview.snapshotId,
			previousSnapshotId: baseline.snapshotId,
			keys: [
				{
					id: "hello",
					values: [
						{
							origin: "git",
							previous: { value: "Hello", snapshotId: baseline.snapshotId },
							current: { value: "Welcome", snapshotId: preview.snapshotId },
						},
						{
							origin: "git",
							previous: { value: "Hallo", snapshotId: baseline.snapshotId },
							current: {
								value: "Willkommen",
								snapshotId: preview.snapshotId,
							},
						},
					],
				},
			],
		});
	});

	test("leaves the active catalog unchanged when a later ingest fails", async () => {
		const user = await authenticatedBackend(t, "projection-atomic");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","hello":"Hello"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","hello":"Hallo"}' },
			],
		});
		const failed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "broken",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","hello":"Broken"}',
				},
				{ catalogPath: "de.arb", content: "{" },
			],
		});

		expect(failed.snapshotId).toBeNull();
		expect((await readActiveCatalog(user, projectId))?.snapshotId).toBe(
			baseline.snapshotId,
		);
	});

	test("publishes Git-authored value changes with the Baseline projection", async () => {
		const user = await authenticatedBackend(t, "projection-git-changes");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","hello":"Hello","unchanged":"Keep"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","hello":"Hallo","unchanged":"Behalten"}',
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
					content: '{"@@locale":"en","hello":"Welcome","unchanged":"Keep"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","hello":"Willkommen","unchanged":"Behalten"}',
				},
			],
		});

		const active = await readActiveCatalog(user, projectId);
		const changes = await readGitChanges(user, projectId);

		expect(active).toMatchObject({
			snapshotId: next.snapshotId,
			previousSnapshotId: baseline.snapshotId,
			gitChangeCount: 2,
		});
		expect(
			active?.keys
				.find((key) => key.id === "hello")
				?.values.map((value) => value.value),
		).toEqual(["Welcome", "Willkommen"]);
		expect(changes).toMatchObject({
			snapshotId: next.snapshotId,
			previousSnapshotId: baseline.snapshotId,
			keys: [
				{
					id: "hello",
					values: [
						{
							origin: "git",
							previous: {
								snapshotId: baseline.snapshotId,
								value: "Hello",
							},
							current: {
								snapshotId: next.snapshotId,
								value: "Welcome",
							},
						},
						{
							origin: "git",
							previous: {
								snapshotId: baseline.snapshotId,
								value: "Hallo",
							},
							current: {
								snapshotId: next.snapshotId,
								value: "Willkommen",
							},
						},
					],
				},
			],
		});
		expect(changes?.keys.map((key) => key.id)).toEqual(["hello"]);

		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","hello":"Preview","unchanged":"Keep"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","hello":"Vorschau","unchanged":"Behalten"}',
				},
			],
		});
		expect((await readActiveCatalog(user, projectId))?.snapshotId).toBe(
			next.snapshotId,
		);
		expect(await readGitChanges(user, projectId)).toMatchObject({
			snapshotId: next.snapshotId,
			keys: [{ id: "hello" }],
		});

		const noOp = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "no-op",
			lineage: {
				baselineCommit: "next",
				relationship: "descendant",
				mergeBase: "next",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","hello":"Welcome","unchanged":"Keep"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","hello":"Willkommen","unchanged":"Behalten"}',
				},
			],
		});
		expect(await readGitChanges(user, projectId)).toMatchObject({
			snapshotId: noOp.snapshotId,
			previousSnapshotId: next.snapshotId,
			keys: [],
		});
	});

	test("requires project-view permission to read the active catalog", async () => {
		const owner = await authenticatedBackend(t, "projection-owner-only");
		const projectId = await createProject(owner);
		await bindTwoLocales(owner, projectId);
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "one",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","hello":"Hello"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","hello":"Hallo"}' },
			],
		});
		const outsider = await authenticatedBackend(t, "projection-outsider");

		await expect(
			outsider.query(api.catalogProjection.getActive, { projectId }),
		).rejects.toThrow();
		await expect(
			outsider.query(api.catalogProjection.getGitChanges, { projectId }),
		).rejects.toThrow();
	});
});
