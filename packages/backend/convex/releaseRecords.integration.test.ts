import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

let t: Backend;

beforeEach(() => {
	vi.useFakeTimers();
	t = createBackend();
});

afterEach(() => vi.useRealTimers());

async function repositoryRequest(
	token: string,
	path: string,
	init: RequestInit = {},
) {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("X-Blabla-CLI-Protocol", "1");
	if (init.body !== undefined) headers.set("Content-Type", "application/json");
	return await t.fetch(path, { ...init, headers });
}

async function createCatalog(
	user: Awaited<ReturnType<typeof authenticatedBackend>>,
	slug = "primary-project",
) {
	const projectId = await createProject(user, { slug });
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the Source Locale.");
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
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "en.arb",
				content: '{"@@locale":"en","greeting":"Hello"}',
			},
			{
				catalogPath: "de.arb",
				content: '{"@@locale":"de","greeting":"Hallo"}',
			},
		],
	});
	return { projectId, targetId };
}

async function createThreeLocaleCatalog(
	user: Awaited<ReturnType<typeof authenticatedBackend>>,
	germanValue: string | null,
) {
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the Source Locale.");
	const targetIds = await Promise.all(
		["de", "fr"].map((code) =>
			user.mutation(api.locales.create, { projectId, code }),
		),
	);
	const [germanId, frenchId] = targetIds;
	if (!germanId || !frenchId) throw new Error("Expected target Locales.");
	await Promise.all([
		user.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "en.arb",
		}),
		user.action(api.locales.bind, {
			localeId: germanId,
			catalogPath: "de.arb",
		}),
		user.action(api.locales.bind, {
			localeId: frenchId,
			catalogPath: "fr.arb",
		}),
	]);
	const germanEntry =
		germanValue === null ? "" : `,"greeting":${JSON.stringify(germanValue)}`;
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "en.arb",
				content:
					'{"@@locale":"en","greeting":"Hello {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			},
			{
				catalogPath: "de.arb",
				content: `{"@@locale":"de"${germanEntry}}`,
			},
			{
				catalogPath: "fr.arb",
				content: '{"@@locale":"fr","greeting":"Bonjour {name}"}',
			},
		],
	});
	return { projectId, germanId, frenchId };
}

async function targetTokens(
	user: Awaited<ReturnType<typeof authenticatedBackend>>,
	projectId: Id<"projects">,
	targetId: Id<"locales">,
) {
	const workspace = await readWorkspaceKeyCards(user, projectId);
	const target = workspace.keys[0]?.values.find(
		(value) => !value.isSource && value.localeId === targetId,
	);
	if (!target) throw new Error("Expected the target value.");
	return target as typeof target & {
		gitValueFingerprint: string;
		gitValueRevision: number;
		workspaceRevision: number;
		expectedSourceFingerprint: string;
	};
}

async function save(
	user: Awaited<ReturnType<typeof authenticatedBackend>>,
	projectId: Id<"projects">,
	targetId: Id<"locales">,
	value: string,
) {
	const target = await targetTokens(user, projectId, targetId);
	await user.mutation(api.catalogWorkspace.commit, {
		projectId,
		messageId: "greeting",
		localeId: targetId,
		intent: { kind: "save", value },
		expectedGitValueFingerprint: target.gitValueFingerprint,
		expectedGitValueRevision: target.gitValueRevision,
		expectedWorkspaceRevision: target.workspaceRevision,
		expectedSourceFingerprint: target.expectedSourceFingerprint,
	});
}

async function prepareAndFinish(
	user: Awaited<ReturnType<typeof authenticatedBackend>>,
	projectId: Id<"projects">,
) {
	const started = await user.mutation(api.releaseRecords.prepare, {
		projectId,
	});
	let result = started;
	for (let step = 0; result.status === "preparing" && step < 10; step++) {
		const next = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		if (!next)
			throw new Error("Expected the Release Record to remain readable.");
		result = next;
	}
	if (result.status === "preparing") {
		throw new Error("Release Record did not reach a terminal state.");
	}
	return result;
}

