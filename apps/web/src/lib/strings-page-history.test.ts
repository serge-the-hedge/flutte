import { expect, test } from "bun:test";
import {
	previousStringsPage,
	rememberStringsPage,
	type StringsPageHistory,
	type StringsPagePosition,
} from "./strings-page-history";

for (const kind of ["repository", "basic"] as const) {
	const page = (index: number): StringsPagePosition =>
		kind === "repository" ? { after: index } : { cursor: `native-${index}` };
	test(`${kind}: mixed UI Previous and browser Back preserve each visited predecessor`, () => {
		const first = { key: "start-key" };
		const second = page(2);
		const third = page(3);
		let history: StringsPageHistory = { context: kind, links: [] };
		history = rememberStringsPage(history, kind, first, second);
		history = rememberStringsPage(history, kind, second, third);
		// UI Previous from 3 to 2, followed by browser Back to 3.
		expect(previousStringsPage(history, kind, third)).toEqual(second);
		expect(previousStringsPage(history, kind, second)).toEqual(first);
		expect(previousStringsPage(history, kind, third)).toEqual(second);
		// Browser Back to 1, then Next follows a different freshly read continuation.
		const alternate = page(4);
		history = rememberStringsPage(history, kind, first, alternate);
		expect(previousStringsPage(history, kind, alternate)).toEqual(first);
		expect(previousStringsPage(history, kind, third)).toEqual(second);
		expect(previousStringsPage(history, kind, second)).toEqual(first);
		expect(previousStringsPage(history, kind, first)).toBeUndefined();
	});
}
test("project/filter changes isolate links and old contexts are discarded on Next", () => {
	const history = rememberStringsPage(
		{ context: "old", links: [] },
		"old",
		{},
		{ cursor: "next" },
	);
	expect(
		previousStringsPage(history, "new", { cursor: "next" }),
	).toBeUndefined();
	const next = rememberStringsPage(history, "new", {}, { cursor: "new-next" });
	expect(previousStringsPage(next, "new", { cursor: "next" })).toBeUndefined();
	expect(previousStringsPage(next, "new", { cursor: "new-next" })).toEqual({});
});
