import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { act, useState } from "react";
import { createDomTest } from "@/test/dom";
import { LocaleSourceSelector } from "./locale-source-selector";

const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
const commit = "f123456789abcdef0123456789abcdef012345678";
const watch = spyOn(client, "watchQuery").mockImplementation(() => ({
	onUpdate: () => () => {},
	localQueryResult: () =>
		[
			{
				_id: "preview",
				name: "English reviewed · PR 1672",
				commit,
				kind: "preview",
				repository: "brickit",
			},
			{
				_id: "older",
				commit: "a123456789abcdef0123456789abcdef012345678",
				kind: "preview",
				repository: "brickit",
			},
		] as never,
	localQueryLogs: () => [],
	journal: () => undefined,
}));
afterAll(async () => {
	watch.mockRestore();
	await client.close();
});
function Harness({ disabled = false }: { disabled?: boolean }) {
	const [value, setValue] = useState<string | null>(null);
	return (
		<ConvexProvider client={client}>
			<LocaleSourceSelector
				projectId="project"
				value={value}
				onChange={setValue}
				disabled={disabled}
			/>
			<output>{value ?? "current"}</output>
		</ConvexProvider>
	);
}
async function choose(text: string) {
	const trigger = dom.container.querySelector<HTMLElement>('[role="combobox"]');
	if (!trigger) throw new Error("Missing Source selector");
	await act(async () =>
		trigger.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		),
	);
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((item) => item.textContent?.includes(text));
	if (!option) throw new Error(`Missing Source option: ${text}`);
	await act(async () => option.click());
}
describe("new Locale Source selection", () => {
	test("keeps current Source as default and fetches captured snapshots only after a deliberate gesture", async () => {
		watch.mockClear();
		await dom.render(<Harness />);
		expect(watch).not.toHaveBeenCalled();
		expect(dom.container.querySelector("output")?.textContent).toBe("current");
		await act(async () => dom.container.querySelector("button")?.click());
		expect(watch.mock.calls.length).toBeGreaterThan(0);
		await choose("English reviewed");
		expect(dom.container.querySelector("output")?.textContent).toBe("preview");
		expect(dom.container.textContent).toContain(commit);
		expect(dom.container.textContent).toContain(
			"Delivery on the integration branch uses the accepted Source",
		);
		await choose("Current accepted source");
		expect(dom.container.querySelector("output")?.textContent).toBe("current");
	});

	test("does not offer source changes to a disabled editor", async () => {
		watch.mockClear();
		await dom.render(<Harness disabled />);
		expect(dom.container.querySelector("button")?.disabled).toBe(true);
		await act(async () => dom.container.querySelector("button")?.click());
		expect(watch).not.toHaveBeenCalled();
	});
});
