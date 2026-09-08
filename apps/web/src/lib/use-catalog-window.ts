import { useQueries } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import {
	advanceWindowBatches,
	type CatalogWindowArgs,
	type CatalogWindowBatch,
	type CatalogWindowResult,
	initialWindowBatches,
	mergeWindowCards,
	windowBatchKey,
} from "./catalog-window-requests";
import { api } from "./convex-api";

/** Load at most four new language/key batches concurrently. Completed visible
 * batches remain subscribed, so edits continue to update partial and full cards. */
export function useCatalogWindow(input: CatalogWindowArgs | "skip"): {
	cards: CatalogWindowResult | undefined;
	isLoading: boolean;
} {
	const requestKey = JSON.stringify(input);
	const args = useMemo(
		() => JSON.parse(requestKey) as CatalogWindowArgs | "skip",
		[requestKey],
	);
	const [state, setState] = useState<{
		requestKey: string;
		batches: CatalogWindowBatch[];
	} | null>(null);
	const batches = useMemo(
		() =>
			args === "skip"
				? []
				: state?.requestKey === requestKey
					? state.batches
					: initialWindowBatches(args),
		[args, requestKey, state],
	);
	const queries = useMemo(
		() =>
			Object.fromEntries(
				batches
					.filter((batch) => batch.started)
					.map((batch) => [
						windowBatchKey(batch),
						{
							query: api.catalogWorkspaceNavigation.window,
							args:
								args === "skip"
									? {}
									: {
											...args,
											messageIds: batch.messageIds,
											...(batch.localeIds === undefined
												? {}
												: { localeIds: batch.localeIds }),
										},
						},
					]),
			),
		[args, batches],
	);
	// Every entry uses this one generated query; Convex deliberately erases the
	// individual result types in its multi-query API.
	const results = useQueries(queries) as Record<
		string,
		CatalogWindowResult | Error | undefined
	>;
	const next = useMemo(
		() => advanceWindowBatches(batches, results),
		[batches, results],
	);
	useEffect(() => {
		if (next) setState({ requestKey, batches: next });
	}, [requestKey, next]);
	return useMemo(
		() =>
			args === "skip"
				? { cards: undefined, isLoading: false }
				: mergeWindowCards(args, batches, results),
		[args, batches, results],
	);
}
