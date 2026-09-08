import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import type { api } from "./convex-api";

export type CatalogWindowArgs = FunctionArgs<
	typeof api.catalogWorkspaceNavigation.window
>;
export type CatalogWindowResult = FunctionReturnType<
	typeof api.catalogWorkspaceNavigation.window
>;
export type CatalogWindowBatch = Pick<
	CatalogWindowArgs,
	"messageIds" | "localeIds"
> & { started: boolean };
export const MAX_PENDING_WINDOWS = 4;
export function windowBatchKey(batch: CatalogWindowBatch) {
	return JSON.stringify([batch.messageIds, batch.localeIds]);
}

export function initialWindowBatches(
	args: Pick<CatalogWindowArgs, "messageIds" | "localeIds">,
): CatalogWindowBatch[] {
	const locales = args.localeIds;
	const groups =
		locales === undefined
			? [undefined]
			: locales.length === 0
				? [[]]
				: Array.from({ length: Math.ceil(locales.length / 4) }, (_, index) =>
						locales.slice(index * 4, index * 4 + 4),
					);
	const keys = Array.from(
		{ length: Math.ceil(args.messageIds.length / 32) },
		(_, index) => args.messageIds.slice(index * 32, index * 32 + 32),
	);
	return keys
		.flatMap((messageIds) =>
			groups.map((localeIds) => ({ messageIds, localeIds })),
		)
		.map((batch, index) => ({
			...batch,
			started: index < MAX_PENDING_WINDOWS,
		}));
}

/** Only byte-limit errors subdivide requests. Keep completed leaves reactive,
 * and admit queued requests as earlier requests settle. */
export function advanceWindowBatches(
	batches: readonly CatalogWindowBatch[],
	results: Readonly<Record<string, unknown>>,
	sizeErrorCode = "WINDOW_TOO_LARGE",
): CatalogWindowBatch[] | null {
	let changed = false;
	const next: CatalogWindowBatch[] = [];
	for (const batch of batches) {
		const result = results[windowBatchKey(batch)];
		if (!(result instanceof Error)) {
			next.push(batch);
			continue;
		}
		const data: unknown =
			result instanceof ConvexError ? result.data : undefined;
		if (
			data === null ||
			typeof data !== "object" ||
			!("code" in data) ||
			data.code !== sizeErrorCode
		)
			throw result;
		if (batch.messageIds.length > 1) {
			const middle = Math.ceil(batch.messageIds.length / 2);
			next.push(
				{
					...batch,
					messageIds: batch.messageIds.slice(0, middle),
					started: false,
				},
				{
					...batch,
					messageIds: batch.messageIds.slice(middle),
					started: false,
				},
			);
		} else if (batch.localeIds && batch.localeIds.length > 1) {
			const middle = Math.ceil(batch.localeIds.length / 2);
			next.push(
				{
					...batch,
					localeIds: batch.localeIds.slice(0, middle),
					started: false,
				},
				{ ...batch, localeIds: batch.localeIds.slice(middle), started: false },
			);
		} else throw result;
		changed = true;
	}
	let pending = next.filter(
		(batch) => batch.started && results[windowBatchKey(batch)] === undefined,
	).length;
	for (
		let index = 0;
		index < next.length && pending < MAX_PENDING_WINDOWS;
		index++
	) {
		const batch = next[index];
		if (batch && !batch.started) {
			next[index] = { ...batch, started: true };
			pending++;
			changed = true;
		}
	}
	return changed ? next : null;
}

/** A key can appear in many language batches. Merge only compatible Source
 * revisions, and never fabricate values for batches that have not arrived. */
export function mergeWindowCards(
	args: CatalogWindowArgs,
	batches: readonly CatalogWindowBatch[],
	results: Readonly<Record<string, CatalogWindowResult | Error | undefined>>,
) {
	const groups = new Map<string, CatalogWindowResult>();
	let isLoading = false;
	let received = false;
	for (const batch of batches) {
		const result = batch.started ? results[windowBatchKey(batch)] : undefined;
		if (result === undefined || result instanceof Error) {
			isLoading = true;
			continue;
		}
		received = true;
		for (const card of result)
			groups.set(card.id, [...(groups.get(card.id) ?? []), card]);
	}
	const cards: CatalogWindowResult = [];
	for (const id of args.messageIds) {
		const parts = groups.get(id);
		const first = parts?.[0];
		if (!parts || !first) continue;
		const source = first.values.find((value) => value.isSource);
		const signature = JSON.stringify([
			first.icuType,
			first.messageSignature.declaredPlaceholderNames,
			first.messageSignature.declaredPlaceholderNamesComplete,
			first.messageSignature.declaredPlaceholderNameCount,
			source,
		]);
		if (
			parts.some(
				(card) =>
					JSON.stringify([
						card.icuType,
						card.messageSignature.declaredPlaceholderNames,
						card.messageSignature.declaredPlaceholderNamesComplete,
						card.messageSignature.declaredPlaceholderNameCount,
						card.values.find((value) => value.isSource),
					]) !== signature,
			)
		) {
			isLoading = true;
			continue;
		}
		const values = new Map(
			parts.flatMap((card) =>
				card.values.map((value) => [value.localeId, value] as const),
			),
		);
		const ordered =
			args.localeIds === undefined
				? [...values.values()].filter((value) => !value.isSource)
				: args.localeIds.flatMap((localeId) => {
						const value = values.get(localeId);
						return value && !value.isSource ? [value] : [];
					});
		cards.push({
			...first,
			messageSignature: {
				...first.messageSignature,
				argumentNames: [
					...new Set(
						parts.flatMap((card) => card.messageSignature.argumentNames),
					),
				],
				argumentNamesComplete:
					batches
						.filter((batch) => batch.messageIds.includes(id))
						.every(
							(batch) =>
								batch.started && Array.isArray(results[windowBatchKey(batch)]),
						) &&
					parts.every((card) => card.messageSignature.argumentNamesComplete),
			},
			values: [...(source ? [source] : []), ...ordered],
		});
	}
	return {
		cards: received || args.messageIds.length === 0 ? cards : undefined,
		isLoading,
	};
}
