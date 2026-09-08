export type LocaleProposalReviewPhase =
	| "reviewing"
	| "readyToFinalize"
	| "stale"
	| "previousSource"
	| "finalized"
	| "handedOff";

export type LocaleProposalReviewState = {
	phase: LocaleProposalReviewPhase;
	badgeLabel: string;
	emptyTitle: string;
	emptyDescription: string;
	canFinalize: boolean;
};

/** Turns persistence facts into the workflow state an editor needs to see. */
export function localeProposalReviewState(input: {
	status: "draft" | "ready";
	isBound?: boolean;
	isCurrentBaseline: boolean;
	remaining: number;
	pendingReview: { count: number; hasMore: boolean };
}): LocaleProposalReviewState {
	if (input.status === "ready" && input.isBound) {
		return {
			phase: "handedOff",
			badgeLabel: "Language connected",
			emptyTitle: "Language is available in Strings",
			emptyDescription:
				"This task is complete. Review current translations and any changed source values in Strings.",
			canFinalize: false,
		};
	}
	if (!input.isCurrentBaseline && input.status === "ready") {
		return {
			phase: "previousSource",
			badgeLabel: "Ready on previous source",
			emptyTitle: "Ready on previous source",
			emptyDescription:
				"Keep compatible reviewed values and continue with changed or new source values.",
			canFinalize: false,
		};
	}
	if (input.status === "ready") {
		return {
			phase: "finalized",
			badgeLabel: "Finalized",
			emptyTitle: "Catalog finalized",
			emptyDescription:
				"This task is complete. Its catalog is ready to deliver.",
			canFinalize: false,
		};
	}
	if (!input.isCurrentBaseline) {
		return {
			phase: "stale",
			badgeLabel: "Source changed",
			emptyTitle: "Source changed",
			emptyDescription:
				"Continue on the current source before finalizing this proposal.",
			canFinalize: false,
		};
	}
	if (input.remaining === 0 && input.pendingReview.count === 0) {
		return {
			phase: "readyToFinalize",
			badgeLabel: "Ready to finalize",
			emptyTitle: "Review complete",
			emptyDescription:
				"Nothing is waiting for review. Finalize the catalog above to complete this task.",
			canFinalize: true,
		};
	}
	if (input.pendingReview.count > 0) {
		return {
			phase: "reviewing",
			badgeLabel: `${input.pendingReview.count}${input.pendingReview.hasMore ? "+" : ""} to review`,
			emptyTitle: "Review queue is loading",
			emptyDescription:
				"Agent candidates need your approval or an authorized independent review before finalizing.",
			canFinalize: false,
		};
	}
	return {
		phase: "reviewing",
		badgeLabel: "Reviewing",
		emptyTitle: "No values match this view",
		emptyDescription: "Try another review focus or clear the search.",
		canFinalize: false,
	};
}