describe("Release Records", () => {
	test("offers a ready new-Locale artifact for the same Release Snapshot", async () => {
		const user = await authenticatedBackend(t, "combined-release-delivery");
		const { projectId } = await createCatalog(
			user,
			"combined-release-delivery",
		);
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "pt",
			label: "Portuguese",
			catalogPath: "intl_pt.arb",
			runtimeLocale: "pt-BR",
		});
		const { proposalId } = await user.mutation(
			api.localeProposals.ensureForReview,
			{ projectId, localeCode: "pt" },
		);
		const proposal = await user.query(api.localeProposals.getForReview, {
			proposalId,
			limit: 16,
		});
		const message = proposal?.messages[0];
		if (!message) throw new Error("Expected the Portuguese source message.");
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId,
			items: [
				{
					messageId: message.messageId,
					value: "Olá",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
		});
		await user.mutation(api.localeProposals.reviewStagedValue, {
			projectId,
			proposalId,
			messageId: message.messageId,
			decision: { kind: "accept" },
		});
		const record = await prepareAndFinish(user, projectId);
		await expect(
			user.query(api.releaseBundles.readyLocaleProposalForRecord, {
				recordId: record.recordId,
			}),
		).resolves.toBeNull();

		await user.action(api.localeProposals.finalizeForReview, {
			projectId,
			proposalId,
		});

		await expect(
			user.query(api.releaseBundles.readyLocaleProposalForRecord, {
				recordId: record.recordId,
			}),
		).resolves.toEqual({
			proposalId,
			localeCode: "pt",
			runtimeLocale: "pt-BR",
			valueCount: 1,
		});
	});

	test("builds a Ready record and applies its server-authored delta to a delivery tree", async () => {
		const user = await authenticatedBackend(t, "release-bundle");
		const { projectId, targetId } = await createCatalog(user);
		await save(user, projectId, targetId, "Guten Tag");
		const record = await prepareAndFinish(user, projectId);
		expect(record).toMatchObject({ status: "ready", posture: "ready" });

		const started = await user.mutation(api.releaseBundles.build, {
			recordId: record.recordId,
		});
		expect(started.status).toBe("building");
		await t.action(internal.releaseBundles.buildArtifact, {
			runId: started.runId,
		});
		expect(
			(
				await user.query(api.releaseBundles.forRecord, {
					recordId: record.recordId,
				})
			)?.failure,
		).toBeNull();
		await expect(
			user.query(api.releaseBundles.forRecord, {
				recordId: record.recordId,
			}),
		).resolves.toMatchObject({
			status: "ready",
			changeKeyCount: 1,
		});

		const token = await user.mutation(api.apiTokens.create, {
			projectId,
			name: "release adapter",
			scopes: ["export"],
		});
		const summary = await repositoryRequest(
			token.token,
			`/api/repository-adapter/v1/releases/${record.recordId}`,
		);
		expect(summary.status).toBe(200);
		expect(await summary.json()).toMatchObject({
			releaseRecord: { id: record.recordId, baselineCommit: "baseline" },
			changeKeyCount: 1,
		});

		const delivery = await repositoryRequest(
			token.token,
			`/api/repository-adapter/v1/releases/${record.recordId}/delivery-tree`,
			{
				method: "POST",
				body: JSON.stringify({
					files: [
						{
							catalogPath: "en.arb",
							content: '{"@@locale":"en","greeting":"Hello"}',
						},
						{
							catalogPath: "de.arb",
							content: '{"@@locale":"de","greeting":"Servus"}',
						},
					],
				}),
			},
		);
		expect(delivery.status).toBe(200);
		const deliveryBody = (await delivery.json()) as {
			deliveryCaptureId: Id<"releaseDeliveryCaptures">;
			files: Array<{ catalogPath: string; content: string }>;
			applied: string[];
			skipped: unknown[];
		};
		expect(deliveryBody.applied).toEqual(["greeting"]);
		expect(deliveryBody.skipped).toEqual([]);
		expect(
			deliveryBody.files.find((file) => file.catalogPath === "de.arb")?.content,
		).toBe('{"@@locale":"de","greeting":"Guten Tag"}');
		const captures = await t.run(async (ctx) =>
			ctx.db.query("releaseDeliveryCaptures").collect(),
		);
		expect(captures).toHaveLength(1);
		expect(captures[0]).toMatchObject({
			_id: deliveryBody.deliveryCaptureId,
			recordId: record.recordId,
			appliedCount: 1,
			skippedCount: 0,
		});
	});

	test("refuses a build page after the recorded Workspace basis changes", async () => {
		const user = await authenticatedBackend(t, "release-build-race");
		const { projectId, targetId } = await createCatalog(user);
		await save(user, projectId, targetId, "Guten Tag");
		const record = await prepareAndFinish(user, projectId);
		const started = await user.mutation(api.releaseBundles.build, {
			recordId: record.recordId,
		});

		await expect(
			t.query(internal.releaseBundles.bundleChangePage, {
				runId: started.runId,
				paginationOpts: { cursor: null, numItems: 1 },
			}),
		).resolves.toMatchObject({ isDone: true });

		await save(user, projectId, targetId, "Hallo wieder");
		await expect(
			t.query(internal.releaseBundles.bundleChangePage, {
				runId: started.runId,
				paginationOpts: { cursor: null, numItems: 1 },
			}),
		).rejects.toThrow("Catalog Workspace changed");
	});

	test("requires a Baseline and a complete Navigation Index", async () => {
		const user = await authenticatedBackend(t, "release-basis");
		const projectId = await createProject(user);

		await expect(
			user.query(api.releaseRecords.current, { projectId }),
		).resolves.toEqual({ kind: "noBaseline" });
		await expect(
			user.mutation(api.releaseRecords.prepare, { projectId }),
		).rejects.toThrow("accepted Baseline Catalog");

		const navigationUser = await authenticatedBackend(
			t,
			"release-navigation-basis",
		);
		const catalog = await createCatalog(
			navigationUser,
			"release-navigation-project",
		);
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("catalogWorkspaceNavigationStates")
				.withIndex("by_project", (q) => q.eq("projectId", catalog.projectId))
				.unique();
			if (!state) throw new Error("Expected the Navigation Index state.");
			await ctx.db.patch(state._id, { status: "staging" });
		});

		await expect(
			navigationUser.query(api.releaseRecords.current, {
				projectId: catalog.projectId,
			}),
		).resolves.toMatchObject({ kind: "available", canPrepare: false });
		await expect(
			navigationUser.mutation(api.releaseRecords.prepare, {
				projectId: catalog.projectId,
			}),
		).rejects.toThrow("Navigation Index backfill completes");
	});

	test("prepares one reusable durable Ready record with deliberate evidence", async () => {
		const user = await authenticatedBackend(t, "release-ready");
		const { projectId, targetId } = await createCatalog(user);
		await save(user, projectId, targetId, "Hello");

		const started = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		expect(started.status).toBe("preparing");
		await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		await t.run(async (ctx) => {
			const durable = await ctx.db.get(started.recordId);
			const preparation = await ctx.db
				.query("releaseRecordPreparations")
				.withIndex("by_recordId", (q) => q.eq("recordId", started.recordId))
				.unique();
			expect(durable).toMatchObject({
				status: "preparing",
				deltaKeyCount: 0,
				scopeValueCount: 0,
			});
			expect(durable).not.toHaveProperty("cursor");
			expect(durable).not.toHaveProperty("stepPending");
			expect(preparation).toMatchObject({
				cursor: 0,
				deltaKeyCount: 1,
				scopeValueCount: 1,
			});
		});
		const stagingHandoff = await user.query(api.releaseRecords.handoff, {
			projectId,
			recordId: started.recordId,
		});
		expect(stagingHandoff).toEqual({
			recordId: started.recordId,
			status: "staging",
			keys: [],
		});
		const completed = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});

		expect(completed).toMatchObject({
			status: "ready",
			posture: "ready",
			deltaKeyCount: 1,
			scopeValueCount: 1,
			sourceIdenticalCount: 1,
		});
		await t.run(async (ctx) => {
			const durable = await ctx.db.get(started.recordId);
			const preparation = await ctx.db
				.query("releaseRecordPreparations")
				.withIndex("by_recordId", (q) => q.eq("recordId", started.recordId))
				.unique();
			expect(durable).toMatchObject({
				status: "ready",
				deltaKeyCount: 1,
				scopeValueCount: 1,
			});
			expect(preparation).toBeNull();
		});
		const details = await user.query(api.releaseRecords.details, {
			recordId: started.recordId,
			findingCursor: -1,
			evidenceCursor: -1,
			limit: 10,
		});
		expect(details.findings).toEqual([]);
		expect(details.evidence).toMatchObject([
			{ messageId: "greeting", localeCode: "de", kind: "source_identical" },
		]);
		const handoff = await user.query(api.releaseRecords.handoff, {
			projectId,
			recordId: started.recordId,
		});
		expect(handoff).toMatchObject({ status: "published", keys: [] });
		const reused = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		expect(reused.recordId).toBe(started.recordId);
		await save(user, projectId, targetId, "Hallo wieder");
		await expect(
			user.query(api.releaseRecords.handoff, {
				projectId,
				recordId: started.recordId,
			}),
		).resolves.toEqual({
			recordId: started.recordId,
			status: "stale",
			keys: [],
		});
	});

	test("does not reuse a superseded record on the same basis", async () => {
		const user = await authenticatedBackend(t, "release-superseded-retry");
		const { projectId } = await createCatalog(user);
		const completed = await prepareAndFinish(user, projectId);
		await t.run(async (ctx) => {
			await ctx.db.patch(completed.recordId, {
				status: "superseded",
				completedAt: Date.now(),
			});
		});

		const retried = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		expect(retried.recordId).not.toBe(completed.recordId);
		expect(retried.status).toBe("preparing");
	});

	test("supersedes preparation when the Workspace revision advances", async () => {
		const user = await authenticatedBackend(t, "release-race");
		const { projectId, targetId } = await createCatalog(user);
		await save(user, projectId, targetId, "Hello");
		const started = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		await t.run(async (ctx) => {
			const stagedEvidence = await ctx.db
				.query("releaseEvidence")
				.withIndex("by_record", (q) => q.eq("recordId", started.recordId))
				.collect();
			expect(stagedEvidence).toHaveLength(1);
		});
		await expect(
			user.query(api.releaseRecords.evidence, {
				recordId: started.recordId,
				paginationOpts: { cursor: null, numItems: 10 },
			}),
		).rejects.toThrow("has not been published");

		await save(user, projectId, targetId, "Hallo wieder");
		const cleanupQueued = await t.mutation(
			internal.releaseRecords.processStep,
			{
				recordId: started.recordId,
			},
		);
		expect(cleanupQueued?.status).toBe("preparing");
		await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		const result = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		expect(result?.status).toBe("superseded");
		await t.run(async (ctx) => {
			const [findings, evidence, handoffKeys, preparation] = await Promise.all([
				ctx.db
					.query("releaseFindings")
					.withIndex("by_record", (q) => q.eq("recordId", started.recordId))
					.collect(),
				ctx.db
					.query("releaseEvidence")
					.withIndex("by_record", (q) => q.eq("recordId", started.recordId))
					.collect(),
				ctx.db.query("releaseWorkHandoffKeys").collect(),
				ctx.db
					.query("releaseRecordPreparations")
					.withIndex("by_recordId", (q) => q.eq("recordId", started.recordId))
					.unique(),
			]);
			expect(findings).toEqual([]);
			expect(evidence).toEqual([]);
			expect(handoffKeys).toEqual([]);
			expect(preparation).toBeNull();
		});
		await expect(
			user.query(api.releaseRecords.details, {
				recordId: started.recordId,
				findingCursor: -1,
				evidenceCursor: -1,
				limit: 10,
			}),
		).rejects.toThrow("has not been published");
	});

	test("blocks a delta key whose current target still violates the Source Contract", async () => {
		const user = await authenticatedBackend(t, "release-blocked");
		const { projectId, frenchId } = await createThreeLocaleCatalog(
			user,
			"Hallo {other}",
		);
		await save(user, projectId, frenchId, "Salut {name}");
		const started = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		const stagingHandoff = await user.query(api.releaseRecords.handoff, {
			projectId,
			recordId: started.recordId,
		});
		expect(stagingHandoff.keys).toEqual([]);
		const completed = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});

		expect(completed).toMatchObject({
			status: "ready",
			posture: "blocked",
			blockedCount: 1,
		});
		const handoff = await user.query(api.releaseRecords.handoff, {
			projectId,
			recordId: started.recordId,
		});
		expect(handoff.keys).toEqual([{ catalogIndex: 0, messageId: "greeting" }]);
	});

	test("blocks a pending Source Proposal that no longer preserves its Source Contract", async () => {
		const user = await authenticatedBackend(t, "release-source-contract");
		const { projectId } = await createCatalog(user);
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const source = workspace.keys[0]?.values.find((value) => value.isSource);
		if (
			!source?.localeId ||
			source.gitValueFingerprint === undefined ||
			source.gitValueRevision === undefined ||
			source.workspaceRevision === undefined
		) {
			throw new Error("Expected Source Proposal concurrency tokens.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: source.localeId,
			intent: { kind: "save", value: "Welcome" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});
		await t.run(async (ctx) => {
			const head = await ctx.db
				.query("catalogWorkspaceSourceProposalHeads")
				.withIndex("by_project_and_messageId", (q) =>
					q.eq("projectId", projectId).eq("messageId", "greeting"),
				)
				.unique();
			if (!head) throw new Error("Expected a pending Source Proposal.");
			// Model corrupt or legacy evidence that bypassed the current write
			// invariant: Release must still refuse to call it shippable.
			await ctx.db.patch(head._id, { sourceValue: "Count {count}" });
		});

		await expect(prepareAndFinish(user, projectId)).resolves.toMatchObject({
			status: "ready",
			posture: "blocked",
			blockedCount: 1,
		});
	});

	test("needs a decision for a missing scoped target while unconfirmed imports stay non-gating", async () => {
		const user = await authenticatedBackend(t, "release-decisions");
		const { projectId, frenchId } = await createThreeLocaleCatalog(user, null);
		await save(user, projectId, frenchId, "Salut {name}");
		const started = await user.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});
		const completed = await t.mutation(internal.releaseRecords.processStep, {
			recordId: started.recordId,
		});

		expect(completed).toMatchObject({
			status: "ready",
			posture: "needsDecisions",
			needsDecisionCount: 1,
		});
	});

	test("gates populated targets introduced after bootstrap until First Review", async () => {
		const user = await authenticatedBackend(t, "release-introduced");
		const { projectId } = await createCatalog(user);
		await user.action(api.snapshots.ingest, {
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
					content:
						'{"@@locale":"en","greeting":"Hello","newKey":"Draft source"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","greeting":"Hallo","newKey":"Platzhalter"}',
				},
			],
		});

		const record = await prepareAndFinish(user, projectId);
		expect(record).toMatchObject({
			status: "ready",
			posture: "needsDecisions",
			deltaKeyCount: 1,
			needsDecisionCount: 1,
		});
		const details = await user.query(api.releaseRecords.details, {
			recordId: record.recordId,
			findingCursor: -1,
			evidenceCursor: -1,
			limit: 8,
		});
		expect(details.findings).toEqual([
			expect.objectContaining({
				messageId: "newKey",
				localeCode: "de",
				kind: "introduction_review",
			}),
		]);
	}, 30_000);

	test("pages complete finding and evidence key groups", async () => {
		const user = await authenticatedBackend(t, "release-details");
		const { projectId, targetId } = await createCatalog(user);
		await save(user, projectId, targetId, "Hello");
		const record = await prepareAndFinish(user, projectId);

		await t.run(async (ctx) => {
			const oldEvidence = await ctx.db
				.query("releaseEvidence")
				.withIndex("by_record", (q) => q.eq("recordId", record.recordId))
				.collect();
			for (const evidence of oldEvidence) await ctx.db.delete(evidence._id);
			for (const [catalogIndex, suffix] of [
				[1, "a"],
				[1, "b"],
				[2, "c"],
			] as const) {
				await ctx.db.insert("releaseFindings", {
					projectId,
					recordId: record.recordId,
					catalogIndex,
					messageId: `finding_${suffix}`,
					localeId: targetId,
					localeCode: "de",
					kind: "missing_value",
				});
				await ctx.db.insert("releaseEvidence", {
					projectId,
					recordId: record.recordId,
					catalogIndex,
					messageId: `evidence_${suffix}`,
					localeId: targetId,
					localeCode: "de",
					kind: "source_identical",
				});
			}
		});

		const first = await user.query(api.releaseRecords.details, {
			recordId: record.recordId,
			findingCursor: -1,
			evidenceCursor: -1,
			limit: 1,
		});
		expect(first.findings.map((item) => item.catalogIndex)).toEqual([1, 1]);
		expect(first.evidence.map((item) => item.catalogIndex)).toEqual([1, 1]);
		expect(first.nextFindingCursor).toBe(1);
		expect(first.nextEvidenceCursor).toBe(1);

		const second = await user.query(api.releaseRecords.details, {
			recordId: record.recordId,
			findingCursor: first.nextFindingCursor ?? -1,
			evidenceCursor: first.nextEvidenceCursor ?? -1,
			limit: 1,
		});
		expect(second.findings.map((item) => item.catalogIndex)).toEqual([2]);
		expect(second.evidence.map((item) => item.catalogIndex)).toEqual([2]);
		expect(second.nextFindingCursor).toBeNull();
		expect(second.nextEvidenceCursor).toBeNull();

		const firstEvidence = await user.query(api.releaseRecords.evidence, {
			recordId: record.recordId,
			paginationOpts: { cursor: null, numItems: 2 },
		});
		expect(firstEvidence.page.map((item) => item.messageId)).toEqual([
			"evidence_a",
			"evidence_b",
		]);
		expect(firstEvidence.isDone).toBe(false);
		const remainingEvidence = await user.query(api.releaseRecords.evidence, {
			recordId: record.recordId,
			paginationOpts: {
				cursor: firstEvidence.continueCursor,
				numItems: 2,
			},
		});
		expect(remainingEvidence.page.map((item) => item.messageId)).toEqual([
			"evidence_c",
		]);
		expect(remainingEvidence.isDone).toBe(true);
	});

	test("pages immutable record history", async () => {
		const user = await authenticatedBackend(t, "release-history");
		const { projectId, targetId } = await createCatalog(user);
		const records: Id<"releaseRecords">[] = [];
		for (const value of ["Hello", "Hallo wieder", "Guten Tag"]) {
			await save(user, projectId, targetId, value);
			records.push((await prepareAndFinish(user, projectId)).recordId);
		}

		const first = await user.query(api.releaseRecords.history, {
			projectId,
			paginationOpts: { cursor: null, numItems: 2 },
		});
		expect(first.records).toHaveLength(2);
		expect(first.isDone).toBe(false);
		const second = await user.query(api.releaseRecords.history, {
			projectId,
			paginationOpts: { cursor: first.continueCursor, numItems: 2 },
		});
		expect(second.records).toHaveLength(1);
		expect(second.isDone).toBe(true);
		expect(
			new Set(
				[...first.records, ...second.records].map((item) => item.recordId),
			),
		).toEqual(new Set(records));

		const latest = await user.query(api.releaseRecords.current, { projectId });
		if (latest.kind !== "available")
			throw new Error("Expected Release history.");
		expect(latest.current?.recordId).toBe(records[records.length - 1]);
		const earlier = await user.query(api.releaseRecords.history, {
			projectId,
			paginationOpts: { cursor: latest.historyCursor, numItems: 8 },
		});
		expect(earlier.records.map((item) => item.recordId)).toEqual(
			records.slice(0, -1).reverse(),
		);
	});

	test("enforces authentication and project ownership on every public read", async () => {
		const owner = await authenticatedBackend(t, "release-owner");
		const outsider = await authenticatedBackend(t, "release-outsider");
		const { projectId, targetId } = await createCatalog(owner);
		const otherProjectId = await createProject(owner, {
			slug: "release-other-project",
		});
		await save(owner, projectId, targetId, "Hello");
		const record = await prepareAndFinish(owner, projectId);

		await expect(
			t.query(api.releaseRecords.current, { projectId }),
		).rejects.toThrow();
		await expect(
			outsider.query(api.releaseRecords.current, { projectId }),
		).rejects.toThrow();
		await expect(
			outsider.query(api.releaseRecords.history, {
				projectId,
				paginationOpts: { cursor: null, numItems: 5 },
			}),
		).rejects.toThrow();
		await expect(
			outsider.query(api.releaseRecords.details, {
				recordId: record.recordId,
				findingCursor: -1,
				evidenceCursor: -1,
				limit: 5,
			}),
		).rejects.toThrow();
		await expect(
			outsider.query(api.releaseRecords.evidence, {
				recordId: record.recordId,
				paginationOpts: { cursor: null, numItems: 5 },
			}),
		).rejects.toThrow();
		await expect(
			owner.query(api.releaseRecords.handoff, {
				projectId: otherProjectId,
				recordId: record.recordId,
			}),
		).rejects.toThrow("Release Record not found");
		await expect(
			outsider.query(api.releaseRecords.handoff, {
				projectId,
				recordId: record.recordId,
			}),
		).rejects.toThrow();
		await expect(
			outsider.mutation(api.releaseRecords.prepare, { projectId }),
		).rejects.toThrow();
	});
});

