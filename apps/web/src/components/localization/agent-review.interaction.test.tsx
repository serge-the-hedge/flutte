import { beforeAll, describe, expect, test } from "bun:test";
import { act, type ComponentProps } from "react";

import { convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import type { AgentReviewEvidence as Evidence } from "./agent-review-evidence";
import type { AgentReviewPolicyCard as PolicyCard } from "./agent-review-policy-card";
import type { CandidateReviewControls as Controls } from "./candidate-review-delegation";

const dom = createDomTest();
let AgentReviewPolicyCard: typeof PolicyCard;
let CandidateReviewControls: typeof Controls;
let AgentReviewEvidence: typeof Evidence;
beforeAll(async () => {
	({ AgentReviewPolicyCard } = await import("./agent-review-policy-card"));
	({ CandidateReviewControls } = await import("./candidate-review-delegation"));
	({ AgentReviewEvidence } = await import("./agent-review-evidence"));
});
const reviewerTokenId = convexId<"apiTokens">("reviewer-1");
const grantId = convexId<"agentReviewGrants">("grant-1");
const authorization: ComponentProps<typeof Controls>["authorization"] = {
	policy: { enabled: false, revision: 0 },
	canGrant: true,
	reviewers: [
		{ tokenId: reviewerTokenId, name: "Independent French reviewer" },
	],
	grants: [],
};
const reviewUrl =
	"https://example.convex.site/api/agent/v1/candidate-reviews/revision-1";
function button(label: string) {
	const element = [...dom.container.querySelectorAll("button")].find(
		(item) => item.textContent === label,
	);
	if (!element) throw new Error(`No button: ${label}`);
	return element;
}
async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}
async function chooseReviewer() {
	const select = dom.container.querySelector<HTMLElement>('[role="combobox"]');
	if (!select) throw new Error("No reviewer selector");
	await act(async () => {
		select.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((item) => item.textContent === "Independent French reviewer");
	if (!option)
		throw new Error(
			`No reviewer option: ${document.body.innerHTML.slice(-3000)}`,
		);
	await click(option);
}

describe("Independent agent review controls", () => {
	test("enables project review only after an owner acts and reports a rejected change", async () => {
		const requested: boolean[] = [];
		await dom.render(
			<AgentReviewPolicyCard
				enabled={false}
				isOwner
				onChange={async (enabled) => {
					requested.push(enabled);
					throw new Error("Permission changed");
				}}
			/>,
		);
		expect(requested).toEqual([]);
		expect(dom.container.textContent).toContain("Agent review · off");
		await click(button("Enable agent review"));
		expect(requested).toEqual([true]);
		expect(dom.container.textContent).toContain("Permission changed");
		await dom.render(
			<AgentReviewPolicyCard
				enabled={false}
				isOwner={false}
				onChange={async () => {
					throw new Error("Must not be called");
				}}
			/>,
		);
		expect(dom.container.querySelector("button")).toBeNull();
	});

	test("requires a named reviewer and explicit delegation while project review is off", async () => {
		const grants: string[] = [];
		const onGrant = async (tokenId: string) => {
			grants.push(tokenId);
		};
		await dom.render(
			<CandidateReviewControls
				authorization={authorization}
				disabled={false}
				reviewUrl={reviewUrl}
				onGrant={onGrant}
				onRevoke={async () => {}}
			/>,
		);
		expect(button("Delegate this revision").disabled).toBe(true);
		await chooseReviewer();
		expect(grants).toEqual([]);
		await click(button("Delegate this revision"));
		expect(grants).toEqual([reviewerTokenId]);
		const revocations: string[] = [];
		await dom.render(
			<CandidateReviewControls
				authorization={{
					...authorization,
					grants: [
						{
							grantId,
							reviewerTokenId,
							grantedByUserId: "human-1",
							createdAt: 1,
						},
					],
				}}
				disabled={false}
				reviewUrl={reviewUrl}
				onGrant={onGrant}
				onRevoke={async (id) => {
					revocations.push(id);
				}}
			/>,
		);
		expect(dom.container.textContent).toContain(
			"Delegated to Independent French reviewer",
		);
		expect(button("Delegate this revision").disabled).toBe(true);
		expect(dom.container.textContent).toContain(reviewUrl);
		await click(button("Revoke delegation"));
		expect(revocations).toEqual([grantId]);
	});

	test("does not require a revision grant when project review is enabled", async () => {
		await dom.render(
			<CandidateReviewControls
				authorization={{
					...authorization,
					policy: { enabled: true, revision: 1 },
				}}
				disabled={false}
				reviewUrl={reviewUrl}
				onGrant={async () => {
					throw new Error("Not required");
				}}
				onRevoke={async () => {}}
			/>,
		);
		expect(dom.container.querySelector('[role="combobox"]')).toBeNull();
		expect(button("Copy review URL").disabled).toBe(false);
		expect(dom.container.textContent).toContain("Project settings allow");
	});

	test("keeps selection on delegation failure and disables authorization for an edited or stale candidate", async () => {
		const onGrant = async () => {
			throw new Error("Candidate changed. Review its new revision.");
		};
		await dom.render(
			<CandidateReviewControls
				authorization={authorization}
				disabled={false}
				reviewUrl={reviewUrl}
				onGrant={onGrant}
				onRevoke={async () => {}}
			/>,
		);
		await chooseReviewer();
		await click(button("Delegate this revision"));
		expect(dom.container.textContent).toContain(
			"Candidate changed. Review its new revision.",
		);
		await dom.render(
			<CandidateReviewControls
				authorization={authorization}
				disabled
				reviewUrl={reviewUrl}
				onGrant={onGrant}
				onRevoke={async () => {}}
			/>,
		);
		expect(button("Delegate this revision").disabled).toBe(true);
	});

	test("attributes completed review to the reviewer credential, including revoked credentials", async () => {
		await dom.render(
			<AgentReviewEvidence
				reviewer={{ kind: "agent", id: reviewerTokenId }}
				authorization={{ kind: "projectPolicy", policyRevision: 3 }}
				tokens={[{ _id: reviewerTokenId, name: "Archived reviewer" }]}
			/>,
		);
		expect(dom.container.textContent).toBe(
			"Reviewer agent: Archived reviewer · project setting (revision 3)",
		);
		await dom.render(
			<AgentReviewEvidence
				reviewer={{ kind: "agent", id: reviewerTokenId }}
				authorization={{ kind: "candidateGrant" }}
				tokens={[]}
			/>,
		);
		expect(dom.container.textContent).toContain(
			"reviewer-1 · human delegation for this revision",
		);
	});
});
