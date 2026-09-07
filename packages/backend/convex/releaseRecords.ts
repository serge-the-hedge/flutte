import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	activeProjectionFor,
	MAX_PROJECTED_LOCALES,
	MAX_WORKING_CATALOG_KEYS,
} from "./catalogProjection";
import {
	decisionForIdentity,
	latestDecisionForValue,
} from "./catalogWorkspaceDecisionQueries";
import { readyNavigationStateFor } from "./catalogWorkspaceNavigation";
import {
	currentHeadForRow,
	encodedSize,
	sourceChangeKindForConfirmation,
	sourceChangeMap,
	valueIdentity,
} from "./catalogWorkspaceView";
import {
	assertSourceProposalValueContract,
	assertTargetValueContract,
} from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import { requireEditor, requireViewer } from "./permissions";
import {
	deliberateEvidenceFor,
	emptyLocaleSummary,
	emptyReleaseAssessment,
	evidenceSummary,
	evidenceValidator,
	findingValidator,
	isReleaseDelta,
	localeSummaryMap,
	releaseAssessmentFrom,
	releasePostureFor,
	releaseSummary,
	releaseSummaryValidator,
	releaseTargetContribution,
	sortedLocaleSummaries,
} from "./releaseRecordModel";
import { sourceProposalHeadFor } from "./sourceProposals";

/** Release Assessment is deliberately a deep module: callers prepare and
 * read one durable record while this bounded worker owns traversal,
 * classification, evidence normalization, supersession, and hand-off. */
export const MAX_RELEASE_ROWS_PER_STEP = 64;
const MAX_RELEASE_DETAIL_PAGE = 50;
const MAX_RELEASE_HISTORY = 8;
const MAX_RELEASE_HANDOFF_BYTES = 2 * 1024 * 1024;

function releaseFailureFor(error: unknown) {
	const data =
		error instanceof ConvexError &&
		typeof error.data === "object" &&
		error.data !== null
			? error.data
			: null;
	const code =
		data && "code" in data && typeof data.code === "string"
			? data.code
			: undefined;
	return {
		...(code === undefined ? {} : { code }),
		message:
			error instanceof Error ? error.message : "Release assessment failed.",
		failedAt: now(),
	};
}

function preparationFor(
	ctx: MutationCtx | QueryCtx,
	recordId: Id<"releaseRecords">,
) {
	return ctx.db
		.query("releaseRecordPreparations")
		.withIndex("by_recordId", (q) => q.eq("recordId", recordId))
		.unique();
}

type ReleaseTerminalCleanup = NonNullable<
	Doc<"releaseRecordPreparations">["terminal"]
>;

async function queueTerminalCleanup(
	ctx: MutationCtx,
	record: Doc<"releaseRecords">,
	preparation: Doc<"releaseRecordPreparations">,
	terminal: ReleaseTerminalCleanup,
) {
	const updatedAt = now();
	await ctx.db.patch(preparation._id, {
		terminal,
		stepPending: true,
		updatedAt,
	});
	await ctx.scheduler.runAfter(0, internal.releaseRecords.processStep, {
		recordId: record._id,
	});
	return { ...preparation, terminal, stepPending: true, updatedAt };
}

