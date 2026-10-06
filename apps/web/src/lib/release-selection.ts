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

export function releaseSelectionInvalid(
	selection: ReleasePreparationSelection,
) {
	const ids =
		selection.mode === "selected"
			? selection.selectedMessageIds
			: selection.excludedMessageIds;
	return (
		(selection.mode === "selected" && ids.length === 0) ||
		ids.length > 64 ||
		ids.some((id) => !id.length) ||
		new TextEncoder().encode(JSON.stringify(ids)).byteLength > 16 * 1024
	);
}
