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
				"Carry compatible reviewed values forward and finish only the changed source residue.",
			canFinalize: false,
		};
	}
	if (input.status === "ready") {
		return {
			phase: "finalized",
			badgeLabel: "Finalized",
			emptyTitle: "Catalog finalized",
			emptyDescription:
				"This task is complete and its immutable delivery artifact is ready.",
			canFinalize: false,
		};
	}
	if (!input.isCurrentBaseline) {
		return {
			phase: "stale",
			badgeLabel: "Source changed",
			emptyTitle: "Source changed",
			emptyDescription:
				"This proposal cannot be finalized against the current Source.",
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
				"Agent-submitted values still need a human or authorized independent reviewer’s decision before this catalog can be finalized.",
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
