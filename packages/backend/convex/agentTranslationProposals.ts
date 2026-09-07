import { paginationOptsValidator } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	type AgentReviewAuthorization,
	agentReviewAuthorizationValidator,
	agentReviewDecisionValidator,
	isReviewOnlyToken,
} from "./agentReviewModel";
import {
	authorizeCandidateReview,
	candidateAuthorizationValidator,
	grantCandidateReview as grantReview,
	readCandidateAuthorization,
	revokeCandidateReviewGrant as revokeReview,
} from "./agentReviews";
import { hashToken } from "./apiTokens";
import {
	activeProjectionFor,
	activeWorkingCatalog,
	MAX_WORKING_CATALOG_KEYS,
} from "./catalogProjection";
import {
	applyAgentTargetValue,
	MAX_CATALOG_WORKSPACE_VALUE_HEADS,
} from "./catalogWorkspace";
import { readyNavigationStateFor } from "./catalogWorkspaceNavigation";
import { assertTargetValueContract } from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import {
	applyTaskReviewedValue,
	carryForwardLocaleProposal,
	ensureLocaleProposalForReview,
	finalizeProposal,
	type LocaleProposalCarryForwardResult,
} from "./localeProposals";
import { requireEditor, requireViewer } from "./permissions";
import {
	isCurrentSourceProposalHeadForSource,
	publishedResolutionFor,
	sourceProposalHeadFor,
} from "./sourceProposals";

const MAX_PROPOSAL_CLIENT_KEY_BYTES = 256;
const MAX_REVISION_CLIENT_KEY_BYTES = 256;
const MAX_CANDIDATE_VALUE_BYTES = 256 * 1024;
const MAX_INTENTIONAL_BLANK_REASON_BYTES = 4 * 1024;
const MAX_SUBMISSION_ITEMS = 16;
const MAX_SUBMISSION_BYTES = 512 * 1024;
const MAX_REVIEW_CANDIDATES = 128;
const MAX_CANDIDATES = MAX_WORKING_CATALOG_KEYS;
const MAX_REVISIONS = MAX_WORKING_CATALOG_KEYS * 2;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_KEYS = 50;
const MAX_CONTEXT_LOCALES = 20;
const MAX_CONTEXT_PAIRS = 128;
const MAX_DISCOVERY_RESULTS = 50;
const MAX_DISCOVERY_RESPONSE_BYTES = 512 * 1024;
const MAX_WORK_QUEUE_ITEMS = 16;
const MAX_WORK_QUEUE_SCAN_ROWS = 64;
const MAX_WORK_QUEUE_RESPONSE_BYTES = 768 * 1024;
const MAX_TASK_TARGETS = 32;
const MAX_TASK_TITLE_BYTES = 256;
const MAX_TRANSLATION_TASKS_PER_OWNER = 128;

async function latestCandidateReview(
	ctx: QueryCtx | MutationCtx,
	revisionId: Id<"agentTranslationCandidateRevisions">,
) {
	return await ctx.db
		.query("agentTranslationCandidateReviews")
		.withIndex("by_revision", (q) => q.eq("revisionId", revisionId))
		.order("desc")
		.first();
}

const targetValidator = v.union(
	v.object({ kind: v.literal("catalogWorkspace") }),
	v.object({
		kind: v.literal("localeProposal"),
		localeProposalId: v.id("localeProposals"),
	}),
);

const candidateRevisionInputValidator = v.object({
	messageId: v.string(),
	localeId: v.optional(v.id("locales")),
	value: v.string(),
	intentionalBlankReason: v.optional(v.string()),
	clientRevisionKey: v.string(),
	expectedCandidateRevision: v.number(),
	basis: v.union(
		v.object({
			kind: v.literal("catalogWorkspace"),
			projectionId: v.id("catalogProjections"),
			snapshotId: v.id("sourceSnapshots"),
			gitValueFingerprint: v.string(),
			gitValueRevision: v.number(),
			workspaceRevision: v.number(),
			sourceFingerprint: v.string(),
		}),
		v.object({
			kind: v.literal("localeProposal"),
			localeProposalId: v.id("localeProposals"),
			snapshotId: v.id("sourceSnapshots"),
			sourceFingerprint: v.string(),
		}),
	),
});

export const reviewDecisionValidator = v.union(
	v.object({ kind: v.literal("accept") }),
	v.object({ kind: v.literal("keepForCurrentSource") }),
	v.object({ kind: v.literal("acceptWithEdits"), value: v.string() }),
	v.object({
		kind: v.literal("reject"),
		reason: v.optional(v.string()),
	}),
	v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
);

export type TranslationTaskReviewDecision =
	| { kind: "accept" }
	| { kind: "keepForCurrentSource" }
	| { kind: "acceptWithEdits"; value: string }
	| { kind: "reject"; reason?: string }
	| { kind: "intentionalBlank"; reason: string };

const translationWorkReasonValidator = v.union(
	v.literal("missing"),
	v.literal("sourceIdentical"),
	v.literal("sameKeyRepeat"),
	v.literal("stale"),
);

export type TranslationWorkReason =
	| "missing"
	| "sourceIdentical"
	| "sameKeyRepeat"
	| "stale";

type TranslationWorkCursor = {
	projectionId: Id<"catalogProjections">;
	catalogIndex: number;
	targetIndex: number;
};

const taskBasisValidator = v.object({
	kind: v.literal("catalogWorkspace"),
	projectionId: v.id("catalogProjections"),
	snapshotId: v.id("sourceSnapshots"),
	gitValueFingerprint: v.string(),
	gitValueRevision: v.number(),
	workspaceRevision: v.number(),
	sourceFingerprint: v.string(),
});

const taskTargetValidator = v.object({
	messageId: v.string(),
	sourceValue: v.string(),
	targetValue: v.string(),
});

function catalogWorkspaceTaskBasis(
	current: Awaited<ReturnType<typeof currentWorkspaceTarget>>,
) {
	if (!current.projection.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active Catalog Workspace is missing Snapshot identity.",
		});
	}
	return {
		kind: "catalogWorkspace" as const,
		projectionId: current.projection._id,
		snapshotId: current.projection.snapshotId,
		gitValueFingerprint: current.target.gitValueFingerprint as string,
		gitValueRevision: current.target.gitValueRevision ?? 0,
		workspaceRevision: current.workspaceRevision,
		sourceFingerprint: current.source.sourceFingerprint,
	};
}

function sameCatalogWorkspaceTaskBasis(
	left: Extract<CandidateRevisionInput["basis"], { kind: "catalogWorkspace" }>,
	right: Extract<CandidateRevisionInput["basis"], { kind: "catalogWorkspace" }>,
) {
	return (
		left.projectionId === right.projectionId &&
		left.snapshotId === right.snapshotId &&
		left.gitValueFingerprint === right.gitValueFingerprint &&
		left.gitValueRevision === right.gitValueRevision &&
		left.workspaceRevision === right.workspaceRevision &&
		left.sourceFingerprint === right.sourceFingerprint
	);
}

function sameLocaleProposalTaskBasis(
	left: Extract<CandidateRevisionInput["basis"], { kind: "localeProposal" }>,
	right: Extract<CandidateRevisionInput["basis"], { kind: "localeProposal" }>,
) {
	return (
		left.localeProposalId === right.localeProposalId &&
		left.snapshotId === right.snapshotId &&
		left.sourceFingerprint === right.sourceFingerprint
	);
}

const localeProposalTaskScopeValidator = v.object({
	localeProposalId: v.id("localeProposals"),
	localeCode: v.string(),
	targetCount: v.number(),
});

const translationWorkPageValidator = v.object({
	projectionId: v.id("catalogProjections"),
	items: v.array(
		v.object({
			messageId: v.string(),
			localeCode: v.string(),
			reasons: v.array(translationWorkReasonValidator),
			sourceValue: v.string(),
			targetValue: v.string(),
		}),
	),
	nextCursor: v.union(v.string(), v.null()),
});

type ProposalTarget =
	| { kind: "catalogWorkspace" }
	| { kind: "localeProposal"; localeProposalId: Id<"localeProposals"> };

type CandidateRevisionInput = {
	messageId: string;
	localeId?: Id<"locales">;
	value: string;
	intentionalBlankReason?: string;
	clientRevisionKey: string;
	expectedCandidateRevision: number;
	basis:
		| {
				kind: "catalogWorkspace";
				projectionId: Id<"catalogProjections">;
				snapshotId: Id<"sourceSnapshots">;
				gitValueFingerprint: string;
				gitValueRevision: number;
				workspaceRevision: number;
				sourceFingerprint: string;
		  }
		| {
				kind: "localeProposal";
				localeProposalId: Id<"localeProposals">;
				snapshotId: Id<"sourceSnapshots">;
				sourceFingerprint: string;
		  };
};

function byteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertBoundedString(value: string, name: string, limit: number): void {
	if (value.trim().length === 0 || byteLength(value) > limit) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `${name} exceeds its supported envelope.`,
		});
	}
}

function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `${name} must be a non-negative integer.`,
		});
	}
}

const ALL_TRANSLATION_WORK_REASONS = [
	"missing",
	"sourceIdentical",
	"sameKeyRepeat",
	"stale",
] as const satisfies readonly TranslationWorkReason[];

function translationWorkReasons(
	digest: Doc<"catalogWorkspaceNavigationRows">,
	target: Doc<"catalogWorkspaceNavigationRows">["targets"][number],
): TranslationWorkReason[] {
	if (target.valueState === "waiting") return ["missing"];
	if (target.valueState === "stale") return ["stale"];
	if (target.confirmedGitContent || target.touched) return [];

	const reasons: TranslationWorkReason[] = [];
	if (
		!digest.pendingSourceProposal &&
		target.gitValueFingerprint !== undefined &&
		target.gitValueFingerprint === digest.source.gitValueFingerprint
	) {
		reasons.push("sourceIdentical");
	}
	if (
		target.valueFingerprint !== undefined &&
		digest.targets.some(
			(other) =>
				other.localeId !== target.localeId &&
				other.valueFingerprint === target.valueFingerprint,
		)
	) {
		reasons.push("sameKeyRepeat");
	}
	return reasons;
}

function decodeTranslationWorkCursor(
	cursor: string,
): TranslationWorkCursor | null {
	if (cursor.length === 0) return null;
	const match = /^v1\.([^.]+)\.(\d+)\.(\d+)$/.exec(cursor);
	if (!match) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Translation work pagination cursor is invalid.",
		});
	}
	const catalogIndex = Number(match[2]);
	const targetIndex = Number(match[3]);
	if (
		!Number.isSafeInteger(catalogIndex) ||
		catalogIndex < 0 ||
		!Number.isSafeInteger(targetIndex) ||
		targetIndex < 0
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Translation work pagination cursor is invalid.",
		});
	}
	return {
		projectionId: match[1] as Id<"catalogProjections">,
		catalogIndex,
		targetIndex,
	};
}

function encodeTranslationWorkCursor(cursor: TranslationWorkCursor): string {
	return `v1.${cursor.projectionId}.${cursor.catalogIndex}.${cursor.targetIndex}`;
}

function nextTranslationWorkCursor(
	rows: readonly Doc<"catalogWorkspaceNavigationRows">[],
	rowIndex: number,
	targetIndex: number,
	projectionId: Id<"catalogProjections">,
): string | null {
	const row = rows[rowIndex];
	if (row && targetIndex + 1 < row.targets.length) {
		return encodeTranslationWorkCursor({
			projectionId,
			catalogIndex: row.catalogIndex,
			targetIndex: targetIndex + 1,
		});
	}
	const nextRow = rows[rowIndex + 1];
	return nextRow
		? encodeTranslationWorkCursor({
				projectionId,
				catalogIndex: nextRow.catalogIndex,
				targetIndex: 0,
			})
		: null;
}

async function authenticate(
	ctx: QueryCtx | MutationCtx,
	rawToken: string,
	scope: "read" | "search" | "propose",
) {
	const tokenHash = await hashToken(rawToken);
	const token = await ctx.db
		.query("apiTokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
		.unique();
	if (
		!token ||
		token.revokedAt !== undefined ||
		!token.scopes.includes(scope) ||
		(token.scopes.includes("review") && !isReviewOnlyToken(token.scopes))
	) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "Invalid or insufficient API token.",
		});
	}
	return token;
}

async function proposalForToken(
	ctx: QueryCtx | MutationCtx,
	proposalId: Id<"agentTranslationProposals">,
	tokenId: Id<"apiTokens">,
) {
	const proposal = await ctx.db.get(proposalId);
	const token = await ctx.db.get(tokenId);
	if (
		!proposal ||
		!token ||
		proposal.projectId !== token.projectId ||
		(proposal.createdByTokenId !== undefined &&
			proposal.createdByTokenId !== tokenId)
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Translation proposal not found.",
		});
	}
	return proposal;
}

function proposalSummary(proposal: {
	_id: Id<"agentTranslationProposals">;
	projectId: Id<"projects">;
	clientProposalKey: string;
	target: ProposalTarget;
	status: "open" | "accepted" | "rejected";
	candidateCount: number;
	revisionCount: number;
	retainedByteLength: number;
	createdAt: number;
	updatedAt: number;
}) {
	return {
		proposalId: proposal._id,
		projectId: proposal.projectId,
		clientProposalKey: proposal.clientProposalKey,
		target: proposal.target,
		status: proposal.status,
		candidateCount: proposal.candidateCount,
		revisionCount: proposal.revisionCount,
		retainedByteLength: proposal.retainedByteLength,
		createdAt: proposal.createdAt,
		updatedAt: proposal.updatedAt,
	};
}

