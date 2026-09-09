import { useConvex } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { api } from "./convex-api";

type CountArgs = Omit<
	FunctionArgs<typeof api.catalogBrowse.scopeCounts>,
	"cursor"
>;
type Counts = FunctionReturnType<
	typeof api.catalogBrowse.scopeCounts
>["counts"];

/** Count each catalog generation once per language selection, never per focus
 * or browse page. Revision changes cancel the scan so totals cannot mix edits. */
export function useCatalogScopeCounts(
	input: CountArgs | "skip",
): Counts | undefined {
	const convex = useConvex();
	const requestKey = JSON.stringify(input);
	const [result, setResult] = useState<{
		requestKey: string;
		counts?: Counts;
		error?: unknown;
	}>();
	useEffect(() => {
		const args = JSON.parse(requestKey) as CountArgs | "skip";
		if (args === "skip") return;
		let cancelled = false;
		async function scan(args: CountArgs) {
			const totals: Counts = {
				waiting: 0,
				unconfirmedImport: 0,
				stale: 0,
				settled: 0,
				introduced: 0,
			};
			let cursor: string | undefined;
			do {
				const page = await convex.query(api.catalogBrowse.scopeCounts, {
					...args,
					cursor,
				});
				if (cancelled || page.stale) return;
				for (const key of Object.keys(totals) as (keyof Counts)[])
					totals[key] += page.counts[key];
				if (page.cursor !== null && page.cursor === cursor)
					throw new Error("Catalog counts did not advance their scan cursor.");
				cursor = page.cursor ?? undefined;
			} while (cursor !== undefined);
			if (!cancelled) setResult({ requestKey, counts: totals });
		}
		void scan(args).catch((error) => {
			if (!cancelled) setResult({ requestKey, error });
		});
		return () => {
			cancelled = true;
		};
	}, [convex, requestKey]);
	if (result?.requestKey !== requestKey) return undefined;
	if (result.error) throw result.error;
	return result.counts;
}
