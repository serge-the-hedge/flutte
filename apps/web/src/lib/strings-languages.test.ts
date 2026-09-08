import { expect, test } from "bun:test";
import {
	stringsLanguageSelectionKey,
	stringsLanguagesFromSearch,
} from "./strings-languages";

test("default All, explicit Source only, and legacy single-language links remain distinct", () => {
	expect(stringsLanguagesFromSearch({})).toBeUndefined();
	expect(stringsLanguagesFromSearch({ locales: [] })).toEqual([]);
	expect(stringsLanguagesFromSearch({ locale: "de" })).toEqual(["de"]);
	expect(stringsLanguagesFromSearch({ locales: ["fr", "de", "fr"] })).toEqual([
		"de",
		"fr",
	]);
	expect(stringsLanguageSelectionKey({ locales: ["fr", "de"] })).toBe(
		stringsLanguageSelectionKey({ locales: ["de", "fr"] }),
	);
	expect(stringsLanguageSelectionKey({ locales: [] })).not.toBe(
		stringsLanguageSelectionKey({}),
	);
});
