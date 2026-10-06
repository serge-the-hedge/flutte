import { expect, test } from "bun:test";
import {
	releaseSelectionFromRecord,
	releaseSelectionFromSearch,
	releaseSelectionInvalid,
} from "./release-selection";

test("a carried selection survives search round trip and malformed or empty input stays selected-only", () => {
	const selection = ["another", " exact ", "another"];
	const search: Record<string, unknown> = JSON.parse(
		JSON.stringify({ selectedMessages: selection }),
	);
	expect(releaseSelectionFromSearch(search)).toEqual({
		mode: "selected",
		selectedMessageIds: [" exact ", "another"],
	});
	expect(releaseSelectionFromSearch({})).toBeUndefined();
	for (const selectedMessages of [[], "another", null, ["another", 4]]) {
		const scope = releaseSelectionFromSearch({ selectedMessages });
		expect(scope).toEqual({ mode: "selected", selectedMessageIds: [] });
		expect(
			releaseSelectionInvalid(scope ?? releaseSelectionFromRecord(null)),
		).toBe(true);
	}
});

test("refresh uses the frozen exact mode and identifiers, including legacy defaults", () => {
	expect(
		releaseSelectionFromRecord({
			selectedMessageIds: [" exact "],
			excludedMessageIds: [],
		}),
	).toEqual({ mode: "selected", selectedMessageIds: [" exact "] });
	expect(
		releaseSelectionFromRecord({ excludedMessageIds: ["deferred"] }),
	).toEqual({ mode: "all", excludedMessageIds: ["deferred"] });
	expect(releaseSelectionInvalid(releaseSelectionFromRecord(null))).toBe(false);
	expect(
		releaseSelectionInvalid({
			mode: "selected",
			selectedMessageIds: Array.from({ length: 65 }, () => "key"),
		}),
	).toBe(true);
	expect(
		releaseSelectionInvalid({
			mode: "selected",
			selectedMessageIds: ["語".repeat(6000)],
		}),
	).toBe(true);
});
