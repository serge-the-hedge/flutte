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
import { authenticateAgent as authenticate } from "./agentApi";
import {
	type AgentReviewAuthorization,
	agentReviewAuthorizationValidator,
	agentReviewDecisionValidator,
} from "./agentReviewModel";
import {
	authorizeCandidateReview,
	candidateAuthorizationValidator,
	grantCandidateReview as grantReview,
	readCandidateAuthorization,
	revokeCandidateReviewGrant as revokeReview,
} from "./agentReviews";
import {
	activeProjectionFor,
	MAX_WORKING_CATALOG_KEYS,
} from "./catalogProjection";
import { applyAgentTargetValue } from "./catalogWorkspace";
import { decisionForIdentity } from "./catalogWorkspaceDecisionQueries";
import { readWorkspaceTarget as currentWorkspaceTarget } from "./catalogWorkspaceRead";
import { requireManagedCollection } from "./contentCollections";
import { type ManagedBasis, managedBasisValidator } from "./contentModel";
import { assertTargetValueContract } from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import {
	applyTaskReviewedValue,
	carryForwardLocaleProposal,
	ensureLocaleProposalForReview,
	finalizeProposal,
	type LocaleProposalCarryForwardResult,
} from "./localeProposals";
import {
	commitManagedTarget,
	managedMessageName,
	readManagedTarget,
} from "./managedContent";
import {
	assertMessageCharacterLimit,
	readCharacterLimit,
} from "./messageConstraints";
import { requireEditor, requireViewer } from "./permissions";
import { guidanceContextValidator, readGuidance } from "./translationGuidance";

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
const MAX_TASK_TARGETS = 32;
const MAX_TASK_PAGE_BYTES = 1024 * 1024;
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
	v.object({
		kind: v.literal("managedCollection"),
		collectionId: v.id("contentCollections"),
	}),
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
		managedBasisValidator,
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

const taskBasisValidator = v.union(
	managedBasisValidator,
	v.object({
		kind: v.literal("catalogWorkspace"),
		projectionId: v.id("catalogProjections"),
		snapshotId: v.id("sourceSnapshots"),
		gitValueFingerprint: v.string(),
		gitValueRevision: v.number(),
		workspaceRevision: v.number(),
		sourceFingerprint: v.string(),
	}),
);

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

const taskCandidateValidator = v.object({
	messageId: v.string(),
	revisionId: v.id("agentTranslationCandidateRevisions"),
	revision: v.number(),
	value: v.string(),
	intentionalBlankReason: v.optional(v.string()),
	latestReview: v.union(v.null(), reviewSummaryValidator),
});

/** Both task adapters expose the newest immutable candidate and its own review;
 * an older revision's verdict must not describe an unreviewed correction. */
async function taskCandidateFeedback(
	ctx: QueryCtx,
	candidate: Doc<"agentTranslationCandidates"> | null,
) {
	const revision = candidate?.latestRevisionId
		? await ctx.db.get(candidate.latestRevisionId)
		: null;
	if (!revision) return null;
	const review = await latestCandidateReview(ctx, revision._id);
	return {
		messageId: revision.messageId,
		revisionId: revision._id,
		revision: revision.revision,
		value: revision.value,
		intentionalBlankReason: revision.intentionalBlankReason,
		latestReview: review ? reviewSummary(review) : null,
	};
}

