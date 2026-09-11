import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { StringsPagination } from "./strings-pagination";

describe("Strings pagination", () => {
	const dom = createDomTest();
	test("shows page counts, locks loading navigation, and exposes accessible actions", async () => {
		let previous = 0;
		let next = 0;
		const render = (
			count: number | undefined,
			hasPrevious = true,
			hasNext = true,
		) =>
			dom.render(
				<StringsPagination
					count={count}
					hasPrevious={hasPrevious}
					hasNext={hasNext}
					onPrevious={() => previous++}
					onNext={() => next++}
				/>,
			);
		const button = (label: string) => {
			const element = dom.container.querySelector<HTMLButtonElement>(
				`button[aria-label="${label}"]`,
			);
			if (!element) throw new Error(`Missing ${label} button`);
			return element;
		};
		await render(undefined);
		expect(dom.container.textContent).toContain("Loading strings…");
		expect(button("Previous page").disabled).toBe(true);
		expect(button("Next page").disabled).toBe(true);
		await render(16);
		expect(dom.container.textContent).toContain("16 strings on this page");
		await act(async () => {
			button("Previous page").click();
			button("Next page").click();
		});
		expect([previous, next]).toEqual([1, 1]);
		await render(1, false, false);
		expect(dom.container.textContent).toContain("1 string on this page");
		expect(button("Previous page").disabled).toBe(true);
		expect(button("Next page").disabled).toBe(true);
		await render(0, true, false);
		expect(dom.container.textContent).toContain("0 strings on this page");
		expect(button("Previous page").disabled).toBe(false);
	});
});
