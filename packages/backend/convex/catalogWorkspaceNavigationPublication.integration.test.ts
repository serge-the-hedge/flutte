import { beforeEach, describe, expect, test } from "vitest";
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
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	deriveNavigationDigest,
	MAX_NAVIGATION_STAGE_STEPS,
	navigationDigestByteLength,
} from "./catalogWorkspaceNavigation";

const ENGLISH =
	'{"@@locale":"en","greeting":"Hello {name}","farewell":"Goodbye"}';
const GERMAN_IDENTICAL =
	'{"@@locale":"de","greeting":"Hello {name}","farewell":"Tschüss"}';
const GERMAN_UPDATED =
	'{"@@locale":"de","greeting":"Hallo auch {name}","farewell":"Tschüss"}';
const PROPOSED_ENGLISH =
	'{"@@locale":"en","greeting":"Hi there {name}","farewell":"Goodbye"}';

let t: Backend;

beforeEach(() => {
	t = createBackend();
});

type CatalogFile = { catalogPath: string; content: string };

async function bindLocales(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
	bindings: readonly { code: string; catalogPath: string }[],
) {
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === bindings[0]?.code);
	if (!source) throw new Error("Expected the source Locale.");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: bindings[0].catalogPath,
	});
	const ids: Record<string, Id<"locales">> = {
		[bindings[0].code]: source._id,
	};
	for (const binding of bindings.slice(1)) {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: binding.code,
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: binding.catalogPath,
		});
		ids[binding.code] = localeId;
	}
	return ids;
}

async function ingest(
	user: AuthenticatedBackend,
	input: {
		projectId: Id<"projects">;
		commit: string;
		files: CatalogFile[];
		baselineCommit?: string;
	},
) {
	return await user.action(api.snapshots.ingest, {
		projectId: input.projectId,
		repository: "repo",
		commit: input.commit,
		...(input.baselineCommit
			? {
					lineage: {
						baselineCommit: input.baselineCommit,
						relationship: "descendant" as const,
						mergeBase: input.baselineCommit,
					},
				}
			: {}),
		files: input.files,
	});
}

type EvidenceDb = {
	db: Parameters<Parameters<typeof t.run>[0]>[0]["db"];
};

