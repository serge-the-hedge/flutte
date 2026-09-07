import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { decisionStateFor, recordDecisions } from "./catalogWorkspace";
import {
	decisionForIdentity,
	latestDecisionForValue,
} from "./catalogWorkspaceDecisionQueries";
import { sha256Hex } from "./lib";
import { realizeLocaleBinding } from "./snapshots";

const sourceContent = JSON.stringify({
	"@@locale": "en",
	greeting: "Hello",
	quiet: "Hidden",
});
async function fixture(
	input: { targetCodes?: string[]; introduceQuiet?: boolean } = {},
) {
	const t = createBackend();
	const user = await authenticatedBackend(t, "locale-delivery-owner");
	const projectId = await createProject(user);
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing source");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "intl_en.arb",
	});
	await user.mutation(api.localeIntroductionTargets.save, {
		projectId,
		localeCode: "pt",
		label: "Portuguese",
		catalogPath: "intl_pt.arb",
		runtimeLocale: "pt-BR",
	});
	const existingFiles = [];
	for (const code of input.targetCodes ?? []) {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code,
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `intl_${code}.arb`,
		});
		existingFiles.push({
			catalogPath: `intl_${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				greeting: `${code} greeting`,
				quiet: `${code} hidden`,
			}),
		});
	}
	if (input.introduceQuiet)
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "bootstrap",
			files: [
				{
					catalogPath: "intl_en.arb",
					content: JSON.stringify({ "@@locale": "en", greeting: "Hello" }),
				},
				...existingFiles.map((file) => ({
					catalogPath: file.catalogPath,
					content: file.content.replace(/,"quiet":"[^"]*"/, ""),
				})),
			],
		});
	const baseline = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{ catalogPath: "intl_en.arb", content: sourceContent },
			...existingFiles,
		],
		...(input.introduceQuiet
			? {
					lineage: {
						baselineCommit: "bootstrap",
						relationship: "descendant" as const,
						mergeBase: "bootstrap",
					},
				}
			: {}),
	});
	const { proposalId } = await user.mutation(
		api.localeProposals.ensureForReview,
		{ projectId, localeCode: "pt" },
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
				intentionalBlankReason: "This label is deliberately hidden.",
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
	return { t, user, projectId, proposalId, baseline, artifact, existingFiles };
}

describe("Locale delivery observation and binding realization", () => {
	test("observes exact delivery, then binds without advancing Snapshot Identity and retains reviewed text and blank evidence", async () => {
		const { t, user, projectId, proposalId, artifact, existingFiles } =
			await fixture({
				targetCodes: ["de", "es", "fr", "ru", "zh"],
				introduceQuiet: true,
			});
		const delivered = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				...existingFiles,
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "observed", snapshotId: delivered.snapshotId });
		if (!delivered.snapshotId) throw new Error("Expected delivery Snapshot.");
		const before = await readWorkspaceKeyCards(user, projectId);
		expect(before.keys.every((key) => key.values.length === 6)).toBe(true);
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
			label: "Portuguese",
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "intl_pt.arb",
		});
		const after = await readWorkspaceKeyCards(user, projectId);
		expect(after.projectionId).not.toBe(before.projectionId);
		const scopes = await t.run(async (ctx) => {
			const beforeSource = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", before.projectionId)
						.eq("messageId", "quiet")
						.eq("isSource", true),
				)
				.unique();
			const afterSource = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", after.projectionId)
						.eq("messageId", "quiet")
						.eq("isSource", true),
				)
				.unique();
			return {
				before: beforeSource?.introductionLocaleIds,
				after: afterSource?.introductionLocaleIds,
			};
		});
		expect(scopes.before).toHaveLength(5);
		expect(scopes.after).toEqual(scopes.before);
		expect(scopes.after).not.toContain(localeId);

		expect(
			after.keys
				.find((key) => key.id === "greeting")
				?.values.find((value) => value.localeId === localeId),
		).toMatchObject({ value: "Olá", valueState: "settled" });
		expect(
			after.keys
				.find((key) => key.id === "quiet")
				?.values.find((value) => value.localeId === localeId),
		).toMatchObject({
			value: "",
			valueState: "settled",
			intentionalBlankReason: "This label is deliberately hidden.",
		});
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "bound", snapshotId: delivered.snapshotId });
		const stored = await t.run(async (ctx) => ({
			project: await ctx.db.get(projectId),
			snapshots: await ctx.db.query("sourceSnapshots").collect(),
			decisions: await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.collect(),
		}));
		expect(stored.project?.baselineSnapshotId).toBe(delivered.snapshotId);
		expect(stored.snapshots).toHaveLength(3);
		expect(stored.decisions).toHaveLength(2);
		expect(
			stored.decisions.every(
				(decision) =>
					decision.localeProposalId === proposalId &&
					decision.recordedBy.kind === "user",
			),
		).toBe(true);
		expect(
			await user.action(api.snapshots.catalogText, {
				snapshotId: delivered.snapshotId,
				localeCode: "pt",
			}),
		).toBe(artifact.catalog.content);
		// A realized Locale immediately participates in ordinary editing and release.
		const greeting = after.keys
			.find((key) => key.id === "greeting")
			?.values.find((value) => value.localeId === localeId);
		if (
			!greeting ||
			greeting.isSource ||
			greeting.gitValueFingerprint === undefined ||
			greeting.gitValueRevision === undefined ||
			greeting.expectedSourceFingerprint === undefined
		)
			throw new Error("Missing realized target tokens.");
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId,
			intent: { kind: "save", value: "Olá de novo" },
			expectedGitValueFingerprint: greeting.gitValueFingerprint,
			expectedGitValueRevision: greeting.gitValueRevision,
			expectedWorkspaceRevision: greeting.workspaceRevision,
			expectedSourceFingerprint: greeting.expectedSourceFingerprint,
		});
		for (const target of after.keys.find((key) => key.id === "quiet")?.values ??
			[]) {
			if (
				target.isSource ||
				target.localeId === localeId ||
				target.gitValueFingerprint === undefined ||
				target.gitValueRevision === undefined ||
				target.expectedSourceFingerprint === undefined
			)
				continue;
			await user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "quiet",
				localeId: target.localeId,
				intent: { kind: "confirm" },
				expectedGitValueFingerprint: target.gitValueFingerprint,
				expectedGitValueRevision: target.gitValueRevision,
				expectedWorkspaceRevision: target.workspaceRevision,
				expectedSourceFingerprint: target.expectedSourceFingerprint,
			});
		}
		let record = await user.mutation(api.releaseRecords.prepare, { projectId });
		for (let step = 0; step < 10 && record.status === "preparing"; step++) {
			const next = await t.mutation(internal.releaseRecords.processStep, {
				recordId: record.recordId,
			});
			if (!next) throw new Error("Release Record disappeared.");
			record = next;
		}
		expect(record).toMatchObject({ status: "ready", posture: "ready" });
		const build = await user.mutation(api.releaseBundles.build, {
			recordId: record.recordId,
		});
		const context = await t.query(internal.releaseBundles.bundleContext, {
			runId: build.runId,
		});
		expect(context.artifact.catalogs).toHaveLength(7);
		expect(context.artifact.catalogs).toContainEqual({
			localeCode: "pt",
			catalogPath: "intl_pt.arb",
			isSource: false,
		});
		await t.action(internal.releaseBundles.buildArtifact, {
			runId: build.runId,
		});
		expect(
			await user.query(api.releaseBundles.forRecord, {
				recordId: record.recordId,
			}),
		).toMatchObject({ status: "ready", changeKeyCount: 1 });
		// The next ordinary ingest must retain the same exact decisions.
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "delivered",
				relationship: "descendant",
				mergeBase: "delivered",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				...existingFiles,
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		expect(
			(await readWorkspaceKeyCards(user, projectId)).keys.every((key) =>
				key.values.some(
					(value) =>
						value.localeId === localeId &&
						"valueState" in value &&
						value.valueState === "settled",
				),
			),
		).toBe(true);
	});
	test("a Locale bound before delivery carries approval on accepted descendant ingestion", async () => {
		const { user, projectId, proposalId, artifact } = await fixture();
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "intl_pt.arb",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "bound" });
		expect(
			(await readWorkspaceKeyCards(user, projectId)).keys.every((key) =>
				key.values.some(
					(value) =>
						value.localeId === localeId &&
						"valueState" in value &&
						value.valueState === "settled",
				),
			),
		).toBe(true);
	});
	test.each(["wrong path", "changed bytes", "changed source", "preview"])(
		"does not infer delivery approval for %s",
		async (kind) => {
			const { t, user, projectId, proposalId, artifact } = await fixture();
			await user.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: "other",
				...(kind === "preview"
					? {}
					: {
							lineage: {
								baselineCommit: "baseline",
								relationship: "descendant" as const,
								mergeBase: "baseline",
							},
						}),
				files: [
					{
						catalogPath: "intl_en.arb",
						content:
							kind === "changed source"
								? sourceContent.replace("Hello", "Welcome")
								: sourceContent,
					},
					{
						catalogPath: kind === "wrong path" ? "other_pt.arb" : "intl_pt.arb",
						content:
							kind === "changed bytes"
								? `${artifact.catalog.content}\n`
								: artifact.catalog.content,
					},
				],
			});
			expect(
				await user.query(api.localeDelivery.forProposal, { proposalId }),
			).toBeNull();
			expect(
				await t.run((ctx) =>
					ctx.db.query("catalogWorkspaceDecisionRecords").collect(),
				),
			).toHaveLength(0);
		},
	);
	test("binding enforces membership and the observed file Locale identity", async () => {
		const { t, user, projectId, artifact } = await fixture();
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		const stranger = await authenticatedBackend(t, "locale-delivery-stranger");
		await expect(
			stranger.action(api.locales.bind, {
				localeId,
				catalogPath: "intl_pt.arb",
			}),
		).rejects.toThrow();
		await expect(
			user.action(api.locales.bind, { localeId, catalogPath: "intl_pt.arb" }),
		).rejects.toThrow("different Locale code");
		expect(
			(await user.query(api.locales.list, { projectId })).find(
				(locale) => locale._id === localeId,
			)?.catalogPath,
		).toBeUndefined();
	});
	test("promotion of a stored Preview observes delivery only when accepted", async () => {
		const { user, projectId, proposalId, artifact } = await fixture();
		const files = [
			{ catalogPath: "intl_en.arb", content: sourceContent },
			{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
		];
		const preview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files,
		});
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toBeNull();
		const accepted = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "preview",
			files,
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});
		expect(accepted.snapshotId).toBe(preview.snapshotId);
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "observed", snapshotId: preview.snapshotId });
	});
	test("private delivery decisions stay invisible and failure cleanup restores their history envelope", async () => {
		const { t, user, projectId, proposalId, artifact } = await fixture();
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "intl_pt.arb",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		const staged = await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			const current = project?.activeCatalogProjectionId
				? await ctx.db.get(project.activeCatalogProjectionId)
				: null;
			if (!current) throw new Error("Expected active projection");
			const { _id, _creationTime, snapshotId, ...fields } = current;
			const projectionId = await ctx.db.insert("catalogProjections", {
				...fields,
				status: "staging",
			});
			await ctx.db.insert("catalogProjectionPublicationStates", {
				projectId,
				projectionId,
				status: "staging",
			});
			const sourceFingerprint = await sha256Hex("Unaccepted Source");
			const valueFingerprint = await sha256Hex("Olá");
			await recordDecisions(ctx, {
				projectId,
				state: await decisionStateFor(ctx, projectId),
				next: [
					{
						messageId: "greeting",
						localeId,
						sourceFingerprint,
						valueFingerprint,
						kind: "translatorConfirmation",
						recordedBy: { kind: "user", id: "historical-reviewer" },
						recordedAt: Date.now() + 10000,
						deliveryProjectionId: projectionId,
						localeProposalId: proposalId,
					},
				],
			});
			const privateDecision = await decisionForIdentity(ctx, {
				projectId,
				messageId: "greeting",
				localeId,
				sourceFingerprint,
				valueFingerprint,
			});
			const latest = await latestDecisionForValue(ctx, {
				projectId,
				messageId: "greeting",
				localeId,
				valueFingerprint,
			});
			return { projectionId, privateDecision, latest };
		});
		expect(staged.privateDecision).toBeNull();
		expect(staged.latest?.sourceFingerprint).toBe(await sha256Hex("Hello"));
		await user.mutation(internal.localeDelivery.discardDecisions, {
			projectId,
			projectionId: staged.projectionId,
		});
		const after = await t.run(async (ctx) => ({
			state: await decisionStateFor(ctx, projectId),
			records: await ctx.db.query("catalogWorkspaceDecisionRecords").collect(),
		}));
		expect(after.state?.decisionRecordCount).toBe(2);
		expect(after.records).toHaveLength(2);
	});

	test("observes previously finalized Portuguese artifacts after metadata upgrade", async () => {
		const { t, user, projectId, proposalId, artifact } = await fixture();
		await t.run((ctx) =>
			ctx.db.patch(proposalId, {
				catalogPath: undefined,
				catalogContentHash: undefined,
			}),
		);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
			],
		});
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "observed" });
		expect(await t.run((ctx) => ctx.db.get(proposalId))).toMatchObject({
			catalogPath: "intl_pt.arb",
			catalogContentHash: await sha256Hex(artifact.catalog.content),
		});
	});
	test.each([
		'{"greeting":"Olá"}',
		'{"@@locale":42,"greeting":"Olá"}',
		'{"@@locale":"PT","greeting":"Olá"}',
		'{"@@locale":"pt","greeting":"Olá","@greeting":"invalid metadata"}',
	])(
		"refuses malformed observed catalog %s without publishing binding or projection",
		async (content) => {
			const { t, user, projectId } = await fixture();
			await user.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: "malformed",
				lineage: {
					baselineCommit: "baseline",
					relationship: "descendant",
					mergeBase: "baseline",
				},
				files: [
					{ catalogPath: "intl_en.arb", content: sourceContent },
					{ catalogPath: "intl_pt.arb", content },
				],
			});
			const before = await t.run((ctx) => ctx.db.get(projectId));
			const localeId = await user.mutation(api.locales.create, {
				projectId,
				code: "pt",
			});
			await expect(
				user.action(api.locales.bind, { localeId, catalogPath: "intl_pt.arb" }),
			).rejects.toThrow();
			const after = await t.run(async (ctx) => ({
				project: await ctx.db.get(projectId),
				locale: await ctx.db.get(localeId),
				realizations: await ctx.db.query("localeBindingRealizations").collect(),
			}));
			expect(after.project?.baselineSnapshotId).toBe(
				before?.baselineSnapshotId,
			);
			expect(after.project?.activeCatalogProjectionId).toBe(
				before?.activeCatalogProjectionId,
			);
			expect(after.locale?.catalogPath).toBeUndefined();
			expect(after.realizations).toHaveLength(0);
		},
	);

	test("a concurrent binding cannot be dropped by a projection built from older file evidence", async () => {
		const { t, user, projectId, artifact } = await fixture();
		const delivered = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "delivered",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "intl_en.arb", content: sourceContent },
				{ catalogPath: "intl_pt.arb", content: artifact.catalog.content },
				{
					catalogPath: "de.arb",
					content: JSON.stringify({
						"@@locale": "de",
						greeting: "Hallo",
						quiet: "Still",
					}),
				},
			],
		});
		if (!delivered.snapshotId) throw new Error("Expected delivered Baseline");
		const portuguese = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		const german = await user.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		const plan = await user.query(internal.locales.bindingPlan, {
			localeId: portuguese,
			catalogPath: "intl_pt.arb",
		});
		if (!plan.unboundFile)
			throw new Error("Expected Portuguese unbound evidence");
		const input = {
			projectId,
			localeId: portuguese,
			catalogPath: "intl_pt.arb",
			snapshotId: delivered.snapshotId,
			unboundFileId: plan.unboundFile._id,
		};
		await expect(
			user.action(async (ctx) => {
				let injected = false;
				const runQuery: ActionCtx["runQuery"] = async (query, args) => {
					const result = await ctx.runQuery(query, args);
					if (
						!injected &&
						getFunctionName(query) === "snapshots:projectionEvidenceFor"
					) {
						injected = true;
						await user.action(api.locales.bind, {
							localeId: german,
							catalogPath: "de.arb",
						});
					}
					return result;
				};
				await realizeLocaleBinding({ ...ctx, runQuery }, input);
			}),
		).rejects.toThrow("changed while Snapshot files were read");
		const after = await readWorkspaceKeyCards(user, projectId);
		expect(
			after.keys.every((key) =>
				key.values.some((value) => value.localeId === german),
			),
		).toBe(true);
		expect(
			after.keys.every(
				(key) => !key.values.some((value) => value.localeId === portuguese),
			),
		).toBe(true);
		expect(
			(await user.query(api.locales.list, { projectId })).find(
				(locale) => locale._id === portuguese,
			)?.catalogPath,
		).toBeUndefined();
		await user.action(api.locales.bind, {
			localeId: portuguese,
			catalogPath: "intl_pt.arb",
		});
		expect(
			(await readWorkspaceKeyCards(user, projectId)).keys.every(
				(key) => key.values.length === 3,
			),
		).toBe(true);
		expect(
			(await t.run((ctx) => ctx.db.get(projectId)))?.baselineSnapshotId,
		).toBe(delivered.snapshotId);
	});
	test("ordinary ingestion cannot stage a binding list captured before setup changed", async () => {
		const { user, projectId } = await fixture();
		const captured = await user.query(internal.snapshots.bindingsFor, {
			projectId,
		});
		const german = await user.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		await user.action(api.locales.bind, {
			localeId: german,
			catalogPath: "de.arb",
		});
		await expect(
			user.mutation(internal.catalogProjection.begin, {
				projectId,
				repository: "repo",
				commit: "next",
				manifestHash: "candidate",
				expectedKeyCount: 2,
				expectedMessageCount: 2,
				expectedByteLength: 1,
				expectedBindingBasis: {
					projectionId: captured.projectionId,
					localeBindingRevision: captured.localeBindingRevision,
				},
			}),
		).rejects.toThrow("changed while Snapshot files were read");
	});
});
