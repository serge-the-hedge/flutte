import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./_generated/server";
import {
	type AgentReviewAuthorization,
	isHumanOrAuthorizedReview,
} from "./agentReviewModel";
import {
	activeProjectionFor,
	MAX_WORKING_CATALOG_ROWS,
} from "./catalogProjection";
import { decisionForIdentity } from "./catalogWorkspaceDecisionQueries";
import { recomputeNavigationRows } from "./catalogWorkspaceNavigation";
import {
	decisionIdentity,
	encodedSize,
	isCurrentHeadForRow,
} from "./catalogWorkspaceView";
import {
	assertSourceProposalValueContract,
	assertTargetValueContract,
} from "./contractTransforms";
import { type Actor, now, sha256Hex } from "./lib";
import { assertMessageCharacterLimit } from "./messageConstraints";
import { requireEditor } from "./permissions";
import {
	isCurrentSourceProposalHeadForSource,
	MAX_SOURCE_PROPOSAL_VALUE_BYTES,
	publishedResolutionFor,
	saveSourceProposal,
	sourceProposalHeadFor,
} from "./sourceProposals";
import {
	appendTranslationHistory,
	recordTranslationConfirmation,
	retainWorkspaceValue,
} from "./translationHistoryWrite";

/** Storage envelopes are independent of transaction reads: all current-value
 * and decision lookups use bounded indexes, including ordinary import runs. */
export const MAX_CATALOG_WORKSPACE_VALUE_HEADS = MAX_WORKING_CATALOG_ROWS;
export const MAX_CATALOG_WORKSPACE_VALUE_HEAD_BYTES = 12 * 1024 * 1024;
export const MAX_CATALOG_WORKSPACE_VALUE_BYTES = 256 * 1024;
export const MAX_CATALOG_WORKSPACE_DECISION_RECORDS = 100_000;
export const MAX_CATALOG_WORKSPACE_DECISION_RECORD_BYTES = 32 * 1024 * 1024;
export const MAX_INTENTIONAL_BLANK_REASON_BYTES = 4 * 1024;
const MAX_RECONCILED_VALUE_HEADS_PER_MUTATION = 8;

const commitIntentValidator = v.union(
	v.object({ kind: v.literal("save"), value: v.string() }),
	v.object({ kind: v.literal("confirm") }),
	v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
);

type CatalogWorkspaceValueHeadInput = {
	messageId: string;
	localeId: Id<"locales">;
	value: string;
	valueFingerprint?: string;
	sourceFingerprint: string;
	basisGitValueFingerprint: string;
	basisGitValueRevision: number;
	revision: number;
	reconciliationGeneration: number;
	updatedBy: Actor;
	reviewAuthorization?: AgentReviewAuthorization;
	updatedAt: number;
};
type CatalogWorkspaceDecisionBasis = {
	deliveryProjectionId?: Id<"catalogProjections">;
	localeProposalId?: Id<"localeProposals">;
	messageId: string;
	localeId: Id<"locales">;
	sourceFingerprint: string;
	valueFingerprint: string;
	recordedBy: Actor;
	reviewAuthorization?: AgentReviewAuthorization;
	recordedAt: number;
};
type CatalogWorkspaceDecisionRecordInput =
	| (CatalogWorkspaceDecisionBasis & {
			kind: "intentionalBlank";
			reason: string;
	  })
	| (CatalogWorkspaceDecisionBasis & { kind: "translatorConfirmation" });

function valueHeadByteLength(head: CatalogWorkspaceValueHeadInput): number {
	return encodedSize({
		messageId: head.messageId,
		localeId: head.localeId,
		value: head.value,
		...(head.valueFingerprint === undefined
			? {}
			: { valueFingerprint: head.valueFingerprint }),
		sourceFingerprint: head.sourceFingerprint,
		basisGitValueFingerprint: head.basisGitValueFingerprint,
		basisGitValueRevision: head.basisGitValueRevision,
		revision: head.revision,
		reconciliationGeneration: head.reconciliationGeneration,
		updatedBy: head.updatedBy,
		...(head.reviewAuthorization
			? { reviewAuthorization: head.reviewAuthorization }
			: {}),
		updatedAt: head.updatedAt,
	});
}

