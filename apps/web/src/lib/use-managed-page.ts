import { useQueries } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useEffect, useMemo, useState } from "react";
import { api } from "./convex-api";

type PageArgs = Omit<FunctionArgs<typeof api.managedContent.page>, "limit">;
type Page = FunctionReturnType<typeof api.managedContent.page>;

/** Keep native cursor boundaries intact; oversized pages retry with fewer rows. */
export function useManagedPage(input: PageArgs) {
	const key = JSON.stringify(input);
	const scope = JSON.stringify([input.projectId, input.collectionId]);
	const args = useMemo(() => JSON.parse(key) as PageArgs, [key]);
	const [size, setSize] = useState({ scope, limit: 16 });
	const limit = size.scope === scope ? size.limit : 16;
	const queries = useMemo(
		() => ({
			page: { query: api.managedContent.page, args: { ...args, limit } },
		}),
		[args, limit],
	);
	const { page } = useQueries(queries) as { page: Page | Error | undefined };
	const data: unknown = page instanceof ConvexError ? page.data : null;
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
	if (page instanceof Error) {
		if (!retry) throw page;
		return undefined;
	}
	return page;
}