const taskTargetValidator = v.object({
	characterLimit: v.optional(v.number()),
	context: v.optional(v.string()),
	messageId: v.string(),
	sourceValue: v.string(),
	targetValue: v.string(),
	candidate: v.union(v.null(), taskCandidateValidator),
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

type ProposalTarget =
	| { kind: "managedCollection"; collectionId: Id<"contentCollections"> }
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
		| ManagedBasis
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

type TaskActor =
	| { kind: "user"; id: string }
	| { kind: "agent"; id: Id<"apiTokens"> };

function managedSourceContext(source: {
	key: string;
	name?: string | null;
	sourceValue: string;
	context?: string;
}) {
	return {
		value: source.sourceValue,
		name: managedMessageName(source),
		context: source.context,
		icuType: "plain" as const,
		argumentNames: [],
		argumentNamesComplete: true,
		declaredPlaceholderNames: [],
		declaredPlaceholderNamesComplete: true,
	};
}

async function selectedTaskCurrent(
	ctx: QueryCtx | MutationCtx,
	proposal: { projectId: Id<"projects">; target: ProposalTarget },
	messageId: string,
	localeId: Id<"locales">,
) {
	if (proposal.target.kind === "managedCollection") {
		const current = await readManagedTarget(ctx, {
			projectId: proposal.projectId,
			collectionId: proposal.target.collectionId,
			messageId,
			localeId,
		});
		const locale = current.locale;
		return {
			source: managedSourceContext(current.source),
			value: current.value,
			basis: current.basis,
			localeCode: locale.code,
			catalogPath: undefined,
			catalogIndex: undefined,
		};
	}
	const current = await currentWorkspaceTarget(
		ctx,
		proposal.projectId,
		messageId,
		localeId,
	);
	return {
		source: current.source,
		value: current.value,
		basis: catalogWorkspaceTaskBasis(current),
		localeCode: current.target.localeCode,
		catalogPath: current.target.catalogPath,
		catalogIndex: current.target.catalogIndex,
	};
}

function messageConstraintAddress(
	proposal: { projectId: Id<"projects">; target: ProposalTarget },
	messageId: string,
) {
	return {
		projectId: proposal.projectId,
		messageId,
		collectionId:
			proposal.target.kind === "managedCollection"
				? proposal.target.collectionId
				: undefined,
	};
}

function sameSelectedBasis(
	left: CandidateRevisionInput["basis"],
	right: CandidateRevisionInput["basis"],
) {
	if (left.kind === "managed" && right.kind === "managed")
		return (
			left.collectionId === right.collectionId &&
			left.sourceRevision === right.sourceRevision &&
			left.targetRevision === right.targetRevision &&
			left.sourceFingerprint === right.sourceFingerprint &&
			left.membershipRevision === right.membershipRevision
		);
	return (
		left.kind === "catalogWorkspace" &&
		right.kind === "catalogWorkspace" &&
		sameCatalogWorkspaceTaskBasis(left, right)
	);
}

async function createCatalogWorkspaceTask(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		collectionId?: Id<"contentCollections">;
		title: string;
		localeId: Id<"locales">;
		messageIds: readonly string[];
		actor: TaskActor;
		createdByTokenId?: Id<"apiTokens">;
	},
) {
	const project = await ctx.db.get(input.projectId);
	const collectionId =
		input.collectionId ??
		(project?.type === "basic" ? project.managedCollectionId : undefined);
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
	let managedReadBytes = 0;
	for (const messageId of uniqueMessageIds) {
		const target = collectionId
			? { kind: "managedCollection" as const, collectionId: collectionId }
			: { kind: "catalogWorkspace" as const };
		const current = await selectedTaskCurrent(
			ctx,
			{ projectId: input.projectId, target },
			messageId,
			input.localeId,
		);
		if (collectionId) {
			managedReadBytes += byteLength(current);
			if (managedReadBytes > 4 * 1024 * 1024)
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message:
						"Selected content exceeds one task creation read budget; select fewer keys.",
				});
		}
		targets.push({
			catalogIndex: current.catalogIndex ?? targets.length,
			messageId,
			localeId: locale._id,
			localeCode: locale.code,
			// Managed targets retain revision identities; page reads resolve live text.
			sourceValue: collectionId ? undefined : current.source.value,
			targetValue: collectionId ? undefined : current.value,
			targetCatalogPath: current.catalogPath,
			basis: current.basis,
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
		target: collectionId
			? { kind: "managedCollection", collectionId: collectionId }
			: { kind: "catalogWorkspace" },
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
		localeCode: string;
	},
) {
	assertBoundedString(input.title, "title", MAX_TASK_TITLE_BYTES);
	const ensured = await ensureLocaleProposalForReview(
		ctx,
		input.projectId,
		input.userId,
		input.localeCode,
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
				kind: v.literal("managedLocale"),
				collectionId: v.id("contentCollections"),
				localeId: v.id("locales"),
			}),
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
		if (
			args.target.kind === "existingLocale" ||
			args.target.kind === "managedLocale"
		) {
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
				collectionId:
					args.target.kind === "managedLocale"
						? args.target.collectionId
						: undefined,
				messageIds: args.scope.messageIds,
				actor: { kind: "user", id: userId },
			});
		}
		if (args.scope.kind !== "completeCatalog") {
			throw new ConvexError({
				code: "VALIDATION",
				message: "The configured new Locale needs complete-catalog scope.",
			});
		}
		return await createNewLocaleTaskForHuman(ctx, {
			projectId: args.projectId,
			title: args.title,
			userId,
			localeCode: args.target.localeCode,
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
			title: `${localeProposal.localeCode} · complete catalog · ${snapshot.commit.slice(0, 12)}`,
			localeCode: localeProposal.localeCode,
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
		collectionId: v.optional(v.id("contentCollections")),
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
		const project = await ctx.db.get(token.projectId);
		const collectionId =
			args.collectionId ??
			(project?.type === "basic" ? project.managedCollectionId : undefined);
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
				(collectionId
					? existing.target.kind !== "managedCollection" ||
						existing.target.collectionId !== collectionId
					: existing.target.kind !== "catalogWorkspace") ||
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
			collectionId: collectionId,
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
			collectionId: v.optional(v.id("contentCollections")),
			format: v.optional(v.literal("plain")),
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
		guidance: guidanceContextValidator,
		nextCursor: v.union(v.number(), v.null()),
	}),
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const proposal = await proposalForToken(ctx, args.taskId, token._id);
		if (!proposal.taskScope || proposal.target.kind === "localeProposal") {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Translation Task not found.",
			});
		}
		assertNonNegativeInteger(args.cursor, "cursor");
		assertNonNegativeInteger(args.limit, "limit");
		const limit = Math.min(16, Math.max(1, Math.trunc(args.limit)));
		const rows = await ctx.db
			.query("translationTaskTargets")
			.withIndex("by_proposal_and_catalogIndex", (q) =>
				q.eq("proposalId", proposal._id).gte("catalogIndex", args.cursor),
			)
			.take(limit + 1);
		const targets = rows.slice(0, limit);
		const liveTargets = [];
		let targetBytes = 0;
		for (const target of targets) {
			const [current, candidate] = await Promise.all([
				selectedTaskCurrent(ctx, proposal, target.messageId, target.localeId),
				ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", target.messageId)
							.eq("localeId", target.localeId),
					)
					.unique(),
			]);
			const liveTarget = {
				characterLimit: await readCharacterLimit(
					ctx,
					messageConstraintAddress(proposal, target.messageId),
				),
				messageId: target.messageId,
				sourceValue: current.source.value,
				context:
					"context" in current.source ? current.source.context : undefined,
				targetValue: current.value,
				candidate: await taskCandidateFeedback(ctx, candidate),
			};
			const bytes = new TextEncoder().encode(
				JSON.stringify(liveTarget),
			).byteLength;
			if (bytes > MAX_TASK_PAGE_BYTES) {
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: `Translation Task value “${target.messageId}” exceeds its page envelope.`,
				});
			}
			if (targetBytes + bytes > MAX_TASK_PAGE_BYTES) break;
			liveTargets.push(liveTarget);
			targetBytes += bytes;
		}
		return {
			task: {
				collectionId:
					proposal.target.kind === "managedCollection"
						? proposal.target.collectionId
						: undefined,
				format:
					proposal.target.kind === "managedCollection"
						? ("plain" as const)
						: undefined,
				taskId: proposal._id,
				title: proposal.clientProposalKey,
				status: proposal.status,
				localeCode: proposal.taskScope.localeCode,
				targetCount: proposal.taskScope.targetCount,
				candidateCount: proposal.candidateCount,
			},
			targets: liveTargets,
			guidance: await readGuidance(ctx, token.projectId, {
				syntax: proposal.target.kind === "managedCollection" ? "plain" : "icu",
				texts: liveTargets.map((target) => target.sourceValue),
				localeCodes: [proposal.taskScope.localeCode],
			}),
			nextCursor: rows[liveTargets.length]?.catalogIndex ?? null,
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
			kind: v.union(v.literal("existingLocale"), v.literal("managedLocale")),
			collectionId: v.optional(v.id("contentCollections")),
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
		if (proposal.taskScope && proposal.target.kind !== "localeProposal") {
			return {
				kind:
					proposal.target.kind === "managedCollection"
						? ("managedLocale" as const)
						: ("existingLocale" as const),
				collectionId:
					proposal.target.kind === "managedCollection"
						? proposal.target.collectionId
						: undefined,
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
			kind: v.union(
				v.literal("existingLocale"),
				v.literal("newLocale"),
				v.literal("managedLocale"),
			),
			collectionId: v.optional(v.id("contentCollections")),
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
						kind:
							task.target.kind === "managedCollection"
								? ("managedLocale" as const)
								: ("existingLocale" as const),
						collectionId:
							task.target.kind === "managedCollection"
								? task.target.collectionId
								: undefined,
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
			proposal.target.kind === "localeProposal" ||
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
			const current = await selectedTaskCurrent(
				ctx,
				proposal,
				target.messageId,
				target.localeId,
			);
			const basis = current.basis;
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
				currentCandidate.basis.kind === "localeProposal"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Translation Task candidate has the wrong target basis.",
				});
			}
			const currentCandidateBasis =
				currentCandidate && currentCandidate.basis.kind !== "localeProposal"
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
								basisIsCurrent: sameSelectedBasis(currentCandidateBasis, basis),
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
	returns: v.array(taskCandidateValidator),
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
			const feedback = await taskCandidateFeedback(ctx, candidate);
			if (feedback) result.push(feedback);
		}
		return result;
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
		if (args.target.kind === "managedCollection")
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Managed content requires a Translation Task with selected messages.",
			});
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
					item.basis.kind !== taskTarget.basis.kind
				) {
					throw new ConvexError({
						code: "VALIDATION",
						message:
							"This candidate is outside the Translation Task's frozen target scope.",
					});
				}
			}
			let candidate: Doc<"agentTranslationCandidates"> | null = null;
			if (proposal.target.kind !== "localeProposal") {
				if (
					item.localeId === undefined ||
					(proposal.target.kind === "managedCollection"
						? item.basis.kind !== "managed" ||
							item.basis.collectionId !== proposal.target.collectionId
						: item.basis.kind !== "catalogWorkspace")
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
			await assertMessageCharacterLimit(
				ctx,
				messageConstraintAddress(proposal, item.messageId),
				item.value,
			);
			if (proposal.target.kind === "managedCollection") {
				if (!item.localeId)
					throw new ConvexError({
						code: "VALIDATION",
						message: "Managed candidates need a Locale.",
					});
				const current = await selectedTaskCurrent(
					ctx,
					proposal,
					item.messageId,
					item.localeId,
				);
				if (!sameSelectedBasis(item.basis, current.basis))
					throw new ConvexError({
						code: "STALE_BASIS",
						message: "Managed content changed; refresh before proposing.",
					});
			} else if (proposal.target.kind === "catalogWorkspace") {
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
		localeCode: v.optional(v.string()),
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
		return {
			...page,
			page:
				args.localeCode === undefined
					? page.page
					: page.page.filter(
							(task) =>
								(task.taskScope?.localeCode ??
									task.localeProposalTaskScope?.localeCode) === args.localeCode,
						),
		};
	},
});

