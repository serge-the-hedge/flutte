import { expect, test } from "bun:test";
import { act, useState } from "react";
import type { ReleasePreparationSelection } from "@/lib/release-selection";
import { createDomTest } from "@/test/dom";
import { ReleasePreparationScope } from "./release-preparation-scope";

const testDom = createDomTest();

test("keeps an explicit frozen selection on refresh and lets the editor include a message again", async () => {
	const preparations: string[][] = [];
	function Harness({ revision }: { revision: number }) {
		const [draft, setDraft] = useState<string[] | null>(null);
		const ids = draft ?? ["legacy_message"];
		return (
			<div data-revision={revision}>
				<ReleasePreparationScope
					selection={{ mode: "all", excludedMessageIds: ids }}
					onChange={(next) =>
						setDraft(
							next.mode === "all"
								? next.excludedMessageIds
								: next.selectedMessageIds,
						)
					}
					onPrepare={() => preparations.push([...ids])}
					preparing={false}
				/>
			</div>
		);
	}
	await testDom.render(<Harness revision={1} />);
	const button = (label: string) => {
		const result = [...testDom.container.querySelectorAll("button")].find(
			(item) =>
				item.textContent === label || item.getAttribute("aria-label") === label,
		);
		if (!result) throw new Error(`Missing button: ${label}`);
		return result;
	};
	await act(async () => button("Prepare with this selection").click());
	expect(preparations).toEqual([["legacy_message"]]);
	const input = testDom.container.querySelector('input[data-slot="input"]');
	if (!input) throw new Error("Missing exact identifier input");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, " another_message ");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => button("Leave pending").click());
	await testDom.render(<Harness revision={2} />);
	await act(async () => button("Prepare with this selection").click());
	expect(preparations[1]).toEqual([" another_message ", "legacy_message"]);
	await act(async () => button("Include legacy_message again").click());
	await testDom.render(<Harness revision={3} />);
	await act(async () => button("Prepare with this selection").click());
	expect(preparations[2]).toEqual([" another_message "]);
	await act(async () => button("Include  another_message  again").click());
	await act(async () => button("Prepare with this selection").click());
	expect(preparations[3]).toEqual([]);
	expect(testDom.container.textContent).toContain(
		"All current message changes are included.",
	);
});

test("selected-only preparation remains selected-only when the last message is removed", async () => {
	const preparations: ReleasePreparationSelection[] = [];
	function Harness({ revision }: { revision: number }) {
		const [selection, setSelection] = useState<ReleasePreparationSelection>({
			mode: "selected",
			selectedMessageIds: [" exact_message "],
		});
		return (
			<div data-revision={revision}>
				<ReleasePreparationScope
					selection={selection}
					onChange={setSelection}
					onPrepare={() => preparations.push(selection)}
					preparing={false}
				/>
			</div>
		);
	}
	await testDom.render(<Harness revision={1} />);
	const prepare = () =>
		[...testDom.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Prepare with this selection",
		);
	await act(async () => prepare()?.click());
	expect(preparations).toEqual([
		{ mode: "selected", selectedMessageIds: [" exact_message "] },
	]);
	const remove = testDom.container.querySelector<HTMLButtonElement>(
		'[aria-label="Remove  exact_message  from selection"]',
	);
	if (!remove) throw new Error("Missing selected message removal control");
	await act(async () => remove.click());
	await testDom.render(<Harness revision={2} />);
	expect(prepare()?.disabled).toBe(true);
	await act(async () => prepare()?.click());
	expect(preparations).toHaveLength(1);
	expect(testDom.container.textContent).toContain(
		"Select at least one message",
	);
});