async function processTerminalCleanup(
	ctx: MutationCtx,
	record: Doc<"releaseRecords">,
	preparation: Doc<"releaseRecordPreparations">,
) {
	const terminal = preparation.terminal;
	if (!terminal) return null;
	const [findings, evidence, handoffKeys] = await Promise.all([
		ctx.db
			.query("releaseFindings")
			.withIndex("by_record", (q) => q.eq("recordId", record._id))
			.take(MAX_RELEASE_ROWS_PER_STEP),
		ctx.db
			.query("releaseEvidence")
			.withIndex("by_record", (q) => q.eq("recordId", record._id))
			.take(MAX_RELEASE_ROWS_PER_STEP),
		ctx.db
			.query("releaseWorkHandoffKeys")
			.withIndex("by_handoff", (q) => q.eq("handoffId", record.handoffId))
			.take(MAX_RELEASE_ROWS_PER_STEP),
	]);
	for (const row of [...findings, ...evidence, ...handoffKeys]) {
		await ctx.db.delete(row._id);
	}
	if (findings.length + evidence.length + handoffKeys.length > 0) {
		const updatedAt = now();
		await ctx.db.patch(preparation._id, { stepPending: true, updatedAt });
		await ctx.scheduler.runAfter(0, internal.releaseRecords.processStep, {
			recordId: record._id,
		});
		return releaseSummary(record, {
			...preparation,
			stepPending: true,
			updatedAt,
		});
	}
	await ctx.db.patch(record.handoffId, { keyCount: 0, byteLength: 0 });
	await ctx.db.delete(preparation._id);
	if (terminal.status === "failed") {
		await ctx.db.patch(record._id, {
			status: terminal.status,
			failure: terminal.failure,
			completedAt: terminal.completedAt,
		});
		return releaseSummary({
			...record,
			status: terminal.status,
			failure: terminal.failure,
			completedAt: terminal.completedAt,
		});
	}
	await ctx.db.patch(record._id, {
		status: terminal.status,
		completedAt: terminal.completedAt,
	});
	return releaseSummary({
		...record,
		status: terminal.status,
		completedAt: terminal.completedAt,
	});
}

function assertPublishedEvidence(record: Doc<"releaseRecords">) {
	if (record.status !== "ready") {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Release Record evidence has not been published.",
		});
	}
}

async function currentNavigationBasis(
	ctx: MutationCtx,
	projectId: Id<"projects">,
) {
	const projection = await activeProjectionFor(ctx, projectId);
	const snapshotId = projection?.snapshotId;
	if (!projection || !snapshotId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Release assessment needs an accepted Baseline Catalog.",
		});
	}
	const navigation = await readyNavigationStateFor(ctx, {
		projectId,
		projectionId: projection._id,
		expectedRowCount: projection.expectedKeyCount,
	});
	return {
		projection,
		snapshotId,
		navigationRevision: navigation.revision ?? 0,
	};
}

export const prepare = mutation({
	args: { projectId: v.id("projects") },
	returns: releaseSummaryValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const { projection, snapshotId, navigationRevision } =
			await currentNavigationBasis(ctx, args.projectId);
		const sameBasis = await ctx.db
			.query("releaseRecords")
			.withIndex("by_project_and_projection_and_navigationRevision", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("projectionId", projection._id)
					.eq("navigationRevision", navigationRevision),
			)
			.order("desc")
			.take(1);
		const reusable = sameBasis[0];
		if (reusable?.status === "ready") {
			return releaseSummary(reusable);
		}
		if (reusable?.status === "preparing") {
			const preparation = await preparationFor(ctx, reusable._id);
			if (!preparation) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release Record lost its preparation state.",
				});
			}
			if (!preparation.terminal) {
				await ctx.db.patch(preparation._id, {
					stepPending: true,
					updatedAt: now(),
				});
				await ctx.scheduler.runAfter(0, internal.releaseRecords.processStep, {
					recordId: reusable._id,
				});
				return releaseSummary(reusable, preparation);
			}
		}
		const preparing = await ctx.db
			.query("releaseRecords")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.order("desc")
			.take(MAX_RELEASE_HISTORY);
		for (const record of preparing) {
			if (record.status === "preparing") {
				const preparation = await preparationFor(ctx, record._id);
				if (preparation && !preparation.terminal) {
					await queueTerminalCleanup(ctx, record, preparation, {
						status: "superseded",
						completedAt: now(),
					});
				}
			}
		}
		const handoffId = await ctx.db.insert("releaseWorkHandoffs", {
			projectId: args.projectId,
			status: "staging",
			keyCount: 0,
			byteLength: 0,
		});
		const createdAt = now();
		const emptyAssessment = emptyReleaseAssessment();
		const recordId = await ctx.db.insert("releaseRecords", {
			projectId: args.projectId,
			projectionId: projection._id,
			snapshotId,
			commit: projection.commit,
			navigationRevision,
			expectedKeyCount: projection.expectedKeyCount,
			handoffId,
			status: "preparing",
			...emptyAssessment,
			startedBy: { kind: "user", id: userId },
			createdAt,
		});
		const preparationId = await ctx.db.insert("releaseRecordPreparations", {
			projectId: args.projectId,
			recordId,
			cursor: -1,
			...emptyAssessment,
			stepPending: true,
			updatedAt: createdAt,
		});
		await ctx.db.patch(handoffId, { recordId });
		await ctx.scheduler.runAfter(0, internal.releaseRecords.processStep, {
			recordId,
		});
		const [created, preparation] = await Promise.all([
			ctx.db.get(recordId),
			ctx.db.get(preparationId),
		]);
		if (!created || !preparation) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The Release Record disappeared while it was created.",
			});
		}
		return releaseSummary(created, preparation);
	},
});