test("delivers one uploaded catalog at a time with export-only authorization and retained input evidence", async () => {
	const { sha256Hex } = await import("./lib");
	const user = await authenticatedBackend(t, "release-file-delivery");
	const { projectId, targetId } = await createCatalog(user);
	await save(user, projectId, targetId, "Guten Tag");
	const record = await prepareAndFinish(user, projectId);
	const started = await user.mutation(api.releaseBundles.build, {
		recordId: record.recordId,
	});
	await t.action(internal.releaseBundles.buildArtifact, {
		runId: started.runId,
	});
	const token = (
		await user.mutation(api.apiTokens.create, {
			projectId,
			name: "export only",
			scopes: ["export"],
		})
	).token;
	const post = async (suffix: string, body: unknown) =>
		await repositoryRequest(
			token,
			`/api/repository-adapter/v1/snapshot-uploads${suffix}`,
			{ method: "POST", body: JSON.stringify(body) },
		);
	const begin = await post("", {
		kind: "release",
		releaseRecordId: record.recordId,
		repository: "repo",
		commit: "baseline",
		expectedFiles: 2,
	});
	expect(begin.status).toBe(200);
	const { sessionId } = (await begin.json()) as {
		sessionId: Id<"snapshotUploadSessions">;
	};
	const uploadState = await t.run(async (ctx) => await ctx.db.get(sessionId));
	if (!uploadState) throw new Error("Expected upload session");
	const { finalizeUpload } = await import("./snapshotUploads");
	await expect(
		t.action(
			async (ctx) =>
				await finalizeUpload(ctx, {
					sessionId,
					projectId,
					tokenId: uploadState.tokenId,
				}),
		),
	).rejects.toThrow("Release delivery finalization");
	expect(
		(await t.run(async (ctx) => await ctx.db.get(sessionId)))?.status,
	).toBe("uploading");
	for (const file of [
		{ catalogPath: "en.arb", content: '{"@@locale":"en","greeting":"Hello"}' },
		{ catalogPath: "de.arb", content: '{"@@locale":"de","greeting":"Servus"}' },
	]) {
		expect(
			(
				await post("/file", {
					kind: "release",
					sessionId,
					...file,
					contentHash: await sha256Hex(file.content),
				})
			).status,
		).toBe(200);
	}
	const finalized = await post("/finalize", { kind: "release", sessionId });
	expect(finalized.status).toBe(200);
	expect(await finalized.json()).toMatchObject({
		catalogPaths: ["de.arb", "en.arb"],
		applied: ["greeting"],
		skipped: [],
	});
	const delivered = await post("/download", {
		sessionId,
		catalogPath: "de.arb",
	});
	expect(delivered.status).toBe(200);
	expect(await delivered.json()).toMatchObject({
		content: '{"@@locale":"de","greeting":"Guten Tag"}',
	});
	const inputs = await t.run(async (ctx) => {
		const files = await ctx.db
			.query("snapshotUploadFiles")
			.withIndex("by_session_and_catalogPath", (q) =>
				q.eq("sessionId", sessionId),
			)
			.take(3);
		await ctx.db.patch(sessionId, { expiresAt: 0 });
		return files;
	});
	await t.mutation(internal.snapshotUploads.cleanup, { sessionId });
	for (const file of inputs) {
		expect(
			await t.run(async (ctx) => await ctx.db.system.get(file.storageId)),
		).not.toBeNull();
		if (!file.outputStorageId) throw new Error("Expected output artifact");
		const outputStorageId = file.outputStorageId;
		expect(
			await t.run(async (ctx) => await ctx.db.system.get(outputStorageId)),
		).toBeNull();
	}
});
