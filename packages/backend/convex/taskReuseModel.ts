import { v } from "convex/values";

/** A historical pointer, never review authority for the new revision. */
export const reusedCandidateOrigin = v.object({
	taskId: v.id("agentTranslationProposals"),
	revisionId: v.id("agentTranslationCandidateRevisions"),
	reviewId: v.id("agentTranslationCandidateReviews"),
});

export const reuseOutcome = v.object({
	messageId: v.string(),
	status: v.union(
		v.literal("copied"),
		v.literal("alreadyCopied"),
		v.literal("unreviewed"),
		v.literal("sourceChanged"),
		v.literal("incompatibleSource"),
		v.literal("outsideDestination"),
		v.literal("occupiedDestination"),
		v.literal("invalidDestination"),
	),
	originRevisionId: v.optional(v.id("agentTranslationCandidateRevisions")),
	revisionId: v.optional(v.id("agentTranslationCandidateRevisions")),
	reason: v.optional(v.string()),
});
export const reusePage = v.object({
	sourceTaskId: v.id("agentTranslationProposals"),
	destinationTaskId: v.id("agentTranslationProposals"),
	clientReuseKey: v.string(),
	items: v.array(reuseOutcome),
	nextCursor: v.union(v.number(), v.null()),
});
