import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { api } from "./convex-api";

type BrowseArgs = FunctionArgs<typeof api.catalogBrowse.page>;
type BrowsePage = FunctionReturnType<typeof api.catalogBrowse.page>;

type BrowseRevisions = {
	content?: number;
	classification?: number;
	classificationGeneration?: string;
	tags?: number;
};

/** A logical page may need several bounded scans before it contains a match.
 * Keep scan positions private and retain the same logical page during a refresh.
 * Only key digests are retained; visible values stay independently subscribed. */
export function useCatalogBrowsePage(
	input: BrowseArgs | "skip",
	revisions: BrowseRevisions = {},
): { page: BrowsePage | undefined; isRefreshing: boolean } {
	const argsKey = JSON.stringify(input);
	const viewKey = JSON.stringify(
		input === "skip" ? input : { ...input, expectedTagRevision: undefined },
	);
	// Text can change search membership without changing a key's review state.
	// Focus membership and counts only depend on classifications.
	const revision =
		input !== "skip" && input.q?.trim()
			? revisions.content
			: revisions.classification;
	const requestKey = JSON.stringify([
		argsKey,
		revision,
		revisions.classificationGeneration,
		revisions.tags,
	]);
	const args = useMemo(
		() => JSON.parse(argsKey) as BrowseArgs | "skip",
		[argsKey],
	);
	// Store positions, not stale result data. The matching page is always a live
	// subscription; relevant classification/content/tag changes reset its bookmark.
	const [bookmarks] = useState(
		() => new Map<string, { after: number; targetIndex: number }>(),
	);
	const bookmark =
		revision === undefined ? undefined : bookmarks.get(requestKey);
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
			revision === undefined ||
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
		revision,
		page,
		nextAfter,
		after,
		scanTargetIndex,
		requestKey,
	]);
	const resolved = args !== "skip" && nextAfter === null ? page : undefined;
	const [lastPage, setLastPage] = useState<{
		viewKey: string;
		page: BrowsePage;
	}>();
	useEffect(() => {
		if (args === "skip" || resolved?.stale) {
			setLastPage(undefined);
		} else if (resolved) {
			setLastPage((previous) =>
				previous?.viewKey === viewKey && previous.page === resolved
					? previous
					: { viewKey, page: resolved },
			);
		} else {
			setLastPage((previous) =>
				previous?.viewKey === viewKey ? previous : undefined,
			);
		}
	}, [args, viewKey, resolved]);
	const retained =
		args !== "skip" && lastPage?.viewKey === viewKey
			? lastPage.page
			: undefined;
	return {
		page: resolved ?? retained,
		isRefreshing: resolved === undefined && retained !== undefined,
	};
}
