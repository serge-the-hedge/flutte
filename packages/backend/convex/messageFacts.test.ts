import { describe, expect, test } from "vitest";

import { messageFacts, messageLiteralParts } from "./messageFacts";

describe("message facts", () => {
	test("collects nested ICU arguments without treating plural arm text as a placeholder", () => {
		expect(
			messageFacts(
				"{count, plural, zero{Scanned} one{{count} scan} other{{count} scans}}",
			),
		).toEqual({ icuType: "icu", argumentNames: ["count"] });
	});

	test("collects select arguments and ignores quoted ICU syntax", () => {
		expect(
			messageFacts(
				"It's {name}; '{ignored}' {gender, select, male{He} other{They}}",
			),
		).toEqual({
			icuType: "icu",
			argumentNames: ["name", "gender"],
		});
	});

	test("returns only literal runs while preserving quoted text and separating plural alternatives", () => {
		expect(
			messageLiteralParts(
				"Don't {name}; '{Brand}' {count, plural, one{One Brickit} other{Many Brickit}} {cost, number, currency}",
			),
		).toEqual(["Don't ", "; {Brand} ", "One Brickit", "Many Brickit", " "]);
		expect(messageLiteralParts("Start{name} now")).toEqual(["Start", " now"]);
		expect(messageLiteralParts("Players'")).toEqual(["Players'"]);
	});

	test("separates plural substitutions from literal and quoted number signs", () => {
		expect(messageLiteralParts("# models")).toEqual(["# models"]);
		expect(
			messageLiteralParts("{count, plural, other{# models; '#' models}}"),
		).toEqual([" models; # models"]);
		expect(
			messageLiteralParts(
				"{count, plural, other{Before#{kind, select, other{# models}}}}",
			),
		).toEqual(["Before", " models"]);
	});
});
