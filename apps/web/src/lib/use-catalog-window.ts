import { useQueries } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { splitOversizedCatalogWindow } from "./catalog-window-requests";
import { api } from "./convex-api";

type WindowArgs = FunctionArgs<typeof api.catalogWorkspaceNavigation.window>;
type WindowResult = FunctionReturnType<
	typeof api.catalogWorkspaceNavigation.window
>;

/** Keep one subscription for normal windows. Exceptionally large values split
 * only the failed batch; every leaf stays reactive and the full window remains
 * available to the existing card cache once its requests finish. */
export function useCatalogWindow(
	args: WindowArgs | "skip",
): WindowResult | undefined {
	const requestKey = JSON.stringify(args);
	const [split, setSplit] = useState<{
		requestKey: string;
		batches: string[][];
	} | null>(null);
	const batches = useMemo(
		() =>
			args === "skip"
				? []
				: split?.requestKey === requestKey
					? split.batches
					: [args.messageIds],
		[args, requestKey, split],
	);
	const queries = useMemo(
		() =>
			Object.fromEntries(
				batches.map((messageIds) => [
					JSON.stringify(messageIds),
					{
						query: api.catalogWorkspaceNavigation.window,
						args: args === "skip" ? {} : { ...args, messageIds },
					},
				]),
			),
		[args, batches],
	);
	// Convex's multi-query hook intentionally erases individual return types. All
	// requests here use this one generated, typed query.
	const results = useQueries(queries) as Record<
		string,
		WindowResult | Error | undefined
	>;
	const next = useMemo(
		() => splitOversizedCatalogWindow(batches, results),
		[batches, results],
	);
	useEffect(() => {
		if (next) setSplit({ requestKey, batches: next });
	}, [requestKey, next]);
	return useMemo(() => {
		if (args === "skip" || next) return undefined;
		const combined: WindowResult = [];
		for (const batch of batches) {
			const result = results[JSON.stringify(batch)];
			if (result === undefined || result instanceof Error) return undefined;
			combined.push(...result);
		}
		return combined;
	}, [args, batches, next, results]);
}
