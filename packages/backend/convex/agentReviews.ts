import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import {
	type AgentReviewAuthorization,
	isReviewOnlyToken,
} from "./agentReviewModel";
import { hashToken } from "./apiTokens";
import {
	assertProjectExists,
	requireEditor,
	requireViewer,
} from "./permissions";

const MAX_REVISION_REVIEWERS = 32;
const MAX_PROJECT_TOKENS = 128;

export const candidateAuthorizationValidator = v.object({
	policy: v.object({ enabled: v.boolean(), revision: v.number() }),
	canGrant: v.boolean(),
	grants: v.array(
		v.object({
			grantId: v.id("agentReviewGrants"),
			reviewerTokenId: v.id("apiTokens"),
			grantedByUserId: v.string(),
			createdAt: v.number(),
		}),
	),
	reviewers: v.array(
		v.object({ tokenId: v.id("apiTokens"), name: v.string() }),
	),
});

async function candidateEvidence(
	ctx: QueryCtx | MutationCtx,
	revisionId: Id<"agentTranslationCandidateRevisions">,
) {
	const revision = await ctx.db.get(revisionId);
	if (!revision)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Candidate revision not found.",
		});
	const proposal = await ctx.db.get(revision.proposalId);
	const candidate = await ctx.db.get(revision.candidateId);
	if (
		!proposal ||
		!candidate ||
		candidate.proposalId !== proposal._id ||
		proposal.projectId !== revision.projectId
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Candidate evidence not found.",
		});
	}
	return { revision, proposal, candidate };
}

function separateReviewer(
	token: Doc<"apiTokens">,
	revision: Doc<"agentTranslationCandidateRevisions">,
	proposal: Doc<"agentTranslationProposals">,
) {
	return (
		isReviewOnlyToken(token.scopes) &&
		token.revokedAt === undefined &&
		token.projectId === revision.projectId &&
		token._id !== proposal.createdByTokenId &&
		!(
			revision.createdBy.kind === "agent" && revision.createdBy.id === token._id
		)
	);
}

/** Resolve current permission in the same transaction that applies a review.
 * The snapshot is audit evidence, never a bearer credential. */
export async function authorizeCandidateReview(
	ctx: QueryCtx | MutationCtx,
	rawToken: string,
	revisionId: Id<"agentTranslationCandidateRevisions">,
	requireLatest = true,
) {
	const tokenHash = await hashToken(rawToken);
	const token = await ctx.db
		.query("apiTokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
		.unique();
	if (
		!token ||
		!isReviewOnlyToken(token.scopes) ||
		token.revokedAt !== undefined
	) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "A separate review-only token is required.",
		});
	}
	const project = await assertProjectExists(ctx, token.projectId);
	const evidence = await candidateEvidence(ctx, revisionId);
	if (!separateReviewer(token, evidence.revision, evidence.proposal)) {
		throw new ConvexError({
			code: "FORBIDDEN",
			message:
				"The reviewer must be a separate project agent from the candidate author and task's translator.",
		});
	}
	if (requireLatest && evidence.candidate.latestRevisionId !== revisionId) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "Only the latest candidate revision can be reviewed.",
		});
	}
	const grant = await ctx.db
		.query("agentReviewGrants")
		.withIndex("by_revision_and_reviewer", (q) =>
			q.eq("candidateRevisionId", revisionId).eq("reviewerTokenId", token._id),
		)
		.unique();
	let authorization: AgentReviewAuthorization;
	if (grant && grant.revokedAt === undefined) {
		authorization = {
			kind: "candidateGrant",
			grantId: grant._id,
			grantRevision: grant.revision,
			reviewerTokenId: token._id,
			candidateRevisionId: revisionId,
			authorizedByUserId: grant.grantedByUserId,
			authorizedAt: grant.createdAt,
		};
	} else if (project.agentReviewPolicy?.enabled) {
		authorization = {
			kind: "projectPolicy",
			policyRevision: project.agentReviewPolicy.revision,
			reviewerTokenId: token._id,
			candidateRevisionId: revisionId,
			authorizedByUserId: project.agentReviewPolicy.updatedByUserId,
			authorizedAt: project.agentReviewPolicy.updatedAt,
		};
	} else {
		throw new ConvexError({
			code: "FORBIDDEN",
			message:
				"A human must enable project agent review or authorize this reviewer for this exact candidate revision.",
		});
	}
	return {
		...evidence,
		token,
		authorization,
		policyRevision: project.agentReviewPolicy?.revision ?? 0,
	};
}

