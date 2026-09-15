import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { StringsCatalogNavigationState } from "@/lib/strings-catalog-navigation";
import { createDomTest } from "@/test/dom";
import { StringsCatalogView } from "./strings-catalog-view";

describe("Strings search input", () => {
	const dom = createDomTest();
	const render = (
		navigationState: StringsCatalogNavigationState,
		onNavigationChange: (next: StringsCatalogNavigationState) => void,
		page: "ready" | "loading" | "empty" = "ready",
	) =>
		dom.render(
			<StringsCatalogView
				navigationState={navigationState}
				onNavigationChange={onNavigationChange}
				onConnectCheckout={() => {}}
				navigation={
					page === "loading"
						? undefined
						: {
								kind: "ready",
								projectionId: "projection",
								keyCount: page === "empty" ? 0 : 1,
								keys: [],
							}
				}
				hydratedCards={new Map()}
				onWindowMessageIdsChange={() => {}}
			/>,
		);
	function input() {
		const element = dom.container.querySelector<HTMLInputElement>(
			'[aria-label="Search strings"]',
		);
		if (!element) throw new Error("Missing search");
		return element;
	}
	async function type(value: string) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input(), value);
			input().dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	const settle = () =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 250));
		});

	test("keeps typing immediate and commits one query with the latest filters and callback", async () => {
		const oldCalls: StringsCatalogNavigationState[] = [];
		const calls: StringsCatalogNavigationState[] = [];
		await render({ query: "" }, (next) => oldCalls.push(next));
		await type("p");
		await type("purchase");
		expect(input().value).toBe("purchase");
		expect(oldCalls).toEqual([]);
		await render({ query: "", scope: "changedInGit" }, (next) =>
			calls.push(next),
		);
		await settle();
		expect(oldCalls).toEqual([]);
		expect(calls).toEqual([{ query: "purchase", scope: "changedInGit" }]);
	});

	test("Enter and clearing commit immediately without a later duplicate", async () => {
		const calls: StringsCatalogNavigationState[] = [];
		await render({ query: "old" }, (next) => calls.push(next));
		await type("purchase");
		await act(async () =>
			input().dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			),
		);
		expect(calls).toEqual([{ query: "purchase" }]);
		await type("pending");
		const clear = dom.container.querySelector<HTMLButtonElement>(
			'[aria-label="Clear search: pending"]',
		);
		if (!clear) throw new Error("Missing clear search");
		await act(async () => clear.click());
		expect(calls).toEqual([{ query: "purchase" }, { query: "" }]);
		await settle();
		expect(calls).toHaveLength(2);
	});

	test("keeps the focused search and unfinished typing while results load or become empty", async () => {
		const calls: StringsCatalogNavigationState[] = [];
		const onNavigationChange = (next: StringsCatalogNavigationState) =>
			calls.push(next);
		await render({ query: "" }, onNavigationChange);
		const search = input();
		await act(async () => search.focus());
		await type("purchase");
		await settle();
		await render({ query: "purchase" }, onNavigationChange, "loading");
		expect(input() === search).toBe(true);
		expect(document.activeElement === search).toBe(true);
		expect(search.value).toBe("purchase");
		await type("purchase modal");
		await render({ query: "purchase" }, onNavigationChange, "empty");
		expect(input() === search).toBe(true);
		expect(document.activeElement === search).toBe(true);
		expect(search.value).toBe("purchase modal");
		expect(dom.container.textContent).toContain("No matching strings");
		await settle();
		expect(calls).toEqual([{ query: "purchase" }, { query: "purchase modal" }]);
	});

	test("browser navigation replaces a pending draft and unmount cancels work", async () => {
		const calls: StringsCatalogNavigationState[] = [];
		const onNavigationChange = (next: StringsCatalogNavigationState) =>
			calls.push(next);
		await render({ query: "old" }, onNavigationChange);
		await type("unfinished");
		await render({ query: "restored" }, onNavigationChange);
		expect(input().value).toBe("restored");
		await settle();
		expect(calls).toEqual([]);
		await type("another draft");
		await render({ query: "restored", key: "greeting" }, onNavigationChange);
		expect(input().value).toBe("restored");
		await settle();
		expect(calls).toEqual([]);
		await type("last draft");
		await dom.render(<div>Another page</div>);
		await settle();
		expect(calls).toEqual([]);
	});
});
