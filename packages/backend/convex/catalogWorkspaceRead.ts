import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { activeProjectionFor } from "./catalogProjection";
import {
	decisionForIdentity,
	latestDecisionForValue,
} from "./catalogWorkspaceDecisionQueries";
import { readyNavigationStateFor } from "./catalogWorkspaceNavigation";
import {
	currentDecisionForValue,
	currentSourceProposalRows,
	currentWorkspaceRows,
	decisionRecordMap,
	decisionSourceFingerprintFor,
	isCurrentHeadForRow,
	sourceChangeKindForConfirmation,
	sourceChangeMap,
	valueIdentity,
	valueStateFor,
} from "./catalogWorkspaceView";
import { assertTargetValueContract } from "./contractTransforms";
import { sha256Hex } from "./lib";
import { readCharacterLimit } from "./messageConstraints";
import {
	isCurrentSourceProposalHeadForSource,
	publishedResolutionFor,
	sourceProposalHeadFor,
} from "./sourceProposals";

/** Read one active target using the same overlays as the human Workspace.
 * Authentication belongs to the caller. Raw target rows retain their Git basis;
 * effective rows describe exactly the content an agent will read or review. */
export async function readWorkspaceTarget(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	messageId: string,
	localeId: Id<"locales">,
) {
	const [project, projection, locale] = await Promise.all([
		ctx.db.get(projectId),
		activeProjectionFor(ctx, projectId),
		ctx.db.get(localeId),
	]);
	const sourceLocaleId = project?.sourceLocaleId;
	if (!project || !sourceLocaleId || !projection?.snapshotId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "No active Baseline Catalog is available for this project.",
		});
	}
	if (
		!locale ||
		locale.projectId !== projectId ||
		locale.isSource ||
		locale.archivedAt !== undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "The requested Catalog Workspace target Locale is not active.",
		});
	}
	const [source, target, head, sourceProposalHead] = await Promise.all([
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", messageId)
					.eq("localeId", sourceLocaleId),
			)
			.unique(),
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", messageId)
					.eq("localeId", localeId),
			)
			.unique(),
		ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project_and_messageId_and_localeId", (q) =>
				q
					.eq("projectId", projectId)
					.eq("messageId", messageId)
					.eq("localeId", localeId),
			)
			.unique(),
		sourceProposalHeadFor(ctx, projectId, messageId),
	]);
	if (!source?.isSource || !target || target.isSource) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "The requested Catalog Workspace target is not active.",
		});
	}
	if (target.gitValueFingerprint === undefined) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message:
				"This target predates Git value identity. Refresh the active Catalog Workspace before proposing it.",
		});
	}
	const currentHead = isCurrentHeadForRow(target, head) ? head : undefined;
	const sourceProposalResolution = sourceProposalHead
		? await publishedResolutionFor(ctx, {
				_id: sourceProposalHead.proposalId,
				projectId,
				messageId,
			})
		: null;
	const [effectiveSource, effectiveTarget] = currentWorkspaceRows(
		currentSourceProposalRows(
			[source, target],
			new Map(sourceProposalHead ? [[messageId, sourceProposalHead]] : []),
			new Map(
				sourceProposalHead && sourceProposalResolution
					? [[sourceProposalHead.proposalId, sourceProposalResolution]]
					: [],
			),
		),
		new Map(currentHead ? [[valueIdentity(target), currentHead]] : []),
	);
	if (!effectiveSource || !effectiveTarget) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace lost the requested source or target.",
		});
	}
	return {
		projection,
		gitSource: source,
		characterLimit: await readCharacterLimit(ctx, { projectId, messageId }),
		source: effectiveSource,
		target,
		effectiveTarget,
		currentHead,
		pendingSourceProposal:
			isCurrentSourceProposalHeadForSource(source, sourceProposalHead) &&
			!sourceProposalResolution,
		value: effectiveTarget.value,
		valueFingerprint:
			effectiveTarget.valueFingerprint ??
			(await sha256Hex(effectiveTarget.value)),
		workspaceRevision: currentHead?.revision ?? 0,
	};
}

/** Additional reference evidence is optional: candidate writes need the current
 * basis, while discovery needs to distinguish reviewed examples from imports.
 * Exact decisions and the latest matching-value decision use existing indexes.
 * First Review comes from the ready Navigation projection because it survives
 * later edits to the reviewed value. */
