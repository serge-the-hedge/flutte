import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { TranslationHistoryRow } from "./translation-history";

describe("inline translation history", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	let emptyPage = false;
	const events = [
		{
			id: "saved-1",
			kind: "saved",
			value: "Bonjour",
			recordedAt: 1788940800000,
			actorLabel: "Seryozha",
		},
	];
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(_query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				({
					events: args.cursor
						? [
								{
									...events[0],
									id: "blank-1",
									value: "",
									intentionalBlankReason: "This label is hidden",
								},
							]
						: emptyPage
							? []
							: events,
					nextCursor: args.cursor ? null : "older-page",
					olderManualHistoryUnavailable: true,
				}) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	beforeEach(() => {
		watch.mockClear();
		emptyPage = false;
	});
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	async function render() {
		await dom.render(
			<ConvexProvider client={client}>
				<TranslationHistoryRow
					projectId="project"
					messageId="greeting"
					messageLabel="greeting"
					localeId="fr-id"
					localeCode="fr"
				>
					<textarea aria-label="Translation" defaultValue="Unsaved draft" />
				</TranslationHistoryRow>
			</ConvexProvider>,
		);
	}
	function button(label: string) {
		const result = Array.from(dom.container.querySelectorAll("button")).find(
			(item) =>
				item.getAttribute("aria-label") === label || item.textContent === label,
		);
		if (!result) throw Error(`Missing ${label}`);
		return result;
	}
	async function click(label: string) {
		await act(async () => button(label).click());
	}
	test("only fetches when opened and preserves the editor through open, close and Escape", async () => {
		await render();
		const editor = dom.container.querySelector("textarea");
		expect(watch).not.toHaveBeenCalled();
		const label = "History of greeting in fr";
		expect(button(label).getAttribute("aria-expanded")).toBe("false");
		await click(label);
		expect([
			...new Set(watch.mock.calls.map(([query]) => getFunctionName(query))),
		]).toEqual(["translationHistory:list"]);
		expect(dom.container.querySelector("textarea")).toBe(editor);
		expect(editor?.value).toBe("Unsaved draft");
		expect(dom.container.textContent).toContain("Bonjour");
		expect(dom.container.textContent).toContain("Seryozha");
		expect(dom.container.textContent).toContain(
			"Older manual edits may be unavailable.",
		);
		await click("Close history");
		expect(dom.container.querySelector("textarea")).toBe(editor);
		expect(document.activeElement).toBe(button(label));
		await click(label);
		await act(async () =>
			button("Close history").dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		expect(button(label).getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(button(label));
		expect(dom.container.querySelector("textarea")).toBe(editor);
	});
	test("copies the retained bytes, including an intentional blank", async () => {
		const previousClipboard = Object.getOwnPropertyDescriptor(
			navigator,
			"clipboard",
		);
		const copied: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (value: string) => {
					copied.push(value);
				},
			},
		});
		try {
			await render();
			await click("History of greeting in fr");
			await click("Copy value");
			await click("Older");
			await click("Copy value");
			expect(copied).toEqual(["Bonjour", ""]);
		} finally {
			if (previousClipboard)
				Object.defineProperty(navigator, "clipboard", previousClipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	test("keeps pagination available through a quiet page", async () => {
		emptyPage = true;
		await render();
		await click("History of greeting in fr");
		expect(dom.container.textContent).toContain("No changes on this page.");
		expect(dom.container.textContent).not.toContain("No recorded history.");
		await click("Older");
		expect(dom.container.textContent).toContain("Intentionally blank");
	});

	test("pages older values and distinguishes a recorded blank from absent history", async () => {
		await render();
		await click("History of greeting in fr");
		expect(button("Newer").disabled).toBe(true);
		await click("Older");
		expect(watch.mock.calls.at(-1)?.[1]).toMatchObject({
			cursor: "older-page",
			projectId: "project",
			messageId: "greeting",
			localeId: "fr-id",
		});
		expect(dom.container.textContent).toContain("Intentionally blank");
		expect(dom.container.textContent).toContain("This label is hidden");
		expect(button("Older").disabled).toBe(true);
		await click("Newer");
		expect(dom.container.textContent).toContain("Bonjour");
	});
});
