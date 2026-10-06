export type ReleasePreparationSelection =
	| { mode: "all"; excludedMessageIds: string[] }
	| { mode: "selected"; selectedMessageIds: string[] };

/** Omitted means all current deltas. Invalid or empty selected input stays
 * selected-only, so malformed links cannot silently broaden a release. */
export function releaseSelectionFromSearch(search: Record<string, unknown>) {
	if (
		search.selectedMessages === undefined &&
		search.excludedMessages === undefined
	)
		return undefined;
	const selected = search.selectedMessages !== undefined;
	const input = selected ? search.selectedMessages : search.excludedMessages;
	if (
		!Array.isArray(input) ||
		!input.every((id): id is string => typeof id === "string") ||
		(selected && search.excludedMessages !== undefined)
	) {
		return {
			mode: "selected",
			selectedMessageIds: [],
		} satisfies ReleasePreparationSelection;
	}
	const ids = [...new Set(input)].sort();
	return selected
		? ({
				mode: "selected",
				selectedMessageIds: ids,
			} satisfies ReleasePreparationSelection)
		: ({
				mode: "all",
				excludedMessageIds: ids,
			} satisfies ReleasePreparationSelection);
}

export function releaseSelectionFromRecord(
	record?: {
		selectedMessageIds?: string[];
		excludedMessageIds: string[];
	} | null,
): ReleasePreparationSelection {
	return record?.selectedMessageIds === undefined
		? { mode: "all", excludedMessageIds: record?.excludedMessageIds ?? [] }
		: { mode: "selected", selectedMessageIds: record.selectedMessageIds };
}

export function releaseSelectionProblem(
	selection: ReleasePreparationSelection,
) {
	const ids =
		selection.mode === "selected"
			? selection.selectedMessageIds
			: selection.excludedMessageIds;
	if (
		ids.length > 64 ||
		new TextEncoder().encode(JSON.stringify(ids)).byteLength > 16 * 1024
	)
		return "Use at most 64 identifiers and 16 KiB of UTF-8 JSON.";
	if (selection.mode === "selected" && ids.length === 0)
		return "Select at least one message, or carry a selection from Strings.";
	if (ids.some((id) => !id.length))
		return "Every message needs an exact identifier.";
	return null;
}

export function releaseSelectionInvalid(
	selection: ReleasePreparationSelection,
) {
	return releaseSelectionProblem(selection) !== null;
}
