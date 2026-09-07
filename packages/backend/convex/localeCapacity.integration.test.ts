import { afterEach, expect, test, vi } from "vitest";

import en from "../fixtures/arb/intl_en.arb?raw";
import fr from "../fixtures/arb/intl_fr.arb?raw";
import {
	type AuthenticatedBackend,
	authenticatedBackend,
	createBackend,
	createProject,
	readAllCatalogPages,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	archiveReconciliation,
	restoreByteIdenticalArchivedTargets,
} from "./archiveReconciliation";
import { MAX_WORKING_CATALOG_ROWS } from "./catalogProjection";
import { MAX_CATALOG_WORKSPACE_NAVIGATION_RETURN_BYTES } from "./catalogWorkspaceNavigation";

const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
const MIB = 1024 * 1024;
const realSetTimeout = globalThis.setTimeout;
const codes = ["en", "de", "es", "fr", "ru", "zh", "pt", "it", "ja", "ko"];
const addedMessageId = "capacityIntroducedMessage";

afterEach(() => vi.useRealTimers());

test("supports ten full catalogs within stored and public read budgets", async () => {
	await exerciseCapacity(false);
}, 180_000);

test.skipIf(process.env.BLABLA_LOCALE_CAPACITY_PROOF !== "1")(
	"proves full ten-Locale introduction, review, archive, restoration, source change, and release",
	async () => {
		await exerciseCapacity(true);
	},
	30 * 60_000,
);