export function decisionRecordByteLength(
	head: CatalogWorkspaceDecisionRecordInput,
): number {
	return encodedSize({
		kind: head.kind,
		...(head.deliveryProjectionId
			? { deliveryProjectionId: head.deliveryProjectionId }
			: {}),
		...(head.localeProposalId
			? { localeProposalId: head.localeProposalId }
			: {}),
		messageId: head.messageId,
		localeId: head.localeId,
		sourceFingerprint: head.sourceFingerprint,
		valueFingerprint: head.valueFingerprint,
		...(head.kind === "intentionalBlank" ? { reason: head.reason } : {}),
		recordedBy: head.recordedBy,
		...(head.reviewAuthorization
			? { reviewAuthorization: head.reviewAuthorization }
			: {}),
		recordedAt: head.recordedAt,
	});
}

async function workspaceStateFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogWorkspaceStates"> | null> {
	return await ctx.db
		.query("catalogWorkspaceStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

export async function decisionStateFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogWorkspaceDecisionStates"> | null> {
	return await ctx.db
		.query("catalogWorkspaceDecisionStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

function assertIntentionalBlankReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed.length === 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An Intentional Blank needs a non-empty reason.",
		});
	}
	if (
		new TextEncoder().encode(trimmed).byteLength >
		MAX_INTENTIONAL_BLANK_REASON_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"An Intentional Blank reason exceeds the supported byte envelope.",
		});
	}
	return trimmed;
}

/** Persist exact human decisions without replacing evidence for different
 * content. The collection envelope is updated once, which makes one-value and
 * bounded batch confirmation share the same atomic evidence path. */
export async function recordDecisions(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		state: Doc<"catalogWorkspaceDecisionStates"> | null;
		next: readonly CatalogWorkspaceDecisionRecordInput[];
	},
): Promise<void> {
	const identities = new Set<string>();
	for (const next of input.next) {
		const identity = decisionIdentity(next);
		if (identities.has(identity)) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A decision batch contains a duplicate Locale value.",
			});
		}
		identities.add(identity);
	}
	const previous = await Promise.all(
		input.next.map((next) =>
			decisionForIdentity(
				ctx,
				{ projectId: input.projectId, ...next },
				next.deliveryProjectionId,
			),
		),
	);
	if (!input.state && previous.some((record) => record !== null)) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace decision records are missing their project envelope.",
		});
	}
	const additions = input.next.filter((_, index) => previous[index] === null);
	if (additions.length === 0) return;
	const additionalByteLength = additions.reduce(
		(total, next) => total + decisionRecordByteLength(next),
		0,
	);
	const nextCount = (input.state?.decisionRecordCount ?? 0) + additions.length;
	const nextTotalByteLength =
		(input.state?.decisionRecordByteLength ?? 0) + additionalByteLength;
	if (
		nextCount > MAX_CATALOG_WORKSPACE_DECISION_RECORDS ||
		nextTotalByteLength > MAX_CATALOG_WORKSPACE_DECISION_RECORD_BYTES
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message:
				"Catalog Workspace exceeds its supported decision-record envelope.",
		});
	}
	for (const next of additions) {
		await ctx.db.insert("catalogWorkspaceDecisionRecords", {
			projectId: input.projectId,
			...next,
		});
		await recordTranslationConfirmation(ctx, {
			projectId: input.projectId,
			...next,
		});
	}
	if (input.state) {
		await ctx.db.patch(input.state._id, {
			decisionRecordCount: nextCount,
			decisionRecordByteLength: nextTotalByteLength,
		});
	} else {
		await ctx.db.insert("catalogWorkspaceDecisionStates", {
			projectId: input.projectId,
			decisionRecordCount: nextCount,
			decisionRecordByteLength: nextTotalByteLength,
		});
	}
}

async function recordDecision(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		state: Doc<"catalogWorkspaceDecisionStates"> | null;
		next: CatalogWorkspaceDecisionRecordInput;
	},
): Promise<void> {
	await recordDecisions(ctx, { ...input, next: [input.next] });
}

