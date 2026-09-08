/** Undefined means All (including languages bound later); [] means Source only. */
export function parseStringsLanguages(value: unknown): string[] | undefined {
	if (value === undefined || value === "all") return undefined;
	const values = typeof value === "string" ? value.split(",") : value;
	if (
		!Array.isArray(values) ||
		!values.every((item) => typeof item === "string")
	)
		return undefined;
	return [...new Set(values.map((code) => code.trim()).filter(Boolean))].sort();
}

/** Old single-language permalinks retain their explicit selection. */
export function stringsLanguagesFromSearch(search: Record<string, unknown>) {
	return parseStringsLanguages(
		search.locales ??
			(typeof search.locale === "string" ? [search.locale] : undefined),
	);
}

export function stringsLanguageSelectionKey(search: Record<string, unknown>) {
	return JSON.stringify(stringsLanguagesFromSearch(search) ?? "all");
}