async function tasksForOwner(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	createdByTokenId: Id<"apiTokens"> | undefined,
) {
	const [existingLocaleTasks, newLocaleTasks] = await Promise.all([
		ctx.db
			.query("agentTranslationProposals")
			.withIndex("by_owner_and_existingTask", (q) =>
				q
					.eq("projectId", projectId)
					.eq("createdByTokenId", createdByTokenId)
					.gt("taskScope.localeId", undefined),
			)
			.take(MAX_TRANSLATION_TASKS_PER_OWNER + 1),
		ctx.db
			.query("agentTranslationProposals")
			.withIndex("by_owner_and_newLocaleTask", (q) =>
				q
					.eq("projectId", projectId)
					.eq("createdByTokenId", createdByTokenId)
					.gt("localeProposalTaskScope.localeProposalId", undefined),
			)
			.take(MAX_TRANSLATION_TASKS_PER_OWNER + 1),
	]);
	const tasks = [...existingLocaleTasks, ...newLocaleTasks];
	if (tasks.length > MAX_TRANSLATION_TASKS_PER_OWNER) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Translation Task history exceeds its list envelope.",
		});
	}
	return tasks;
}

async function newLocaleTaskForOwner(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	createdByTokenId: Id<"apiTokens"> | undefined,
	localeProposalId: Id<"localeProposals">,
) {
	return await ctx.db
		.query("agentTranslationProposals")
		.withIndex("by_owner_and_newLocaleTask", (q) =>
			q
				.eq("projectId", projectId)
				.eq("createdByTokenId", createdByTokenId)
				.eq("localeProposalTaskScope.localeProposalId", localeProposalId),
		)
		.unique();
}

async function currentWorkspaceTarget(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	messageId: string,
	localeId: Id<"locales">,
) {
	const [project, projection] = await Promise.all([
		ctx.db.get(projectId),
		activeProjectionFor(ctx, projectId),
	]);
	const sourceLocaleId = project?.sourceLocaleId;
	if (!project || !sourceLocaleId || !projection?.snapshotId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "No active Baseline Catalog is available for this project.",
		});
	}
	const [source, target, head] = await Promise.all([
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
	const currentHead =
		head &&
		head.basisGitValueFingerprint === target.gitValueFingerprint &&
		head.basisGitValueRevision === (target.gitValueRevision ?? 0)
			? head
			: undefined;
	const sourceProposalHead = await sourceProposalHeadFor(
		ctx,
		projectId,
		messageId,
	);
	const sourceProposalResolution = sourceProposalHead
		? await publishedResolutionFor(ctx, {
				_id: sourceProposalHead.proposalId,
				projectId,
				messageId,
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
	return {
		projection,
		source: effectiveSource,
		target,
		value: currentHead?.value ?? target.value,
		valueFingerprint:
			currentHead?.valueFingerprint ??
			(await sha256Hex(currentHead?.value ?? target.value)),
		workspaceRevision: currentHead?.revision ?? 0,
	};
}

async function currentLocaleProposalTarget(
	ctx: QueryCtx | MutationCtx,
	proposal: {
		projectId: Id<"projects">;
		target: ProposalTarget;
	},
	messageId: string,
) {
	if (proposal.target.kind !== "localeProposal") {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The proposal target is not a Locale Proposal.",
		});
	}
	const localeProposal = await ctx.db.get(proposal.target.localeProposalId);
	if (!localeProposal || localeProposal.projectId !== proposal.projectId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Locale Proposal not found for this project.",
		});
	}
	const project = await ctx.db.get(proposal.projectId);
	const projection = project
		? await activeProjectionFor(ctx, proposal.projectId)
		: null;
	const sourceRow =
		project && projection
			? await ctx.db
					.query("catalogProjectionMessages")
					.withIndex("by_projection_and_messageId_and_isSource", (q) =>
						q
							.eq("projectionId", projection._id)
							.eq("messageId", messageId)
							.eq("isSource", true),
					)
					.unique()
			: null;
	if (
		!project ||
		!projection ||
		projection.snapshotId !== localeProposal.sourceSnapshotId ||
		!sourceRow?.isSource ||
		localeProposal.status !== "draft"
	) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Locale Proposal is no longer an editable current draft.",
		});
	}
	return {
		localeProposal,
		source: {
			sourceSnapshotId: localeProposal.sourceSnapshotId,
			isCurrentBaseline:
				project.baselineSnapshotId === localeProposal.sourceSnapshotId,
			localeCode: localeProposal.localeCode,
			sourceValue: sourceRow.value,
			sourceFingerprint: sourceRow.sourceFingerprint,
			source: {
				icuType: sourceRow.icuType,
				argumentNames: sourceRow.argumentNames,
				argumentNamesComplete: sourceRow.argumentNamesComplete,
				declaredPlaceholderNames: sourceRow.declaredPlaceholderNames ?? [],
				declaredPlaceholderNamesComplete:
					sourceRow.declaredPlaceholderNamesComplete ?? true,
			},
		},
	};
}

function discoveryEntry(
	current: Awaited<ReturnType<typeof currentWorkspaceTarget>>,
) {
	if (!current.projection.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active Catalog Workspace is missing Snapshot identity.",
		});
	}
	return {
		messageId: current.target.messageId,
		localeId: current.target.localeId,
		localeCode: current.target.localeCode,
		source: {
			value: current.source.value,
			fingerprint: current.source.sourceFingerprint,
			icuType: current.source.icuType,
			argumentNames: current.source.argumentNames,
			argumentNamesComplete: current.source.argumentNamesComplete,
			declaredPlaceholderNames: current.source.declaredPlaceholderNames ?? [],
			declaredPlaceholderNamesComplete:
				current.source.declaredPlaceholderNamesComplete ?? true,
		},
		target: {
			value: current.value,
			valueFingerprint: current.valueFingerprint,
			gitValueFingerprint: current.target.gitValueFingerprint,
			gitValueRevision: current.target.gitValueRevision ?? 0,
			workspaceRevision: current.workspaceRevision,
			catalogPath: current.target.catalogPath,
			sourceFingerprint: current.target.sourceFingerprint,
		},
		basis: {
			projectionId: current.projection._id,
			snapshotId: current.projection.snapshotId,
			gitValueFingerprint: current.target.gitValueFingerprint,
			gitValueRevision: current.target.gitValueRevision ?? 0,
			workspaceRevision: current.workspaceRevision,
			sourceFingerprint: current.source.sourceFingerprint,
		},
	};
}

function assertDiscoveryResponse(value: unknown): void {
	if (byteLength(value) > MAX_DISCOVERY_RESPONSE_BYTES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Workspace discovery response exceeds its byte envelope.",
		});
	}
}

type TaskActor =
	| { kind: "user"; id: string }
	| { kind: "agent"; id: Id<"apiTokens"> };

async function createCatalogWorkspaceTask(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		title: string;
		localeId: Id<"locales">;
		messageIds: readonly string[];
		actor: TaskActor;
		createdByTokenId?: Id<"apiTokens">;
	},
) {
	assertBoundedString(input.title, "title", MAX_TASK_TITLE_BYTES);
	if (
		input.messageIds.length === 0 ||
		input.messageIds.length > MAX_TASK_TARGETS
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: `A Translation Task needs 1–${MAX_TASK_TARGETS} keys.`,
		});
	}
	const uniqueMessageIds = [...new Set(input.messageIds)];
	if (uniqueMessageIds.length !== input.messageIds.length) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Translation Task cannot contain the same key twice.",
		});
	}
	const locale = await ctx.db.get(input.localeId);
	if (
		!locale ||
		locale.projectId !== input.projectId ||
		locale.archivedAt !== undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "The requested target Locale is not active in this project.",
		});
	}

	const targets = [];
	for (const messageId of uniqueMessageIds) {
		const current = await currentWorkspaceTarget(
			ctx,
			input.projectId,
			messageId,
			input.localeId,
		);
		if (!current.projection.snapshotId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The active Catalog Workspace is missing Snapshot identity.",
			});
		}
		targets.push({
			catalogIndex: current.target.catalogIndex,
			messageId,
			localeId: current.target.localeId,
			localeCode: current.target.localeCode,
			sourceValue: current.source.value,
			targetValue: current.value,
			targetCatalogPath: current.target.catalogPath,
			basis: {
				kind: "catalogWorkspace" as const,
				projectionId: current.projection._id,
				snapshotId: current.projection.snapshotId,
				gitValueFingerprint: current.target.gitValueFingerprint as string,
				gitValueRevision: current.target.gitValueRevision ?? 0,
				workspaceRevision: current.workspaceRevision,
				sourceFingerprint: current.source.sourceFingerprint,
			},
		});
	}
	targets.sort(
		(left, right) =>
			left.catalogIndex - right.catalogIndex ||
			left.messageId.localeCompare(right.messageId),
	);

	const timestamp = now();
	const proposalId = await ctx.db.insert("agentTranslationProposals", {
		projectId: input.projectId,
		...(input.createdByTokenId === undefined
			? {}
			: { createdByTokenId: input.createdByTokenId }),
		createdBy: input.actor,
		clientProposalKey: input.title.trim(),
		target: { kind: "catalogWorkspace" },
		taskScope: {
			localeId: locale._id,
			localeCode: locale.code,
			targetCount: targets.length,
		},
		status: "open",
		candidateCount: 0,
		revisionCount: 0,
		retainedByteLength: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	for (const target of targets) {
		await ctx.db.insert("translationTaskTargets", {
			projectId: input.projectId,
			proposalId,
			...target,
			createdAt: timestamp,
		});
	}
	return {
		taskId: proposalId,
		title: input.title.trim(),
		localeCode: locale.code,
		targetCount: targets.length,
	};
}

async function createNewLocaleTaskForHuman(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		title: string;
		userId: string;
	},
) {
	assertBoundedString(input.title, "title", MAX_TASK_TITLE_BYTES);
	const ensured = await ensureLocaleProposalForReview(
		ctx,
		input.projectId,
		input.userId,
	);
	const localeProposal = await ctx.db.get(ensured.proposalId);
	if (!localeProposal || localeProposal.projectId !== input.projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The new-Locale proposal was not created.",
		});
	}
	const title = input.title.trim();
	const existingTask = await newLocaleTaskForOwner(
		ctx,
		input.projectId,
		undefined,
		localeProposal._id,
	);
	if (existingTask) {
		if (
			localeProposal.status !== "draft" &&
			existingTask.clientProposalKey !== title
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message:
					"This new Locale is already finalized; resume its completed task instead of creating another.",
			});
		}
		return {
			taskId: existingTask._id,
			title: existingTask.clientProposalKey,
			localeCode: localeProposal.localeCode,
			targetCount: localeProposal.sourceMessageCount,
		};
	}
	const existing = await ctx.db
		.query("agentTranslationProposals")
		.withIndex("by_project_and_token_and_clientProposalKey", (q) =>
			q
				.eq("projectId", input.projectId)
				.eq("createdByTokenId", undefined)
				.eq("clientProposalKey", title),
		)
		.unique();
	if (existing) {
		if (
			existing.target.kind !== "localeProposal" ||
			existing.target.localeProposalId !== localeProposal._id ||
			existing.localeProposalTaskScope?.targetCount !==
				localeProposal.sourceMessageCount
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message:
					"The existing new-Locale task belongs to an older Baseline Snapshot.",
			});
		}
		return {
			taskId: existing._id,
			title: existing.clientProposalKey,
			localeCode: localeProposal.localeCode,
			targetCount: localeProposal.sourceMessageCount,
		};
	}
	if (localeProposal.status !== "draft") {
		throw new ConvexError({
			code: "BAD_STATE",
			message:
				"This new Locale is already finalized; resume its completed task instead of creating another.",
		});
	}
	const timestamp = now();
	const taskId = await ctx.db.insert("agentTranslationProposals", {
		projectId: input.projectId,
		createdBy: { kind: "user", id: input.userId },
		clientProposalKey: title,
		target: {
			kind: "localeProposal",
			localeProposalId: localeProposal._id,
		},
		localeProposalTaskScope: {
			localeProposalId: localeProposal._id,
			localeCode: localeProposal.localeCode,
			targetCount: localeProposal.sourceMessageCount,
		},
		status: "open",
		candidateCount: 0,
		revisionCount: 0,
		retainedByteLength: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	return {
		taskId,
		title,
		localeCode: localeProposal.localeCode,
		targetCount: localeProposal.sourceMessageCount,
	};
}

/** Human task creation uses the same target/scope vocabulary for a selected
 * existing Locale and for a complete new Locale. */
export const createTask = mutation({
	args: {
		projectId: v.id("projects"),
		title: v.string(),
		target: v.union(
			v.object({
				kind: v.literal("existingLocale"),
				localeId: v.id("locales"),
			}),
			v.object({ kind: v.literal("newLocale"), localeCode: v.string() }),
		),
		scope: v.union(
			v.object({
				kind: v.literal("selectedMessages"),
				messageIds: v.array(v.string()),
			}),
			v.object({ kind: v.literal("completeCatalog") }),
		),
	},
	returns: v.object({
		taskId: v.id("agentTranslationProposals"),
		title: v.string(),
		localeCode: v.string(),
		targetCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		if (args.target.kind === "existingLocale") {
			if (args.scope.kind !== "selectedMessages") {
				throw new ConvexError({
					code: "VALIDATION",
					message: "An existing-Locale task needs selected message ids.",
				});
			}
			return await createCatalogWorkspaceTask(ctx, {
				projectId: args.projectId,
				title: args.title,
				localeId: args.target.localeId,
				messageIds: args.scope.messageIds,
				actor: { kind: "user", id: userId },
			});
		}
		if (
			args.target.localeCode !== "pt" ||
			args.scope.kind !== "completeCatalog"
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "The configured new Locale needs complete-catalog scope.",
			});
		}
		return await createNewLocaleTaskForHuman(ctx, {
			projectId: args.projectId,
			title: args.title,
			userId,
		});
	},
});

export const newLocaleContinuationBasis = internalQuery({
	args: { taskId: v.id("agentTranslationProposals") },
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (
			task?.target.kind !== "localeProposal" ||
			!task.localeProposalTaskScope ||
			task.localeProposalTaskScope.localeProposalId !==
				task.target.localeProposalId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "New-Locale Translation Task not found.",
			});
		}
		const { userId } = await requireEditor(ctx, task.projectId);
		return {
			projectId: task.projectId,
			fromProposalId: task.target.localeProposalId,
			userId,
		};
	},
});

