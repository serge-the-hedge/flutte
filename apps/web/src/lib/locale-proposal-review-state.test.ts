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