async function classifyTarget(
	ctx: MutationCtx,
	input: {
		record: Doc<"releaseRecords">;
		digest: Doc<"catalogWorkspaceNavigationRows">;
		target: Doc<"catalogWorkspaceNavigationRows">["targets"][number];
		rows: Doc<"catalogProjectionMessages">[];
		sourceChanges: Doc<"catalogProjectionGitChanges">[];
		residue?: Doc<"catalogProjectionTranslationResidues">;
		sourceProposal: Doc<"catalogWorkspaceSourceProposalHeads"> | null;
	},
) {
	const sourceRow = input.rows.find((row) => row.isSource);
	const targetRow = input.rows.find(
		(row) => !row.isSource && row.localeId === input.target.localeId,
	);
	if (!sourceRow || !targetRow || input.target.valueFingerprint === undefined) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release assessment lost a scoped Source or target value.",
		});
	}
	if (input.digest.pendingSourceProposal && !input.sourceProposal) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release assessment lost a pending Source Proposal.",
		});
	}
	const head = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q
				.eq("projectId", input.record.projectId)
				.eq("messageId", input.digest.messageId)
				.eq("localeId", targetRow.localeId),
		)
		.unique();
	const currentHead = head
		? currentHeadForRow(targetRow, new Map([[valueIdentity(targetRow), head]]))
		: undefined;
	const visibleSourceFingerprint =
		currentHead?.sourceFingerprint ?? targetRow.sourceFingerprint;
	const decisionSourceFingerprint = input.digest.pendingSourceProposal
		? visibleSourceFingerprint === sourceRow.sourceFingerprint ||
			visibleSourceFingerprint === input.sourceProposal?.sourceFingerprint
			? visibleSourceFingerprint
			: (input.sourceProposal?.sourceFingerprint ?? sourceRow.sourceFingerprint)
		: sourceRow.sourceFingerprint;
	const decision = await decisionForIdentity(ctx, {
		projectId: input.record.projectId,
		messageId: input.digest.messageId,
		localeId: targetRow.localeId,
		sourceFingerprint: decisionSourceFingerprint,
		valueFingerprint: input.target.valueFingerprint,
	});
	const findings: Array<{
		kind:
			| "contract_invalid"
			| "missing_value"
			| "semantic_source_change"
			| "introduction_review";
		reasonCodes?: Doc<"catalogProjectionTranslationResidues">["reasons"][number]["code"][];
	}> = [];
	let contractInvalid = false;
	try {
		// Source Proposals are value-only: proving that the pending value keeps
		// the persisted Source Contract makes that same contract authoritative
		// for every target assessed below.
		if (input.sourceProposal) {
			assertSourceProposalValueContract({
				messageId: input.digest.messageId,
				localeCode: sourceRow.localeCode,
				value: input.sourceProposal.sourceValue,
				source: sourceRow,
			});
		}
		assertTargetValueContract({
			messageId: input.digest.messageId,
			localeCode: targetRow.localeCode,
			value: currentHead?.value ?? targetRow.value,
			source: sourceRow,
		});
	} catch {
		contractInvalid = true;
	}
	if (contractInvalid) {
		findings.push({
			kind: "contract_invalid",
			...(input.residue === undefined
				? {}
				: { reasonCodes: input.residue.reasons.map((reason) => reason.code) }),
		});
	}
	if (input.target.valueState === "waiting") {
		findings.push({ kind: "missing_value" });
	}
	if (
		input.target.valueState === "stale" &&
		!input.digest.pendingSourceProposal
	) {
		const previousDecision = await latestDecisionForValue(ctx, {
			projectId: input.record.projectId,
			messageId: input.digest.messageId,
			localeId: targetRow.localeId,
			valueFingerprint: input.target.valueFingerprint,
		});
		const sourceChangeKind =
			previousDecision?.kind === "translatorConfirmation"
				? sourceChangeKindForConfirmation({
						messageId: input.digest.messageId,
						confirmedSourceFingerprint: previousDecision.sourceFingerprint,
						currentSourceFingerprint: sourceRow.sourceFingerprint,
						sourceChangesByIdentity: sourceChangeMap(input.sourceChanges),
					})
				: "semantic";
		if (sourceChangeKind === "semantic") {
			findings.push({ kind: "semantic_source_change" });
		}
	}
	// Waiting, invalid, and semantic-stale findings already demand the same
	// human gesture that completes First Review. Add introduction_review only
	// when provenance is the otherwise invisible reason this current value must
	// be examined, so one target never reports two decisions for one action.
	if (input.target.firstReviewPending === true && findings.length === 0) {
		findings.push({ kind: "introduction_review" });
	}
	const sourceValueFingerprint = input.digest.pendingSourceProposal
		? await sha256Hex(input.sourceProposal?.sourceValue ?? sourceRow.value)
		: (sourceRow.valueFingerprint ?? (await sha256Hex(sourceRow.value)));
	const evidence = deliberateEvidenceFor({
		decision,
		targetValueFingerprint: input.target.valueFingerprint,
		sourceValueFingerprint,
	});
	return { findings, evidence };
}