async function exerciseCapacity(extended: boolean) {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "capacity-owner", 60 * 60_000);
	const projectId = await createProject(owner);
	const [source] = await owner.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing Source");
	for (const code of codes) {
		const localeId =
			code === "en"
				? source._id
				: await owner.mutation(api.locales.create, { projectId, code });
		await owner.action(api.locales.bind, {
			localeId,
			catalogPath: `lib/l10n/intl_${code}.arb`,
		});
	}
	// Reuse real message/metadata sizes; target wording here is capacity evidence,
	// not a translation-quality fixture or an ordinary-confirmation candidate.
	const documents = codes.map((code) => ({
		code,
		document: {
			...JSON.parse(code === "en" ? en : fr),
			"@@locale": code,
		} as Record<string, unknown>,
	}));
	const files = () =>
		documents.map(({ code, document }) => ({
			catalogPath: `lib/l10n/intl_${code}.arb`,
			content: JSON.stringify(document),
		}));
	let previousCommit: string | undefined;
	async function ingest(commit: string) {
		const startedAt = performance.now();
		const result = await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			files: files(),
			...(previousCommit
				? {
						lineage: {
							baselineCommit: previousCommit,
							relationship: "descendant" as const,
							mergeBase: previousCommit,
						},
					}
				: {}),
		});
		const diagnostics = result.snapshotId
			? []
			: await t.run(async (ctx) =>
					ctx.db
						.query("snapshotIngestionDiagnostics")
						.withIndex("by_run_and_generation", (q) =>
							q.eq("runId", result.runId),
						)
						.collect(),
				);
		expect(result.snapshotId, JSON.stringify(diagnostics)).not.toBeNull();
		previousCommit = commit;
		// Yield the fake backend's microtask-heavy ingestion so progress and the
		// test runner's real timeout can be delivered between complete commits.
		await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
		if (extended)
			console.info(
				`${commit}: ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
			);
		return result;
	}
	async function navigation() {
		const overview = await owner.query(api.catalogBrowse.overview, {
			projectId,
		});
		if (overview.kind !== "ready") throw new Error("Expected ready Navigation");
		let page = await owner.query(api.catalogBrowse.page, {
			projectId,
			projectionId: overview.projectionId,
		});
		const keys = [...page.keys];
		while (page.nextAfter !== null) {
			page = await owner.query(api.catalogBrowse.page, {
				projectId,
				projectionId: overview.projectionId,
				after: page.nextAfter,
			});
			keys.push(...page.keys);
		}
		const result = { ...overview, keys };
		expect(bytes(result)).toBeLessThan(
			MAX_CATALOG_WORKSPACE_NAVIGATION_RETURN_BYTES,
		);
		return result;
	}
	async function addedCard() {
		const nav = await navigation();
		const [card] = await owner.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: nav.projectionId,
			messageIds: [addedMessageId],
		});
		if (!card) throw new Error("Missing introduced message card");
		return card;
	}
	async function commitTarget(
		localeCode: string,
		intent: { kind: "confirm" } | { kind: "save"; value: string } = {
			kind: "confirm",
		},
	) {
		const target = (await addedCard()).values.find(
			(value) => value.localeCode === localeCode,
		);
		if (
			!target?.gitValueFingerprint ||
			target.gitValueRevision === undefined ||
			target.workspaceRevision === undefined ||
			!target.expectedSourceFingerprint
		) {
			throw new Error("Expected current target edit tokens");
		}
		await owner.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: addedMessageId,
			localeId: target.localeId,
			intent,
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
	}

	await ingest("capacity-baseline");
	const baselineNav = await navigation();
	expect(baselineNav.keys).toHaveLength(1434);
	const catalog = await readAllCatalogPages(owner, projectId);
	expect(catalog?.keys[0]?.values).toHaveLength(10);
	expect(bytes(catalog)).toBeLessThan(16 * MIB);
	const projectionMeasurements = await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection", (q) =>
				q.eq("projectionId", baselineNav.projectionId),
			)
			.collect();
		const projection = await ctx.db.get(baselineNav.projectionId);
		if (!projection?.snapshotId)
			throw new Error("Missing published projection");
		const messages = rows.map(
			({ _id, _creationTime, projectionId, ...message }) => message,
		);
		const fullArchive = archiveReconciliation(
			messages,
			[],
			[],
			projection.snapshotId,
			[],
		);
		const fullRestoration = restoreByteIdenticalArchivedTargets(
			messages.map((message) =>
				message.isSource
					? message
					: { ...message, value: "", materialized: true },
			),
			{ values: fullArchive.values },
		);
		return {
			fullArchiveByteLength: [
				...fullArchive.keys,
				...fullArchive.locales,
				...fullArchive.values,
			].reduce((total, value) => total + bytes(value), 0),
			fullRestorationByteLength: fullRestoration.reduce(
				(total, value) => total + bytes(value),
				0,
			),
			count: rows.length,
			byteLength: rows.reduce((total, row) => total + bytes(row), 0),
		};
	});
	const navigationByteLength = await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", projectId)
					.eq("projectionId", baselineNav.projectionId),
			)
			.collect();
		return rows.reduce((total, row) => total + bytes(row), 0);
	});
	const stored = { ...projectionMeasurements, navigationByteLength };
	console.info(JSON.stringify({ capacityBaseline: stored }));

	expect(stored.count).toBe(1434 * 10);
	expect(stored.count).toBeLessThan(MAX_WORKING_CATALOG_ROWS);
	// These include stored IDs, timestamps, and projection references, which the
	// authored payload envelope intentionally excludes. Reserve 1 MiB for other
	// documents read by the same public query.
	expect(stored.byteLength).toBeLessThan(15 * MIB);
	expect(stored.navigationByteLength).toBeLessThan(15 * MIB);
	expect(stored.fullArchiveByteLength, JSON.stringify(stored)).toBeLessThan(
		12 * MIB,
	);
	expect(stored.fullRestorationByteLength, JSON.stringify(stored)).toBeLessThan(
		12 * MIB,
	);
	if (!extended) return;

	for (const { code, document } of documents)
		document[addedMessageId] =
			code === "en" ? "A new message" : `Reviewed example ${code}`;
	await ingest("capacity-introduction");
	expect((await navigation()).keys).toHaveLength(1435);
	await commitTarget("de");
	expect(
		(await addedCard()).values.find((value) => value.localeCode === "de"),
	).toMatchObject({ valueState: "settled" });

	for (const { document } of documents) delete document[addedMessageId];
	await ingest("capacity-archive");
	const archive = await readArchives(owner, projectId);
	expect(archive?.keys).toHaveLength(1);
	expect(archive?.keys[0]?.values).toHaveLength(10);
	expect(bytes(archive)).toBeLessThan(16 * MIB);

	const sourceDocument = documents.find(({ code }) => code === "en")?.document;
	if (!sourceDocument) throw new Error("Missing Source document");
	sourceDocument[addedMessageId] = "A new message";
	await ingest("capacity-restoration");
	const restorations = await readRestorations(owner, projectId);
	expect(restorations?.keys[0]?.values).toHaveLength(9);
	expect(
		(await addedCard()).values.find((value) => value.localeCode === "de"),
	).toMatchObject({ value: "Reviewed example de", valueState: "settled" });

	sourceDocument[addedMessageId] = "A completely different message";
	await ingest("capacity-source-change");
	expect(
		(await addedCard()).values.find((value) => value.localeCode === "de"),
	).toMatchObject({ valueState: "stale", sourceChangeKind: "semantic" });
	for (const code of codes.filter((code) => code !== "en"))
		await commitTarget(code);
	expect(
		(await addedCard()).values
			.filter((value) => !value.isSource)
			.every(
				(value) => "valueState" in value && value.valueState === "settled",
			),
	).toBe(true);

	// Automatic restorations travel separately from a Release Bundle. Save a
	// reviewed workspace edit so this proof exercises an actual release delta.
	await commitTarget("ja", { kind: "save", value: "Updated Japanese example" });
	await commitTarget("ja");

	const started = await owner.mutation(api.releaseRecords.prepare, {
		projectId,
	});
	let record = started;
	for (let step = 0; record.status === "preparing" && step < 128; step++) {
		const next = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		if (!next) throw new Error("Missing Release Record");
		record = next;
	}
	expect(record).toMatchObject({ status: "ready", posture: "ready" });
	const build = await owner.mutation(api.releaseBundles.build, {
		recordId: record.recordId,
	});
	await t.action(internal.releaseBundles.buildArtifact, { runId: build.runId });
	expect(
		await owner.query(api.releaseBundles.forRecord, {
			recordId: record.recordId,
		}),
	).toMatchObject({ status: "ready", changeKeyCount: 1 });

	for (const { code, document } of documents) {
		for (const key of Object.keys(document)) delete document[key];
		document["@@locale"] = code;
	}
	await ingest("capacity-full-archive");
	const fullArchive = await readArchives(owner, projectId);
	expect(fullArchive?.keys).toHaveLength(1435);
	expect(fullArchive?.keys.every((key) => key.values.length === 10)).toBe(true);
	expect(bytes(fullArchive)).toBeLessThan(16 * MIB);
	const archiveNavigation = await navigation();
	const storedArchiveBytes = await t.run(async (ctx) => {
		const [keys, values, locales] = await Promise.all([
			ctx.db
				.query("catalogProjectionArchiveKeys")
				.withIndex("by_projection", (q) =>
					q.eq("projectionId", archiveNavigation.projectionId),
				)
				.collect(),
			ctx.db
				.query("catalogProjectionArchiveValues")
				.withIndex("by_projection", (q) =>
					q.eq("projectionId", archiveNavigation.projectionId),
				)
				.collect(),
			ctx.db
				.query("catalogProjectionArchiveLocales")
				.withIndex("by_projection", (q) =>
					q.eq("projectionId", archiveNavigation.projectionId),
				)
				.collect(),
		]);
		return [...keys, ...values, ...locales].reduce(
			(total, value) => total + bytes(value),
			0,
		);
	});
	expect(storedArchiveBytes).toBeLessThan(15 * MIB);

	Object.assign(sourceDocument, JSON.parse(en), {
		[addedMessageId]: "A completely different message",
	});
	await ingest("capacity-full-restoration");
	const restoredNavigation = await navigation();
	expect(restoredNavigation.keys).toHaveLength(1435);
	const fullRestorations = await readRestorations(owner, projectId);
	expect(fullRestorations?.keys).toHaveLength(1435);
	expect(fullRestorations?.keys.every((key) => key.values.length === 9)).toBe(
		true,
	);
	expect(bytes(fullRestorations)).toBeLessThan(16 * MIB);
	const restoredStoredBytes = await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection", (q) =>
				q.eq("projectionId", restoredNavigation.projectionId),
			)
			.collect();
		return rows.reduce((total, value) => total + bytes(value), 0);
	});
	expect(restoredStoredBytes).toBeLessThan(15 * MIB);
	expect(
		(await addedCard()).values.find((value) => value.localeCode === "de"),
	).toMatchObject({ valueState: "settled" });
	console.info(
		JSON.stringify({
			baseline: stored,
			storedArchiveBytes,
			restoredStoredBytes,
		}),
	);
}

async function readArchives(
	owner: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const first = await owner.query(api.archiveReconciliation.getActive, {
		projectId,
	});
	if (!first) return null;
	const keys = new Map<string, (typeof first.keys)[number]>();
	let page = first;
	for (;;) {
		expect(bytes(page)).toBeLessThan(2 * MIB);
		for (const key of page.keys) {
			const previous = keys.get(key.id);
			const values = new Map(
				previous?.values.map((value) => [value.localeId, value]),
			);
			for (const value of key.values) values.set(value.localeId, value);
			keys.set(key.id, { ...key, values: [...values.values()] });
		}
		if (page.isDone) break;
		const next = await owner.query(api.archiveReconciliation.getActive, {
			projectId,
			projectionId: first.projectionId,
			cursor: page.continueCursor,
		});
		if (!next) throw new Error("Pinned catalog transition disappeared");
		page = next;
	}
	return { ...first, keys: [...keys.values()] };
}

async function readRestorations(
	owner: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const first = await owner.query(api.catalogProjection.getRestorations, {
		projectId,
	});
	if (!first) return null;
	const keys = new Map<string, (typeof first.keys)[number]>();
	let page = first;
	for (;;) {
		expect(bytes(page)).toBeLessThan(2 * MIB);
		for (const key of page.keys) {
			const previous = keys.get(key.id);
			const values = new Map(
				previous?.values.map((value) => [value.localeId, value]),
			);
			for (const value of key.values) values.set(value.localeId, value);
			keys.set(key.id, { ...key, values: [...values.values()] });
		}
		if (page.isDone) break;
		const next = await owner.query(api.catalogProjection.getRestorations, {
			projectId,
			projectionId: first.projectionId,
			cursor: page.continueCursor,
		});
		if (!next) throw new Error("Pinned catalog transition disappeared");
		page = next;
	}
	return { ...first, keys: [...keys.values()] };
}