async function upsertValueHead(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		state: Doc<"catalogWorkspaceStates"> | null;
		previous: Doc<"catalogWorkspaceValueHeads"> | null;
		next: CatalogWorkspaceValueHeadInput;
		historyKind?: "saved" | "accepted";
		intentionalBlankReason?: string;
	},
): Promise<void> {
	if (!input.state && input.previous) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace value heads are missing their project envelope.",
		});
	}
	const previousByteLength = input.previous
		? valueHeadByteLength(input.previous)
		: 0;
	const nextByteLength = valueHeadByteLength(input.next);
	const nextCount =
		(input.state?.valueHeadCount ?? 0) + (input.previous ? 0 : 1);
	const nextTotalByteLength =
		(input.state?.valueHeadByteLength ?? 0) -
		previousByteLength +
		nextByteLength;
	if (
		nextCount > MAX_CATALOG_WORKSPACE_VALUE_HEADS ||
		nextTotalByteLength > MAX_CATALOG_WORKSPACE_VALUE_HEAD_BYTES
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Catalog Workspace exceeds its supported value-head envelope.",
		});
	}
	if (!input.previous || input.previous.revision !== input.next.revision) {
		await retainWorkspaceValue(ctx, input.previous);
		await appendTranslationHistory(ctx, {
			projectId: input.projectId,
			messageId: input.next.messageId,
			localeId: input.next.localeId,
			kind: input.historyKind ?? "saved",
			value: input.next.value,
			sourceFingerprint: input.next.sourceFingerprint,
			actor: input.next.updatedBy,
			reviewAuthorization: input.next.reviewAuthorization,
			recordedAt: input.next.updatedAt,
			intentionalBlankReason: input.intentionalBlankReason,
		});
	}
	if (input.previous) {
		await ctx.db.patch(input.previous._id, {
			...input.next,
			reviewAuthorization: input.next.reviewAuthorization,
		});
	} else {
		await ctx.db.insert("catalogWorkspaceValueHeads", {
			projectId: input.projectId,
			...input.next,
		});
	}
	if (input.state) {
		await ctx.db.patch(input.state._id, {
			valueHeadCount: nextCount,
			valueHeadByteLength: nextTotalByteLength,
		});
	} else {
		await ctx.db.insert("catalogWorkspaceStates", {
			projectId: input.projectId,
			valueHeadCount: nextCount,
			valueHeadByteLength: nextTotalByteLength,
			reconciliationGeneration: 0,
		});
	}
}

async function ensureWorkspaceState(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	state: Doc<"catalogWorkspaceStates"> | null,
): Promise<void> {
	if (state) return;
	await ctx.db.insert("catalogWorkspaceStates", {
		projectId,
		valueHeadCount: 0,
		valueHeadByteLength: 0,
		reconciliationGeneration: 0,
	});
}

function assertReconciliationGeneration(generation: number): void {
	if (!Number.isSafeInteger(generation) || generation < 0) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace has an invalid reconciliation generation.",
		});
	}
}

/** Advance the retained-value lifecycle with the Baseline publication that
 * changed its Git evidence. Cleanup is intentionally deferred and bounded:
 * visibility compares fingerprints immediately, while this worker reclaims
 * obsolete durable heads without making publication depend on their volume. */
export async function advanceWorkspaceReconciliationGeneration(
	ctx: MutationCtx,
	projectId: Id<"projects">,
): Promise<void> {
	const state = await workspaceStateFor(ctx, projectId);
	if (!state) return;
	assertReconciliationGeneration(state.reconciliationGeneration);
	await ctx.db.patch(state._id, {
		reconciliationGeneration: state.reconciliationGeneration + 1,
	});
	await ctx.scheduler.runAfter(
		0,
		internal.catalogWorkspace.reconcileValueHeads,
		{ projectId },
	);
}

