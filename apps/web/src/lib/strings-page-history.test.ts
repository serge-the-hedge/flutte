import { expect, test } from "bun:test";
import { previousStringsPages } from "./strings-page-history";

test("browser Back shortens page history without losing a permalink start", () => {
	const start = { key: "message70" };
	const second = { after: 101 };
	const history = { context: "de", pages: [start, second] };
	expect(previousStringsPages(history, "de", { after: 133 })).toEqual([
		start,
		second,
	]);
	expect(previousStringsPages(history, "de", second)).toEqual([start]);
	expect(previousStringsPages(history, "de", start)).toEqual([]);
});
test("a language, filter, release or Baseline change starts a separate history", () => {
	expect(
		previousStringsPages(
			{ context: "old", pages: [{}, { after: 31 }] },
			"new",
			{ after: 63 },
		),
	).toEqual([]);
});