export async function readWorkspaceTargetEvidence(
	ctx: QueryCtx | MutationCtx,
	current: Awaited<ReturnType<typeof readWorkspaceTarget>>,
) {
	const { target, effectiveTarget, source, gitSource, projection } = current;
	await readyNavigationStateFor(ctx, {
		projectId: projection.projectId,
		projectionId: projection._id,
		expectedRowCount: projection.expectedKeyCount,
	});
	const navigation = await ctx.db
		.query("catalogWorkspaceNavigationRows")
		.withIndex("by_project_and_projection_and_messageId", (q) =>
			q
				.eq("projectId", projection.projectId)
				.eq("projectionId", projection._id)
				.eq("messageId", target.messageId),
		)
		.unique();
	const navigationTarget = navigation?.targets.find(
		(value) => value.localeId === target.localeId,
	);
	if (!navigationTarget || navigationTarget.firstReviewPending === undefined) {
		throw new ConvexError({
			code: "INCOMPLETE",
			message: "First Review evidence requires a complete Navigation Index.",
		});
	}
	const decisionSourceFingerprint = decisionSourceFingerprintFor({
		gitSourceFingerprint: gitSource.sourceFingerprint,
		currentSourceFingerprint: source.sourceFingerprint,
		valueSourceFingerprint: effectiveTarget.sourceFingerprint,
		pendingSourceProposalFingerprint: current.pendingSourceProposal
			? source.sourceFingerprint
			: undefined,
	});
	const identity = {
		projectId: projection.projectId,
		messageId: target.messageId,
		localeId: target.localeId,
		valueFingerprint: current.valueFingerprint,
	};
	const [exactDecision, latestDecision] = await Promise.all([
		decisionForIdentity(ctx, {
			...identity,
			sourceFingerprint: decisionSourceFingerprint,
		}),
		current.pendingSourceProposal
			? null
			: latestDecisionForValue(ctx, identity),
	]);
	const decision = currentDecisionForValue({
		row: target,
		sourceFingerprint: decisionSourceFingerprint,
		value: current.value,
		valueFingerprint: current.valueFingerprint,
		decisionsByIdentity: decisionRecordMap(
			exactDecision ? [exactDecision] : [],
		),
	});
	const previousConfirmation =
		latestDecision?.kind === "translatorConfirmation"
			? latestDecision
			: undefined;
	let sourceChangeKind: "cosmetic" | "semantic" | undefined;
	if (
		previousConfirmation &&
		previousConfirmation.sourceFingerprint !== decisionSourceFingerprint
	) {
		const changes = await ctx.db
			.query("catalogProjectionGitChanges")
			.withIndex("by_projection_and_messageId_and_isSource", (q) =>
				q
					.eq("projectionId", projection._id)
					.eq("messageId", target.messageId)
					.eq("isSource", true),
			)
			.take(2);
		sourceChangeKind = sourceChangeKindForConfirmation({
			messageId: target.messageId,
			confirmedSourceFingerprint: previousConfirmation.sourceFingerprint,
			currentSourceFingerprint: decisionSourceFingerprint,
			sourceChangesByIdentity: sourceChangeMap(changes),
		});
	}
	let contract:
		| { valid: true }
		| { valid: false; code: string; message: string };
	try {
		assertTargetValueContract({
			messageId: target.messageId,
			localeCode: target.localeCode,
			value: current.value,
			source,
		});
		contract = { valid: true };
	} catch (error) {
		if (!(error instanceof ConvexError)) throw error;
		const detail: unknown = error.data;
		contract = {
			valid: false,
			code: "VALIDATION",
			message:
				typeof detail === "object" &&
				detail !== null &&
				"message" in detail &&
				typeof detail.message === "string"
					? detail.message
					: error.message,
		};
	}
	return {
		...valueStateFor({
			value: current.value,
			decision,
			previousConfirmation,
			currentSourceFingerprint: decisionSourceFingerprint,
			sourceChangeKind,
		}),
		confirmation: decision
			? {
					decisionId: decision._id,
					kind: decision.kind,
					actor: decision.recordedBy,
					...(decision.reviewAuthorization === undefined
						? {}
						: { reviewAuthorization: decision.reviewAuthorization }),
					recordedAt: decision.recordedAt,
					sourceFingerprint: decision.sourceFingerprint,
					valueFingerprint: decision.valueFingerprint,
				}
			: null,
		firstReviewPending: navigationTarget.firstReviewPending,
		reference: {
			projectionId: projection._id,
			snapshotId: projection.snapshotId,
			messageId: target.messageId,
			localeId: target.localeId,
			valueFingerprint: current.valueFingerprint,
			sourceFingerprint: source.sourceFingerprint,
		},
		// A settled Git translation can differ from pending English proposal
		// wording. This stricter fact prevents treating it as same-basis evidence.
		sourceMatchesCurrent:
			effectiveTarget.sourceFingerprint === source.sourceFingerprint,
		pendingSourceProposal: current.pendingSourceProposal,
		contract,
		provenance: current.currentHead ? ("workspace" as const) : ("git" as const),
	};
}
