import {
	afterAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";

mock.module("@blabla/env/web", () => ({
	env: { VITE_CONVEX_SITE_URL: "https://example.convex.site" },
}));
const { LocaleProposalWorkbench } = await import("./locale-proposal-workbench");

const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
const commit = "f123456789abcdef0123456789abcdef012345678";
function fixture(
	status: "draft" | "ready" = "draft",
	selected = true,
	withMessage = false,
) {
	return {
		proposal: {
			proposalId: "proposal",
			locale: { code: "pt", label: "Portuguese", runtimeLocale: "pt" },
			sourceSnapshot: { commit },
			status,
			progress: { total: 1, staged: 1, remaining: 0 },
		},
		messages: withMessage
			? [
					{
						messageId: "hello",
						sourceValue: "Hello",
						sourceFingerprint: "source",
						sourceIcuType: "plain",
						facts: {
							state: "reviewed",
							sourceIdentical: false,
							sourceEmpty: false,
							blankCandidate: false,
							icu: false,
							edgeWhitespaceMismatch: false,
							staleSource: false,
						},
						value: { value: "Olá", updatedBy: { kind: "user", id: "human" } },
						candidate: null,
						review: null,
					},
				]
			: [],
		isCurrentBaseline: false,
		locale: { code: "pt", runtimeLocale: "pt" },
		sourceSelection: selected ? "selectedSnapshot" : "baseline",
		sourceIsEligible: selected,
		pendingReview: { count: 0, hasMore: false },
		continueCursor: null,
		pendingQueueContinueCursor: null,
		cursor: 0,
		isDone: true,
		diagnostics: [],
	};
}
let detail = fixture();
const snapshot = {
	_id: "preview",
	name: "English reviewed · PR 1672",
	commit,
	repository: "brickit",
	kind: "preview",
};
const watch = spyOn(client, "watchQuery").mockImplementation(
	(query, _args) => ({
		onUpdate: () => () => {},
		localQueryResult: () => {
			switch (getFunctionName(query)) {
				case "projects:get":
					return {
						name: "Brickit",
						role: "owner",
						type: "repository",
					} as never;
				case "localeProposals:getForReview":
					return detail as never;
				case "localeDelivery:forProposal":
				case "localeDelivery:bindingForProposal":
					return null as never;
				case "snapshots:list":
					return [snapshot] as never;
				default:
					return [] as never;
			}
		},
		localQueryLogs: () => [],
		journal: () => undefined,
	}),
);
const action = spyOn(client, "action").mockResolvedValue({
	localeProposalId: "next",
	carriedValueCount: 1,
	remainingValueCount: 0,
} as never);
beforeEach(() => {
	action.mockClear();
	detail = fixture();
});
afterAll(async () => {
	watch.mockRestore();
	action.mockRestore();
	await client.close();
});
function button(text: string) {
	const element = [...dom.container.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === text,
	);
	if (!element) throw new Error(`Missing button ${text}`);
	return element;
}
async function render() {
	const root = createRootRoute({ component: Outlet });
	const page = createRoute({
		getParentRoute: () => root,
		path: "/projects/$projectId/locale-proposals/pt",
		component: () => (
			<LocaleProposalWorkbench
				projectId="project"
				localeCode="pt"
				initialProposalId="proposal"
			/>
		),
	});
	const router = createRouter({
		routeTree: root.addChildren([page]),
		history: createMemoryHistory({
			initialEntries: ["/projects/project/locale-proposals/pt"],
		}),
	});
	await router.load();
	await dom.render(
		<ConvexProvider client={client}>
			<RouterProvider router={router} />
		</ConvexProvider>,
	);
}
describe("Locale selected-source workbench", () => {
	test("enables eligible selected-source finalization while ordinary stale work stays blocked", async () => {
		await render();
		expect(button("Finalize catalog").disabled).toBe(false);
		expect(dom.container.textContent).toContain(
			"review evidence for the selected Source Snapshot",
		);
		expect(
			dom.container.querySelector(`code[title="${commit}"]`),
		).not.toBeNull();
		await act(async () => button("Finalize catalog").click());
		expect(getFunctionName(action.mock.calls[0][0])).toBe(
			"localeProposals:finalizeForReview",
		);
		detail = fixture("draft", false);
		await render();
		expect(dom.container.textContent).toContain("Source changed");
		expect(
			[...dom.container.querySelectorAll("button")].some(
				(item) => item.textContent?.trim() === "Finalize catalog",
			),
		).toBe(false);
	});

	test("finalized selected work has review evidence and no delivery command", async () => {
		detail = fixture("ready");
		await render();
		expect(dom.container.textContent).toContain("Reviewed for selected source");
		expect(dom.container.textContent).toContain("not accepted for delivery");
		expect(dom.container.textContent).not.toContain(
			"deliver-locale --proposal",
		);
		expect(dom.container.textContent).not.toContain("Ready to deliver");
	});

	test("selection alone writes nothing; explicit continuation passes the chosen captured snapshot", async () => {
		await render();
		await act(async () => button("Choose a captured Source Snapshot").click());
		const trigger =
			dom.container.querySelector<HTMLElement>('[role="combobox"]');
		if (!trigger) throw Error("Missing Source selector");
		await act(async () =>
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			),
		);
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((item) => item.textContent?.includes("English reviewed"));
		if (!option) throw Error("Missing reviewed English snapshot");
		await act(async () => option.click());
		expect(action).not.toHaveBeenCalled();
		await act(async () => button("Continue on selected source").click());
		expect(getFunctionName(action.mock.calls[0][0])).toBe(
			"localeProposals:carryForwardForReview",
		);
		expect(action.mock.calls[0][1]).toMatchObject({
			proposalId: "proposal",
			sourceSnapshotId: "preview",
		});
	});

	test("blocks source continuation when a visible value is edited to empty", async () => {
		detail = fixture("draft", true, true);
		await render();
		await act(async () =>
			dom.container
				.querySelector<HTMLButtonElement>('[aria-label="Expand hello"]')
				?.click(),
		);
		const input =
			dom.container.querySelector<HTMLTextAreaElement>("textarea") ??
			dom.container.querySelector<HTMLInputElement>(
				'[data-slot="input-group-control"]',
			);
		if (!input) throw new Error("Missing Locale value editor");
		expect(input.disabled).toBe(false);
		const prototype =
			input.tagName === "TEXTAREA"
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		await act(async () => {
			Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(button("Resolve unsaved edits").disabled).toBe(true);
		await act(async () => button("Discard unsaved edits").click());
		expect(button("Continue on current source").disabled).toBe(false);
		expect(action).not.toHaveBeenCalled();
	});

	test("keeps another Source choice behind a disclosure for current-source work", async () => {
		detail = { ...fixture(), isCurrentBaseline: true };
		await render();
		expect(dom.container.querySelector('[role="combobox"]')).toBeNull();
		expect(dom.container.textContent).not.toContain(
			"Continue on the current source",
		);
		await act(async () => button("Choose another source").click());
		expect(dom.container.querySelector('[role="combobox"]')).not.toBeNull();
		expect(button("Continue on current source").disabled).toBe(false);
		expect(action).not.toHaveBeenCalled();
	});
});
