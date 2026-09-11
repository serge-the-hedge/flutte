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

test("native cursor pages reconcile browser Back and retain an exact-key starting point", () => {
	const start = { key: "store.subtitle" };
	const second = { cursor: "native-page-2" };
	const history = { context: "basic-marketing", pages: [start, second] };
	expect(
		previousStringsPages(history, "basic-marketing", {
			cursor: "native-page-3",
		}),
	).toEqual([start, second]);
	expect(previousStringsPages(history, "basic-marketing", second)).toEqual([
		start,
	]);
	expect(previousStringsPages(history, "basic-marketing", start)).toEqual([]);
});

test("native cursor history cannot leak across a tag/search or project change", () => {
	expect(
		previousStringsPages(
			{ context: "old", pages: [{}, { cursor: "page-2" }] },
			"new",
			{ cursor: "page-3" },
		),
	).toEqual([]);
});