export const processStep = internalMutation({
	args: { recordId: v.id("releaseRecords") },
	returns: v.union(v.null(), releaseSummaryValidator),
	handler: async (ctx, args) => {
		try {
			const record = await ctx.db.get(args.recordId);
			if (!record) return null;
			if (record.status !== "preparing") return releaseSummary(record);
			const preparation = await preparationFor(ctx, record._id);
			if (!preparation) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release Record lost its preparation state.",
				});
			}
			if (!preparation.stepPending) {
				return releaseSummary(record, preparation);
			}
			await ctx.db.patch(preparation._id, { stepPending: false });
			if (preparation.terminal) {
				return await processTerminalCleanup(ctx, record, preparation);
			}
			const projection = await activeProjectionFor(ctx, record.projectId);
			const navigation = projection
				? await readyNavigationStateFor(ctx, {
						projectId: record.projectId,
						projectionId: projection._id,
						expectedRowCount: projection.expectedKeyCount,
					}).catch(() => null)
				: null;
			if (
				!projection ||
				projection._id !== record.projectionId ||
				!navigation ||
				(navigation.revision ?? 0) !== record.navigationRevision
			) {
				const cleanup = await queueTerminalCleanup(ctx, record, preparation, {
					status: "superseded",
					completedAt: now(),
				});
				return releaseSummary(record, cleanup);
			}
			const page = await ctx.db
				.query("catalogWorkspaceNavigationRows")
				.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
					q
						.eq("projectId", record.projectId)
						.eq("projectionId", record.projectionId)
						.gt("catalogIndex", preparation.cursor),
				)
				.paginate({
					cursor: null,
					numItems: MAX_RELEASE_ROWS_PER_STEP,
					maximumBytesRead: 512 * 1024,
				});
			const rows = page.page;
			if (!rows.length && !page.isDone)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release scanning did not advance.",
				});
			if (rows.length === 0) {
				const completedAt = now();
				const posture = releasePostureFor(preparation);
				const assessment = releaseAssessmentFrom(preparation);
				await ctx.db.patch(record.handoffId, { status: "published" });
				await ctx.db.delete(preparation._id);
				await ctx.db.patch(record._id, {
					status: "ready",
					posture,
					...assessment,
					completedAt,
				});
				return releaseSummary({
					...record,
					status: "ready",
					posture,
					...assessment,
					completedAt,
				});
			}
			let deltaKeyCount = preparation.deltaKeyCount;
			let scopeValueCount = preparation.scopeValueCount;
			let blockedCount = preparation.blockedCount;
			let needsDecisionCount = preparation.needsDecisionCount;
			let intentionalBlankCount = preparation.intentionalBlankCount;
			let sourceIdenticalCount = preparation.sourceIdenticalCount;
			let unconfirmedImportCount = preparation.unconfirmedImportCount;
			const localeSummaries = localeSummaryMap(preparation.localeSummaries);
			const handoff = await ctx.db.get(record.handoffId);
			if (!handoff || handoff.projectId !== record.projectId) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release assessment lost its Work Hand-off.",
				});
			}
			let handoffKeyCount = handoff.keyCount;
			let handoffByteLength = handoff.byteLength;
			let cursor = preparation.cursor;
			for (const digest of rows) {
				cursor = digest.catalogIndex;
				const isDelta = isReleaseDelta(digest);
				if (!isDelta) continue;
				deltaKeyCount++;
				const [catalogRows, residues, sourceChanges, sourceProposal] =
					await Promise.all([
						ctx.db
							.query("catalogProjectionMessages")
							.withIndex("by_projection_and_messageId", (q) =>
								q
									.eq("projectionId", record.projectionId)
									.eq("messageId", digest.messageId),
							)
							.take(MAX_PROJECTED_LOCALES + 1),
						ctx.db
							.query("catalogProjectionTranslationResidues")
							.withIndex("by_projection_and_messageId", (q) =>
								q
									.eq("projectionId", record.projectionId)
									.eq("messageId", digest.messageId),
							)
							.take(MAX_PROJECTED_LOCALES + 1),
						ctx.db
							.query("catalogProjectionGitChanges")
							.withIndex("by_projection_and_messageId_and_isSource", (q) =>
								q
									.eq("projectionId", record.projectionId)
									.eq("messageId", digest.messageId)
									.eq("isSource", true),
							)
							.take(2),
						digest.pendingSourceProposal
							? sourceProposalHeadFor(ctx, record.projectId, digest.messageId)
							: Promise.resolve(null),
					]);
				if (catalogRows.length > MAX_PROJECTED_LOCALES) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "A Release Scope key exceeds the Locale envelope.",
					});
				}
				let keyHasFinding = false;
				for (const target of digest.targets) {
					const summary =
						localeSummaries.get(target.localeId) ??
						emptyLocaleSummary(target.localeId, target.localeCode);
					const result = await classifyTarget(ctx, {
						record,
						digest,
						target,
						rows: catalogRows,
						sourceChanges,
						residue: residues.find(
							(residue) => residue.localeId === target.localeId,
						),
						sourceProposal,
					});
					const contribution = releaseTargetContribution({
						findings: result.findings,
						evidence: result.evidence,
						unconfirmedImport: target.valueState === "unconfirmedImport",
					});
					scopeValueCount += contribution.scopeValueCount;
					blockedCount += contribution.blockedCount;
					needsDecisionCount += contribution.needsDecisionCount;
					intentionalBlankCount += contribution.intentionalBlankCount;
					sourceIdenticalCount += contribution.sourceIdenticalCount;
					unconfirmedImportCount += contribution.unconfirmedImportCount;
					summary.scopeValueCount += contribution.scopeValueCount;
					summary.blockedCount += contribution.blockedCount;
					summary.needsDecisionCount += contribution.needsDecisionCount;
					summary.intentionalBlankCount += contribution.intentionalBlankCount;
					summary.sourceIdenticalCount += contribution.sourceIdenticalCount;
					summary.unconfirmedImportCount += contribution.unconfirmedImportCount;
					for (const finding of result.findings) {
						keyHasFinding = true;
						await ctx.db.insert("releaseFindings", {
							projectId: record.projectId,
							recordId: record._id,
							catalogIndex: digest.catalogIndex,
							messageId: digest.messageId,
							localeId: target.localeId,
							localeCode: target.localeCode,
							...finding,
						});
					}
					if (result.evidence?.kind === "intentional_blank") {
						await ctx.db.insert("releaseEvidence", {
							projectId: record.projectId,
							recordId: record._id,
							catalogIndex: digest.catalogIndex,
							messageId: digest.messageId,
							localeId: target.localeId,
							localeCode: target.localeCode,
							...result.evidence,
						});
					} else if (result.evidence?.kind === "source_identical") {
						await ctx.db.insert("releaseEvidence", {
							projectId: record.projectId,
							recordId: record._id,
							catalogIndex: digest.catalogIndex,
							messageId: digest.messageId,
							localeId: target.localeId,
							localeCode: target.localeCode,
							kind: "source_identical",
						});
					}
					localeSummaries.set(target.localeId, summary);
				}
				if (keyHasFinding) {
					const key = {
						projectId: record.projectId,
						handoffId: record.handoffId,
						catalogIndex: digest.catalogIndex,
						messageId: digest.messageId,
					};
					const byteLength = encodedSize(key);
					if (
						handoffKeyCount + 1 > MAX_WORKING_CATALOG_KEYS ||
						handoffByteLength + byteLength > MAX_RELEASE_HANDOFF_BYTES
					) {
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message: "Release Work Hand-off exceeds its supported envelope.",
						});
					}
					await ctx.db.insert("releaseWorkHandoffKeys", key);
					handoffKeyCount++;
					handoffByteLength += byteLength;
				}
				// One delta key can span every language. Keep its hydration and classification
				// in one bounded transaction; later keys remain behind the cursor.
				break;
			}
			const updatedAt = now();
			const assessment = releaseAssessmentFrom({
				deltaKeyCount,
				scopeValueCount,
				blockedCount,
				needsDecisionCount,
				intentionalBlankCount,
				sourceIdenticalCount,
				unconfirmedImportCount,
				localeSummaries: sortedLocaleSummaries(localeSummaries),
			});
			await ctx.db.patch(record.handoffId, {
				keyCount: handoffKeyCount,
				byteLength: handoffByteLength,
			});
			await ctx.db.patch(preparation._id, {
				cursor,
				...assessment,
				stepPending: true,
				updatedAt,
			});
			await ctx.scheduler.runAfter(0, internal.releaseRecords.processStep, {
				recordId: record._id,
			});
			return releaseSummary(record, {
				...preparation,
				cursor,
				...assessment,
			});
		} catch (error) {
			const record = await ctx.db.get(args.recordId);
			if (!record) throw error;
			const failure = releaseFailureFor(error);
			const existing = await preparationFor(ctx, record._id);
			const preparation =
				existing ??
				(await ctx.db.get(
					await ctx.db.insert("releaseRecordPreparations", {
						projectId: record.projectId,
						recordId: record._id,
						cursor: -1,
						...emptyReleaseAssessment(),
						stepPending: true,
						updatedAt: failure.failedAt,
					}),
				));
			if (!preparation) throw error;
			const cleanup = await queueTerminalCleanup(ctx, record, preparation, {
				status: "failed",
				failure,
				completedAt: failure.failedAt,
			});
			return releaseSummary(record, cleanup);
		}
	},
});

