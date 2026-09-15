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
	tagRevision?: number,
): BrowsePage | undefined {
	const argsKey = JSON.stringify(input);
	const requestKey = JSON.stringify([argsKey, navigationRevision, tagRevision]);
	const args = useMemo(
		() => JSON.parse(argsKey) as BrowseArgs | "skip",
		[argsKey],
	);
	// Store positions, not stale result data. The matching page is always a live
	// subscription; any catalog/tag revision invalidates its scan bookmark.
	const [bookmarks] = useState(
		() => new Map<string, { after: number; targetIndex: number }>(),
	);
	const bookmark =
		navigationRevision === undefined ? undefined : bookmarks.get(requestKey);
	const [scan, setScan] = useState<{
		requestKey: string;
		after: number;
		targetIndex: number;
	} | null>(null);
	const after =
		scan?.requestKey === requestKey
			? scan.after
			: (bookmark?.after ?? (args === "skip" ? undefined : args.after));
	const scanTargetIndex =
		scan?.requestKey === requestKey
			? scan.targetIndex
			: (bookmark?.targetIndex ??
				(args === "skip" ? undefined : args.scanTargetIndex));
	const queryArgs = useMemo(
		() =>
			args === "skip" ? ("skip" as const) : { ...args, after, scanTargetIndex },
		[args, after, scanTargetIndex],
	);
	const page = useQuery(api.catalogBrowse.page, queryArgs);
	const nextAfter =
		page && !page.stale && page.keys.length === 0 ? page.nextAfter : null;
	const nextTargetIndex = page?.nextTargetIndex ?? 0;
	// A non-advancing cursor is a protocol failure, never an invitation to loop.
	if (
		nextAfter !== null &&
		(nextAfter < (after ?? -1) ||
			(nextAfter === (after ?? -1) &&
				nextTargetIndex <= (scanTargetIndex ?? 0)))
	)
		throw new Error("Catalog search did not advance its scan cursor.");
	useEffect(() => {
		setScan((previous) => {
			if (nextAfter !== null)
				return previous?.requestKey === requestKey &&
					previous.after === nextAfter &&
					previous.targetIndex === nextTargetIndex
					? previous
					: { requestKey, after: nextAfter, targetIndex: nextTargetIndex };
			// A committed request change must forget the earlier scan even if
			// the new request immediately matches or temporarily skips reads.
			return previous?.requestKey === requestKey ? previous : null;
		});
	}, [requestKey, nextAfter, nextTargetIndex]);
	useEffect(() => {
		if (
			navigationRevision === undefined ||
			!page ||
			page.stale ||
			nextAfter !== null ||
			after === undefined
		)
			return;
		bookmarks.delete(requestKey);
		bookmarks.set(requestKey, { after, targetIndex: scanTargetIndex ?? 0 });
		if (bookmarks.size > 16) {
			const oldest = bookmarks.keys().next().value;
			if (oldest !== undefined) bookmarks.delete(oldest);
		}
	}, [
		bookmarks,
		navigationRevision,
		page,
		nextAfter,
		after,
		scanTargetIndex,
		requestKey,
	]);
	return args === "skip" || nextAfter !== null ? undefined : page;
}