export const createContinuedNewLocaleTask = internalMutation({
	args: {
		fromTaskId: v.id("agentTranslationProposals"),
		localeProposalId: v.id("localeProposals"),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const [fromTask, localeProposal] = await Promise.all([
			ctx.db.get(args.fromTaskId),
			ctx.db.get(args.localeProposalId),
		]);
		if (
			fromTask?.target.kind !== "localeProposal" ||
			!fromTask.localeProposalTaskScope ||
			!localeProposal ||
			localeProposal.projectId !== fromTask.projectId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "New-Locale Translation Task continuation was not found.",
			});
		}
		const snapshot = await ctx.db.get(localeProposal.sourceSnapshotId);
		if (!snapshot || snapshot.projectId !== fromTask.projectId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The current Source Snapshot is missing.",
			});
		}
		const task = await createNewLocaleTaskForHuman(ctx, {
			projectId: fromTask.projectId,
			title: `pt · complete catalog · ${snapshot.commit.slice(0, 12)}`,
			userId: args.userId,
		});
		const created = await ctx.db.get(task.taskId);
		if (
			created?.target.kind !== "localeProposal" ||
			created.target.localeProposalId !== args.localeProposalId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The continued task does not target the current Locale Proposal.",
			});
		}
		return task;
	},
});

/** Move a new-Locale task onto the current Source without discarding work
 * whose per-value Source fingerprint still matches. */
export const continueNewLocaleTask = action({
	args: { taskId: v.id("agentTranslationProposals") },
	handler: async (
		ctx,
		args,
	): Promise<
		LocaleProposalCarryForwardResult & {
			taskId: Id<"agentTranslationProposals">;
			title: string;
			localeCode: string;
			targetCount: number;
		}
	> => {
		const basis: {
			projectId: Id<"projects">;
			fromProposalId: Id<"localeProposals">;
			userId: string;
		} = await ctx.runQuery(
			internal.agentTranslationProposals.newLocaleContinuationBasis,
			{ taskId: args.taskId },
		);
		const carried = await carryForwardLocaleProposal(ctx, basis);
		const task: {
			taskId: Id<"agentTranslationProposals">;
			title: string;
			localeCode: string;
			targetCount: number;
		} = await ctx.runMutation(
			internal.agentTranslationProposals.createContinuedNewLocaleTask,
			{
				fromTaskId: args.taskId,
				localeProposalId: carried.localeProposalId,
				userId: basis.userId,
			},
		);
		return { ...task, ...carried };
	},
});

export const createTaskForAgent = internalMutation({
	args: {
		token: v.string(),
		clientTaskKey: v.string(),
		localeCode: v.string(),
		messageIds: v.array(v.string()),
	},
	returns: v.object({
		taskId: v.id("agentTranslationProposals"),
		title: v.string(),
		localeCode: v.string(),
		targetCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "propose");
		assertBoundedString(
			args.clientTaskKey,
			"clientTaskKey",
			MAX_TASK_TITLE_BYTES,
		);
		const locale = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", token.projectId).eq("code", args.localeCode),
			)
			.unique();
		if (!locale || locale.archivedAt !== undefined) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "The requested target Locale is not active in this project.",
			});
		}
		const existing = await ctx.db
			.query("agentTranslationProposals")
			.withIndex("by_project_and_token_and_clientProposalKey", (q) =>
				q
					.eq("projectId", token.projectId)
					.eq("createdByTokenId", token._id)
					.eq("clientProposalKey", args.clientTaskKey.trim()),
			)
			.unique();
		if (existing) {
			const targets = existing.taskScope
				? await ctx.db
						.query("translationTaskTargets")
						.withIndex("by_proposal_and_catalogIndex", (q) =>
							q.eq("proposalId", existing._id),
						)
						.take(MAX_TASK_TARGETS + 1)
				: [];
			const expected = [...new Set(args.messageIds)].sort();
			const actual = targets.map((target) => target.messageId).sort();
			if (
				!existing.taskScope ||
				existing.taskScope.localeId !== locale._id ||
				JSON.stringify(actual) !== JSON.stringify(expected)
			) {
				throw new ConvexError({
					code: "IDEMPOTENCY_KEY_REUSED",
					message:
						"clientTaskKey is already bound to a different Translation Task scope.",
				});
			}
			return {
				taskId: existing._id,
				title: existing.clientProposalKey,
				localeCode: existing.taskScope.localeCode,
				targetCount: existing.taskScope.targetCount,
			};
		}
		return await createCatalogWorkspaceTask(ctx, {
			projectId: token.projectId,
			title: args.clientTaskKey,
			localeId: locale._id,
			messageIds: args.messageIds,
			actor: { kind: "agent", id: token._id },
			createdByTokenId: token._id,
		});
	},
});

/** Bounded agent read for a human-created task. Unlike Workspace discovery,
 * this returns the exact frozen scope and never asks the caller to manufacture
 * concurrency tokens. */
export const taskForAgent = internalQuery({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
		cursor: v.number(),
		limit: v.number(),
	},
	returns: v.object({
		task: v.object({
			taskId: v.id("agentTranslationProposals"),
			title: v.string(),
			status: v.union(
				v.literal("open"),
				v.literal("accepted"),
				v.literal("rejected"),
			),
			localeCode: v.string(),
			targetCount: v.number(),
			candidateCount: v.number(),
		}),
		targets: v.array(taskTargetValidator),
		nextCursor: v.union(v.number(), v.null()),
	}),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (!proposal.taskScope || proposal.target.kind !== "catalogWorkspace") {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		assertNonNegativeInteger(args.cursor, "cursor");
		const limit = Math.min(16, Math.max(1, Math.trunc(args.limit)));
		const rows = await ctx.db
			.query("translationTaskTargets")
			.withIndex("by_proposal_and_catalogIndex", (q) =>
				q.eq("proposalId", proposal._id).gte("catalogIndex", args.cursor),
			)
			.take(limit + 1);
		const targets = rows.slice(0, limit);
		const liveTargets = await Promise.all(
			targets.map(async (target) => {
				const current = await currentWorkspaceTarget(
					ctx,
					proposal.projectId,
					target.messageId,
					target.localeId,
				);
				return {
					messageId: target.messageId,
					sourceValue: current.source.value,
					targetValue: current.value,
				};
			}),
		);
		const last = targets[targets.length - 1];
		return {
			task: {
				taskId: proposal._id,
				title: proposal.clientProposalKey,
				status: proposal.status,
				localeCode: proposal.taskScope.localeCode,
				targetCount: proposal.taskScope.targetCount,
				candidateCount: proposal.candidateCount,
			},
			targets: liveTargets,
			nextCursor: rows.length > limit && last ? last.catalogIndex + 1 : null,
		};
	},
});

/** Resolve which private adapter backs a Translation Task. HTTP and future UI
 * callers branch once at this seam; they do not learn proposal basis fields or
 * manufacture different task identifiers for existing and new Locales. */
export const taskDescriptorForAgent = internalQuery({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
	},
	returns: v.union(
		v.object({
			kind: v.literal("existingLocale"),
			taskId: v.id("agentTranslationProposals"),
			title: v.string(),
			status: v.union(
				v.literal("open"),
				v.literal("accepted"),
				v.literal("rejected"),
			),
			localeCode: v.string(),
			targetCount: v.number(),
			candidateCount: v.number(),
		}),
		v.object({
			kind: v.literal("newLocale"),
			taskId: v.id("agentTranslationProposals"),
			title: v.string(),
			status: v.union(
				v.literal("open"),
				v.literal("accepted"),
				v.literal("rejected"),
			),
			localeCode: v.string(),
			targetCount: v.number(),
			candidateCount: v.number(),
			localeProposalId: v.id("localeProposals"),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (proposal.taskScope && proposal.target.kind === "catalogWorkspace") {
			return {
				kind: "existingLocale" as const,
				taskId: proposal._id,
				title: proposal.clientProposalKey,
				status: proposal.status,
				localeCode: proposal.taskScope.localeCode,
				targetCount: proposal.taskScope.targetCount,
				candidateCount: proposal.candidateCount,
			};
		}
		if (
			proposal.localeProposalTaskScope &&
			proposal.target.kind === "localeProposal" &&
			proposal.localeProposalTaskScope.localeProposalId ===
				proposal.target.localeProposalId
		) {
			const localeProposal = await ctx.db.get(proposal.target.localeProposalId);
			if (
				!localeProposal ||
				localeProposal.projectId !== proposal.projectId ||
				localeProposal.localeCode !==
					proposal.localeProposalTaskScope.localeCode ||
				localeProposal.sourceMessageCount !==
					proposal.localeProposalTaskScope.targetCount
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"New-Locale Translation Task no longer matches its Locale Proposal.",
				});
			}
			return {
				kind: "newLocale" as const,
				taskId: proposal._id,
				title: proposal.clientProposalKey,
				status: proposal.status,
				localeCode: localeProposal.localeCode,
				targetCount: localeProposal.sourceMessageCount,
				candidateCount: proposal.candidateCount,
				localeProposalId: localeProposal._id,
			};
		}
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Translation Task not found.",
		});
	},
});

/** Enumerate the bounded Translation Task inbox visible to one project token.
 * Token-owned tasks stay private to that token; human-created tasks are the
 * project work queue any current propose token may resume. */
export const listTasksForAgent = internalQuery({
	args: {
		token: v.string(),
		status: v.optional(
			v.union(v.literal("open"), v.literal("accepted"), v.literal("rejected")),
		),
	},
	returns: v.array(
		v.object({
			kind: v.union(v.literal("existingLocale"), v.literal("newLocale")),
			taskId: v.id("agentTranslationProposals"),
			title: v.string(),
			status: v.union(
				v.literal("open"),
				v.literal("accepted"),
				v.literal("rejected"),
			),
			localeCode: v.string(),
			targetCount: v.number(),
			candidateCount: v.number(),
			ownership: v.union(v.literal("token"), v.literal("project")),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const [projectTasks, tokenTasks] = await Promise.all([
			tasksForOwner(ctx, token.projectId, undefined),
			tasksForOwner(ctx, token.projectId, token._id),
		]);
		return [...projectTasks, ...tokenTasks]
			.filter(
				(task) => args.status === undefined || task.status === args.status,
			)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.map((task) => {
				if (task.taskScope) {
					return {
						kind: "existingLocale" as const,
						taskId: task._id,
						title: task.clientProposalKey,
						status: task.status,
						localeCode: task.taskScope.localeCode,
						targetCount: task.taskScope.targetCount,
						candidateCount: task.candidateCount,
						ownership:
							task.createdByTokenId === undefined
								? ("project" as const)
								: ("token" as const),
						updatedAt: task.updatedAt,
					};
				}
				const scope = task.localeProposalTaskScope;
				if (!scope) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Translation Task lost its target scope.",
					});
				}
				return {
					kind: "newLocale" as const,
					taskId: task._id,
					title: task.clientProposalKey,
					status: task.status,
					localeCode: scope.localeCode,
					targetCount: scope.targetCount,
					candidateCount: task.candidateCount,
					ownership:
						task.createdByTokenId === undefined
							? ("project" as const)
							: ("token" as const),
					updatedAt: task.updatedAt,
				};
			});
	},
});

