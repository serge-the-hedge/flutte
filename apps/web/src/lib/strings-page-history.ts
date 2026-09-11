export type StringsPagePosition = {
	after?: number;
	cursor?: string;
	key?: string;
};
export type StringsPageHistory = {
	context: string;
	pages: StringsPagePosition[];
};

/** Browser Back can revisit a position already stored in our local history. */
export function previousStringsPages(
	history: StringsPageHistory,
	context: string,
	current: StringsPagePosition,
) {
	if (history.context !== context) return [];
	const index = history.pages.findIndex(
		(page) =>
			page.after === current.after &&
			page.cursor === current.cursor &&
			page.key === current.key,
	);
	return index < 0 ? history.pages : history.pages.slice(0, index);
}