export const getForReview = query({
	args: {
		proposalId: v.id("agentTranslationProposals"),
		cursor: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal) return null;
		await requireViewer(ctx, proposal.projectId);
		if (proposal.taskScope) {
			const limit = args.limit ?? MAX_TASK_TARGETS;
			let cursor = args.cursor ?? 0;
			assertNonNegativeInteger(cursor, "cursor");
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_TARGETS)
				throw new ConvexError({
					code: "VALIDATION",
					message: "Review page limit must be between 1 and 32.",
				});
			const taskTargets: (Doc<"translationTaskTargets"> & {
				name?: string | null;
			})[] = [];
			const candidates: {
				candidate: Doc<"agentTranslationCandidates">;
				revision: Doc<"agentTranslationCandidateRevisions"> | null;
				reviews: Doc<"agentTranslationCandidateReviews">[];
			}[] = [];
			let bytes = byteLength(proposal);
			let count = 0;
			let nextCursor: number | null = null;
			while (true) {
				const target = await ctx.db
					.query("translationTaskTargets")
					.withIndex("by_proposal_and_catalogIndex", (q) =>
						q.eq("proposalId", proposal._id).gte("catalogIndex", cursor),
					)
					.first();
				if (!target) break;
				if (count >= limit) {
					nextCursor = target.catalogIndex;
					break;
				}
				const candidate = await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
						q
							.eq("proposalId", proposal._id)
							.eq("messageId", target.messageId)
							.eq("localeId", target.localeId),
					)
					.unique();
				const revision = candidate?.latestRevisionId
					? await ctx.db.get(candidate.latestRevisionId)
					: null;
				const review = revision
					? await latestCandidateReview(ctx, revision._id)
					: null;
				const entry = candidate
					? {
							candidate,
							revision,
							reviews: review
								? [
										{
											...review,
											finalValue:
												review.finalValue === revision?.value
													? undefined
													: review.finalValue,
										},
									]
								: [],
						}
					: null;
				const current = entry
					? null
					: await selectedTaskCurrent(
							ctx,
							proposal,
							target.messageId,
							target.localeId,
						);
				const waiting = current
					? {
							...target,
							sourceValue: current.source.value,
							name: "name" in current.source ? current.source.name : undefined,
							targetValue: current.value,
							basis: current.basis,
						}
					: { ...target, sourceValue: undefined, targetValue: undefined };
				const entryBytes = byteLength({ entry, waiting });
				if (entryBytes > 900 * 1024)
					throw new ConvexError({
						code: "LIMIT_EXCEEDED",
						message: "One task review value exceeds its page envelope.",
					});
				if (count > 0 && bytes + entryBytes > 900 * 1024) {
					nextCursor = target.catalogIndex;
					break;
				}
				if (entry) candidates.push(entry);
				if (waiting) taskTargets.push(waiting);
				bytes += entryBytes;
				count += 1;
				cursor = target.catalogIndex + 1;
			}
			return { proposal, taskTargets, candidates, nextCursor };
		}
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
		return { proposal, taskTargets: [], candidates: entries, nextCursor: null };
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
		const characterLimit = await readCharacterLimit(
			ctx,
			messageConstraintAddress(proposal, revision.messageId),
		);

		try {
			if (proposal.target.kind === "managedCollection") {
				if (!revision.localeId || revision.basis.kind !== "managed")
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Managed candidate evidence is incomplete.",
					});
				const current = await selectedTaskCurrent(
					ctx,
					proposal,
					revision.messageId,
					revision.localeId,
				);
				const review = await latestCandidateReview(ctx, revision._id);
				return {
					kind: "managedCollection" as const,
					characterLimit,
					available: true as const,
					localeCode: current.localeCode,
					source: {
						value: current.source.value,
						name: "name" in current.source ? current.source.name : undefined,
						context:
							"context" in current.source ? current.source.context : undefined,
						icuType: current.source.icuType,
						argumentNames: current.source.argumentNames,
						argumentNamesComplete: current.source.argumentNamesComplete,
						declaredPlaceholderNames:
							current.source.declaredPlaceholderNames ?? [],
						declaredPlaceholderNamesComplete:
							current.source.declaredPlaceholderNamesComplete ?? true,
					},
					target: { value: current.value, catalogPath: undefined },
					basisIsCurrent: sameSelectedBasis(revision.basis, current.basis),
					reviewBasisIsCurrent: review?.appliedBasis
						? sameSelectedBasis(review.appliedBasis, current.basis)
						: null,
				};
			}

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
					characterLimit,
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
				characterLimit,
				available: true as const,
				localeCode: current.localeProposal.localeCode,
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
			proposal.target.kind !== "localeProposal";
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
						revision.basis.kind !==
							(proposal.target.kind === "managedCollection"
								? "managed"
								: "catalogWorkspace"))) ||
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
			if (proposal.target.kind === "managedCollection") {
				await applyCandidateReview(
					ctx,
					{ candidateRevisionId, decision: { kind: "accept" } },
					{ actor: { kind: "user", id: userId } },
				);
				accepted += 1;
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
	if (proposal.target.kind === "managedCollection")
		await requireManagedCollection(
			ctx,
			proposal.projectId,
			proposal.target.collectionId,
		);
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
	} else if (proposal.target.kind === "managedCollection") {
		if (
			!revision.localeId ||
			revision.basis.kind !== "managed" ||
			revision.basis.collectionId !== proposal.target.collectionId
		)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Managed candidate evidence is incomplete.",
			});
		const basis =
			args.decision.kind === "keepForCurrentSource"
				? (
						await readManagedTarget(ctx, {
							projectId: proposal.projectId,
							collectionId: proposal.target.collectionId,
							messageId: revision.messageId,
							localeId: revision.localeId,
						})
					).basis
				: revision.basis;
		const reason =
			args.decision.kind === "intentionalBlank"
				? args.decision.reason
				: args.decision.kind === "accept"
					? revision.intentionalBlankReason
					: undefined;
		finalValue =
			reason !== undefined
				? ""
				: args.decision.kind === "acceptWithEdits"
					? args.decision.value
					: revision.value;
		const applied = await commitManagedTarget(ctx, {
			projectId: proposal.projectId,
			collectionId: proposal.target.collectionId,
			messageId: revision.messageId,
			localeId: revision.localeId,
			basis,
			intent:
				reason !== undefined
					? { kind: "intentionalBlank", reason }
					: { kind: "save", value: finalValue },
			actor,
			reviewAuthorization: reviewer.reviewAuthorization,
		});
		finalValueFingerprint = await sha256Hex(finalValue);
		workspaceRevision = applied.workspaceRevision;
		appliedBasis = applied.basis;
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

