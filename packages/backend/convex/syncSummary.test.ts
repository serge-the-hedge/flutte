import { describe, expect, test } from "vitest";
import { parse } from "./catalogDocument";
import { sourceSyncSummary } from "./syncSummary";

describe("sync source summary", () => {
	test("counts introduction, wording, metadata and removal separately", () => {
		const previous = parse(
			JSON.stringify({
				unchanged: "Same",
				wording: "Before",
				metadata: "Value",
				"@metadata": { description: "Before" },
				removed: "Gone",
			}),
		);
		const current = parse(
			JSON.stringify({
				unchanged: "Same",
				wording: "After",
				metadata: "Value",
				"@metadata": { description: "After" },
				added: "New",
			}),
		);
		expect(sourceSyncSummary(previous, current)).toEqual({
			sourceKeyCount: 4,
			addedKeyCount: 1,
			changedSourceKeyCount: 2,
			removedKeyCount: 1,
			targetValueChangeCount: 0,
		});
	});

	test("ignores formatting and metadata property ordering, including nested objects", () => {
		const previous = parse(
			'{"a":"Value","@a":{"description":"Context","placeholders":{"count":{"type":"int","example":2}}}}',
		);
		const current = parse(
			'{ "@a": {"placeholders":{"count":{"example":2,"type":"int"}},"description":"Context"}, "a":"Value" }',
		);
		expect(sourceSyncSummary(previous, current).changedSourceKeyCount).toBe(0);
		expect(sourceSyncSummary(null, current)).toEqual({
			sourceKeyCount: 1,
			addedKeyCount: 1,
			changedSourceKeyCount: 0,
			removedKeyCount: 0,
			targetValueChangeCount: 0,
		});
	});
});