export const reconcileValueHeads = internalMutation({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const state = await workspaceStateFor(ctx, args.projectId);
		if (!state) return null;
		assertReconciliationGeneration(state.reconciliationGeneration);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Catalog Workspace cannot reconcile heads without an active Baseline Catalog.",
			});
		}
		const stale = await ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project_and_reconciliationGeneration", (q) =>
				q
					.eq("projectId", args.projectId)
					.lt("reconciliationGeneration", state.reconciliationGeneration),
			)
			.take(MAX_RECONCILED_VALUE_HEADS_PER_MUTATION + 1);
		const heads = stale.slice(0, MAX_RECONCILED_VALUE_HEADS_PER_MUTATION);
		let nextHeadCount = state.valueHeadCount;
		let nextHeadByteLength = state.valueHeadByteLength;
		for (const head of heads) {
			const target = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_localeId", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", head.messageId)
						.eq("localeId", head.localeId),
				)
				.unique();
			const previousByteLength = valueHeadByteLength(head);
			if (
				!target ||
				target.isSource ||
				target.gitValueFingerprint !== head.basisGitValueFingerprint ||
				(target.gitValueRevision ?? 0) !== head.basisGitValueRevision
			) {
				await retainWorkspaceValue(ctx, head);
				await ctx.db.delete(head._id);
				nextHeadCount--;
				nextHeadByteLength -= previousByteLength;
				continue;
			}
			const reconciled = {
				...head,
				reconciliationGeneration: state.reconciliationGeneration,
			};
			await ctx.db.patch(head._id, {
				reconciliationGeneration: state.reconciliationGeneration,
			});
			nextHeadByteLength +=
				valueHeadByteLength(reconciled) - previousByteLength;
		}
		if (nextHeadCount < 0 || nextHeadByteLength < 0) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace reconciled an invalid value-head envelope.",
			});
		}
		if (
			nextHeadCount !== state.valueHeadCount ||
			nextHeadByteLength !== state.valueHeadByteLength
		) {
			await ctx.db.patch(state._id, {
				valueHeadCount: nextHeadCount,
				valueHeadByteLength: nextHeadByteLength,
			});
		}
		if (stale.length > MAX_RECONCILED_VALUE_HEADS_PER_MUTATION) {
			await ctx.scheduler.runAfter(
				0,
				internal.catalogWorkspace.reconcileValueHeads,
				args,
			);
		}
		return null;
	},
});

/** Apply one reviewed Agent Translation Proposal value through the same
 * concurrency and contract checks as a direct Catalog Workspace edit. The
 * proposal module owns evidence and review history; this helper owns the one
 * current-value write so the two paths cannot drift. */
