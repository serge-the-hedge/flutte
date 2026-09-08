import { describe, expect, test } from "bun:test";

import type { CatalogWorkspaceValue } from "./strings-catalog";
import {
	catalogWorkspaceCommitShortcut,
	presentCatalogKey,
	presentCatalogWorkspaceValue,
} from "./strings-catalog-presentation";

const target = (
	overrides: Partial<CatalogWorkspaceValue> = {},
): CatalogWorkspaceValue => ({
	localeCode: "de",
	isSource: false,
	value: "Konto",
	materialized: false,
	valueState: "settled",
	...overrides,
});

const source = (
	overrides: Partial<CatalogWorkspaceValue> = {},
): CatalogWorkspaceValue => ({
	localeCode: "en",
	isSource: true,
	value: "Account",
	materialized: false,
	...overrides,
});

const present = (
	value: CatalogWorkspaceValue,
	overrides: Partial<{
		sourceValue: string;
		isFocused: boolean;
		isDirty: boolean;
		draftValue: string;
	}> = {},
) =>
	presentCatalogWorkspaceValue({
		value,
		sourceValue: "Account",
		isFocused: false,
		isDirty: false,
		draftValue: value.value,
		...overrides,
	});

describe("presentCatalogWorkspaceValue", () => {
	test("a settled value says nothing and offers nothing at rest", () => {
		const presentation = present(target());

		expect(presentation.phrase).toBeUndefined();
		expect(presentation.tone).toBe("silent");
		expect(presentation.blocks).toBe(false);
		expect(presentation.affordances).toEqual([]);
		expect(presentation.commitHint).toBeUndefined();
	});

	test("a waiting value says it needs a value and takes the accent", () => {
		const presentation = present(target({ value: "", valueState: "waiting" }), {
			draftValue: "",
		});

		expect(presentation.phrase).toBe("needs a value");
		expect(presentation.tone).toBe("attention");
		expect(presentation.blocks).toBe(true);
	});

	test("an Unconfirmed Import carries a mark rather than the accent", () => {
		const presentation = present(target({ valueState: "unconfirmedImport" }));

		expect(presentation.tone).toBe("mark");
		expect(presentation.blocks).toBe(false);
		expect(presentation.phrase).toBeUndefined();
		expect(presentation.affordances).toEqual(["confirm"]);
	});

	test("an unconfirmed value equal to its source reads as Source, not chosen", () => {
		const presentation = present(
			target({ value: "Account", valueState: "unconfirmedImport" }),
			{ draftValue: "Account" },
		);

		expect(presentation.phrase).toBe("Source, not chosen");
		expect(presentation.tone).toBe("mark");
		expect(presentation.blocks).toBe(false);
	});

	test("a semantic Source change says Source changed and blocks", () => {
		const presentation = present(
			target({ valueState: "stale", sourceChangeKind: "semantic" }),
		);

		expect(presentation.phrase).toBe("Source changed");
		expect(presentation.tone).toBe("attention");
		expect(presentation.blocks).toBe(true);
	});

	test("a cosmetic Source change is a quiet greyscale mark", () => {
		const presentation = present(
			target({ valueState: "stale", sourceChangeKind: "cosmetic" }),
		);

		expect(presentation.phrase).toBeUndefined();
		expect(presentation.tone).toBe("mark");
		expect(presentation.blocks).toBe(false);
	});

	test("an empty source does not make an empty target a Source Echo", () => {
		const presentation = present(
			target({ value: "", valueState: "unconfirmedImport" }),
			{ sourceValue: "", draftValue: "" },
		);

		expect(presentation.phrase).not.toBe("Source, not chosen");
	});

	test("an Intentional Blank is settled and silent", () => {
		const presentation = present(
			target({
				value: "",
				valueState: "settled",
				intentionalBlankReason: "Brand name renders nothing here",
			}),
			{ draftValue: "" },
		);

		expect(presentation.phrase).toBeUndefined();
		expect(presentation.tone).toBe("silent");
		expect(presentation.blocks).toBe(false);
	});

	test("the source row is never waiting and never an import", () => {
		const presentation = present(source(), { draftValue: "Account" });

		expect(presentation.phrase).toBeUndefined();
		expect(presentation.tone).toBe("silent");
		expect(presentation.affordances).toEqual([]);
	});
});