export const taskSubmissionContext = internalQuery({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
		messageIds: v.array(v.string()),
	},
	returns: v.array(
		v.object({
			messageId: v.string(),
			localeId: v.id("locales"),
			basis: taskBasisValidator,
			currentRevision: v.number(),
			currentCandidate: v.union(
				v.object({
					candidateId: v.id("agentTranslationCandidates"),
					revisionId: v.id("agentTranslationCandidateRevisions"),
					revision: v.number(),
					value: v.string(),
					intentionalBlankReason: v.optional(v.string()),
					basisIsCurrent: v.boolean(),
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "propose");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (
			!proposal.taskScope ||
			proposal.target.kind !== "catalogWorkspace" ||
			proposal.status !== "open"
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "This Translation Task cannot receive candidates.",
			});
		}
		if (
			args.messageIds.length === 0 ||
			args.messageIds.length > MAX_SUBMISSION_ITEMS ||
			new Set(args.messageIds).size !== args.messageIds.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Submit 1–${MAX_SUBMISSION_ITEMS} distinct task keys at a time.`,
			});
		}
		const result = [];
		for (const messageId of args.messageIds) {
			const target = await ctx.db
				.query("translationTaskTargets")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", proposal._id).eq("messageId", messageId),
				)
				.unique();
			if (!target) {
				throw new ConvexError({
					code: "VALIDATION",
					message: `“${messageId}” is outside this Translation Task.`,
				});
			}
			const current = await currentWorkspaceTarget(
				ctx,
				proposal.projectId,
				target.messageId,
				target.localeId,
			);
			const basis = catalogWorkspaceTaskBasis(current);
			const candidate = await ctx.db
				.query("agentTranslationCandidates")
				.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
					q
						.eq("proposalId", proposal._id)
						.eq("messageId", messageId)
						.eq("localeId", target.localeId),
				)
				.unique();
			const currentCandidate = candidate?.latestRevisionId
				? await ctx.db.get(candidate.latestRevisionId)
				: null;
			if (candidate && !currentCandidate) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Translation Task candidate lost its current revision.",
				});
			}
			if (
				currentCandidate &&
				currentCandidate.basis.kind !== "catalogWorkspace"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Translation Task candidate has the wrong target basis.",
				});
			}
			const currentCandidateBasis =
				currentCandidate?.basis.kind === "catalogWorkspace"
					? currentCandidate.basis
					: null;
			result.push({
				messageId,
				localeId: target.localeId,
				basis,
				currentRevision: candidate?.currentRevision ?? 0,
				currentCandidate:
					candidate && currentCandidate && currentCandidateBasis
						? {
								candidateId: candidate._id,
								revisionId: currentCandidate._id,
								revision: currentCandidate.revision,
								value: currentCandidate.value,
								intentionalBlankReason: currentCandidate.intentionalBlankReason,
								basisIsCurrent: sameCatalogWorkspaceTaskBasis(
									currentCandidateBasis,
									basis,
								),
							}
						: null,
			});
		}
		return result;
	},
});

/** Resolve the private Locale Proposal evidence needed to create immutable
 * candidate revisions. The public Translation Task API deliberately exposes
 * none of this concurrency state to its caller. */
export const newLocaleTaskSubmissionContext = internalQuery({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
		messageIds: v.array(v.string()),
	},
	returns: v.array(
		v.object({
			messageId: v.string(),
			basis: v.object({
				kind: v.literal("localeProposal"),
				localeProposalId: v.id("localeProposals"),
				snapshotId: v.id("sourceSnapshots"),
				sourceFingerprint: v.string(),
			}),
			currentRevision: v.number(),
			currentCandidate: v.union(
				v.object({
					candidateId: v.id("agentTranslationCandidates"),
					revisionId: v.id("agentTranslationCandidateRevisions"),
					revision: v.number(),
					value: v.string(),
					intentionalBlankReason: v.optional(v.string()),
					basisIsCurrent: v.boolean(),
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "propose");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (
			!proposal.localeProposalTaskScope ||
			proposal.target.kind !== "localeProposal" ||
			proposal.localeProposalTaskScope.localeProposalId !==
				proposal.target.localeProposalId ||
			proposal.status !== "open"
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "This Translation Task cannot receive candidates.",
			});
		}
		const localeProposalId = proposal.target.localeProposalId;
		if (
			args.messageIds.length === 0 ||
			args.messageIds.length > MAX_SUBMISSION_ITEMS ||
			new Set(args.messageIds).size !== args.messageIds.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Submit 1–${MAX_SUBMISSION_ITEMS} distinct task keys at a time.`,
			});
		}
		const result = [];
		for (const messageId of args.messageIds) {
			const current = await currentLocaleProposalTarget(
				ctx,
				proposal,
				messageId,
			);
			const candidate = await ctx.db
				.query("agentTranslationCandidates")
				.withIndex("by_proposal_and_messageId_and_localeProposalId", (q) =>
					q
						.eq("proposalId", proposal._id)
						.eq("messageId", messageId)
						.eq("localeProposalId", localeProposalId),
				)
				.unique();
			const currentCandidate = candidate?.latestRevisionId
				? await ctx.db.get(candidate.latestRevisionId)
				: null;
			if (candidate && !currentCandidate) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Translation Task candidate lost its current revision.",
				});
			}
			if (
				currentCandidate &&
				currentCandidate.basis.kind !== "localeProposal"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Translation Task candidate has the wrong target basis.",
				});
			}
			const currentCandidateBasis =
				currentCandidate?.basis.kind === "localeProposal"
					? currentCandidate.basis
					: null;
			const basis = {
				kind: "localeProposal" as const,
				localeProposalId: current.localeProposal._id,
				snapshotId: current.source.sourceSnapshotId,
				sourceFingerprint: current.source.sourceFingerprint,
			};
			result.push({
				messageId,
				basis,
				currentRevision: candidate?.currentRevision ?? 0,
				currentCandidate:
					candidate && currentCandidate && currentCandidateBasis
						? {
								candidateId: candidate._id,
								revisionId: currentCandidate._id,
								revision: currentCandidate.revision,
								value: currentCandidate.value,
								intentionalBlankReason: currentCandidate.intentionalBlankReason,
								basisIsCurrent: sameLocaleProposalTaskBasis(
									currentCandidateBasis,
									basis,
								),
							}
						: null,
			});
		}
		return result;
	},
});

export const newLocaleTaskCandidatesForAgent = internalQuery({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
		messageIds: v.array(v.string()),
	},
	returns: v.array(
		v.object({
			messageId: v.string(),
			revisionId: v.id("agentTranslationCandidateRevisions"),
			revision: v.number(),
			value: v.string(),
			intentionalBlankReason: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (
			!proposal.localeProposalTaskScope ||
			proposal.target.kind !== "localeProposal" ||
			proposal.localeProposalTaskScope.localeProposalId !==
				proposal.target.localeProposalId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "New-Locale Translation Task not found.",
			});
		}
		const localeProposalId = proposal.target.localeProposalId;
		if (
			args.messageIds.length > MAX_SUBMISSION_ITEMS ||
			new Set(args.messageIds).size !== args.messageIds.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Candidate page is outside its bounded task envelope.",
			});
		}
		const result = [];
		for (const messageId of args.messageIds) {
			const candidate = await ctx.db
				.query("agentTranslationCandidates")
				.withIndex("by_proposal_and_messageId_and_localeProposalId", (q) =>
					q
						.eq("proposalId", proposal._id)
						.eq("messageId", messageId)
						.eq("localeProposalId", localeProposalId),
				)
				.unique();
			const revision = candidate?.latestRevisionId
				? await ctx.db.get(candidate.latestRevisionId)
				: null;
			if (revision) {
				result.push({
					messageId,
					revisionId: revision._id,
					revision: revision.revision,
					value: revision.value,
					intentionalBlankReason: revision.intentionalBlankReason,
				});
			}
		}
		return result;
	},
});

export const workspaceContext = internalQuery({
	args: {
		token: v.string(),
		keys: v.array(v.string()),
		locales: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		if (
			args.keys.length > MAX_CONTEXT_KEYS ||
			args.locales.length > MAX_CONTEXT_LOCALES ||
			args.keys.length * args.locales.length > MAX_CONTEXT_PAIRS
		) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `Workspace context supports at most ${MAX_CONTEXT_KEYS} keys, ${MAX_CONTEXT_LOCALES} Locales, and ${MAX_CONTEXT_PAIRS} pairs.`,
			});
		}
		const localeIds = new Map<string, Id<"locales">>();
		for (const code of args.locales) {
			const locale = await ctx.db
				.query("locales")
				.withIndex("by_project_code", (q) =>
					q.eq("projectId", token.projectId).eq("code", code),
				)
				.unique();
			if (locale && locale.archivedAt === undefined) {
				localeIds.set(code, locale._id);
			}
		}
		const rows = [];
		for (const messageId of args.keys) {
			for (const localeId of localeIds.values()) {
				try {
					rows.push(
						discoveryEntry(
							await currentWorkspaceTarget(
								ctx,
								token.projectId,
								messageId,
								localeId,
							),
						),
					);
				} catch (error) {
					if (
						error instanceof ConvexError &&
						typeof error.data === "object" &&
						error.data !== null &&
						"code" in error.data &&
						error.data.code === "NOT_FOUND"
					) {
						continue;
					}
					throw error;
				}
			}
		}
		const result = { rows };
		assertDiscoveryResponse(result);
		return result;
	},
});

export const workspaceSearch = internalQuery({
	args: {
		token: v.string(),
		q: v.optional(v.string()),
		localeCode: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "search");
		const active = await activeWorkingCatalog(ctx, token.projectId);
		if (!active) return { results: [], hasMore: false };
		const limit = Math.min(
			MAX_DISCOVERY_RESULTS,
			Math.max(1, Math.trunc(args.limit ?? MAX_DISCOVERY_RESULTS)),
		);
		const heads = await ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
			.take(MAX_CATALOG_WORKSPACE_VALUE_HEADS + 1);
		if (heads.length > MAX_CATALOG_WORKSPACE_VALUE_HEADS) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace exceeds its value-head envelope.",
			});
		}
		const headByIdentity = new Map(
			heads.map((head) => [`${head.messageId}\u0000${head.localeId}`, head]),
		);
		const sourceByMessageId = new Map(
			active.rows
				.filter((row) => row.isSource)
				.map((row) => [row.messageId, row]),
		);
		const needle = args.q?.trim().toLocaleLowerCase() ?? "";
		const matchingRows = active.rows.filter((row) => {
			if (row.isSource) return false;
			if (args.localeCode && row.localeCode !== args.localeCode) return false;
			const source = sourceByMessageId.get(row.messageId);
			const head = headByIdentity.get(`${row.messageId}\u0000${row.localeId}`);
			const visibleValue =
				head &&
				head.basisGitValueFingerprint === row.gitValueFingerprint &&
				head.basisGitValueRevision === (row.gitValueRevision ?? 0)
					? head.value
					: row.value;
			return (
				needle.length === 0 ||
				[row.messageId, source?.value ?? "", visibleValue]
					.join(" ")
					.toLocaleLowerCase()
					.includes(needle)
			);
		});
		const pageRows = matchingRows.slice(0, limit + 1);
		const hasMore = pageRows.length > limit;
		const results = await Promise.all(
			pageRows
				.slice(0, limit)
				.map(async (row) =>
					discoveryEntry(
						await currentWorkspaceTarget(
							ctx,
							token.projectId,
							row.messageId,
							row.localeId,
						),
					),
				),
		);
		const result = { results, hasMore };
		assertDiscoveryResponse(result);
		return result;
	},
});

/** Exhaustive, low-read discovery for translation work. The Navigation Index
 * owns ordering and classification; this query scans only a bounded index
 * window and hydrates full Source/target values for matches. The cursor pins
 * the exact projection so a Baseline change cannot silently splice two runs. */