export const current = query({
	args: { projectId: v.id("projects") },
	returns: v.union(
		v.object({ kind: v.literal("noBaseline") }),
		v.object({
			kind: v.literal("available"),
			projectionId: v.id("catalogProjections"),
			commit: v.string(),
			canPrepare: v.boolean(),
			basisCurrent: v.boolean(),
			historyCursor: v.string(),
			current: v.union(releaseSummaryValidator, v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const { member } = await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection?.snapshotId) return { kind: "noBaseline" as const };
		const state = await ctx.db
			.query("catalogWorkspaceNavigationStates")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.unique();
		const recordPage = await ctx.db
			.query("releaseRecords")
			.withIndex("by_project_and_createdAt", (q) =>
				q.eq("projectId", args.projectId),
			)
			.order("desc")
			.paginate({ cursor: null, numItems: 1 });
		const current = recordPage.page[0] ?? null;
		const preparation =
			current?.status === "preparing"
				? await preparationFor(ctx, current._id)
				: null;
		const navigationCurrent = Boolean(
			state?.status === "ready" &&
				state.projectionId === projection._id &&
				state.ordinaryImportCounts !== undefined &&
				state.rowCount === projection.expectedKeyCount &&
				state.expectedRowCount === projection.expectedKeyCount,
		);
		const basisCurrent = Boolean(
			current &&
				current.projectionId === projection._id &&
				navigationCurrent &&
				state?.projectionId === current.projectionId &&
				(state?.revision ?? 0) === current.navigationRevision,
		);
		return {
			kind: "available" as const,
			projectionId: projection._id,
			commit: projection.commit,
			canPrepare: member.role !== "viewer" && navigationCurrent,
			basisCurrent,
			historyCursor: recordPage.continueCursor,
			current: current ? releaseSummary(current, preparation) : null,
		};
	},
});

export const history = query({
	args: {
		projectId: v.id("projects"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		records: v.array(releaseSummaryValidator),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		if (
			!Number.isSafeInteger(args.paginationOpts.numItems) ||
			args.paginationOpts.numItems < 1 ||
			args.paginationOpts.numItems > MAX_RELEASE_HISTORY
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Release history pagination is invalid.",
			});
		}
		const page = await ctx.db
			.query("releaseRecords")
			.withIndex("by_project_and_createdAt", (q) =>
				q.eq("projectId", args.projectId),
			)
			.order("desc")
			.paginate(args.paginationOpts);
		return {
			records: page.page.map((record) => releaseSummary(record)),
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

export const details = query({
	args: {
		recordId: v.id("releaseRecords"),
		findingCursor: v.number(),
		evidenceCursor: v.number(),
		limit: v.number(),
	},
	returns: v.object({
		findings: v.array(findingValidator),
		evidence: v.array(evidenceValidator),
		nextFindingCursor: v.union(v.number(), v.null()),
		nextEvidenceCursor: v.union(v.number(), v.null()),
	}),
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Release Record not found.",
			});
		}
		await requireViewer(ctx, record.projectId);
		assertPublishedEvidence(record);
		if (
			!Number.isSafeInteger(args.limit) ||
			args.limit < 1 ||
			args.limit > MAX_RELEASE_DETAIL_PAGE
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Release detail pagination is invalid.",
			});
		}
		const [findingRows, evidenceRows] = await Promise.all([
			ctx.db
				.query("releaseFindings")
				.withIndex("by_record_and_catalogIndex", (q) =>
					q
						.eq("recordId", args.recordId)
						.gt("catalogIndex", args.findingCursor),
				)
				.take(args.limit + MAX_PROJECTED_LOCALES * 2 + 1),
			ctx.db
				.query("releaseEvidence")
				.withIndex("by_record_and_catalogIndex", (q) =>
					q
						.eq("recordId", args.recordId)
						.gt("catalogIndex", args.evidenceCursor),
				)
				.take(args.limit + MAX_PROJECTED_LOCALES + 1),
		]);
		const findingBoundary =
			findingRows[Math.min(args.limit, findingRows.length) - 1]?.catalogIndex;
		const evidenceBoundary =
			evidenceRows[Math.min(args.limit, evidenceRows.length) - 1]?.catalogIndex;
		const findingPage = findingRows.filter(
			(row) =>
				findingBoundary === undefined || row.catalogIndex <= findingBoundary,
		);
		const evidencePage = evidenceRows.filter(
			(row) =>
				evidenceBoundary === undefined || row.catalogIndex <= evidenceBoundary,
		);
		return {
			findings: findingPage.map(
				({
					_id,
					catalogIndex,
					messageId,
					localeId,
					localeCode,
					kind,
					reasonCodes,
				}) => ({
					_id,
					catalogIndex,
					messageId,
					localeId,
					localeCode,
					kind,
					...(reasonCodes === undefined ? {} : { reasonCodes }),
				}),
			),
			evidence: evidencePage.map(evidenceSummary),
			nextFindingCursor:
				findingRows.length > findingPage.length
					? (findingPage[findingPage.length - 1]?.catalogIndex ?? null)
					: null,
			nextEvidenceCursor:
				evidenceRows.length > evidencePage.length
					? (evidencePage[evidencePage.length - 1]?.catalogIndex ?? null)
					: null,
		};
	},
});