export async function applyAgentTargetValue(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		messageId: string;
		localeId: Id<"locales">;
		value: string;
		expectedProjectionId: Id<"catalogProjections">;
		expectedSnapshotId: Id<"sourceSnapshots">;
		expectedGitValueFingerprint: string;
		expectedGitValueRevision: number;
		expectedWorkspaceRevision: number;
		expectedSourceFingerprint: string;
		actor: { kind: "user" | "agent"; id: string };
		reviewAuthorization?: AgentReviewAuthorization;
		intentionalBlankReason?: string;
	},
): Promise<{ workspaceRevision: number }> {
	await assertMessageCharacterLimit(ctx, input, input.value);
	if (!isHumanOrAuthorizedReview(input.actor, input.reviewAuthorization)) {
		throw new ConvexError({
			code: "FORBIDDEN",
			message: "Agent application requires explicit review authorization.",
		});
	}
	if (
		!Number.isSafeInteger(input.expectedGitValueRevision) ||
		input.expectedGitValueRevision < 0 ||
		!Number.isInteger(input.expectedWorkspaceRevision) ||
		input.expectedWorkspaceRevision < 0
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog Workspace revisions must be non-negative integers.",
		});
	}
	const [project, projection] = await Promise.all([
		ctx.db.get(input.projectId),
		activeProjectionFor(ctx, input.projectId),
	]);
	const sourceLocaleId = project?.sourceLocaleId;
	if (!project || !sourceLocaleId || !projection) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "No active Baseline Catalog is available for this project.",
		});
	}
	if (
		projection._id !== input.expectedProjectionId ||
		projection.snapshotId !== input.expectedSnapshotId
	) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Baseline Catalog changed after this proposal revision.",
		});
	}
	const [source, target] = await Promise.all([
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", input.messageId)
					.eq("localeId", sourceLocaleId),
			)
			.unique(),
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", input.messageId)
					.eq("localeId", input.localeId),
			)
			.unique(),
	]);
	if (!source?.isSource || !target || target.isSource) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message:
				"The reviewed proposal no longer addresses an active target Locale value.",
		});
	}
	if (
		target.gitValueFingerprint === undefined ||
		target.gitValueFingerprint !== input.expectedGitValueFingerprint ||
		(target.gitValueRevision ?? 0) !== input.expectedGitValueRevision
	) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Git target value changed after this proposal revision.",
		});
	}
	const sourceProposalHead = await sourceProposalHeadFor(
		ctx,
		input.projectId,
		input.messageId,
	);
	const sourceProposalResolution = sourceProposalHead
		? await publishedResolutionFor(ctx, {
				_id: sourceProposalHead.proposalId,
				projectId: input.projectId,
				messageId: input.messageId,
			})
		: null;
	const effectiveSource =
		isCurrentSourceProposalHeadForSource(source, sourceProposalHead) &&
		!sourceProposalResolution
			? {
					...source,
					value: sourceProposalHead.sourceValue,
					valueFingerprint: sourceProposalHead.sourceFingerprint,
					sourceFingerprint: sourceProposalHead.sourceFingerprint,
				}
			: source;
	if (effectiveSource.sourceFingerprint !== input.expectedSourceFingerprint) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Source Contract changed after this proposal revision.",
		});
	}
	const [state, head, decisionState] = await Promise.all([
		workspaceStateFor(ctx, input.projectId),
		ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project_and_messageId_and_localeId", (q) =>
				q
					.eq("projectId", input.projectId)
					.eq("messageId", input.messageId)
					.eq("localeId", input.localeId),
			)
			.unique(),
		decisionStateFor(ctx, input.projectId),
	]);
	const currentHead = isCurrentHeadForRow(target, head) ? head : undefined;
	if ((currentHead?.revision ?? 0) !== input.expectedWorkspaceRevision) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message:
				"The Catalog Workspace value changed after this proposal revision.",
		});
	}
	const timestamp = now();
	const isIntentionalBlank = input.intentionalBlankReason !== undefined;
	const intentionalBlankReason = input.intentionalBlankReason;
	if (isIntentionalBlank) {
		if (effectiveSource.value.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"An Intentional Blank is only meaningful for a non-empty source value.",
			});
		}
		if (intentionalBlankReason === undefined) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "An Intentional Blank requires a reason.",
			});
		}
		assertIntentionalBlankReason(intentionalBlankReason);
	} else {
		if (input.value.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A reviewed proposal value cannot be empty.",
			});
		}
		if (
			new TextEncoder().encode(input.value).byteLength >
			MAX_CATALOG_WORKSPACE_VALUE_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"One Catalog Workspace value exceeds the supported byte envelope.",
			});
		}
		assertTargetValueContract({
			messageId: input.messageId,
			localeCode: target.localeCode,
			value: input.value,
			source: effectiveSource,
		});
	}
	const nextRevision = (head?.revision ?? 0) + 1;
	const value = isIntentionalBlank ? "" : input.value;
	const valueFingerprint = await sha256Hex(value);
	const nextHead: CatalogWorkspaceValueHeadInput = {
		messageId: input.messageId,
		localeId: input.localeId,
		value,
		valueFingerprint,
		sourceFingerprint: effectiveSource.sourceFingerprint,
		basisGitValueFingerprint: target.gitValueFingerprint,
		basisGitValueRevision: target.gitValueRevision ?? 0,
		revision: nextRevision,
		reconciliationGeneration: state?.reconciliationGeneration ?? 0,
		updatedBy: input.actor,
		reviewAuthorization: input.reviewAuthorization,
		updatedAt: timestamp,
	};
	await upsertValueHead(ctx, {
		projectId: input.projectId,
		state,
		previous: head,
		next: nextHead,
		historyKind: "accepted",
		intentionalBlankReason,
	});
	const valueBasis = {
		messageId: input.messageId,
		localeId: input.localeId,
		sourceFingerprint: effectiveSource.sourceFingerprint,
		recordedBy: input.actor,
		reviewAuthorization: input.reviewAuthorization,
		recordedAt: timestamp,
		valueFingerprint,
	};
	if (isIntentionalBlank) {
		if (intentionalBlankReason === undefined) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "An Intentional Blank requires a reason.",
			});
		}
		await recordDecision(ctx, {
			projectId: input.projectId,
			state: decisionState,
			next: {
				...valueBasis,
				kind: "intentionalBlank",
				reason: intentionalBlankReason,
			},
		});
	} else {
		await recordDecision(ctx, {
			projectId: input.projectId,
			state: decisionState,
			next: { ...valueBasis, kind: "translatorConfirmation" },
		});
	}
	// Keep the Navigation Index atomically current with the accepted proposal.
	await recomputeNavigationRows(ctx, {
		projectId: input.projectId,
		messageIds: [input.messageId],
	});
	return { workspaceRevision: nextRevision };
}

