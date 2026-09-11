import type { ConvexReactClient } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "./convex-api";

/** Resolve a frozen selection from bounded Navigation scans, not hydrated values. */
export async function matchingRepositoryKeys(
	client: Pick<ConvexReactClient, "query">,
	args: FunctionArgs<typeof api.catalogBrowse.page>,
	onProgress: (count: number) => void,
) {
	const ids = new Set<string>();
	let after: number | undefined;
	let scanTargetIndex: number | undefined;
	do {
		const page = await client.query(api.catalogBrowse.page, {
			...args,
			after,
			scanTargetIndex,
		});
		if (page.stale)
			throw new Error(
				"The catalog changed while selecting strings. Try again.",
			);
		for (const key of page.keys) {
			if (!args.focusKey || key.messageId === args.focusKey)
				ids.add(key.messageId);
		}
		if (args.focusKey) {
			onProgress(ids.size);
			break;
		}
		onProgress(ids.size);
		if (
			page.nextAfter !== null &&
			(page.nextAfter < (after ?? -1) ||
				(page.nextAfter === (after ?? -1) &&
					(page.nextTargetIndex ?? 0) <= (scanTargetIndex ?? 0)))
		)
			throw new Error("Catalog search did not advance. Try again.");
		after = page.nextAfter ?? undefined;
		scanTargetIndex = page.nextTargetIndex ?? undefined;
	} while (after !== undefined);
	return [...ids];
}
