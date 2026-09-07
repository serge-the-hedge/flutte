import { describe, expect, test } from "bun:test";

import { localeProposalReviewState } from "./locale-proposal-review-state";

describe("localeProposalReviewState", () => {
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
