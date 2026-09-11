import { useQueries } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useEffect, useMemo, useState } from "react";
import { api } from "./convex-api";

type PageArgs = Omit<FunctionArgs<typeof api.managedContent.page>, "limit">;
type Page = FunctionReturnType<typeof api.managedContent.page>;

/** Empty native scans stay private to a logical page; oversized reads retry with fewer rows. */
export function useManagedPage(input: PageArgs, onStaleCursor?: () => void) {
	const key = JSON.stringify(input);
	const scope = JSON.stringify([input.projectId, input.collectionId]);
	const args = useMemo(() => JSON.parse(key) as PageArgs, [key]);
	const [size, setSize] = useState({ scope, limit: 16 });
	const limit = size.scope === scope ? size.limit : 16;
	const [scan, setScan] = useState<{ key: string; cursor: string } | null>(
		null,
	);
	const cursor = scan?.key === key ? scan.cursor : args.cursor;
	const queries = useMemo(
		() => ({
			page: {
				query: api.managedContent.page,
				args: { ...args, ...(cursor === undefined ? {} : { cursor }), limit },
			},
		}),
		[args, cursor, limit],
	);
	const { page } = useQueries(queries) as { page: Page | Error | undefined };
	const data: unknown = page instanceof ConvexError ? page.data : null;
	const stale =
		data !== null &&
		typeof data === "object" &&
		"code" in data &&
		data.code === "STALE_BASIS" &&
		!!onStaleCursor;
	useEffect(() => {
		if (stale && args.cursor) onStaleCursor?.();
	}, [stale, args.cursor, onStaleCursor]);
	const retry =
		input.focusKey === undefined &&
		limit > 1 &&
		data !== null &&
		typeof data === "object" &&
		"code" in data &&
		data.code === "LIMIT_EXCEEDED";
	useEffect(() => {
		if (retry) setSize({ scope, limit: Math.max(1, Math.floor(limit / 2)) });
	}, [retry, scope, limit]);
	const nextCursor =
		page && !(page instanceof Error) && !page.items.length
			? page.nextCursor
			: null;
	useEffect(() => {
		setScan((previous) =>
			nextCursor !== null
				? { key, cursor: nextCursor }
				: previous?.key === key
					? previous
					: null,
		);
	}, [key, nextCursor]);
	if (nextCursor !== null && nextCursor === cursor)
		throw new Error("String search did not advance its scan cursor.");
	if (stale || nextCursor !== null) return undefined;
	if (page instanceof Error) {
		if (!retry) throw page;
		return undefined;
	}
	return page;
}