type CatalogWorkspaceCommitInput = {
	projectId: Id<"projects">;
	messageId: string;
	localeId: Id<"locales">;
	intent:
		| {
				kind: "save";
				value: string;
		  }
		| {
				kind: "confirm";
		  }
		| {
				kind: "intentionalBlank";
				reason: string;
		  };
	expectedGitValueFingerprint: string;
	expectedGitValueRevision: number;
	expectedWorkspaceRevision: number;
	expectedSourceFingerprint?: string;
};

/** The whole compare-and-save commit body, extracted so the mutation can run
 * the Navigation Index projector over the touched key in the same transaction
 * after the canonical write lands. */
async function commitCatalogWorkspaceValue(
	ctx: MutationCtx,
	args: CatalogWorkspaceCommitInput,
): Promise<{ workspaceRevision: number; sourceFingerprint: string }> {
	const { userId } = await requireEditor(ctx, args.projectId);
	if (
		!Number.isSafeInteger(args.expectedGitValueRevision) ||
		args.expectedGitValueRevision < 0 ||
		!Number.isInteger(args.expectedWorkspaceRevision) ||
		args.expectedWorkspaceRevision < 0
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog Workspace revisions must be non-negative integers.",
		});
	}
	const [project, projection] = await Promise.all([
		ctx.db.get(args.projectId),
		activeProjectionFor(ctx, args.projectId),
	]);
	const sourceLocaleId = project?.sourceLocaleId;
	if (!project || !sourceLocaleId || !projection) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "No active Baseline Catalog is available for this project.",
		});
	}
	const [source, target] = await Promise.all([
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", args.messageId)
					.eq("localeId", sourceLocaleId),
			)
			.unique(),
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", args.messageId)
					.eq("localeId", args.localeId),
			)
			.unique(),
	]);
	if (!source?.isSource || !target) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message:
				"The requested Catalog Workspace value is not in the active Baseline Catalog.",
		});
	}
	if (target.isSource) {
		if (target.localeId !== sourceLocaleId || args.intent.kind !== "save") {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Source Proposal changes its value only; confirmations and Intentional Blanks apply to targets.",
			});
		}
		const sourceGitValueFingerprint =
			source.gitValueFingerprint ?? source.sourceFingerprint;
		if (
			sourceGitValueFingerprint !== args.expectedGitValueFingerprint ||
			(source.gitValueRevision ?? 0) !== args.expectedGitValueRevision
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The Git source value changed before this Source Proposal could be saved.",
			});
		}
		const sourceProposalHead = await sourceProposalHeadFor(
			ctx,
			args.projectId,
			args.messageId,
		);
		const sourceProposalResolution = sourceProposalHead
			? await publishedResolutionFor(ctx, {
					_id: sourceProposalHead.proposalId,
					projectId: args.projectId,
					messageId: args.messageId,
				})
			: null;
		const currentSourceProposal =
			isCurrentSourceProposalHeadForSource(source, sourceProposalHead) &&
			!sourceProposalResolution
				? sourceProposalHead
				: undefined;
		if (
			(currentSourceProposal?.revision ?? 0) !== args.expectedWorkspaceRevision
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The Source Proposal changed before this Catalog Workspace edit could be saved.",
			});
		}
		if (
			new TextEncoder().encode(args.intent.value).byteLength >
			MAX_SOURCE_PROPOSAL_VALUE_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"One Source Proposal value exceeds the supported byte envelope.",
			});
		}
		assertSourceProposalValueContract({
			messageId: args.messageId,
			localeCode: source.localeCode,
			value: args.intent.value,
			source,
		});
		if (!projection.snapshotId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Source Proposal requires a published Baseline Snapshot.",
			});
		}
		const sourceFingerprint = await sha256Hex(args.intent.value);
		const receipt = await saveSourceProposal(ctx, {
			project,
			messageId: args.messageId,
			sourceValue: args.intent.value,
			sourceFingerprint,
			basisGitValueFingerprint: sourceGitValueFingerprint,
			basisGitValueRevision: source.gitValueRevision ?? 0,
			evidenceSnapshotId: projection.snapshotId,
			actor: { kind: "user", id: userId },
		});
		return { ...receipt, sourceFingerprint };
	}
	if (
		target.gitValueFingerprint === undefined ||
		target.gitValueFingerprint !== args.expectedGitValueFingerprint ||
		(target.gitValueRevision ?? 0) !== args.expectedGitValueRevision
	) {
		throw new ConvexError({
			code: "CONFLICT",
			message:
				"The Git value changed before this Catalog Workspace edit could be saved.",
		});
	}
	const sourceProposalHead = await sourceProposalHeadFor(
		ctx,
		args.projectId,
		args.messageId,
	);
	const sourceProposalResolution = sourceProposalHead
		? await publishedResolutionFor(ctx, {
				_id: sourceProposalHead.proposalId,
				projectId: args.projectId,
				messageId: args.messageId,
			})
		: null;
	const effectiveSource =
		isCurrentSourceProposalHeadForSource(source, sourceProposalHead) &&
		!sourceProposalResolution
			? {
					...source,
					value: sourceProposalHead.sourceValue,
					valueFingerprint: sourceProposalHead.sourceFingerprint,
					sourceFingerprint: sourceProposalHead.sourceFingerprint,
				}
			: source;
	if (
		args.expectedSourceFingerprint === undefined ||
		args.expectedSourceFingerprint !== effectiveSource.sourceFingerprint
	) {
		throw new ConvexError({
			code: "CONFLICT",
			message:
				"The source value changed before this Catalog Workspace edit could be saved.",
		});
	}
	const targetValueFingerprint =
		target.valueFingerprint ?? (await sha256Hex(target.value));
	const [state, head, decisionState] = await Promise.all([
		workspaceStateFor(ctx, args.projectId),
		ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project_and_messageId_and_localeId", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("messageId", args.messageId)
					.eq("localeId", args.localeId),
			)
			.unique(),
		decisionStateFor(ctx, args.projectId),
	]);
	let currentHead = isCurrentHeadForRow(target, head) ? head : undefined;
	if ((currentHead?.revision ?? 0) !== args.expectedWorkspaceRevision) {
		throw new ConvexError({
			code: "CONFLICT",
			message:
				"The Catalog Workspace value changed before this edit could be saved.",
		});
	}
	const timestamp = now();
	const currentValue = currentHead?.value ?? target.value;
	const currentValueFingerprint =
		currentHead?.valueFingerprint ??
		(currentHead ? await sha256Hex(currentHead.value) : targetValueFingerprint);
	const reconciliationGeneration = state?.reconciliationGeneration ?? 0;
	const actor = { kind: "user" as const, id: userId };
	const valueBasis = {
		messageId: args.messageId,
		localeId: args.localeId,
		sourceFingerprint: effectiveSource.sourceFingerprint,
		recordedBy: actor,
		recordedAt: timestamp,
	};

	if (args.intent.kind === "confirm") {
		await assertMessageCharacterLimit(
			ctx,
			{ projectId: args.projectId, messageId: args.messageId },
			currentValue,
		);
		if (currentValue.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"An empty target remains Waiting until an Intentional Blank records its reason.",
			});
		}
		assertTargetValueContract({
			messageId: args.messageId,
			localeCode: target.localeCode,
			value: currentValue,
			source: effectiveSource,
		});
		if (currentHead && currentHead.valueFingerprint === undefined) {
			await upsertValueHead(ctx, {
				projectId: args.projectId,
				state,
				previous: head,
				next: { ...currentHead, valueFingerprint: currentValueFingerprint },
			});
			currentHead = {
				...currentHead,
				valueFingerprint: currentValueFingerprint,
			};
		}
		await ensureWorkspaceState(ctx, args.projectId, state);
		await recordDecision(ctx, {
			projectId: args.projectId,
			state: decisionState,
			next: {
				...valueBasis,
				kind: "translatorConfirmation",
				valueFingerprint: currentValueFingerprint,
			},
		});
		return {
			workspaceRevision: currentHead?.revision ?? 0,
			sourceFingerprint: effectiveSource.sourceFingerprint,
		};
	}

	if (args.intent.kind === "save") {
		await assertMessageCharacterLimit(
			ctx,
			{ projectId: args.projectId, messageId: target.messageId },
			args.intent.value,
		);
		if (args.intent.value.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"An empty target remains Waiting until an Intentional Blank records its reason.",
			});
		}
		if (
			new TextEncoder().encode(args.intent.value).byteLength >
			MAX_CATALOG_WORKSPACE_VALUE_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"One Catalog Workspace value exceeds the supported byte envelope.",
			});
		}
		assertTargetValueContract({
			messageId: args.messageId,
			localeCode: target.localeCode,
			value: args.intent.value,
			source: effectiveSource,
		});
		const nextRevision = (head?.revision ?? 0) + 1;
		const valueFingerprint = await sha256Hex(args.intent.value);
		const nextHead: CatalogWorkspaceValueHeadInput = {
			messageId: args.messageId,
			localeId: args.localeId,
			value: args.intent.value,
			valueFingerprint,
			sourceFingerprint: effectiveSource.sourceFingerprint,
			basisGitValueFingerprint: target.gitValueFingerprint,
			basisGitValueRevision: target.gitValueRevision ?? 0,
			revision: nextRevision,
			reconciliationGeneration,
			updatedBy: actor,
			updatedAt: timestamp,
		};
		await upsertValueHead(ctx, {
			projectId: args.projectId,
			state,
			previous: head,
			next: nextHead,
		});
		await recordDecision(ctx, {
			projectId: args.projectId,
			state: decisionState,
			next: {
				...valueBasis,
				kind: "translatorConfirmation",
				valueFingerprint,
			},
		});
		return {
			workspaceRevision: nextRevision,
			sourceFingerprint: effectiveSource.sourceFingerprint,
		};
	}

	if (effectiveSource.value.length === 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"An Intentional Blank is only meaningful for a non-empty source value.",
		});
	}
	const reason = assertIntentionalBlankReason(args.intent.reason);
	const nextRevision = (head?.revision ?? 0) + 1;
	const valueFingerprint = await sha256Hex("");
	const nextHead: CatalogWorkspaceValueHeadInput = {
		messageId: args.messageId,
		localeId: args.localeId,
		value: "",
		valueFingerprint,
		sourceFingerprint: effectiveSource.sourceFingerprint,
		basisGitValueFingerprint: target.gitValueFingerprint,
		basisGitValueRevision: target.gitValueRevision ?? 0,
		revision: nextRevision,
		reconciliationGeneration,
		updatedBy: actor,
		updatedAt: timestamp,
	};
	await upsertValueHead(ctx, {
		projectId: args.projectId,
		state,
		previous: head,
		next: nextHead,
		intentionalBlankReason: reason,
	});
	await recordDecision(ctx, {
		projectId: args.projectId,
		state: decisionState,
		next: {
			...valueBasis,
			kind: "intentionalBlank",
			valueFingerprint,
			reason,
		},
	});
	return {
		workspaceRevision: nextRevision,
		sourceFingerprint: effectiveSource.sourceFingerprint,
	};
}

export const commit = mutation({
	args: {
		projectId: v.id("projects"),
		messageId: v.string(),
		localeId: v.id("locales"),
		intent: commitIntentValidator,
		expectedGitValueFingerprint: v.string(),
		expectedGitValueRevision: v.number(),
		expectedWorkspaceRevision: v.number(),
		expectedSourceFingerprint: v.optional(v.string()),
	},
	returns: v.object({
		workspaceRevision: v.number(),
		sourceFingerprint: v.string(),
	}),
	handler: async (ctx, args) => {
		const receipt = await commitCatalogWorkspaceValue(ctx, args);
		await recomputeNavigationRows(ctx, {
			projectId: args.projectId,
			messageIds: [args.messageId],
		});
		return receipt;
	},
});
