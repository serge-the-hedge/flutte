import { ConvexError } from "convex/values";

/** Count Unicode code points, including whitespace and line breaks. */
export function characterCount(value: string) {
	return Array.from(value).length;
}
export function validateCharacterLimit(limit: number | null | undefined) {
	if (limit != null && (!Number.isSafeInteger(limit) || limit <= 0))
		throw new ConvexError({
			code: "VALIDATION",
			message: "Character limit must be a positive whole number.",
		});
}
export function assertCharacterLimit(
	value: string,
	limit?: number,
	messageId?: string,
) {
	if (limit === undefined) return;
	const count = characterCount(value);
	if (count > limit)
		throw new ConvexError({
			code: "CHARACTER_LIMIT_EXCEEDED",
			messageId: messageId ?? null,
			characterLimit: limit,
			characterCount: count,
			overBy: count - limit,
			message: `${messageId ? `String "${messageId}"` : "Text"} has ${count} characters; limit ${limit}. Remove at least ${count - limit} ${count - limit === 1 ? "character" : "characters"}.`,
		});
}