describe("affordances follow focus", () => {
	test("a focused non-empty target offers no deliberate blank", () => {
		const presentation = present(target(), { isFocused: true });

		expect(presentation.affordances).toEqual([]);
		expect(presentation.commitHint).toBeUndefined();
	});

	test("a dirty non-empty target offers only a save", () => {
		const presentation = present(target(), {
			isDirty: true,
			draftValue: "Kontostand",
		});

		expect(presentation.affordances).toEqual(["commit"]);
		expect(presentation.commitHint).toBe("save");
	});

	test("an exactly empty draft offers a deliberate blank", () => {
		const presentation = present(target(), {
			isFocused: true,
			isDirty: true,
			draftValue: "",
		});

		expect(presentation.affordances).toEqual(["commit", "intentionalBlank"]);
	});

	test("a whitespace-only draft is content, not a deliberate blank", () => {
		const presentation = present(target(), {
			isFocused: true,
			isDirty: true,
			draftValue: " ",
		});

		expect(presentation.affordances).toEqual(["commit"]);
	});

	test("an untouched Unconfirmed Import keeps confirmation visible", () => {
		const presentation = present(target({ valueState: "unconfirmedImport" }), {
			isFocused: true,
		});

		expect(presentation.affordances).toEqual(["confirm"]);
		expect(presentation.commitHint).toBe("still correct");
	});

	test("a focused semantic Source change offers confirmation", () => {
		const presentation = present(
			target({ valueState: "stale", sourceChangeKind: "semantic" }),
			{ isFocused: true },
		);

		expect(presentation.affordances).toEqual(["confirm"]);
		expect(presentation.commitHint).toBe("still correct");
	});

	test("a cosmetic Source change is skipped by the commit shortcut", () => {
		const presentation = present(
			target({ valueState: "stale", sourceChangeKind: "cosmetic" }),
			{ isFocused: true },
		);

		expect(presentation.affordances).toEqual([]);
		expect(presentation.commitHint).toBeUndefined();
	});

	test("typing into an Unconfirmed Import turns the confirmation into a save", () => {
		const presentation = present(target({ valueState: "unconfirmedImport" }), {
			isFocused: true,
			isDirty: true,
			draftValue: "Kontostand",
		});

		expect(presentation.affordances).toEqual(["commit"]);
		expect(presentation.commitHint).toBe("save");
	});

	test("a value that already renders nothing is not offered a second blank", () => {
		const presentation = present(
			target({
				value: "",
				intentionalBlankReason: "Deliberately empty",
			}),
			{ isFocused: true, draftValue: "" },
		);

		expect(presentation.affordances).toEqual([]);
	});

	test("a focused source row offers a proposal only once it is dirty", () => {
		expect(present(source(), { isFocused: true }).affordances).toEqual([]);

		const dirty = present(source(), {
			isFocused: true,
			isDirty: true,
			draftValue: "Account overview",
		});
		expect(dirty.affordances).toEqual(["commit"]);
		expect(dirty.commitHint).toBe("save");
	});
});

describe("the note shown while typing", () => {
	test("a target being typed to match the source says so", () => {
		expect(
			present(target(), { isDirty: true, draftValue: "Account" }).echoesSource,
		).toBe(true);
	});

	test("a target that differs from the source says nothing", () => {
		expect(
			present(target(), { isDirty: true, draftValue: "Konto" }).echoesSource,
		).toBe(false);
	});

	test("an empty draft never echoes an empty source", () => {
		expect(
			present(target(), { isDirty: true, draftValue: "", sourceValue: "" })
				.echoesSource,
		).toBe(false);
	});

	test("the source row never echoes itself", () => {
		expect(
			present(source(), { isDirty: true, draftValue: "Account" }).echoesSource,
		).toBe(false);
	});
});

describe("presentCatalogKey", () => {
	test("counts the targets waiting on someone, once per key", () => {
		const presentation = presentCatalogKey([
			target({ localeCode: "de", value: "", valueState: "waiting" }),
			target({ localeCode: "es", valueState: "unconfirmedImport" }),
			target({ localeCode: "fr", valueState: "settled" }),
		]);

		expect(presentation.waiting).toBe(1);
		expect(presentation.unconfirmed).toBe(1);
		expect(presentation.stale).toBe(0);
	});

	test("a fully settled key says nothing", () => {
		const presentation = presentCatalogKey([
			target({ localeCode: "de" }),
			target({ localeCode: "fr" }),
		]);

		expect(presentation.waiting).toBe(0);
		expect(presentation.unconfirmed).toBe(0);
		expect(presentation.stale).toBe(0);
		expect(presentation.silent).toBe(true);
	});

	test("the source row is never counted", () => {
		const presentation = presentCatalogKey([source(), target()]);
		expect(presentation.waiting).toBe(0);
		expect(presentation.stale).toBe(0);
	});

	test("an Intentional Blank is not waiting", () => {
		const presentation = presentCatalogKey([
			target({
				value: "",
				valueState: "waiting",
				intentionalBlankReason: "Renders nothing on purpose",
			}),
		]);

		expect(presentation.waiting).toBe(0);
		expect(presentation.stale).toBe(0);
		expect(presentation.silent).toBe(true);
	});
});

describe("catalogWorkspaceCommitShortcut", () => {
	test("maps the editor shortcut to save, imported confirmation, or no-op", () => {
		expect(
			catalogWorkspaceCommitShortcut({ isDirty: true, valueState: "waiting" }),
		).toBe("save");
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: false,
				valueState: "unconfirmedImport",
			}),
		).toBe("confirm");
		expect(
			catalogWorkspaceCommitShortcut({ isDirty: false, valueState: "waiting" }),
		).toBe("none");
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: false,
				valueState: "stale",
				sourceChangeKind: "semantic",
			}),
		).toBe("confirm");
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: false,
				valueState: "stale",
				sourceChangeKind: "cosmetic",
			}),
		).toBe("none");
	});
});