export async function readCandidateAuthorization(
	ctx: QueryCtx,
	revisionId: Id<"agentTranslationCandidateRevisions">,
) {
	const evidence = await candidateEvidence(ctx, revisionId);
	const { member } = await requireViewer(ctx, evidence.revision.projectId);
	const project = await assertProjectExists(ctx, evidence.revision.projectId);
	const grants = await ctx.db
		.query("agentReviewGrants")
		.withIndex("by_revision", (q) => q.eq("candidateRevisionId", revisionId))
		.take(MAX_REVISION_REVIEWERS + 1);
	const tokens = await ctx.db
		.query("apiTokens")
		.withIndex("by_project", (q) => q.eq("projectId", project._id))
		.take(MAX_PROJECT_TOKENS + 1);
	if (
		grants.length > MAX_REVISION_REVIEWERS ||
		tokens.length > MAX_PROJECT_TOKENS
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Reviewer authorization exceeds the supported project envelope.",
		});
	}
	return {
		policy: {
			enabled: project.agentReviewPolicy?.enabled ?? false,
			revision: project.agentReviewPolicy?.revision ?? 0,
		},
		canGrant:
			hasMinimumRole(member.role, "editor") &&
			evidence.candidate.latestRevisionId === revisionId,
		grants: grants
			.filter((grant) => grant.revokedAt === undefined)
			.map((grant) => ({
				grantId: grant._id,
				reviewerTokenId: grant.reviewerTokenId,
				grantedByUserId: grant.grantedByUserId,
				createdAt: grant.createdAt,
			})),
		reviewers: tokens
			.filter((token) =>
				separateReviewer(token, evidence.revision, evidence.proposal),
			)
			.map((token) => ({ tokenId: token._id, name: token.name })),
	};
}

export async function grantCandidateReview(
	ctx: MutationCtx,
	revisionId: Id<"agentTranslationCandidateRevisions">,
	reviewerTokenId: Id<"apiTokens">,
) {
	const evidence = await candidateEvidence(ctx, revisionId);
	const { userId } = await requireEditor(ctx, evidence.revision.projectId);
	if (evidence.candidate.latestRevisionId !== revisionId)
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "Authorize the latest candidate revision.",
		});
	const token = await ctx.db.get(reviewerTokenId);
	if (!token || !separateReviewer(token, evidence.revision, evidence.proposal))
		throw new ConvexError({
			code: "VALIDATION",
			message: "Choose a separate, active reviewer token for this project.",
		});
	const grants = await ctx.db
		.query("agentReviewGrants")
		.withIndex("by_revision", (q) => q.eq("candidateRevisionId", revisionId))
		.take(MAX_REVISION_REVIEWERS + 1);
	const existing = grants.find(
		(grant) => grant.reviewerTokenId === reviewerTokenId,
	);
	const fields = {
		revision: (existing?.revision ?? 0) + 1,
		grantedByUserId: userId,
		createdAt: Date.now(),
		revokedAt: undefined,
		revokedByUserId: undefined,
	};
	if (existing) {
		await ctx.db.patch(existing._id, fields);
		return existing._id;
	}
	if (grants.length >= MAX_REVISION_REVIEWERS)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "This candidate has reached its reviewer limit.",
		});
	return await ctx.db.insert("agentReviewGrants", {
		projectId: evidence.revision.projectId,
		candidateRevisionId: revisionId,
		reviewerTokenId,
		...fields,
	});
}

export async function revokeCandidateReviewGrant(
	ctx: MutationCtx,
	grantId: Id<"agentReviewGrants">,
) {
	const grant = await ctx.db.get(grantId);
	if (!grant)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Reviewer authorization not found.",
		});
	const { userId } = await requireEditor(ctx, grant.projectId);
	await ctx.db.patch(grantId, {
		revokedAt: Date.now(),
		revokedByUserId: userId,
	});
	return null;
}
