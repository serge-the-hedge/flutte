import type { ConvexReactClient } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { api } from "./convex-api";

type PageArgs = FunctionArgs<typeof api.managedContent.page>;
type Page = FunctionReturnType<typeof api.managedContent.page>;
type ExportArgs = FunctionArgs<typeof api.managedContent.exportSelection>;
const exceedsEnvelope = (error: unknown) =>
	error instanceof ConvexError &&
	typeof error.data === "object" &&
	error.data !== null &&
	"code" in error.data &&
	error.data.code === "LIMIT_EXCEEDED";

/** Walk native pages, including empty scans; publish a selection only after the scan completes. */
export async function matchingManagedKeys(
	client: Pick<ConvexReactClient, "query">,
	args: PageArgs,
	first: Page | undefined,
	onProgress: (count: number) => void,
) {
	const ids = new Set<string>();
	let cursor: string | undefined;
	let page =
		args.expectedTagRevision === undefined ||
		first?.tagRevision === args.expectedTagRevision
			? first
			: undefined;
	let limit = 16;
	for (;;) {
		if (!page) {
			try {
				page = await client.query(api.managedContent.page, {
					...args,
					cursor,
					limit,
				});
			} catch (error) {
				if (limit > 1 && exceedsEnvelope(error)) {
					limit = Math.max(1, Math.floor(limit / 2));
					continue;
				}
				throw error;
			}
		}
		for (const item of page.items) ids.add(item.messageId);
		onProgress(ids.size);
		if (page.nextCursor !== null && page.nextCursor === cursor)
			throw new Error("String search did not advance. Try again.");
		cursor = page.nextCursor ?? undefined;
		page = undefined;
		if (cursor === undefined) break;
	}
	return [...ids];
}

/** Each server read preserves review policy. A download is created only after every chunk succeeds. */
export async function exportManagedKeys(
	client: Pick<ConvexReactClient, "query">,
	args: ExportArgs,
	onProgress: (count: number) => void,
) {
	type Result = FunctionReturnType<typeof api.managedContent.exportSelection>;
	const results: Result[] = [];
	async function read(
		messageIds: string[],
		localeIds: ExportArgs["localeIds"],
	): Promise<void> {
		try {
			results.push(
				await client.query(api.managedContent.exportSelection, {
					...args,
					messageIds,
					localeIds,
				}),
			);
		} catch (error) {
			if (!exceedsEnvelope(error)) throw error;
			if (messageIds.length > 1) {
				const middle = Math.ceil(messageIds.length / 2);
				await read(messageIds.slice(0, middle), localeIds);
				await read(messageIds.slice(middle), localeIds);
				return;
			}
			if (localeIds.length > 1) {
				const middle = Math.ceil(localeIds.length / 2);
				await read(messageIds, localeIds.slice(0, middle));
				await read(messageIds, localeIds.slice(middle));
				return;
			}
			throw error;
		}
	}
	const keys = [...new Set(args.messageIds)];
	for (let start = 0; start < keys.length; start += 32) {
		for (let locale = 0; locale < args.localeIds.length; locale += 32)
			await read(
				keys.slice(start, start + 32),
				args.localeIds.slice(locale, locale + 32),
			);
		onProgress(Math.min(start + 32, keys.length));
	}
	if (results.length === 0) throw new Error("No matching strings to export.");
	// Keep the existing one-read representation byte-for-byte compatible.
	const only = results[0];
	if (results.length === 1 && only)
		return { text: only.text, omitted: only.omitted.length };
	const names: Record<string, string | null> = Object.create(null);
	const values: Record<string, Record<string, string>> = Object.create(null);
	const omitted: Result["omitted"] = [];
	const evidence: Result["document"]["evidence"] = [];
	const sourceRevisions = new Map<string, number>();
	let membershipRevision: number | undefined;
	for (const result of results) {
		const document = result.document;
		for (const item of document.names) names[item.messageId] = item.name;
		for (const item of document.values) {
			values[item.messageId] ??= Object.create(null);
			const localized = values[item.messageId];
			for (const entry of item.values)
				localized[entry.localeCode] = entry.value;
		}
		omitted.push(...document.omitted);
		for (const item of document.evidence) {
			if (
				(sourceRevisions.has(item.messageId) &&
					sourceRevisions.get(item.messageId) !== item.basis.sourceRevision) ||
				(membershipRevision !== undefined &&
					membershipRevision !== item.basis.membershipRevision)
			)
				throw new Error(
					"Strings or languages changed during export. Try again.",
				);
			sourceRevisions.set(item.messageId, item.basis.sourceRevision);
			membershipRevision = item.basis.membershipRevision;
			evidence.push(item);
		}
	}
	return {
		text: JSON.stringify(
			{
				names,
				collectionId: args.collectionId,
				mode: args.mode,
				values,
				omitted,
				evidence,
			},
			null,
			2,
		),
		omitted: omitted.length,
	};
}
