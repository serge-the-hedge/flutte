import { type Infer, v } from "convex/values";

const authorityFields = {
	reviewerTokenId: v.id("apiTokens"),
	candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	authorizedByUserId: v.string(),
	authorizedAt: v.number(),
};

/** Snapshot of deliberate human authorization, retained with review evidence
 * even after its policy changes or its one-revision grant is revoked. */
export const agentReviewAuthorizationValidator = v.union(
	v.object({
		...authorityFields,
		kind: v.literal("projectPolicy"),
		policyRevision: v.number(),
	}),
	v.object({
		...authorityFields,
		kind: v.literal("candidateGrant"),
		grantId: v.id("agentReviewGrants"),
		grantRevision: v.number(),
	}),
);

export type AgentReviewAuthorization = Infer<
	typeof agentReviewAuthorizationValidator
>;

/** Ordinary agent authorship never counts as review. Only the private review
 * transaction may attach matching authorization evidence to an agent actor. */
export function isHumanOrAuthorizedReview(
	actor: { kind: string; id?: string },
	reviewAuthorization?: AgentReviewAuthorization,
): boolean {
	return (
		actor.kind === "user" ||
		(actor.kind === "agent" &&
			reviewAuthorization !== undefined &&
			actor.id === reviewAuthorization.reviewerTokenId)
	);
}

export const agentReviewPolicyValidator = v.object({
	enabled: v.boolean(),
	revision: v.number(),
	updatedByUserId: v.string(),
	updatedAt: v.number(),
});

export const agentReviewDecisionValidator = v.union(
	v.object({ kind: v.literal("accept") }),
	v.object({ kind: v.literal("reject"), reason: v.optional(v.string()) }),
);

/** Review credentials are deliberately unable to propose or deliver changes. */
export function isReviewOnlyToken(scopes: readonly string[]): boolean {
	return (
		scopes.includes("review") &&
		scopes.every(
			(scope) => scope === "read" || scope === "search" || scope === "review",
		)
	);
}
