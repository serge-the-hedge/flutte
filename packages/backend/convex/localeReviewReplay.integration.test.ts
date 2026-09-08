import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import { LOCALE_REVIEW_EVIDENCE_VERSION } from "./catalogProjection";
import { sha256Hex } from "./lib";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("Locale review preservation on existing Snapshot replay", () => {
	test("hashless recovery prefers newer proposals independently of hash order", async () => {
		const t = createBackend({ transactionLimits: true });
		const user = await authenticatedBackend(t, "proposal-order-owner");
		const projectId = await createProject(user);
		const source = (await user.query(api.locales.list, { projectId }))[0];
		if (!source) throw Error("Missing source");
		await user.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "intl_en.arb",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "intl_en.arb",
					content: JSON.stringify({ "@@locale": "en", greeting: "Hello" }),
				},
			],
		});
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "pt",
			label: "Portuguese",
			catalogPath: "intl_pt.arb",
			runtimeLocale: "pt",
		});
		const { proposalId } = await user.mutation(
			api.localeProposals.ensureForReview,
			{
				projectId,
				localeCode: "pt",
			},
		);
		// Only index selection is under test; no delivery artifact is read here.
		const newerId = await t.run(async (ctx) => {
			await ctx.db.patch(proposalId, {
				status: "ready",
				catalogContentHash: "f".repeat(64),
			});
			const older = await ctx.db.get(proposalId);
			if (!older) throw Error("Missing proposal");
			const { _id, _creationTime, ...fields } = older;
			return await ctx.db.insert("localeProposals", {
				...fields,
				catalogContentHash: "0".repeat(64),
			});
		});
		const args = {
			projectId,
			catalogPath: "intl_pt.arb",
			repository: "repo",
			commit: "delivered",
			cursor: null,
		};
		const recovery = await user.query(
			internal.localeDelivery.matchingArtifact,
			args,
		);
		expect(recovery.proposals.map((proposal) => proposal._id)).toEqual([
			newerId,
			proposalId,
		]);
		const exact = await user.query(internal.localeDelivery.matchingArtifact, {
			...args,
			contentHash: "f".repeat(64),
		});
		expect(exact.proposals.map((proposal) => proposal._id)).toEqual([
			proposalId,
		]);
	});

	test("repairs an old projection once without changing Snapshot Identity or realized bindings", async () => {
		const t = createBackend({ transactionLimits: true });
		const user = await authenticatedBackend(t, "replay-owner");
		const projectId = await createProject(user);
		const source = (await user.query(api.locales.list, { projectId }))[0];
		if (!source) throw Error("Missing source");
		await user.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "intl_en.arb",
		});
		const sourceContent = JSON.stringify({
			"@@locale": "en",
			greeting: "Hello",
			quiet: "Hidden",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [{ catalogPath: "intl_en.arb", content: sourceContent }],
		});
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "pt",
			label: "Portuguese",
			catalogPath: "intl_pt.arb",
			runtimeLocale: "pt-BR",
		});
		const { proposalId } = await user.mutation(
			api.localeProposals.ensureForReview,
			{
				projectId,
				localeCode: "pt",
			},
		);
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId,
			items: [
				{
					messageId: "greeting",
					value: "Olá",
					sourceFingerprint: await sha256Hex("Hello"),
				},
				{
					messageId: "quiet",
					value: "",
					sourceFingerprint: await sha256Hex("Hidden"),
					intentionalBlankReason: "Intentionally hidden",
				},
			],
		});
		await user.action(api.localeProposals.finalizeForReview, {
			projectId,
			proposalId,
		});
		const artifact = await user.action(api.localeProposals.artifactForReview, {
			projectId,
			proposalId,
		});
		const submission = {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant" as const,
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{
					catalogPath: "intl_pt.arb",
					content: JSON.stringify(
						JSON.parse(artifact.catalog.content),
						null,
						4,
					),
				},
			],
		};
		const delivered = await user.action(api.snapshots.ingest, submission);
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "intl_pt.arb",
		});
		const before = await readWorkspaceKeyCards(user, projectId);
		// Reconstruct the pre-preservation projection: reviewed Proposal evidence exists,
		// but the published generation has neither transferred decisions nor a completion marker.
		await t.run(async (ctx) => {
			for (const row of await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.collect())
				await ctx.db.delete(row._id);
			for (const state of await ctx.db
				.query("catalogWorkspaceDecisionStates")
				.collect())
				await ctx.db.patch(state._id, {
					decisionRecordCount: 0,
					decisionRecordByteLength: 0,
				});
			await ctx.db.patch(before.projectionId, {
				localeReviewEvidenceVersion: undefined,
			});
		});
		const replay = await user.action(api.snapshots.ingest, submission);
		expect(replay.snapshotId).toBe(delivered.snapshotId);
		const repaired = await readWorkspaceKeyCards(user, projectId);
		expect(repaired.projectionId).not.toBe(before.projectionId);
		for (const key of repaired.keys)
			expect(
				key.values.find((value) => value.localeId === localeId),
			).toMatchObject({ valueState: "settled" });
		const evidence = await t.run(async (ctx) => ({
			projection: await ctx.db.get(repaired.projectionId),
			snapshots: await ctx.db.query("sourceSnapshots").collect(),
			bindings: await ctx.db.query("localeBindingRealizations").collect(),
			decisions: await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.collect(),
		}));
		expect(evidence.projection?.localeReviewEvidenceVersion).toBe(
			LOCALE_REVIEW_EVIDENCE_VERSION,
		);
		expect(evidence.snapshots).toHaveLength(2);
		expect(evidence.bindings).toHaveLength(1);
		expect(evidence.decisions).toHaveLength(2);
		expect(evidence.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					localeProposalId: proposalId,
					kind: "intentionalBlank",
					reason: "Intentionally hidden",
					recordedBy: { kind: "user", id: "replay-owner" },
				}),
			]),
		);
		await user.action(api.snapshots.ingest, submission);
		expect((await readWorkspaceKeyCards(user, projectId)).projectionId).toBe(
			repaired.projectionId,
		);
		expect(
			await t.run((ctx) =>
				ctx.db.query("catalogWorkspaceDecisionRecords").collect(),
			),
		).toHaveLength(2);
	});
});
