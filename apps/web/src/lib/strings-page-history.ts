export type StringsPagePosition = {
	after?: number;
	cursor?: string;
	key?: string;
};
export type StringsPageHistory = {
	context: string;
	links: { page: StringsPagePosition; previous: StringsPagePosition }[];
};
const samePosition = (left: StringsPagePosition, right: StringsPagePosition) =>
	left.after === right.after &&
	left.cursor === right.cursor &&
	left.key === right.key;

/** Browser and in-app navigation share immutable predecessor links. */
export function previousStringsPage(
	history: StringsPageHistory,
	context: string,
	current: StringsPagePosition,
) {
	if (history.context !== context) return undefined;
	return history.links.find((link) => samePosition(link.page, current))
		?.previous;
}

/** Retain visited branches; Previous must never discard their links. */
export function rememberStringsPage(
	history: StringsPageHistory,
	context: string,
	current: StringsPagePosition,
	next: StringsPagePosition,
): StringsPageHistory {
	const links = history.context === context ? history.links : [];
	return {
		context,
		links: [
			...links.filter((link) => !samePosition(link.page, next)),
			{ page: next, previous: current },
		],
	};
}
