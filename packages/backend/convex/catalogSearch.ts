import { ConvexError, type Infer, v } from "convex/values";

/** Literal retrieval deliberately preserves punctuation, accents, and unspaced
 * scripts. Exact matches compare original bytes; discovery folds case only. */
export const searchOptions = {
	q: v.optional(v.string()),
	searchIn: v.optional(
		v.union(
			v.literal("all"),
			v.literal("key"),
			v.literal("source"),
			v.literal("target"),
		),
	),
	match: v.optional(v.union(v.literal("substring"), v.literal("exact"))),
	keyPrefix: v.optional(v.string()),
	limit: v.optional(v.number()),
	cursor: v.optional(v.string()),
};
const optionsValidator = v.object(searchOptions);
export type SearchOptions = Infer<typeof optionsValidator>;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_SCAN_KEYS = 64;
export const MAX_SEARCH_RESPONSE_BYTES = 512 * 1024;

export function normalizedSearch(options: SearchOptions) {
	const limit = options.limit ?? 16;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Search limit must be an integer from 1 to 50.",
		});
	}
	if (
		new TextEncoder().encode(options.q ?? "").length > 2048 ||
		new TextEncoder().encode(options.keyPrefix ?? "").length > 512
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Search text exceeds its bounded envelope.",
		});
	}
	const match = options.match ?? "substring";
	return {
		q:
			match === "exact"
				? (options.q ?? "")
				: (options.q ?? "").trim().toLowerCase(),
		searchIn: options.searchIn ?? "all",
		match,
		keyPrefix: options.keyPrefix ?? "",
		limit,
	};
}

export function matchedFields(
	options: ReturnType<typeof normalizedSearch>,
	values: { key: string; source: string; target: string },
) {
	if (!values.key.startsWith(options.keyPrefix)) return [];
	return (["key", "source", "target"] as const).filter(
		(field) =>
			(options.searchIn === "all" || options.searchIn === field) &&
			(options.match === "exact"
				? values[field] === options.q
				: values[field].toLowerCase().includes(options.q)),
	);
}