async function readNavigationState(ctx: EvidenceDb, projectId: Id<"projects">) {
	return await ctx.db
		.query("catalogWorkspaceNavigationStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

async function readNavigationStaging(
	ctx: EvidenceDb,
	projectionId: Id<"catalogProjections">,
) {
	return await ctx.db
		.query("catalogWorkspaceNavigationStaging")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.unique();
}

async function readNavigationRow(
	ctx: EvidenceDb,
	projectId: Id<"projects">,
	messageId: string,
) {
	const project = await ctx.db.get(projectId);
	const projectionId = project?.activeCatalogProjectionId;
	if (!projectionId) return null;
	return await ctx.db
		.query("catalogWorkspaceNavigationRows")
		.withIndex("by_project_and_projection_and_messageId", (q) =>
			q
				.eq("projectId", projectId)
				.eq("projectionId", projectionId)
				.eq("messageId", messageId),
		)
		.unique();
}

async function readActiveProjection(
	ctx: EvidenceDb,
	projectId: Id<"projects">,
) {
	const project = await ctx.db.get(projectId);
	const projectionId = project?.activeCatalogProjectionId;
	if (!projectionId) throw new Error("Expected an active Baseline Catalog.");
	const projection = await ctx.db.get(projectionId);
	if (!projection) throw new Error("Expected the active projection row.");
	return projection;
}

async function navigationEvidence(
	ctx: EvidenceDb,
	projectId: Id<"projects">,
	messageId: string,
) {
	const project = await ctx.db.get(projectId);
	const projectionId = project?.activeCatalogProjectionId;
	if (!projectionId) {
		throw new Error("Expected an active Baseline Catalog.");
	}
	const rows = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_messageId", (q) =>
			q.eq("projectionId", projectionId).eq("messageId", messageId),
		)
		.collect();
	const heads = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.collect();
	const decisions = await ctx.db
		.query("catalogWorkspaceDecisionRecords")
		.withIndex("by_value_identity", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.collect();
	const proposalHead = await ctx.db
		.query("catalogWorkspaceSourceProposalHeads")
		.withIndex("by_project_and_messageId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.unique();
	const digest = await deriveNavigationDigest({
		projectId,
		projectionId,
		rows,
		heads,
		decisions,
		sourceProposalHead: proposalHead,
		sourceProposalResolution: null,
	});
	return { projectionId, digest };
}

function stripSystemFields(row: Doc<"catalogWorkspaceNavigationRows">) {
	return {
		projectId: row.projectId,
		projectionId: row.projectionId,
		messageId: row.messageId,
		catalogIndex: row.catalogIndex,
		searchCorpus: row.searchCorpus,
		pendingSourceProposal: row.pendingSourceProposal,
		introductionReviewPending: row.introductionReviewPending ?? 0,
		source: row.source,
		targets: row.targets.map((target) => ({
			...target,
			firstReviewPending: target.firstReviewPending ?? false,
		})),
	};
}

describe("Catalog Navigation Index publication", () => {
	test("publishes a complete generation and reclaims the previous one", async () => {
		const user = await authenticatedBackend(t, "nav-publish");
		const projectId = await createProject(user);
		const ids = await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_IDENTICAL },
			],
		});
		const first = await t.run(async (ctx) => ({
			state: await readNavigationState(ctx, projectId),
			projection: await readActiveProjection(ctx, projectId),
		}));
		expect(first.state).toMatchObject({ rowCount: 2, status: "ready" });
		expect(first.state?.projectionId).toBe(first.projection._id);
		const firstStaging = await t.run(
			async (ctx) => await readNavigationStaging(ctx, first.projection._id),
		);
		expect(firstStaging).toBeNull();

		await ingest(user, {
			projectId,
			commit: "second",
			baselineCommit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_UPDATED },
			],
		});
		const second = await t.run(async (ctx) => ({
			state: await readNavigationState(ctx, projectId),
			projection: await readActiveProjection(ctx, projectId),
			rows: await ctx.db.query("catalogWorkspaceNavigationRows").collect(),
		}));
		expect(second.projection._id).not.toBe(first.projection._id);
		expect(second.state?.projectionId).toBe(second.projection._id);
		expect(second.state).toMatchObject({ rowCount: 2, status: "ready" });
		// The previous generation's rows linger as garbage until the reset
		// worker reclaims them, and the active generation stays complete.
		expect(
			second.rows.some((row) => row.projectionId === first.projection._id),
		).toBe(true);
		expect(
			second.rows.filter((row) => row.projectionId === second.projection._id)
				.length,
		).toBe(2);

		// Publication scheduled the reset worker for the previous generation;
		// drive it directly for a deterministic reclaim.
		await t.mutation(internal.catalogWorkspaceNavigation.resetNavigationIndex, {
			projectId,
			projectionId: first.projection._id,
		});
		const after = await t.run(async (ctx) => ({
			rows: await ctx.db.query("catalogWorkspaceNavigationRows").collect(),
		}));
		expect(after.rows.length).toBe(2);
		expect(
			after.rows.every((row) => row.projectionId === second.projection._id),
		).toBe(true);
		const changed = after.rows.find((row) => row.messageId === "greeting");
		if (!changed) throw new Error("Expected the greeting digest.");
		expect(changed.searchCorpus).toContain("hallo auch {name}");
		expect(changed.targets[0]).toMatchObject({ localeId: ids.de });
	}, 60_000);

	test("resolves an open Source Proposal when the Baseline lands it", async () => {
		const user = await authenticatedBackend(t, "nav-landing");
		const projectId = await createProject(user);
		const ids = await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_IDENTICAL },
			],
		});
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const source = workspace.keys
			.find((entry) => entry.id === "greeting")
			?.values.find((value) => value.isSource);
		if (!source || source.localeId !== ids.en) {
			throw new Error("Expected the English source value.");
		}
		const tokens = source as typeof source & {
			gitValueFingerprint: string;
			gitValueRevision: number;
			workspaceRevision: number;
		};
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: ids.en,
			intent: { kind: "save", value: "Hi there {name}" },
			expectedGitValueFingerprint: tokens.gitValueFingerprint,
			expectedGitValueRevision: tokens.gitValueRevision,
			expectedWorkspaceRevision: tokens.workspaceRevision,
		});
		const pending = await t.run(
			async (ctx) => await readNavigationRow(ctx, projectId, "greeting"),
		);
		expect(pending?.pendingSourceProposal).toBe(true);
		expect(pending?.searchCorpus).toContain("hi there {name}");

		await ingest(user, {
			projectId,
			commit: "landing",
			baselineCommit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: PROPOSED_ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_IDENTICAL },
			],
		});
		const landed = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const { digest } = await navigationEvidence(ctx, projectId, "greeting");
			return { row, fresh: digest };
		});
		if (!landed.row) throw new Error("Expected the greeting digest.");
		expect(stripSystemFields(landed.row)).toEqual(landed.fresh);
		expect(landed.row.pendingSourceProposal).toBe(false);
		expect(landed.row.searchCorpus).toContain("hi there {name}");
	}, 60_000);

	test("retires ordinary candidates from the summary as they confirm", async () => {
		const user = await authenticatedBackend(t, "nav-ordinary");
		const projectId = await createProject(user);
		await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_IDENTICAL },
			],
		});
		const projection = await t.run(
			async (ctx) => await readActiveProjection(ctx, projectId),
		);
		const run = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: projection._id,
				policy: "ordinary-v1",
			},
		);
		const receipt = await t.mutation(
			internal.ordinaryImportRuns.runOrdinaryImportStep,
			{ runId: run.runId },
		);
		expect(receipt?.confirmed).toBe(1);
		// The source-identical greeting is never eligible; the ordinary run
		// confirms the plain untouched "farewell" import.
		const row = await t.run(
			async (ctx) => await readNavigationRow(ctx, projectId, "farewell"),
		);
		if (!row) throw new Error("Expected the farewell digest.");
		expect(row.targets[0]).toMatchObject({
			valueState: "settled",
			touched: false,
			confirmedGitContent: true,
		});
		const greeting = await t.run(
			async (ctx) => await readNavigationRow(ctx, projectId, "greeting"),
		);
		// The source-identical greeting stays an untouched import: only an
		// exact-content confirmation can settle it.
		expect(greeting?.targets[0]).toMatchObject({
			valueState: "unconfirmedImport",
			touched: false,
		});
	}, 60_000);

	test("backfills a legacy generation and verifies its envelope", async () => {
		const user = await authenticatedBackend(t, "nav-backfill");
		const projectId = await createProject(user);
		await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_UPDATED },
			],
		});
		await t.run(async (ctx) => {
			// Simulate a generation that predates the Navigation Index.
			for (const row of await ctx.db
				.query("catalogWorkspaceNavigationRows")
				.collect()) {
				await ctx.db.delete(row._id);
			}
			const state = await readNavigationState(ctx, projectId);
			if (state) await ctx.db.delete(state._id);
		});
		const dryRun = await t.query(
			internal.catalogWorkspaceNavigation.describeNavigationIndexBackfill,
			{ projectId },
		);
		expect(dryRun).toMatchObject({ status: "missing", rowCount: 0 });
		if (!dryRun) throw new Error("Expected the active Baseline projection.");
		await expect(
			user.mutation(api.ordinaryImportRuns.startOrdinaryImportRun, {
				projectId,
				expectedProjectionId: dryRun.projectionId,
				policy: "ordinary-v1" as const,
			}),
		).rejects.toThrow("Navigation Index backfill completes");
		const started = await user.mutation(
			api.catalogWorkspaceNavigation.startNavigationIndexBackfill,
			{ projectId },
		);
		expect(started).toMatchObject({
			status: "staging",
			forceRebuild: true,
			stepPending: true,
			ordinaryImportCounts: {
				total: 0,
				eligible: 0,
				empty: 0,
				sourceIdentical: 0,
				repeated: 0,
				modified: 0,
				stale: 0,
				alreadyConfirmed: 0,
				pendingSourceProposal: 0,
				introduced: 0,
			},
		});
		let phase = "clearing";
		for (
			let step = 0;
			step < MAX_NAVIGATION_STAGE_STEPS && phase !== "ready";
			step += 1
		) {
			const result = await t.mutation(
				internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
				{ projectId },
			);
			phase = result.phase;
		}
		expect(phase).toBe("ready");
		const final = await t.run(async (ctx) => ({
			state: await readNavigationState(ctx, projectId),
			rows: await ctx.db.query("catalogWorkspaceNavigationRows").collect(),
		}));
		expect(final.state).toMatchObject({ rowCount: 2, status: "ready" });
		expect(final.state?.ordinaryImportCounts).toEqual({
			total: 2,
			eligible: 2,
			empty: 0,
			sourceIdentical: 0,
			repeated: 0,
			modified: 0,
			stale: 0,
			alreadyConfirmed: 0,
			pendingSourceProposal: 0,
			introduced: 0,
		});
		expect(final.rows.length).toBe(2);
		const status = await user.query(
			api.catalogWorkspaceNavigation.navigationIndexBackfillStatus,
			{ projectId },
		);
		expect(status?.ordinaryImportCounts).toEqual(
			final.state?.ordinaryImportCounts,
		);
		expect(final.state?.byteLength).toBe(
			final.rows.reduce(
				(total, row) =>
					total + navigationDigestByteLength(stripSystemFields(row)),
				0,
			),
		);
	}, 60_000);

	test("verification fails closed and self-heals when a row drifts", async () => {
		const user = await authenticatedBackend(t, "nav-drift");
		const projectId = await createProject(user);
		await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_UPDATED },
			],
		});
		await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			if (!row) throw new Error("Expected the greeting digest.");
			await ctx.db.patch(row._id, { searchCorpus: ["drifted", "corpus"] });
		});
		const result = await t.mutation(
			internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
			{ projectId },
		);
		expect(result.phase).toBe("drift");
		const drifted = await t.run(async (ctx) => ({
			state: await readNavigationState(ctx, projectId),
		}));
		// Fail closed by clearing the envelope before the scheduled rebuild; the
		// stored rows are still reclaimed by the force-rebuild step.
		expect(drifted.state).toMatchObject({ rowCount: 0, status: "staging" });

		// The next run rebuilds the generation from scratch and heals the drift.
		let phase = "clearing";
		for (
			let step = 0;
			step < MAX_NAVIGATION_STAGE_STEPS && phase !== "ready";
			step += 1
		) {
			const healed = await t.mutation(
				internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
				{ projectId },
			);
			phase = healed.phase;
		}
		expect(phase).toBe("ready");
		const healed = await t.run(async (ctx) => ({
			state: await readNavigationState(ctx, projectId),
			rows: await ctx.db.query("catalogWorkspaceNavigationRows").collect(),
		}));
		expect(healed.state).toMatchObject({ rowCount: 2, status: "ready" });
		expect(healed.rows.length).toBe(2);
	}, 60_000);

	test("persists a backfill failure until an explicit retry", async () => {
		const user = await authenticatedBackend(t, "nav-backfill-failure");
		const projectId = await createProject(user);
		await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "en.arb" },
			{ code: "de", catalogPath: "de.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN_UPDATED },
			],
		});
		await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			const projectionId = project?.activeCatalogProjectionId;
			if (!projectionId) {
				throw new Error("Expected the active Catalog Projection.");
			}
			const rows = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId", (q) =>
					q.eq("projectionId", projectionId).eq("messageId", "greeting"),
				)
				.collect();
			const target = rows.find((row) => !row.isSource);
			if (!target) throw new Error("Expected the greeting target row.");
			await ctx.db.patch(target._id, {
				valueFingerprint: undefined,
				repeatedGitContent: undefined,
				repeatedGitContentVersion: undefined,
			});
		});

		const started = await user.mutation(
			api.catalogWorkspaceNavigation.startNavigationIndexBackfill,
			{ projectId },
		);
		expect(started.status).toBe("staging");
		const failed = await t.mutation(
			internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
			{ projectId },
		);
		expect(failed.phase).toBe("failed");
		const failure = await user.query(
			api.catalogWorkspaceNavigation.navigationIndexBackfillStatus,
			{ projectId },
		);
		expect(failure).toMatchObject({
			status: "failed",
			stepPending: false,
			failure: { code: "INTEGRITY" },
		});

		const retried = await user.mutation(
			api.catalogWorkspaceNavigation.startNavigationIndexBackfill,
			{ projectId },
		);
		expect(retried).toMatchObject({
			status: "staging",
			stepPending: true,
			failure: null,
		});
	}, 60_000);

	test("matches a fresh derivation for every key of a Brickit-sized catalog", async () => {
		const user = await authenticatedBackend(t, "nav-parity");
		const projectId = await createProject(user);
		await bindLocales(user, projectId, [
			{ code: "en", catalogPath: "intl_en.arb" },
			{ code: "de", catalogPath: "intl_de.arb" },
			{ code: "es", catalogPath: "intl_es.arb" },
			{ code: "fr", catalogPath: "intl_fr.arb" },
			{ code: "ru", catalogPath: "intl_ru.arb" },
			{ code: "zh", catalogPath: "intl_zh.arb" },
		]);
		await ingest(user, {
			projectId,
			commit: "brickit",
			files: [
				{ catalogPath: "intl_en.arb", content: en },
				{ catalogPath: "intl_de.arb", content: de },
				{ catalogPath: "intl_es.arb", content: es },
				{ catalogPath: "intl_fr.arb", content: fr },
				{ catalogPath: "intl_ru.arb", content: ru },
				{ catalogPath: "intl_zh.arb", content: zh },
			],
		});
		const { projectionId, expectedKeyCount } = await t.run(async (ctx) => {
			const projection = await readActiveProjection(ctx, projectId);
			return {
				projectionId: projection._id,
				expectedKeyCount: projection.expectedKeyCount,
			};
		});
		const state = await t.run(
			async (ctx) => await readNavigationState(ctx, projectId),
		);
		expect(state).toMatchObject({
			rowCount: expectedKeyCount,
			status: "ready",
		});
		expect(state?.byteLength).toBeGreaterThan(0);

		// Chunked field-wise parity between the stored index and the pure
		// projector over live canonical evidence.
		let after = -1;
		let compared = 0;
		for (;;) {
			const page = await t.run(async (ctx) => {
				const rows = await ctx.db
					.query("catalogWorkspaceNavigationRows")
					.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
						q
							.eq("projectId", projectId)
							.eq("projectionId", projectionId)
							.gt("catalogIndex", after),
					)
					.take(60);
				let sliceEnd = rows.length;
				if (rows.length === 60) {
					const lastId = rows[rows.length - 1]?.messageId;
					while (sliceEnd > 0 && rows[sliceEnd - 1]?.messageId === lastId) {
						sliceEnd -= 1;
					}
				}
				const usable = rows.slice(0, sliceEnd);
				const seen = new Set<string>();
				const checks: Array<{
					messageId: string;
					stored: ReturnType<typeof stripSystemFields>;
					fresh: unknown;
				}> = [];
				for (const row of usable) {
					if (seen.has(row.messageId)) continue;
					seen.add(row.messageId);
					const { digest } = await navigationEvidence(
						ctx,
						projectId,
						row.messageId,
					);
					checks.push({
						messageId: row.messageId,
						stored: stripSystemFields(row),
						fresh: digest,
					});
				}
				const last = usable[usable.length - 1]?.catalogIndex ?? after;
				return { checks, last, exhausted: rows.length < 60 };
			});
			for (const check of page.checks) {
				expect(check.stored).toEqual(check.fresh);
				compared += 1;
			}
			if (page.exhausted) break;
			after = page.last;
		}
		expect(compared).toBe(expectedKeyCount);
	}, 120_000);
});
