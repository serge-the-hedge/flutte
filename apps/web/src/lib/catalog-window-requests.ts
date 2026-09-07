import { ConvexError } from "convex/values";

/** Only a server-declared byte limit warrants subdivision. Authorization,
 * stale Baseline, and integrity failures retain their ordinary error path. */
export function splitOversizedCatalogWindow(
	batches: readonly (readonly string[])[],
	results: Readonly<Record<string, unknown>>,
): string[][] | null {
	let changed = false;
	const next: string[][] = [];
	for (const batch of batches) {
		const result = results[JSON.stringify(batch)];
		if (!(result instanceof Error)) {
			next.push([...batch]);
			continue;
		}
		const data: unknown =
			result instanceof ConvexError ? result.data : undefined;
		const tooLarge =
			data !== null &&
			typeof data === "object" &&
			"code" in data &&
			data.code === "WINDOW_TOO_LARGE";
		if (!tooLarge || batch.length < 2) throw result;
		const middle = Math.ceil(batch.length / 2);
		next.push(batch.slice(0, middle), batch.slice(middle));
		changed = true;
	}
	return changed ? next : null;
}