export const workspaceWorkPage = internalQuery({
	args: {
		token: v.string(),
		cursor: v.string(),
		limit: v.number(),
		localeCode: v.optional(v.string()),
		reasons: v.optional(v.array(translationWorkReasonValidator)),
		q: v.optional(v.string()),
	},
	returns: translationWorkPageValidator,
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "search");
		if (
			!Number.isSafeInteger(args.limit) ||
			args.limit < 1 ||
			args.limit > MAX_WORK_QUEUE_ITEMS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Translation work pages contain 1–${MAX_WORK_QUEUE_ITEMS} items.`,
			});
		}
		const requestedReasons = args.reasons ?? [...ALL_TRANSLATION_WORK_REASONS];
		const reasonSet = new Set<TranslationWorkReason>();
		for (const reason of requestedReasons) {
			if (reasonSet.has(reason)) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Translation work reasons must be unique.",
				});
			}
			reasonSet.add(reason);
		}
		if (reasonSet.size === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "At least one translation work reason is required.",
			});
		}

		const projection = await activeProjectionFor(ctx, token.projectId);
		if (!projection) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "No active Baseline Catalog is available for this project.",
			});
		}
		await readyNavigationStateFor(ctx, {
			projectId: token.projectId,
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		});
		const decodedCursor = decodeTranslationWorkCursor(args.cursor);
		if (decodedCursor && decodedCursor.projectionId !== projection._id) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The Baseline changed while translation work was being paged; restart from the first page.",
			});
		}
		const cursor: TranslationWorkCursor = decodedCursor ?? {
			projectionId: projection._id,
			catalogIndex: 0,
			targetIndex: 0,
		};
		const rows = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", token.projectId)
					.eq("projectionId", projection._id)
					.gte("catalogIndex", cursor.catalogIndex),
			)
			.take(MAX_WORK_QUEUE_SCAN_ROWS + 1);
		const pageRows = rows.slice(0, MAX_WORK_QUEUE_SCAN_ROWS);
		const needle = args.q?.trim().toLocaleLowerCase() ?? "";
		const items: Array<{
			messageId: string;
			localeCode: string;
			reasons: TranslationWorkReason[];
			sourceValue: string;
			targetValue: string;
		}> = [];

		for (let rowIndex = 0; rowIndex < pageRows.length; rowIndex += 1) {
			const row = pageRows[rowIndex];
			if (!row) continue;
			const targetStart =
				row.catalogIndex === cursor.catalogIndex ? cursor.targetIndex : 0;
			if (
				targetStart >= row.targets.length &&
				row.catalogIndex === cursor.catalogIndex
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Translation work pagination cursor is invalid.",
				});
			}
			if (needle && !row.searchCorpus.some((value) => value.includes(needle))) {
				continue;
			}
			for (
				let targetIndex = targetStart;
				targetIndex < row.targets.length;
				targetIndex += 1
			) {
				const target = row.targets[targetIndex];
				if (
					!target ||
					(args.localeCode && target.localeCode !== args.localeCode)
				) {
					continue;
				}
				const reasons = translationWorkReasons(row, target).filter((reason) =>
					reasonSet.has(reason),
				);
				if (reasons.length === 0) continue;
				const current = await currentWorkspaceTarget(
					ctx,
					token.projectId,
					row.messageId,
					target.localeId,
				);
				// An empty Source value is source-data evidence, not untranslated
				// target work and not an Intentional Blank. Keep it out of every
				// translation-repair reason instead of asking agents to invent text.
				if (current.source.value.length === 0) continue;
				const item = {
					messageId: row.messageId,
					localeCode: target.localeCode,
					reasons,
					sourceValue: current.source.value,
					targetValue: current.value,
				};
				if (byteLength([...items, item]) > MAX_WORK_QUEUE_RESPONSE_BYTES) {
					if (items.length === 0) {
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message:
								"One translation work item exceeds the response envelope.",
						});
					}
					return {
						projectionId: projection._id,
						items,
						nextCursor: encodeTranslationWorkCursor({
							projectionId: projection._id,
							catalogIndex: row.catalogIndex,
							targetIndex,
						}),
					};
				}
				items.push(item);
				if (items.length === args.limit) {
					return {
						projectionId: projection._id,
						items,
						nextCursor: nextTranslationWorkCursor(
							rows,
							rowIndex,
							targetIndex,
							projection._id,
						),
					};
				}
			}
		}
		const overflow = rows[MAX_WORK_QUEUE_SCAN_ROWS];
		return {
			projectionId: projection._id,
			items,
			nextCursor: overflow
				? encodeTranslationWorkCursor({
						projectionId: projection._id,
						catalogIndex: overflow.catalogIndex,
						targetIndex: 0,
					})
				: null,
		};
	},
});

function assertBasisMatches(
	input: CandidateRevisionInput,
	current: Awaited<ReturnType<typeof currentWorkspaceTarget>>,
): void {
	if (input.basis.kind !== "catalogWorkspace") {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog Workspace candidates need a workspace basis.",
		});
	}
	if (
		input.basis.projectionId !== current.projection._id ||
		input.basis.snapshotId !== current.projection.snapshotId ||
		input.basis.gitValueFingerprint !== current.target.gitValueFingerprint ||
		input.basis.gitValueRevision !== (current.target.gitValueRevision ?? 0) ||
		input.basis.workspaceRevision !== current.workspaceRevision ||
		input.basis.sourceFingerprint !== current.source.sourceFingerprint
	) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Catalog Workspace basis changed; refresh before proposing.",
			current: {
				projectionId: current.projection._id,
				snapshotId: current.projection.snapshotId,
				gitValueFingerprint: current.target.gitValueFingerprint,
				gitValueRevision: current.target.gitValueRevision ?? 0,
				workspaceRevision: current.workspaceRevision,
				sourceFingerprint: current.source.sourceFingerprint,
				value: current.value,
			},
		});
	}
}

function revisionByteLength(input: {
	value: string;
	intentionalBlankReason?: string;
	clientRevisionKey: string;
	basis: CandidateRevisionInput["basis"];
}): number {
	return byteLength(input);
}

export const create = internalMutation({
	args: {
		token: v.string(),
		clientProposalKey: v.string(),
		target: targetValidator,
		localeProposalTaskScope: v.optional(localeProposalTaskScopeValidator),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "propose");
		assertBoundedString(
			args.clientProposalKey,
			"clientProposalKey",
			MAX_PROPOSAL_CLIENT_KEY_BYTES,
		);
		let localeProposal: Doc<"localeProposals"> | null = null;
		if (args.target.kind === "localeProposal") {
			localeProposal = await ctx.db.get(args.target.localeProposalId);
			if (!localeProposal || localeProposal.projectId !== token.projectId) {
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Locale Proposal not found for this project.",
				});
			}
			if (
				args.localeProposalTaskScope &&
				(args.localeProposalTaskScope.localeProposalId !== localeProposal._id ||
					args.localeProposalTaskScope.localeCode !==
						localeProposal.localeCode ||
					args.localeProposalTaskScope.targetCount !==
						localeProposal.sourceMessageCount)
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"New-Locale Translation Task scope does not match its Locale Proposal.",
				});
			}
		} else if (args.localeProposalTaskScope) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Only a Locale Proposal can back a new-Locale Translation Task.",
			});
		}
		const existing = await ctx.db
			.query("agentTranslationProposals")
			.withIndex("by_project_and_token_and_clientProposalKey", (q) =>
				q
					.eq("projectId", token.projectId)
					.eq("createdByTokenId", token._id)
					.eq("clientProposalKey", args.clientProposalKey),
			)
			.unique();
		if (existing) {
			if (
				JSON.stringify(existing.target) !== JSON.stringify(args.target) ||
				JSON.stringify(existing.localeProposalTaskScope) !==
					JSON.stringify(args.localeProposalTaskScope)
			) {
				throw new ConvexError({
					code: "IDEMPOTENCY_KEY_REUSED",
					message:
						"clientProposalKey is already bound to a different proposal target.",
				});
			}
			return proposalSummary(existing);
		}
		if (localeProposal && args.localeProposalTaskScope) {
			const [projectTask, tokenTask] = await Promise.all([
				newLocaleTaskForOwner(
					ctx,
					token.projectId,
					undefined,
					localeProposal._id,
				),
				newLocaleTaskForOwner(
					ctx,
					token.projectId,
					token._id,
					localeProposal._id,
				),
			]);
			const existingTask = projectTask ?? tokenTask;
			if (existingTask) {
				if (localeProposal.status !== "draft") {
					throw new ConvexError({
						code: "BAD_STATE",
						message:
							"This new Locale is already finalized; resume its completed task instead of creating another.",
					});
				}
				return proposalSummary(existingTask);
			}
		}
		if (
			args.localeProposalTaskScope !== undefined &&
			localeProposal?.status !== "draft"
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message:
					"This new Locale is already finalized; resume its completed task instead of creating another.",
			});
		}
		const timestamp = now();
		const proposalId = await ctx.db.insert("agentTranslationProposals", {
			projectId: token.projectId,
			createdByTokenId: token._id,
			createdBy: { kind: "agent", id: token._id },
			clientProposalKey: args.clientProposalKey,
			target: args.target,
			...(args.localeProposalTaskScope === undefined
				? {}
				: { localeProposalTaskScope: args.localeProposalTaskScope }),
			status: "open",
			candidateCount: 0,
			revisionCount: 0,
			retainedByteLength: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const proposal = await ctx.db.get(proposalId);
		if (!proposal) throw new ConvexError("Proposal was not created.");
		return proposalSummary(proposal);
	},
});

export const submitRevisions = internalMutation({
	args: {
		token: v.string(),
		proposalId: v.id("agentTranslationProposals"),
		items: v.array(candidateRevisionInputValidator),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "propose");
		const proposal = await proposalForToken(ctx, args.proposalId, token._id);
		if (args.items.length === 0 || args.items.length > MAX_SUBMISSION_ITEMS) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `A candidate revision batch must contain 1–${MAX_SUBMISSION_ITEMS} items.`,
			});
		}
		if (proposal.status !== "open") {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "A closed translation proposal cannot receive revisions.",
			});
		}
		if (byteLength(args.items) > MAX_SUBMISSION_BYTES) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "A candidate revision batch exceeds its byte envelope.",
			});
		}
		const results = [];
		const identities = new Set<string>();
		let addedBytes = 0;
		let addedCandidates = 0;
		let addedRevisions = 0;
		for (const item of args.items) {
			assertBoundedString(
				item.clientRevisionKey,
				"clientRevisionKey",
				MAX_REVISION_CLIENT_KEY_BYTES,
			);
			const intentionalBlankReason = item.intentionalBlankReason?.trim();
			if (item.value.trim().length === 0) {
				if (item.value.length !== 0 || !intentionalBlankReason) {
					throw new ConvexError({
						code: "VALIDATION",
						message:
							"An empty candidate must be an Intentional Blank with a reason.",
					});
				}
				assertBoundedString(
					intentionalBlankReason,
					"intentionalBlankReason",
					MAX_INTENTIONAL_BLANK_REASON_BYTES,
				);
			} else if (intentionalBlankReason !== undefined) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"Only an empty candidate can carry an Intentional Blank reason.",
				});
			}
			if (
				new TextEncoder().encode(item.value).byteLength >
				MAX_CANDIDATE_VALUE_BYTES
			) {
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "One candidate value exceeds its byte envelope.",
				});
			}
			assertNonNegativeInteger(
				item.expectedCandidateRevision,
				"expectedCandidateRevision",
			);
			const identity =
				item.basis.kind === "localeProposal"
					? `${item.messageId}\u0000localeProposal:${item.basis.localeProposalId}`
					: `${item.messageId}\u0000${item.localeId}`;
			if (identities.has(identity)) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "A revision batch contains a duplicate target.",
				});
			}
			identities.add(identity);
			if (proposal.taskScope) {
				const taskTarget = await ctx.db
					.query("translationTaskTargets")
					.withIndex("by_proposal_and_messageId", (q) =>
						q.eq("proposalId", proposal._id).eq("messageId", item.messageId),
					)
					.unique();
				if (
					!taskTarget ||
					item.localeId !== taskTarget.localeId ||
					item.basis.kind !== "catalogWorkspace"
				) {
					throw new ConvexError({
						code: "VALIDATION",
						message:
							"This candidate is outside the Translation Task's frozen target scope.",
					});
				}
			}
			let candidate: Doc<"agentTranslationCandidates"> | null = null;
			if (proposal.target.kind === "catalogWorkspace") {
				if (
					item.localeId === undefined ||
					item.basis.kind !== "catalogWorkspace"
				) {
					throw new ConvexError({
						code: "VALIDATION",
						message:
							"Catalog Workspace candidates need a Locale and workspace basis.",
					});
				}
				candidate = await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", item.messageId)
							.eq("localeId", item.localeId),
					)
					.unique();
			} else {
				const localeProposalId = proposal.target.localeProposalId;
				if (
					item.localeId !== undefined ||
					item.basis.kind !== "localeProposal" ||
					item.basis.localeProposalId !== proposal.target.localeProposalId
				) {
					throw new ConvexError({
						code: "VALIDATION",
						message:
							"Locale Proposal candidates need their proposal source basis.",
					});
				}
				candidate = await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeProposalId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", item.messageId)
							.eq("localeProposalId", localeProposalId),
					)
					.unique();
			}
			const existingRevision = candidate
				? await ctx.db
						.query("agentTranslationCandidateRevisions")
						.withIndex("by_candidate_and_clientRevisionKey", (q) =>
							q
								.eq("candidateId", candidate._id)
								.eq("clientRevisionKey", item.clientRevisionKey),
						)
						.unique()
				: null;
			if (existingRevision) {
				if (
					existingRevision.value !== item.value ||
					existingRevision.intentionalBlankReason !== intentionalBlankReason ||
					JSON.stringify(existingRevision.basis) !== JSON.stringify(item.basis)
				) {
					throw new ConvexError({
						code: "IDEMPOTENCY_KEY_REUSED",
						message:
							"clientRevisionKey is already bound to different candidate evidence.",
					});
				}
				results.push({
					candidateId: existingRevision.candidateId,
					revisionId: existingRevision._id,
					revision: existingRevision.revision,
					status: "open" as const,
				});
				continue;
			}
			if (proposal.target.kind === "catalogWorkspace") {
				const current = await currentWorkspaceTarget(
					ctx,
					proposal.projectId,
					item.messageId,
					item.localeId as Id<"locales">,
				);
				assertBasisMatches(item, current);
				if (intentionalBlankReason === undefined) {
					assertTargetValueContract({
						messageId: item.messageId,
						localeCode: current.target.localeCode,
						value: item.value,
						source: current.source,
					});
				}
			} else {
				const current = await currentLocaleProposalTarget(
					ctx,
					proposal,
					item.messageId,
				);
				if (
					item.basis.kind !== "localeProposal" ||
					item.basis.snapshotId !== current.source.sourceSnapshotId ||
					item.basis.sourceFingerprint !== current.source.sourceFingerprint
				) {
					throw new ConvexError({
						code: "STALE_BASIS",
						message:
							"The Locale Proposal source basis changed; refresh before proposing.",
					});
				}
				if (intentionalBlankReason === undefined) {
					assertTargetValueContract({
						messageId: item.messageId,
						localeCode: current.localeProposal.localeCode,
						value: item.value,
						source: current.source.source,
					});
				}
			}
			const currentRevision = candidate?.currentRevision ?? 0;
			if (item.expectedCandidateRevision !== currentRevision) {
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"The proposal target has a newer candidate revision; submit a correction against it.",
				});
			}
			if (
				!candidate &&
				proposal.candidateCount + addedCandidates >= MAX_CANDIDATES
			) {
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "This proposal has reached its candidate target limit.",
				});
			}
			const revision = currentRevision + 1;
			if (proposal.revisionCount + addedRevisions >= MAX_REVISIONS) {
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "This proposal has reached its revision limit.",
				});
			}
			const valueFingerprint = await sha256Hex(item.value);
			const retainedBytes = revisionByteLength({
				value: item.value,
				...(intentionalBlankReason === undefined
					? {}
					: { intentionalBlankReason }),
				clientRevisionKey: item.clientRevisionKey,
				basis: item.basis,
			});
			addedBytes += retainedBytes;
			if (proposal.retainedByteLength + addedBytes > MAX_RETAINED_BYTES) {
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "This proposal has reached its retained evidence limit.",
				});
			}
			const timestamp = now();
			const candidateId =
				candidate?._id ??
				(await ctx.db.insert("agentTranslationCandidates", {
					projectId: proposal.projectId,
					proposalId: proposal._id,
					messageId: item.messageId,
					...(item.localeId === undefined ? {} : { localeId: item.localeId }),
					...(item.basis.kind === "localeProposal"
						? { localeProposalId: item.basis.localeProposalId }
						: {}),
					currentRevision: 0,
					createdAt: timestamp,
					updatedAt: timestamp,
				}));
			const revisionId = await ctx.db.insert(
				"agentTranslationCandidateRevisions",
				{
					projectId: proposal.projectId,
					proposalId: proposal._id,
					candidateId,
					messageId: item.messageId,
					...(item.localeId === undefined ? {} : { localeId: item.localeId }),
					...(item.basis.kind === "localeProposal"
						? { localeProposalId: item.basis.localeProposalId }
						: {}),
					revision,
					clientRevisionKey: item.clientRevisionKey,
					value: item.value,
					...(intentionalBlankReason === undefined
						? {}
						: { intentionalBlankReason }),
					valueFingerprint,
					basis: item.basis,
					createdBy: { kind: "agent", id: token._id },
					createdAt: timestamp,
				},
			);
			await ctx.db.patch(candidateId, {
				currentRevision: revision,
				latestRevisionId: revisionId,
				updatedAt: timestamp,
			});
			addedCandidates += candidate ? 0 : 1;
			addedRevisions += 1;
			results.push({
				candidateId,
				revisionId,
				revision,
				status: "open" as const,
			});
		}
		await ctx.db.patch(proposal._id, {
			candidateCount: proposal.candidateCount + addedCandidates,
			revisionCount: proposal.revisionCount + addedRevisions,
			retainedByteLength: proposal.retainedByteLength + addedBytes,
			updatedAt: now(),
		});
		return {
			proposal: proposalSummary({
				...proposal,
				candidateCount: proposal.candidateCount + addedCandidates,
				revisionCount: proposal.revisionCount + addedRevisions,
				retainedByteLength: proposal.retainedByteLength + addedBytes,
				updatedAt: now(),
			}),
			revisions: results,
		};
	},
});

export const get = internalQuery({
	args: {
		token: v.string(),
		proposalId: v.id("agentTranslationProposals"),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.proposalId, token._id);
		return proposalSummary(proposal);
	},
});

export const listCandidates = internalQuery({
	args: {
		token: v.string(),
		proposalId: v.id("agentTranslationProposals"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.proposalId, token._id);
		const page = await ctx.db
			.query("agentTranslationCandidates")
			.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
			.paginate(args.paginationOpts);
		const entries = await Promise.all(
			page.page.map(async (candidate) => {
				const revision = candidate.latestRevisionId
					? await ctx.db.get(candidate.latestRevisionId)
					: null;
				return { candidate, revision };
			}),
		);
		return { ...page, page: entries };
	},
});

export const listForReview = query({
	args: {
		projectId: v.id("projects"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const page = await ctx.db
			.query("agentTranslationProposals")
			.withIndex("by_project_and_updatedAt", (q) =>
				q.eq("projectId", args.projectId),
			)
			.order("desc")
			.paginate(args.paginationOpts);
		return page;
	},
});

export const getForReview = query({
	args: { proposalId: v.id("agentTranslationProposals") },
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal) return null;
		await requireViewer(ctx, proposal.projectId);
		// Complete new-Locale tasks have their own 16-row review page. Avoid
		// subscribing this routing query to the entire catalog-sized candidate set.
		const candidates = proposal.localeProposalTaskScope
			? []
			: await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
					.take(MAX_REVIEW_CANDIDATES + 1);
		if (candidates.length > MAX_REVIEW_CANDIDATES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Translation proposal exceeds its candidate envelope.",
			});
		}
		const entries = await Promise.all(
			candidates.map(async (candidate) => {
				const revision = candidate.latestRevisionId
					? await ctx.db.get(candidate.latestRevisionId)
					: null;
				const reviews = revision
					? await ctx.db
							.query("agentTranslationCandidateReviews")
							.withIndex("by_revision", (q) => q.eq("revisionId", revision._id))
							.order("desc")
							.take(2)
					: [];
				return { candidate, revision, reviews };
			}),
		);
		const storedTaskTargets = proposal.taskScope
			? await ctx.db
					.query("translationTaskTargets")
					.withIndex("by_proposal_and_catalogIndex", (q) =>
						q.eq("proposalId", proposal._id),
					)
					.take(MAX_TASK_TARGETS + 1)
			: [];
		if (storedTaskTargets.length > MAX_TASK_TARGETS) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Translation Task exceeds its target envelope.",
			});
		}
		const candidateMessageIds = new Set(
			candidates.map((candidate) => candidate.messageId),
		);
		const taskTargets = await Promise.all(
			storedTaskTargets.map(async (target) => {
				// Candidate cards have their own compact live-context subscription.
				// Hydrate only still-waiting rows here so one accepted value does not
				// make this task-level query reread every selected Catalog key.
				if (candidateMessageIds.has(target.messageId)) return target;
				const current = await currentWorkspaceTarget(
					ctx,
					proposal.projectId,
					target.messageId,
					target.localeId,
				);
				return {
					...target,
					sourceValue: current.source.value,
					targetValue: current.value,
					basis: catalogWorkspaceTaskBasis(current),
				};
			}),
		);
		return { proposal, taskTargets, candidates: entries };
	},
});

/** Resolve the live human-review context for one candidate without widening
 * the proposal-list query into an unbounded Catalog Workspace read. Review
 * cards subscribe independently, so focused proposals show source, current
 * target, and contract facts together while stale evidence remains visible. */
export const contextForReview = query({
	args: { revisionId: v.id("agentTranslationCandidateRevisions") },
	handler: async (ctx, args) => {
		const revision = await ctx.db.get(args.revisionId);
		if (!revision) return null;
		const proposal = await ctx.db.get(revision.proposalId);
		if (!proposal) return null;
		await requireViewer(ctx, proposal.projectId);

		try {
			if (proposal.target.kind === "catalogWorkspace") {
				if (
					revision.localeId === undefined ||
					revision.basis.kind !== "catalogWorkspace"
				) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Catalog Workspace candidate evidence is incomplete.",
					});
				}
				const current = await currentWorkspaceTarget(
					ctx,
					proposal.projectId,
					revision.messageId,
					revision.localeId,
				);
				const currentBasis = catalogWorkspaceTaskBasis(current);
				const review = await latestCandidateReview(ctx, revision._id);
				return {
					kind: "catalogWorkspace" as const,
					available: true as const,
					localeCode: current.target.localeCode,
					source: {
						value: current.source.value,
						icuType: current.source.icuType,
						argumentNames: current.source.argumentNames,
						argumentNamesComplete: current.source.argumentNamesComplete,
						declaredPlaceholderNames:
							current.source.declaredPlaceholderNames ?? [],
						declaredPlaceholderNamesComplete:
							current.source.declaredPlaceholderNamesComplete ?? true,
					},
					target: {
						value: current.value,
						catalogPath: current.target.catalogPath,
					},
					basisIsCurrent: sameCatalogWorkspaceTaskBasis(
						revision.basis,
						currentBasis,
					),
					reviewBasisIsCurrent:
						review?.appliedBasis?.kind === "catalogWorkspace"
							? sameCatalogWorkspaceTaskBasis(review.appliedBasis, currentBasis)
							: null,
				};
			}

			if (revision.basis.kind !== "localeProposal") {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Locale Proposal candidate evidence is incomplete.",
				});
			}
			const current = await currentLocaleProposalTarget(
				ctx,
				proposal,
				revision.messageId,
			);
			const value = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q
						.eq("proposalId", current.localeProposal._id)
						.eq("messageId", revision.messageId),
				)
				.unique();
			const currentBasis = {
				kind: "localeProposal" as const,
				localeProposalId: current.localeProposal._id,
				snapshotId: current.source.sourceSnapshotId,
				sourceFingerprint: current.source.sourceFingerprint,
			};
			const review = await latestCandidateReview(ctx, revision._id);
			return {
				kind: "localeProposal" as const,
				available: true as const,
				localeCode: current.localeProposal.runtimeLocale,
				source: {
					value: current.source.sourceValue,
					icuType: current.source.source.icuType,
					argumentNames: current.source.source.argumentNames,
					argumentNamesComplete: current.source.source.argumentNamesComplete,
					declaredPlaceholderNames:
						current.source.source.declaredPlaceholderNames,
					declaredPlaceholderNamesComplete:
						current.source.source.declaredPlaceholderNamesComplete,
				},
				target: {
					value: value?.value ?? "",
					catalogPath: `${current.localeProposal.sourceCatalogPath.slice(
						0,
						current.localeProposal.sourceCatalogPath.lastIndexOf("/") + 1,
					)}intl_pt.arb`,
				},
				basisIsCurrent:
					revision.basis.localeProposalId === current.localeProposal._id &&
					revision.basis.snapshotId === current.source.sourceSnapshotId &&
					revision.basis.sourceFingerprint === current.source.sourceFingerprint,
				reviewBasisIsCurrent:
					review?.appliedBasis?.kind === "localeProposal"
						? sameLocaleProposalTaskBasis(review.appliedBasis, currentBasis)
						: null,
			};
		} catch (error) {
			if (error instanceof ConvexError) {
				return {
					kind: proposal.target.kind,
					available: false as const,
					localeCode: null,
					basisIsCurrent: false,
				};
			}
			throw error;
		}
	},
});

async function completedProposalStatus(
	ctx: MutationCtx,
	proposalId: Id<"agentTranslationProposals">,
): Promise<"open" | "accepted" | "rejected"> {
	const proposal = await ctx.db.get(proposalId);
	// A complete new-Locale task is only complete once finalization creates its
	// immutable artifact. Keeping it open during review also avoids rescanning
	// the whole task after every accepted batch.
	if (proposal?.localeProposalTaskScope) return "open";
	const candidates = await ctx.db
		.query("agentTranslationCandidates")
		.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
		.take(MAX_REVIEW_CANDIDATES + 1);
	if (
		candidates.length === 0 ||
		candidates.length > MAX_REVIEW_CANDIDATES ||
		(proposal?.taskScope !== undefined &&
			candidates.length !== proposal.taskScope.targetCount)
	) {
		return "open";
	}
	let accepted = 0;
	for (const candidate of candidates) {
		if (!candidate.latestRevisionId) return "open";
		const review = await latestCandidateReview(
			ctx,
			candidate.latestRevisionId as Id<"agentTranslationCandidateRevisions">,
		);
		if (!review) return "open";
		if (review.decision.kind !== "reject") accepted += 1;
	}
	return accepted > 0 ? "accepted" : "rejected";
}

/** Accept a bounded set of exact candidates from either Translation Task
 * adapter in one transaction. Edits, rejection, and Intentional Blanks remain
 * individual human decisions. Any stale member aborts the whole batch. */
export const acceptTaskCandidates = mutation({
	args: {
		proposalId: v.id("agentTranslationProposals"),
		candidateRevisionIds: v.array(v.id("agentTranslationCandidateRevisions")),
	},
	returns: v.object({
		accepted: v.number(),
		status: v.union(
			v.literal("open"),
			v.literal("accepted"),
			v.literal("rejected"),
		),
	}),
	handler: async (ctx, args) => {
		if (
			args.candidateRevisionIds.length === 0 ||
			args.candidateRevisionIds.length > MAX_SUBMISSION_ITEMS
		) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `An exact-acceptance batch needs 1–${MAX_SUBMISSION_ITEMS} candidates.`,
			});
		}
		if (
			new Set(args.candidateRevisionIds).size !==
			args.candidateRevisionIds.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "An exact-acceptance batch repeats a candidate revision.",
			});
		}
		const proposal = await ctx.db.get(args.proposalId);
		const isExistingLocaleTask =
			proposal?.taskScope !== undefined &&
			proposal.target.kind === "catalogWorkspace";
		const isNewLocaleTask =
			proposal?.localeProposalTaskScope !== undefined &&
			proposal.target.kind === "localeProposal" &&
			proposal.localeProposalTaskScope.localeProposalId ===
				proposal.target.localeProposalId;
		if (!proposal || (!isExistingLocaleTask && !isNewLocaleTask)) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		const localeProposalId =
			proposal.target.kind === "localeProposal"
				? proposal.target.localeProposalId
				: null;
		const { userId } = await requireEditor(ctx, proposal.projectId);
		let accepted = 0;
		for (const candidateRevisionId of args.candidateRevisionIds) {
			const revision = await ctx.db.get(candidateRevisionId);
			if (!revision || revision.proposalId !== proposal._id) {
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Task candidate revision not found.",
				});
			}
			if (
				revision.value.length === 0 ||
				revision.intentionalBlankReason !== undefined
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"An Intentional Blank candidate must be reviewed individually with its reason.",
				});
			}
			if (
				(isExistingLocaleTask &&
					(revision.localeId === undefined ||
						revision.basis.kind !== "catalogWorkspace")) ||
				(isNewLocaleTask &&
					(revision.localeProposalId !== localeProposalId ||
						revision.basis.kind !== "localeProposal"))
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Task candidate evidence does not match its adapter.",
				});
			}
			const candidate = await ctx.db.get(revision.candidateId);
			if (!candidate || candidate.latestRevisionId !== revision._id) {
				throw new ConvexError({
					code: "STALE_BASIS",
					message: "Only current candidate revisions can be batch accepted.",
				});
			}
			const existingReview = await latestCandidateReview(ctx, revision._id);
			if (existingReview) {
				if (existingReview.decision.kind !== "accept") {
					throw new ConvexError({
						code: "BAD_STATE",
						message:
							"A task candidate already has a different review decision.",
					});
				}
				continue;
			}
			const valueFingerprint = await sha256Hex(revision.value);
			let appliedBasis = revision.basis;
			if (
				proposal.target.kind === "catalogWorkspace" &&
				revision.localeId !== undefined &&
				revision.basis.kind === "catalogWorkspace"
			) {
				const applied = await applyAgentTargetValue(ctx, {
					projectId: proposal.projectId,
					messageId: revision.messageId,
					localeId: revision.localeId,
					value: revision.value,
					expectedProjectionId: revision.basis.projectionId,
					expectedSnapshotId: revision.basis.snapshotId,
					expectedGitValueFingerprint: revision.basis.gitValueFingerprint,
					expectedGitValueRevision: revision.basis.gitValueRevision,
					expectedWorkspaceRevision: revision.basis.workspaceRevision,
					expectedSourceFingerprint: revision.basis.sourceFingerprint,
					actor: { kind: "user", id: userId },
				});
				appliedBasis = {
					...revision.basis,
					workspaceRevision: applied.workspaceRevision,
				};
			} else if (
				proposal.target.kind === "localeProposal" &&
				revision.basis.kind === "localeProposal"
			) {
				await ctx.runMutation(internal.localeProposals.applyReviewedValue, {
					projectId: proposal.projectId,
					proposalId: proposal.target.localeProposalId,
					messageId: revision.messageId,
					sourceSnapshotId: revision.basis.snapshotId,
					sourceFingerprint: revision.basis.sourceFingerprint,
					candidateValueFingerprint: revision.valueFingerprint,
					acceptedValue: revision.value,
					decision: { kind: "accept" },
					reviewer: { kind: "user", id: userId },
				});
			} else {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Task candidate evidence is incomplete.",
				});
			}
			await ctx.db.insert("agentTranslationCandidateReviews", {
				projectId: proposal.projectId,
				proposalId: proposal._id,
				candidateId: candidate._id,
				revisionId: revision._id,
				decision: { kind: "accept" },
				reviewer: { kind: "user", id: userId },
				finalValue: revision.value,
				finalValueFingerprint: valueFingerprint,
				appliedBasis,
				createdAt: now(),
			});
			accepted += 1;
		}
		const status = await completedProposalStatus(ctx, proposal._id);
		await ctx.db.patch(proposal._id, { status, updatedAt: now() });
		return { accepted, status };
	},
});

const candidateReviewResultValidator = v.object({
	reviewId: v.id("agentTranslationCandidateReviews"),
	workspaceRevision: v.optional(v.number()),
	decision: reviewDecisionValidator,
});

/** Both human and independently authorized agent review use the same exact
 * revision application; only human review exposes editing or Source rebasing. */
async function applyCandidateReview(
	ctx: MutationCtx,
	args: {
		candidateRevisionId: Id<"agentTranslationCandidateRevisions">;
		decision: TranslationTaskReviewDecision;
	},
	reviewer: {
		actor: { kind: "user" | "agent"; id: string };
		reviewAuthorization?: AgentReviewAuthorization;
	},
) {
	const revision = await ctx.db.get(args.candidateRevisionId);
	if (!revision) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Candidate revision not found.",
		});
	}
	const proposal = await ctx.db.get(revision.proposalId);
	if (!proposal) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Translation proposal not found.",
		});
	}
	const candidate = await ctx.db.get(revision.candidateId);
	if (!candidate || candidate.latestRevisionId !== revision._id) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "Only the current candidate revision can be reviewed.",
		});
	}
	const existingReview = await latestCandidateReview(ctx, revision._id);
	if (existingReview) {
		const status = await completedProposalStatus(ctx, proposal._id);
		if (status !== proposal.status) {
			await ctx.db.patch(proposal._id, { status, updatedAt: now() });
		}
		return {
			reviewId: existingReview._id,
			workspaceRevision: undefined,
			decision: existingReview.decision,
		};
	}
	const actor = reviewer.actor;
	let finalValue: string | undefined;
	let finalValueFingerprint: string | undefined;
	let workspaceRevision: number | undefined;
	let appliedBasis: CandidateRevisionInput["basis"] | undefined;
	if (args.decision.kind === "reject") {
		// Rejection is deliberately evidence-only.
	} else if (proposal.target.kind === "catalogWorkspace") {
		if (
			revision.localeId === undefined ||
			revision.basis.kind !== "catalogWorkspace"
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace candidate evidence is incomplete.",
			});
		}
		const value =
			args.decision.kind === "intentionalBlank"
				? ""
				: args.decision.kind === "accept" ||
						args.decision.kind === "keepForCurrentSource"
					? revision.value
					: args.decision.value;
		const intentionalBlankReason =
			args.decision.kind === "intentionalBlank"
				? args.decision.reason
				: undefined;
		finalValue = value;
		finalValueFingerprint = await sha256Hex(value);
		const basis =
			args.decision.kind === "keepForCurrentSource"
				? catalogWorkspaceTaskBasis(
						await currentWorkspaceTarget(
							ctx,
							proposal.projectId,
							revision.messageId,
							revision.localeId,
						),
					)
				: revision.basis;
		const applied = await applyAgentTargetValue(ctx, {
			projectId: proposal.projectId,
			messageId: revision.messageId,
			localeId: revision.localeId,
			value,
			expectedProjectionId: basis.projectionId,
			expectedSnapshotId: basis.snapshotId,
			expectedGitValueFingerprint: basis.gitValueFingerprint,
			expectedGitValueRevision: basis.gitValueRevision,
			expectedWorkspaceRevision: basis.workspaceRevision,
			expectedSourceFingerprint: basis.sourceFingerprint,
			actor,
			reviewAuthorization: reviewer.reviewAuthorization,
			...(intentionalBlankReason === undefined
				? {}
				: { intentionalBlankReason }),
		});
		workspaceRevision = applied.workspaceRevision;
		appliedBasis = {
			...basis,
			workspaceRevision: applied.workspaceRevision,
		};
	} else {
		if (args.decision.kind === "keepForCurrentSource") {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Keeping a candidate for the current source is only available for existing-Locale tasks.",
			});
		}
		if (
			revision.localeProposalId !== proposal.target.localeProposalId ||
			revision.basis.kind !== "localeProposal"
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Locale Proposal candidate evidence is incomplete.",
			});
		}
		const value =
			args.decision.kind === "intentionalBlank"
				? ""
				: args.decision.kind === "accept"
					? revision.value
					: args.decision.value;
		finalValue = value;
		finalValueFingerprint = await sha256Hex(value);
		appliedBasis = revision.basis;
		await ctx.runMutation(internal.localeProposals.applyReviewedValue, {
			projectId: proposal.projectId,
			proposalId: proposal.target.localeProposalId,
			messageId: revision.messageId,
			sourceSnapshotId: revision.basis.snapshotId,
			sourceFingerprint: revision.basis.sourceFingerprint,
			candidateValueFingerprint: revision.valueFingerprint,
			acceptedValue: revision.value,
			decision: args.decision,
			reviewer: actor,
			reviewAuthorization: reviewer.reviewAuthorization,
		});
	}
	const reviewId = await ctx.db.insert("agentTranslationCandidateReviews", {
		projectId: proposal.projectId,
		proposalId: proposal._id,
		candidateId: candidate._id,
		revisionId: revision._id,
		decision: args.decision,
		reviewer: actor,
		reviewAuthorization: reviewer.reviewAuthorization,
		...(finalValue === undefined ? {} : { finalValue }),
		...(finalValueFingerprint === undefined ? {} : { finalValueFingerprint }),
		...(appliedBasis === undefined ? {} : { appliedBasis }),
		createdAt: now(),
	});
	const status = await completedProposalStatus(ctx, proposal._id);
	await ctx.db.patch(proposal._id, { status, updatedAt: now() });
	return { reviewId, workspaceRevision, decision: args.decision };
}

export const reviewCandidate = mutation({
	args: {
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
		decision: reviewDecisionValidator,
	},
	returns: candidateReviewResultValidator,
	handler: async (ctx, args) => {
		const revision = await ctx.db.get(args.candidateRevisionId);
		if (!revision)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Candidate revision not found.",
			});
		const { userId } = await requireEditor(ctx, revision.projectId);
		return await applyCandidateReview(ctx, args, {
			actor: { kind: "user", id: userId },
		});
	},
});

export const candidateReviewAuthorization = query({
	args: { candidateRevisionId: v.id("agentTranslationCandidateRevisions") },
	returns: candidateAuthorizationValidator,
	handler: async (ctx, args) =>
		await readCandidateAuthorization(ctx, args.candidateRevisionId),
});

export const grantCandidateReview = mutation({
	args: {
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
		reviewerTokenId: v.id("apiTokens"),
	},
	returns: v.id("agentReviewGrants"),
	handler: async (ctx, args) =>
		await grantReview(ctx, args.candidateRevisionId, args.reviewerTokenId),
});

export const revokeCandidateReviewGrant = mutation({
	args: { grantId: v.id("agentReviewGrants") },
	returns: v.null(),
	handler: async (ctx, args) => await revokeReview(ctx, args.grantId),
});

const reviewSummaryValidator = v.object({
	reviewId: v.id("agentTranslationCandidateReviews"),
	decision: v.object({
		kind: v.union(
			v.literal("accept"),
			v.literal("reject"),
			v.literal("acceptWithEdits"),
			v.literal("keepForCurrentSource"),
			v.literal("intentionalBlank"),
		),
		reason: v.optional(v.string()),
	}),
	reviewer: v.object({
		kind: v.union(
			v.literal("user"),
			v.literal("agent"),
			v.literal("system"),
			v.literal("repositoryAdapter"),
		),
		id: v.string(),
	}),
	reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
	finalValueFingerprint: v.optional(v.string()),
	createdAt: v.number(),
});

const agentReviewContextValidator = v.object({
	kind: v.literal("candidate"),
	proposalId: v.id("agentTranslationProposals"),
	candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	messageId: v.string(),
	localeCode: v.string(),
	source: v.object({
		value: v.string(),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		argumentNames: v.array(v.string()),
		argumentNamesComplete: v.boolean(),
		declaredPlaceholderNames: v.array(v.string()),
		declaredPlaceholderNamesComplete: v.boolean(),
	}),
	target: v.object({
		value: v.string(),
		catalogPath: v.string(),
		intentionalBlankReason: v.optional(v.string()),
	}),
	candidate: v.object({
		value: v.string(),
		intentionalBlankReason: v.optional(v.string()),
		createdBy: v.object({
			kind: v.union(
				v.literal("user"),
				v.literal("agent"),
				v.literal("system"),
				v.literal("repositoryAdapter"),
			),
			id: v.string(),
		}),
	}),
	basisIsCurrent: v.boolean(),
	alreadyReviewed: v.boolean(),
	latestReview: v.union(v.null(), reviewSummaryValidator),
	reviewAuthorization: agentReviewAuthorizationValidator,
	reviewToken: v.string(),
});

const recordedReviewValidator = v.object({
	kind: v.literal("recordedReview"),
	candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	alreadyReviewed: v.literal(true),
	latestReview: reviewSummaryValidator,
	reviewAuthorization: agentReviewAuthorizationValidator,
});

function reviewSummary(review: Doc<"agentTranslationCandidateReviews">) {
	const reason =
		"reason" in review.decision ? review.decision.reason : undefined;
	return {
		reviewId: review._id,
		decision: {
			kind: review.decision.kind,
			...(reason === undefined
				? {}
				: {
						reason: reason.length > 1024 ? `${reason.slice(0, 1024)}…` : reason,
					}),
		},
		reviewer: review.reviewer,
		reviewAuthorization: review.reviewAuthorization,
		finalValueFingerprint: review.finalValueFingerprint,
		createdAt: review.createdAt,
	};
}

/** The read token binds the exact visible facts to the reviewer credential and
 * current authorization. Staged new-Locale edits are included separately from
 * Source basis because candidate submission does not own that mutable value. */
async function contextForAgentReviewer(
	ctx: QueryCtx | MutationCtx,
	authorized: Awaited<ReturnType<typeof authorizeCandidateReview>>,
) {
	const { revision, proposal, authorization } = authorized;
	const review = await latestCandidateReview(ctx, revision._id);
	const common = {
		kind: "candidate" as const,
		proposalId: proposal._id,
		candidateRevisionId: revision._id,
		messageId: revision.messageId,
		candidate: {
			value: revision.value,
			intentionalBlankReason: revision.intentionalBlankReason,
			createdBy: revision.createdBy,
		},
		alreadyReviewed: review !== null,
		latestReview: review ? reviewSummary(review) : null,
		reviewAuthorization: authorization,
	};
	let context: Omit<Infer<typeof agentReviewContextValidator>, "reviewToken">;
	let mutableBasis: unknown;
	if (proposal.target.kind === "catalogWorkspace") {
		if (!revision.localeId || revision.basis.kind !== "catalogWorkspace")
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Candidate target is incomplete.",
			});
		const localeId = revision.localeId;
		const current = await currentWorkspaceTarget(
			ctx,
			proposal.projectId,
			revision.messageId,
			revision.localeId,
		);
		const basis = catalogWorkspaceTaskBasis(current);
		const targetDecision = await ctx.db
			.query("catalogWorkspaceDecisionRecords")
			.withIndex("by_value_identity", (q) =>
				q
					.eq("projectId", proposal.projectId)
					.eq("messageId", revision.messageId)
					.eq("localeId", localeId)
					.eq("sourceFingerprint", current.source.sourceFingerprint)
					.eq("valueFingerprint", current.valueFingerprint),
			)
			.unique();
		context = {
			...common,
			localeCode: current.target.localeCode,
			source: {
				value: current.source.value,
				icuType: current.source.icuType,
				argumentNames: current.source.argumentNames,
				argumentNamesComplete: current.source.argumentNamesComplete,
				declaredPlaceholderNames: current.source.declaredPlaceholderNames ?? [],
				declaredPlaceholderNamesComplete:
					current.source.declaredPlaceholderNamesComplete ?? true,
			},
			target: {
				value: current.value,
				catalogPath: current.target.catalogPath,
				...(targetDecision?.kind === "intentionalBlank"
					? { intentionalBlankReason: targetDecision.reason }
					: {}),
			},
			basisIsCurrent: sameCatalogWorkspaceTaskBasis(revision.basis, basis),
		};
		mutableBasis = basis;
	} else {
		if (revision.basis.kind !== "localeProposal")
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Candidate target is incomplete.",
			});
		const current = await currentLocaleProposalTarget(
			ctx,
			proposal,
			revision.messageId,
		);
		const value = await ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal_and_messageId", (q) =>
				q
					.eq("proposalId", current.localeProposal._id)
					.eq("messageId", revision.messageId),
			)
			.unique();
		const basis = {
			kind: "localeProposal" as const,
			localeProposalId: current.localeProposal._id,
			snapshotId: current.source.sourceSnapshotId,
			sourceFingerprint: current.source.sourceFingerprint,
		};
		context = {
			...common,
			localeCode: current.localeProposal.runtimeLocale,
			source: { value: current.source.sourceValue, ...current.source.source },
			target: {
				value: value?.value ?? "",
				intentionalBlankReason: value?.intentionalBlankReason,
				catalogPath: `${current.localeProposal.sourceCatalogPath.slice(0, current.localeProposal.sourceCatalogPath.lastIndexOf("/") + 1)}intl_pt.arb`,
			},
			basisIsCurrent: sameLocaleProposalTaskBasis(revision.basis, basis),
		};
		mutableBasis = {
			...basis,
			proposalRevision: current.localeProposal.revision,
			stagedValue: value,
		};
	}
	if (byteLength(context) > 900 * 1024)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "One reviewer context exceeds its bounded byte envelope.",
		});
	const reviewToken = await sha256Hex(
		JSON.stringify({
			context,
			mutableBasis,
			latestReviewId: review?._id ?? null,
			policyRevision: authorized.policyRevision,
		}),
	);
	return { ...context, reviewToken };
}

export const contextForAgentReview = internalQuery({
	args: {
		token: v.string(),
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	},
	returns: v.union(agentReviewContextValidator, recordedReviewValidator),
	handler: async (ctx, args) => {
		const authorized = await authorizeCandidateReview(
			ctx,
			args.token,
			args.candidateRevisionId,
			false,
		);
		const review = await latestCandidateReview(ctx, args.candidateRevisionId);
		if (review)
			return {
				kind: "recordedReview" as const,
				candidateRevisionId: args.candidateRevisionId,
				alreadyReviewed: true as const,
				latestReview: reviewSummary(review),
				reviewAuthorization: authorized.authorization,
			};
		if (authorized.candidate.latestRevisionId !== args.candidateRevisionId)
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"Only the latest unreviewed candidate revision can be assessed.",
			});
		return await contextForAgentReviewer(ctx, authorized);
	},
});

export const reviewCandidateForAgent = internalMutation({
	args: {
		token: v.string(),
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
		reviewToken: v.string(),
		decision: agentReviewDecisionValidator,
	},
	returns: candidateReviewResultValidator,
	handler: async (ctx, args) => {
		const authorized = await authorizeCandidateReview(
			ctx,
			args.token,
			args.candidateRevisionId,
		);
		const context = await contextForAgentReviewer(ctx, authorized);
		if (args.reviewToken !== context.reviewToken)
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"Review context or authorization changed. Read and assess the candidate again.",
			});
		if (context.alreadyReviewed)
			throw new ConvexError({
				code: "BAD_STATE",
				message: "This candidate revision already has a review.",
			});
		if (
			args.decision.kind === "reject" &&
			byteLength(args.decision.reason ?? "") > 4096
		)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Review reason exceeds its byte envelope.",
			});
		const decision =
			args.decision.kind === "accept" &&
			authorized.revision.intentionalBlankReason !== undefined
				? {
						kind: "intentionalBlank" as const,
						reason: authorized.revision.intentionalBlankReason,
					}
				: args.decision;
		return await applyCandidateReview(
			ctx,
			{ candidateRevisionId: args.candidateRevisionId, decision },
			{
				actor: { kind: "agent", id: authorized.token._id },
				reviewAuthorization: authorized.authorization,
			},
		);
	},
});

/** Save the value currently visible in a Translation Task review field. The
 * module derives whether that means exact acceptance, human editing, or an
 * explicit keep after Source drift, then delegates to the task's persistence
 * adapter. Repeated human saves append review evidence without changing the
 * immutable agent candidate revision. */
export const saveTaskValue = mutation({
	args: {
		taskId: v.id("agentTranslationProposals"),
		messageId: v.string(),
		candidateToken: v.string(),
		value: v.string(),
	},
	returns: v.object({
		taskId: v.id("agentTranslationProposals"),
		messageId: v.string(),
		decision: reviewDecisionValidator,
	}),
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.taskId);
		if (!proposal) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		const { userId } = await requireEditor(ctx, proposal.projectId);
		const localeId = proposal.taskScope?.localeId;
		const localeProposalId = proposal.localeProposalTaskScope?.localeProposalId;
		const isExistingLocaleTask =
			proposal.target.kind === "catalogWorkspace" && localeId !== undefined;
		const isNewLocaleTask =
			proposal.target.kind === "localeProposal" &&
			localeProposalId !== undefined &&
			proposal.target.localeProposalId === localeProposalId;
		if (!isExistingLocaleTask && !isNewLocaleTask) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		if (args.value.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A reviewed translation cannot be empty. Record an Intentional Blank with a reason instead.",
			});
		}
		if (
			new TextEncoder().encode(args.value).byteLength >
			MAX_CANDIDATE_VALUE_BYTES
		) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"The reviewed translation exceeds the supported byte envelope.",
			});
		}

		const candidate = isExistingLocaleTask
			? await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", args.messageId)
							.eq("localeId", localeId),
					)
					.unique()
			: await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeProposalId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", args.messageId)
							.eq("localeProposalId", localeProposalId),
					)
					.unique();
		if (!candidate?.latestRevisionId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "The task message has no candidate to review.",
			});
		}
		if (`${candidate.latestRevisionId}` !== args.candidateToken) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The task candidate changed; refresh before saving the review.",
			});
		}
		const revision = await ctx.db.get(candidate.latestRevisionId);
		if (!revision || revision.proposalId !== proposal._id) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Translation Task candidate evidence is incomplete.",
			});
		}

		const actor = { kind: "user" as const, id: userId };
		let decision: TranslationTaskReviewDecision;
		let appliedBasis: CandidateRevisionInput["basis"];
		if (isExistingLocaleTask) {
			if (
				revision.localeId !== localeId ||
				revision.basis.kind !== "catalogWorkspace"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Catalog Workspace candidate evidence is incomplete.",
				});
			}
			const current = await currentWorkspaceTarget(
				ctx,
				proposal.projectId,
				revision.messageId,
				localeId,
			);
			const basis = catalogWorkspaceTaskBasis(current);
			const latestReview = await latestCandidateReview(ctx, revision._id);
			if (
				latestReview?.finalValue === args.value &&
				latestReview.appliedBasis?.kind === "catalogWorkspace" &&
				sameCatalogWorkspaceTaskBasis(latestReview.appliedBasis, basis)
			) {
				return {
					taskId: proposal._id,
					messageId: revision.messageId,
					decision: latestReview.decision,
				};
			}
			decision =
				args.value !== revision.value
					? { kind: "acceptWithEdits", value: args.value }
					: sameCatalogWorkspaceTaskBasis(revision.basis, basis)
						? { kind: "accept" }
						: { kind: "keepForCurrentSource" };
			const applied = await applyAgentTargetValue(ctx, {
				projectId: proposal.projectId,
				messageId: revision.messageId,
				localeId,
				value: args.value,
				expectedProjectionId: basis.projectionId,
				expectedSnapshotId: basis.snapshotId,
				expectedGitValueFingerprint: basis.gitValueFingerprint,
				expectedGitValueRevision: basis.gitValueRevision,
				expectedWorkspaceRevision: basis.workspaceRevision,
				expectedSourceFingerprint: basis.sourceFingerprint,
				actor,
			});
			appliedBasis = {
				...basis,
				workspaceRevision: applied.workspaceRevision,
			};
		} else {
			if (
				localeProposalId === undefined ||
				revision.localeProposalId !== localeProposalId ||
				revision.basis.kind !== "localeProposal"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Locale Proposal candidate evidence is incomplete.",
				});
			}
			const current = await currentLocaleProposalTarget(
				ctx,
				proposal,
				revision.messageId,
			);
			const basis = {
				kind: "localeProposal" as const,
				localeProposalId,
				snapshotId: current.source.sourceSnapshotId,
				sourceFingerprint: current.source.sourceFingerprint,
			};
			const latestReview = await latestCandidateReview(ctx, revision._id);
			if (
				latestReview?.finalValue === args.value &&
				latestReview.appliedBasis?.kind === "localeProposal" &&
				sameLocaleProposalTaskBasis(latestReview.appliedBasis, basis)
			) {
				return {
					taskId: proposal._id,
					messageId: revision.messageId,
					decision: latestReview.decision,
				};
			}
			decision =
				args.value === revision.value
					? { kind: "accept" }
					: { kind: "acceptWithEdits", value: args.value };
			await applyTaskReviewedValue(ctx, {
				projectId: proposal.projectId,
				proposalId: localeProposalId,
				messageId: revision.messageId,
				sourceSnapshotId: basis.snapshotId,
				sourceFingerprint: basis.sourceFingerprint,
				value: args.value,
				reviewer: actor,
			});
			appliedBasis = basis;
		}

		const finalValueFingerprint = await sha256Hex(args.value);
		await ctx.db.insert("agentTranslationCandidateReviews", {
			projectId: proposal.projectId,
			proposalId: proposal._id,
			candidateId: candidate._id,
			revisionId: revision._id,
			decision,
			reviewer: actor,
			finalValue: args.value,
			finalValueFingerprint,
			appliedBasis,
			createdAt: now(),
		});
		const status = await completedProposalStatus(ctx, proposal._id);
		await ctx.db.patch(proposal._id, { status, updatedAt: now() });
		return {
			taskId: proposal._id,
			messageId: revision.messageId,
			decision,
		};
	},
});

/** Explicit Translation Task decisions such as rejection and Intentional Blank.
 * Ordinary value review goes through saveTaskValue so exact text, edits, and
 * current-Source keeps share one command. */
export const reviewTaskValue = mutation({
	args: {
		taskId: v.id("agentTranslationProposals"),
		messageId: v.string(),
		candidateToken: v.string(),
		decision: reviewDecisionValidator,
	},
	returns: v.object({
		taskId: v.id("agentTranslationProposals"),
		messageId: v.string(),
		decision: reviewDecisionValidator,
	}),
	handler: async (
		ctx,
		args,
	): Promise<{
		taskId: Id<"agentTranslationProposals">;
		messageId: string;
		decision: TranslationTaskReviewDecision;
	}> => {
		const proposal = await ctx.db.get(args.taskId);
		if (!proposal) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		await requireEditor(ctx, proposal.projectId);
		const isTask =
			(proposal.taskScope !== undefined &&
				proposal.target.kind === "catalogWorkspace") ||
			(proposal.localeProposalTaskScope !== undefined &&
				proposal.target.kind === "localeProposal" &&
				proposal.localeProposalTaskScope.localeProposalId ===
					proposal.target.localeProposalId);
		if (!isTask) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		const candidates = await ctx.db
			.query("agentTranslationCandidates")
			.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
			.filter((q) => q.eq(q.field("messageId"), args.messageId))
			.take(2);
		if (candidates.length !== 1 || !candidates[0]?.latestRevisionId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "The task message has no candidate to review.",
			});
		}
		const candidateRevisionId = candidates[0].latestRevisionId;
		if (`${candidateRevisionId}` !== args.candidateToken) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message: "The task candidate changed; refresh before reviewing it.",
			});
		}
		const review: { decision: TranslationTaskReviewDecision } =
			await ctx.runMutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId,
				decision: args.decision,
			});
		return {
			taskId: proposal._id,
			messageId: args.messageId,
			decision: review.decision,
		};
	},
});

const taskFinalizationContextValidator = v.union(
	v.object({
		kind: v.literal("existingLocale"),
		taskId: v.id("agentTranslationProposals"),
		projectId: v.id("projects"),
	}),
	v.object({
		kind: v.literal("newLocale"),
		taskId: v.id("agentTranslationProposals"),
		projectId: v.id("projects"),
		localeProposalId: v.id("localeProposals"),
	}),
);

type TaskFinalizationContext =
	| {
			kind: "existingLocale";
			taskId: Id<"agentTranslationProposals">;
			projectId: Id<"projects">;
	  }
	| {
			kind: "newLocale";
			taskId: Id<"agentTranslationProposals">;
			projectId: Id<"projects">;
			localeProposalId: Id<"localeProposals">;
	  };

type TaskFinalizationResult =
	| {
			kind: "existingLocale";
			taskId: Id<"agentTranslationProposals">;
			releaseRecordId: Id<"releaseRecords">;
			releaseStatus: "preparing" | "ready" | "superseded" | "failed";
	  }
	| {
			kind: "newLocale";
			taskId: Id<"agentTranslationProposals">;
			localeProposalId: Id<"localeProposals">;
			deliveryStatus: "ready";
	  };

export const taskFinalizationContext = internalQuery({
	args: { taskId: v.id("agentTranslationProposals") },
	returns: taskFinalizationContextValidator,
	handler: async (ctx, args): Promise<TaskFinalizationContext> => {
		const proposal = await ctx.db.get(args.taskId);
		if (!proposal) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		await requireEditor(ctx, proposal.projectId);
		if (proposal.taskScope && proposal.target.kind === "catalogWorkspace") {
			if (proposal.status === "open") {
				throw new ConvexError({
					code: "REVIEW_REQUIRED",
					message: "Review every existing-Locale task value before finalizing.",
				});
			}
			return {
				kind: "existingLocale" as const,
				taskId: proposal._id,
				projectId: proposal.projectId,
			};
		}
		if (
			proposal.localeProposalTaskScope &&
			proposal.target.kind === "localeProposal" &&
			proposal.localeProposalTaskScope.localeProposalId ===
				proposal.target.localeProposalId
		) {
			const localeProposal = await ctx.db.get(proposal.target.localeProposalId);
			if (
				!localeProposal ||
				localeProposal.projectId !== proposal.projectId ||
				localeProposal.stagedValueCount !==
					proposal.localeProposalTaskScope.targetCount
			) {
				throw new ConvexError({
					code: "REVIEW_REQUIRED",
					message: "Apply every new-Locale task value before finalizing.",
				});
			}
			return {
				kind: "newLocale" as const,
				taskId: proposal._id,
				projectId: proposal.projectId,
				localeProposalId: proposal.target.localeProposalId,
			};
		}
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Translation Task not found.",
		});
	},
});

export const markFinalizedNewLocaleTask = internalMutation({
	args: { taskId: v.id("agentTranslationProposals") },
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (
			!task?.localeProposalTaskScope ||
			task.target.kind !== "localeProposal"
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "New-Locale Translation Task not found.",
			});
		}
		const proposal = await ctx.db.get(task.target.localeProposalId);
		if (proposal?.status !== "ready") {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "New-Locale task artifact is not ready.",
			});
		}
		await ctx.db.patch(task._id, { status: "accepted", updatedAt: now() });
		return null;
	},
});

/** Finalize reviewed work and return the next durable hand-off. Existing
 * Locale work starts a Release assessment; new-Locale work creates its ready,
 * immutable Locale Proposal artifact. Neither path touches Git. */
export const finalizeTask = action({
	args: { taskId: v.id("agentTranslationProposals") },
	returns: v.union(
		v.object({
			kind: v.literal("existingLocale"),
			taskId: v.id("agentTranslationProposals"),
			releaseRecordId: v.id("releaseRecords"),
			releaseStatus: v.union(
				v.literal("preparing"),
				v.literal("ready"),
				v.literal("superseded"),
				v.literal("failed"),
			),
		}),
		v.object({
			kind: v.literal("newLocale"),
			taskId: v.id("agentTranslationProposals"),
			localeProposalId: v.id("localeProposals"),
			deliveryStatus: v.literal("ready"),
		}),
	),
	handler: async (ctx, args): Promise<TaskFinalizationResult> => {
		const context: TaskFinalizationContext = await ctx.runQuery(
			internal.agentTranslationProposals.taskFinalizationContext,
			args,
		);
		if (context.kind === "existingLocale") {
			const release: {
				recordId: Id<"releaseRecords">;
				status: "preparing" | "ready" | "superseded" | "failed";
			} = await ctx.runMutation(api.releaseRecords.prepare, {
				projectId: context.projectId,
			});
			return {
				kind: context.kind,
				taskId: context.taskId,
				releaseRecordId: release.recordId,
				releaseStatus: release.status,
			};
		}
		const proposal = await finalizeProposal(
			ctx,
			{ projectId: context.projectId },
			context.localeProposalId,
		);
		if (proposal.deliveryStatus !== "ready") {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The finalized new-Locale task has no ready artifact.",
			});
		}
		await ctx.runMutation(
			internal.agentTranslationProposals.markFinalizedNewLocaleTask,
			{ taskId: context.taskId },
		);
		return {
			kind: context.kind,
			taskId: context.taskId,
			localeProposalId: context.localeProposalId,
			deliveryStatus: proposal.deliveryStatus,
		};
	},
});