/** Page the complete evidence ledger independently from findings. This is the
 * UI-facing read: every recorded exception stays inspectable without loading
 * the whole Release Record into one subscription. */
export const evidence = query({
	args: {
		recordId: v.id("releaseRecords"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		page: v.array(evidenceValidator),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Release Record not found.",
			});
		}
		await requireViewer(ctx, record.projectId);
		assertPublishedEvidence(record);
		if (
			!Number.isSafeInteger(args.paginationOpts.numItems) ||
			args.paginationOpts.numItems < 1 ||
			args.paginationOpts.numItems > MAX_RELEASE_DETAIL_PAGE
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Release evidence pagination is invalid.",
			});
		}
		const page = await ctx.db
			.query("releaseEvidence")
			.withIndex("by_record_and_catalogIndex", (q) =>
				q.eq("recordId", args.recordId),
			)
			.paginate(args.paginationOpts);
		return {
			page: page.page.map(evidenceSummary),
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

export const handoff = query({
	args: {
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
	},
	returns: v.object({
		recordId: v.id("releaseRecords"),
		status: v.union(
			v.literal("staging"),
			v.literal("published"),
			v.literal("stale"),
		),
		keys: v.array(
			v.object({ catalogIndex: v.number(), messageId: v.string() }),
		),
	}),
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record || record.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Release Record not found.",
			});
		}
		await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, record.projectId);
		const navigation = projection
			? await readyNavigationStateFor(ctx, {
					projectId: record.projectId,
					projectionId: projection._id,
					expectedRowCount: projection.expectedKeyCount,
				}).catch(() => null)
			: null;
		if (
			(record.status !== "ready" && record.status !== "preparing") ||
			!projection ||
			projection._id !== record.projectionId ||
			!navigation ||
			(navigation.revision ?? 0) !== record.navigationRevision
		) {
			return { recordId: record._id, status: "stale" as const, keys: [] };
		}
		const handoff = await ctx.db.get(record.handoffId);
		if (!handoff || handoff.projectId !== record.projectId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release Record lost its Work Hand-off.",
			});
		}
		if (handoff.status === "staging") {
			return { recordId: record._id, status: handoff.status, keys: [] };
		}
		const keys = await ctx.db
			.query("releaseWorkHandoffKeys")
			.withIndex("by_handoff", (q) => q.eq("handoffId", handoff._id))
			.take(MAX_WORKING_CATALOG_KEYS + 1);
		if (
			keys.length > MAX_WORKING_CATALOG_KEYS ||
			keys.length !== handoff.keyCount
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release Work Hand-off contradicts its envelope.",
			});
		}
		return {
			recordId: record._id,
			status: handoff.status,
			keys: keys.map(({ catalogIndex, messageId }) => ({
				catalogIndex,
				messageId,
			})),
		};
	},
});