const agentReviewContextValidator = v.object({
	characterLimit: v.optional(v.number()),
	kind: v.literal("candidate"),
	collectionId: v.optional(v.id("contentCollections")),
	format: v.optional(v.literal("plain")),
	proposalId: v.id("agentTranslationProposals"),
	candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	messageId: v.string(),
	localeCode: v.string(),
	source: v.object({
		value: v.string(),
		name: v.optional(v.union(v.string(), v.null())),
		context: v.optional(v.string()),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		argumentNames: v.array(v.string()),
		argumentNamesComplete: v.boolean(),
		declaredPlaceholderNames: v.array(v.string()),
		declaredPlaceholderNamesComplete: v.boolean(),
	}),
	target: v.object({
		value: v.string(),
		catalogPath: v.optional(v.string()),
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
	guidance: guidanceContextValidator,
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
		characterLimit: await readCharacterLimit(
			ctx,
			messageConstraintAddress(proposal, revision.messageId),
		),
		kind: "candidate" as const,
		collectionId:
			proposal.target.kind === "managedCollection"
				? proposal.target.collectionId
				: undefined,
		format:
			proposal.target.kind === "managedCollection"
				? ("plain" as const)
				: undefined,
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
	let context: Omit<
		Infer<typeof agentReviewContextValidator>,
		"reviewToken" | "guidance"
	>;
	let mutableBasis: unknown;
	if (proposal.target.kind === "managedCollection") {
		if (!revision.localeId || revision.basis.kind !== "managed")
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Managed candidate evidence is incomplete.",
			});
		const current = await readManagedTarget(ctx, {
			projectId: proposal.projectId,
			collectionId: proposal.target.collectionId,
			messageId: revision.messageId,
			localeId: revision.localeId,
		});
		const locale = current.locale;
		context = {
			...common,
			localeCode: locale.code,
			source: managedSourceContext(current.source),
			target: {
				value: current.value,
				intentionalBlankReason: current.intentionalBlank ?? undefined,
			},
			basisIsCurrent: sameSelectedBasis(revision.basis, current.basis),
		};
		mutableBasis = current.basis;
	} else if (proposal.target.kind === "catalogWorkspace") {
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
		const targetDecision = await decisionForIdentity(ctx, {
			projectId: proposal.projectId,
			messageId: revision.messageId,
			localeId,
			sourceFingerprint: current.source.sourceFingerprint,
			valueFingerprint: current.valueFingerprint,
		});
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
			localeCode: current.localeProposal.localeCode,
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
	const reviewContext = {
		...context,
		guidance: await readGuidance(ctx, proposal.projectId, {
			syntax: proposal.target.kind === "managedCollection" ? "plain" : "icu",
			texts: [context.source.value],
			localeCodes: [context.localeCode],
		}),
	};
	if (byteLength(reviewContext) > 900 * 1024)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "One reviewer context exceeds its bounded byte envelope.",
		});
	const reviewToken = await sha256Hex(
		JSON.stringify({
			context: reviewContext,
			mutableBasis,
			latestReviewId: review?._id ?? null,
			policyRevision: authorized.policyRevision,
		}),
	);
	return { ...reviewContext, reviewToken };
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
			proposal.target.kind !== "localeProposal" && localeId !== undefined;
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
		if (proposal.target.kind === "managedCollection") {
			if (!localeId || revision.basis.kind !== "managed")
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Managed task candidate evidence is incomplete.",
				});
			const current = await readManagedTarget(ctx, {
				projectId: proposal.projectId,
				collectionId: proposal.target.collectionId,
				messageId: revision.messageId,
				localeId,
			});
			const latestReview = await latestCandidateReview(ctx, revision._id);
			if (
				latestReview?.finalValue === args.value &&
				latestReview.appliedBasis &&
				sameSelectedBasis(latestReview.appliedBasis, current.basis)
			)
				return {
					taskId: proposal._id,
					messageId: args.messageId,
					decision: latestReview.decision,
				};
			decision =
				args.value !== revision.value
					? { kind: "acceptWithEdits", value: args.value }
					: sameSelectedBasis(revision.basis, current.basis)
						? { kind: "accept" }
						: { kind: "keepForCurrentSource" };
			const applied = await commitManagedTarget(ctx, {
				projectId: proposal.projectId,
				collectionId: proposal.target.collectionId,
				messageId: revision.messageId,
				localeId,
				basis: current.basis,
				intent: { kind: "save", value: args.value },
				actor,
			});
			appliedBasis = applied.basis;
		} else if (isExistingLocaleTask) {
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
				proposal.target.kind !== "localeProposal") ||
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
		if (proposal.taskScope && proposal.target.kind !== "localeProposal") {
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
