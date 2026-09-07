import { describe, expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import { splitOversizedCatalogWindow } from "./catalog-window-requests";

const tooLarge = new ConvexError({
	code: "WINDOW_TOO_LARGE",
	message: "Request fewer keys.",
});
describe("large Catalog window retries", () => {
	test("subdivides only failed batches until all requested keys are covered", () => {
		const original = [["a", "b", "c", "d", "e"]];
		const first = splitOversizedCatalogWindow(original, {
			[JSON.stringify(original[0])]: tooLarge,
		});
		expect(first).toEqual([
			["a", "b", "c"],
			["d", "e"],
		]);
		if (!first) throw new Error("Expected split");
		const second = splitOversizedCatalogWindow(first, {
			[JSON.stringify(first[0])]: tooLarge,
			[JSON.stringify(first[1])]: [{ id: "d" }, { id: "e" }],
		});
		expect(second).toEqual([["a", "b"], ["c"], ["d", "e"]]);
		expect(second?.flat()).toEqual(original.flat());
		expect(splitOversizedCatalogWindow(second ?? [], {})).toBeNull();
	});
	test("never retries unrelated errors or an indivisible key", () => {
		const stale = new ConvexError({
			code: "STALE_BASIS",
			message: "Baseline changed.",
		});
		const batch = ["a", "b"];
		expect(() =>
			splitOversizedCatalogWindow([batch], { [JSON.stringify(batch)]: stale }),
		).toThrow(stale);
		expect(() =>
			splitOversizedCatalogWindow([["a"]], { '["a"]': tooLarge }),
		).toThrow(tooLarge);
	});
});
