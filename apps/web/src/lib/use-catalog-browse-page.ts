import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { api } from "./convex-api";

type BrowseArgs = FunctionArgs<typeof api.catalogBrowse.page>;
type BrowsePage = FunctionReturnType<typeof api.catalogBrowse.page>;

/** A logical page may need several bounded scans before it contains a match.
 * Keep that scan cursor private: URL positions and Back/Previous history still
 * describe the user's page, rather than each empty backend response. */
export function useCatalogBrowsePage(
	input: BrowseArgs | "skip",
	navigationRevision?: number,
): BrowsePage | undefined {
	const argsKey = JSON.stringify(input);
	const requestKey = JSON.stringify([argsKey, navigationRevision]);
	const args = useMemo(
		() => JSON.parse(argsKey) as BrowseArgs | "skip",
		[argsKey],
	);
	const [scan, setScan] = useState<{
		requestKey: string;
		after: number;
	} | null>(null);
	const after =
		scan?.requestKey === requestKey
			? scan.after
			: args === "skip"
				? undefined
				: args.after;
	const queryArgs = useMemo(
		() => (args === "skip" ? ("skip" as const) : { ...args, after }),
		[args, after],
	);
	const page = useQuery(api.catalogBrowse.page, queryArgs);
	const nextAfter =
		page && !page.stale && page.keys.length === 0 ? page.nextAfter : null;
	// A non-advancing cursor is a protocol failure, never an invitation to loop.
	if (nextAfter !== null && nextAfter <= (after ?? -1))
		throw new Error("Catalog search did not advance its scan cursor.");
	useEffect(() => {
		setScan((previous) => {
			if (nextAfter !== null)
				return previous?.requestKey === requestKey &&
					previous.after === nextAfter
					? previous
					: { requestKey, after: nextAfter };
			// A committed request change must forget the earlier scan even if
			// the new request immediately matches or temporarily skips reads.
			return previous?.requestKey === requestKey ? previous : null;
		});
	}, [requestKey, nextAfter]);
	return args === "skip" || nextAfter !== null ? undefined : page;
}
