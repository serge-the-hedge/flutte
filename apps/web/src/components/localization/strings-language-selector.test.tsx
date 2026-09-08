import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTest } from "../../test/dom";
import { StringsLanguageSelector } from "./strings-language-selector";

const dom = createDomTest();
const locales = [
	{ code: "de", label: "German" },
	{ code: "fr", label: "French" },
];
async function click(element: Element | null) {
	if (!element) throw new Error("Missing control");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}
function option(label: string) {
	return (
		[...document.querySelectorAll('[role="option"]')].find((node) =>
			node.textContent?.includes(label),
		) ?? null
	);
}

test("defaults to All, supports a subset, Source only, and selecting All again", async () => {
	function View() {
		const [value, setValue] = useState<string[] | undefined>();
		return (
			<>
				<StringsLanguageSelector
					locales={locales}
					value={value}
					onChange={setValue}
				/>
				<output>{JSON.stringify(value ?? "all")}</output>
			</>
		);
	}
	await dom.render(<View />);
	expect(dom.container.textContent).toContain("All languages (2)");
	await click(dom.container.querySelector("button"));
	expect(option("German")?.getAttribute("aria-selected")).toBe("true");
	await click(option("German"));
	expect(dom.container.querySelector("output")?.textContent).toBe('["fr"]');
	await click(option("French"));
	expect(dom.container.querySelector("output")?.textContent).toBe("[]");
	expect(dom.container.textContent).toContain("Source only");
	await click(option("All languages"));
	expect(dom.container.querySelector("output")?.textContent).toBe('"all"');
	await click(option("All languages"));
	expect(dom.container.querySelector("output")?.textContent).toBe("[]");
});
