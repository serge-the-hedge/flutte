import { describe, expect, test } from "bun:test";

import { localeProposalReviewState } from "./locale-proposal-review-state";

describe("localeProposalReviewState", () => {
	test("keeps a bound finalized language complete after the baseline changes", () => {
		expect(
			localeProposalReviewState({
				status: "ready",
				isBound: true,
				isCurrentBaseline: false,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({
			phase: "handedOff",
			badgeLabel: "Language connected",
			canFinalize: false,
			emptyDescription:
				"This task is complete. Review current translations and any changed source values in Strings.",
		});
		expect(
			localeProposalReviewState({
				status: "draft",
				isBound: true,
				isCurrentBaseline: false,
				remaining: 2,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({ phase: "stale", canFinalize: false });
	});
	test("presents a complete draft as ready to finalize", () => {
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: true,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({
			phase: "readyToFinalize",
			badgeLabel: "Ready to finalize",
			emptyTitle: "Review complete",
			emptyDescription:
				"Nothing is waiting for review. Finalize the catalog above to complete this task.",
			canFinalize: true,
		});
	});

	test("does not declare completion while agent-owned values need review", () => {
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: true,
				remaining: 0,
				pendingReview: { count: 3, hasMore: false },
			}),
		).toMatchObject({
			phase: "reviewing",
			badgeLabel: "3 to review",
			canFinalize: false,
		});
	});

	test("distinguishes unfinished, stale, and finalized proposals", () => {
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: true,
				remaining: 3,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({ phase: "reviewing", canFinalize: false });
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: false,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({ phase: "stale", canFinalize: false });
		expect(
			localeProposalReviewState({
				status: "ready",
				isCurrentBaseline: false,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({
			phase: "previousSource",
			badgeLabel: "Ready on previous source",
			canFinalize: false,
		});
		expect(
			localeProposalReviewState({
				status: "ready",
				isCurrentBaseline: true,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({
			phase: "finalized",
			badgeLabel: "Finalized",
			canFinalize: false,
		});
	});
});

describe("selected Source Snapshot review", () => {
	test("allows an eligible selected source draft to finish independently of the Baseline", () => {
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: false,
				sourceSelection: "selectedSnapshot",
				sourceIsEligible: true,
				remaining: 0,
				pendingReview: { count: 0, hasMore: false },
			}),
		).toMatchObject({ phase: "readyToFinalize", canFinalize: true });
		expect(
			localeProposalReviewState({
				status: "draft",
				isCurrentBaseline: false,
				sourceSelection: "selectedSnapshot",
				sourceIsEligible: true,
				remaining: 0,
				pendingReview: { count: 1, hasMore: false },
			}),
		).toMatchObject({ phase: "reviewing", canFinalize: false });
	});

	test("describes selected-source completion as review evidence instead of delivery readiness", () => {
		const state = localeProposalReviewState({
			status: "ready",
			isCurrentBaseline: false,
			sourceSelection: "selectedSnapshot",
			sourceIsEligible: true,
			remaining: 0,
			pendingReview: { count: 0, hasMore: false },
		});
		expect(state).toMatchObject({
			phase: "selectedSourceFinalized",
			badgeLabel: "Reviewed for selected source",
			canFinalize: false,
		});
		expect(state.emptyDescription).toContain(
			"review branch whose Source matches",
		);
		expect(state.emptyDescription).toContain("does not activate the language");
	});

	test("keeps ineligible selected drafts stale and recognizes their later accepted Baseline", () => {
		const input = {
			status: "draft" as const,
			isCurrentBaseline: false,
			sourceSelection: "selectedSnapshot" as const,
			sourceIsEligible: false,
			remaining: 0,
			pendingReview: { count: 0, hasMore: false },
		};
		expect(localeProposalReviewState(input)).toMatchObject({
			phase: "stale",
			canFinalize: false,
		});
		expect(
			localeProposalReviewState({
				...input,
				status: "ready",
				isCurrentBaseline: true,
				sourceIsEligible: true,
			}),
		).toMatchObject({ phase: "finalized" });
	});
});
