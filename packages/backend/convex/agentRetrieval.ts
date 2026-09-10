import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { authenticateAgent as authenticate } from "./agentApi";
import { activeProjectionFor } from "./catalogProjection";
import {
	MAX_SEARCH_SCAN_KEYS,
	matchedFields,
	normalizedSearch,
	searchOptions,
} from "./catalogSearch";
import { readyNavigationStateFor } from "./catalogWorkspaceNavigation";
import {
	readWorkspaceTarget as currentWorkspaceTarget,
	readWorkspaceTargetEvidence,
} from "./catalogWorkspaceRead";
import { encodedSize as byteLength } from "./catalogWorkspaceView";
import { sha256Hex } from "./lib";
import {
	guidanceContextValidator,
	readGuidance,
	readGuidanceRevision,
	retainedGuidanceRevisionValidator,
} from "./translationGuidance";

const MAX_CONTEXT_KEYS = 50;
const MAX_CONTEXT_LOCALES = 20;
const MAX_CONTEXT_PAIRS = 128;
const MAX_DISCOVERY_RESPONSE_BYTES = 512 * 1024;
const MAX_WORK_QUEUE_ITEMS = 16;
const MAX_WORK_QUEUE_SCAN_ROWS = 64;
const MAX_WORK_QUEUE_RESPONSE_BYTES = 768 * 1024;
const MAX_DISCOVERY_READ_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_INDEX_BYTES = 512 * 1024;

const translationWorkReasonValidator = v.union(
	v.literal("missing"),
	v.literal("sourceIdentical"),
	v.literal("sameKeyRepeat"),
	v.literal("stale"),
);

export type TranslationWorkReason =
	| "missing"
	| "sourceIdentical"
	| "sameKeyRepeat"
	| "stale";

type TranslationWorkCursor = {
	projectionId: Id<"catalogProjections">;
	catalogIndex: number;
	targetIndex: number;
};

const translationWorkPageValidator = v.object({
	projectionId: v.id("catalogProjections"),
	items: v.array(
		v.object({
			messageId: v.string(),
			localeCode: v.string(),
			reasons: v.array(translationWorkReasonValidator),
			characterLimit: v.optional(v.number()),
			sourceValue: v.string(),
			targetValue: v.string(),
		}),
	),
	nextCursor: v.union(v.string(), v.null()),
});

const ALL_TRANSLATION_WORK_REASONS = [
	"missing",
	"sourceIdentical",
	"sameKeyRepeat",
	"stale",
] as const satisfies readonly TranslationWorkReason[];

function translationWorkReasons(
	digest: Doc<"catalogWorkspaceNavigationRows">,
	target: Doc<"catalogWorkspaceNavigationRows">["targets"][number],
): TranslationWorkReason[] {
	if (target.valueState === "waiting") return ["missing"];
	if (target.valueState === "stale") return ["stale"];
	if (target.confirmedGitContent || target.touched) return [];

	const reasons: TranslationWorkReason[] = [];
	if (
		!digest.pendingSourceProposal &&
		target.gitValueFingerprint !== undefined &&
		target.gitValueFingerprint === digest.source.gitValueFingerprint
	) {
		reasons.push("sourceIdentical");
	}
	if (
		target.valueFingerprint !== undefined &&
		digest.targets.some(
			(other) =>
				other.localeId !== target.localeId &&
				other.valueFingerprint === target.valueFingerprint,
		)
	) {
		reasons.push("sameKeyRepeat");
	}
	return reasons;
}

function decodeTranslationWorkCursor(
	cursor: string,
): TranslationWorkCursor | null {
	if (cursor.length === 0) return null;
	const match = /^v1\.([^.]+)\.(\d+)\.(\d+)$/.exec(cursor);
	if (!match) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Translation work pagination cursor is invalid.",
		});
	}
	const catalogIndex = Number(match[2]);
	const targetIndex = Number(match[3]);
	if (
		!Number.isSafeInteger(catalogIndex) ||
		catalogIndex < 0 ||
		!Number.isSafeInteger(targetIndex) ||
		targetIndex < 0
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Translation work pagination cursor is invalid.",
		});
	}
	return {
		projectionId: match[1] as Id<"catalogProjections">,
		catalogIndex,
		targetIndex,
	};
}

function encodeTranslationWorkCursor(cursor: TranslationWorkCursor): string {
	return `v1.${cursor.projectionId}.${cursor.catalogIndex}.${cursor.targetIndex}`;
}

function nextTranslationWorkCursor(
	rows: readonly Doc<"catalogWorkspaceNavigationRows">[],
	rowIndex: number,
	targetIndex: number,
	projectionId: Id<"catalogProjections">,
	moreRows: boolean,
): string | null {
	const row = rows[rowIndex];
	if (row && targetIndex + 1 < row.targets.length) {
		return encodeTranslationWorkCursor({
			projectionId,
			catalogIndex: row.catalogIndex,
			targetIndex: targetIndex + 1,
		});
	}
	const nextRow = rows[rowIndex + 1];
	return nextRow
		? encodeTranslationWorkCursor({
				projectionId,
				catalogIndex: nextRow.catalogIndex,
				targetIndex: 0,
			})
		: moreRows && row
			? encodeTranslationWorkCursor({
					projectionId,
					catalogIndex: row.catalogIndex + 1,
					targetIndex: 0,
				})
			: null;
}

function discoveryEntry(
	current: Awaited<ReturnType<typeof currentWorkspaceTarget>>,
) {
	if (!current.projection.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active Catalog Workspace is missing Snapshot identity.",
		});
	}
	return {
		characterLimit: current.characterLimit,
		messageId: current.target.messageId,
		localeId: current.target.localeId,
		localeCode: current.target.localeCode,
		source: {
			value: current.source.value,
			fingerprint: current.source.sourceFingerprint,
			pendingProposal: current.pendingSourceProposal,
			icuType: current.source.icuType,
			argumentNames: current.source.argumentNames,
			argumentNamesComplete: current.source.argumentNamesComplete,
			declaredPlaceholderNames: current.source.declaredPlaceholderNames ?? [],
			declaredPlaceholderNamesComplete:
				current.source.declaredPlaceholderNamesComplete ?? true,
		},
		target: {
			value: current.value,
			valueFingerprint: current.valueFingerprint,
			gitValueFingerprint: current.target.gitValueFingerprint,
			gitValueRevision: current.target.gitValueRevision ?? 0,
			workspaceRevision: current.workspaceRevision,
			catalogPath: current.target.catalogPath,
			sourceFingerprint: current.effectiveTarget.sourceFingerprint,
		},
		basis: {
			projectionId: current.projection._id,
			snapshotId: current.projection.snapshotId,
			gitValueFingerprint: current.target.gitValueFingerprint,
			gitValueRevision: current.target.gitValueRevision ?? 0,
			workspaceRevision: current.workspaceRevision,
			sourceFingerprint: current.source.sourceFingerprint,
		},
	};
}

function assertDiscoveryResponse(value: unknown): void {
	if (byteLength(value) > MAX_DISCOVERY_RESPONSE_BYTES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Workspace discovery response exceeds its byte envelope.",
		});
	}
}

export const workspaceContext = internalQuery({
	args: {
		token: v.string(),
		keys: v.array(v.string()),
		locales: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		if (
			args.keys.length > MAX_CONTEXT_KEYS ||
			args.locales.length > MAX_CONTEXT_LOCALES ||
			args.keys.length * args.locales.length > MAX_CONTEXT_PAIRS
		) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `Workspace context supports at most ${MAX_CONTEXT_KEYS} keys, ${MAX_CONTEXT_LOCALES} Locales, and ${MAX_CONTEXT_PAIRS} pairs.`,
			});
		}
		if (
			new Set(args.keys).size !== args.keys.length ||
			new Set(args.locales).size !== args.locales.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Context keys and Locales must be unique.",
			});
		}
		const missing: Array<{ messageId: string; localeCode: string }> = [];
		const localeIds = new Map<string, Id<"locales">>();
		for (const code of args.locales) {
			const locale = await ctx.db
				.query("locales")
				.withIndex("by_project_code", (q) =>
					q.eq("projectId", token.projectId).eq("code", code),
				)
				.unique();
			if (locale && !locale.isSource && locale.archivedAt === undefined) {
				localeIds.set(code, locale._id);
			} else {
				missing.push(
					...args.keys.map((messageId) => ({ messageId, localeCode: code })),
				);
			}
		}
		const rows = [];
		for (const messageId of args.keys) {
			for (const [localeCode, localeId] of localeIds) {
				try {
					const current = await currentWorkspaceTarget(
						ctx,
						token.projectId,
						messageId,
						localeId,
					);
					rows.push({
						...discoveryEntry(current),
						evidence: await readWorkspaceTargetEvidence(ctx, current),
					});
				} catch (error) {
					if (
						error instanceof ConvexError &&
						typeof error.data === "object" &&
						error.data !== null &&
						"code" in error.data &&
						error.data.code === "NOT_FOUND"
					) {
						missing.push({ messageId, localeCode });
						continue;
					}
					throw error;
				}
			}
		}
		const sourceByMessage = new Map(
			rows.map((row) => [row.messageId, row.source.value]),
		);
		const guidance = await readGuidance(ctx, token.projectId, {
			texts: [...sourceByMessage.values()],
			localeCodes: [...localeIds.keys()],
		});
		const result = {
			rows,
			missing,
			guidance,
			guidanceMessageIds: [...sourceByMessage.keys()],
			codeContext: { status: "unavailable" as const },
		};
		assertDiscoveryResponse(result);
		return result;
	},
});

export const guidanceContext = internalQuery({
	args: {
		token: v.string(),
		texts: v.array(v.string()),
		localeCodes: v.array(v.string()),
		syntax: v.optional(v.union(v.literal("plain"), v.literal("icu"))),
	},
	returns: guidanceContextValidator,
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		return await readGuidance(ctx, token.projectId, args);
	},
});

export const guidanceRevision = internalQuery({
	args: { token: v.string(), revisionId: v.id("translationGuidanceRevisions") },
	returns: retainedGuidanceRevisionValidator,
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		return await readGuidanceRevision(ctx, token.projectId, args.revisionId);
	},
});

/** A bounded Navigation window selects possible matches; exact current rows are
 * hydrated only inside that window. Continuation binds both catalog revision
 * and query options, so edits cannot silently splice two evidence passes. */
export const workspaceSearch = internalQuery({
	args: {
		token: v.string(),
		...searchOptions,
		localeCode: v.optional(v.string()),
		quality: v.optional(v.union(v.literal("all"), v.literal("confirmed"))),
		view: v.optional(v.union(v.literal("compact"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "search");
		const options = normalizedSearch(args);
		const projection = await activeProjectionFor(ctx, token.projectId);
		if (!projection) return { results: [], hasMore: false, nextCursor: null };
		const state = await readyNavigationStateFor(ctx, {
			projectId: token.projectId,
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		});
		const filter = await sha256Hex(
			JSON.stringify({
				...options,
				limit: undefined,
				localeCode: args.localeCode,
				quality: args.quality ?? "all",
				view: args.view ?? "full",
			}),
		);
		const revision = state.revision ?? 0;
		const sourceRevision =
			(await ctx.db.get(token.projectId))?.sourceProposalHeadVersion ?? 0;
		let position = { catalogIndex: 0, targetIndex: 0 };
		if (args.cursor) {
			const decoded: unknown = (() => {
				try {
					if (args.cursor.length > 4096) return null;
					return JSON.parse(args.cursor);
				} catch {
					return null;
				}
			})();
			if (
				!decoded ||
				typeof decoded !== "object" ||
				!("version" in decoded) ||
				decoded.version !== 1 ||
				!("projectionId" in decoded) ||
				!("revision" in decoded) ||
				!("filter" in decoded) ||
				!("catalogIndex" in decoded) ||
				!("targetIndex" in decoded) ||
				typeof decoded.catalogIndex !== "number" ||
				!Number.isSafeInteger(decoded.catalogIndex) ||
				decoded.catalogIndex < 0 ||
				typeof decoded.targetIndex !== "number" ||
				!Number.isSafeInteger(decoded.targetIndex) ||
				decoded.targetIndex < 0
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Invalid search cursor.",
				});
			}
			if (
				decoded.projectionId !== projection._id ||
				decoded.revision !== revision ||
				("sourceRevision" in decoded ? decoded.sourceRevision : 0) !==
					sourceRevision
			)
				throw new ConvexError({
					code: "STALE_BASIS",
					message:
						"The Catalog Workspace changed; restart search from its first page.",
				});
			if (decoded.filter !== filter)
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"Search filters changed; restart search from its first page.",
				});
			position = {
				catalogIndex: decoded.catalogIndex,
				targetIndex: decoded.targetIndex,
			};
		}
		const localeCache = new Map<Id<"locales">, boolean>();
		async function activeLocale(localeId: Id<"locales">) {
			let active = localeCache.get(localeId);
			if (active === undefined) {
				const locale = await ctx.db.get(localeId);
				active =
					locale?.projectId === token.projectId &&
					locale.archivedAt === undefined;
				localeCache.set(localeId, active);
			}
			return active;
		}
		if (args.localeCode) {
			const localeCode = args.localeCode;
			const locale = await ctx.db
				.query("locales")
				.withIndex("by_project_code", (q) =>
					q.eq("projectId", token.projectId).eq("code", localeCode),
				)
				.unique();
			if (!locale || locale.archivedAt !== undefined)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "The requested Locale is not active.",
				});
		}
		const exactKey = options.searchIn === "key" && options.match === "exact";
		const indexedPage = exactKey
			? {
					page: [
						await ctx.db
							.query("catalogWorkspaceNavigationRows")
							.withIndex("by_project_and_projection_and_messageId", (q) =>
								q
									.eq("projectId", token.projectId)
									.eq("projectionId", projection._id)
									.eq("messageId", options.q),
							)
							.unique(),
					].filter((row) => row !== null),
					isDone: true,
				}
			: await ctx.db
					.query("catalogWorkspaceNavigationRows")
					.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
						q
							.eq("projectId", token.projectId)
							.eq("projectionId", projection._id)
							.gte("catalogIndex", position.catalogIndex),
					)
					.paginate({
						cursor: null,
						numItems: MAX_SEARCH_SCAN_KEYS,
						maximumBytesRead: MAX_DISCOVERY_INDEX_BYTES,
					});
		const rows = indexedPage.page;
		type Entry = ReturnType<typeof discoveryEntry> & {
			evidence: Awaited<ReturnType<typeof readWorkspaceTargetEvidence>>;
			matchedFields: ReturnType<typeof matchedFields>;
		};
		type CompactEntry = Pick<
			Entry,
			| "messageId"
			| "localeCode"
			| "evidence"
			| "matchedFields"
			| "characterLimit"
		> & {
			source: { value: string; pendingProposal: boolean };
			target: { value: string };
		};
		const results: Array<Entry | CompactEntry> = [];
		let resultBytes = 0;
		let hydrated = 0;
		let hydratedBytes = 0;
		const continuation = (catalogIndex: number, targetIndex: number) =>
			JSON.stringify({
				version: 1,
				projectionId: projection._id,
				revision,
				sourceRevision,
				filter,
				catalogIndex,
				targetIndex,
			});
		const finish = (nextCursor: string | null) => ({
			results,
			hasMore: nextCursor !== null,
			nextCursor,
		});
		for (const [rowIndex, row] of rows.entries()) {
			if (!row.messageId.startsWith(options.keyPrefix)) continue;
			const start =
				row.catalogIndex === position.catalogIndex ? position.targetIndex : 0;
			if (start > row.targets.length)
				throw new ConvexError({
					code: "VALIDATION",
					message: "Invalid search target cursor.",
				});
			for (
				let targetIndex = start;
				targetIndex < row.targets.length;
				targetIndex++
			) {
				const target = row.targets[targetIndex];
				if (
					!target ||
					(args.localeCode && target.localeCode !== args.localeCode) ||
					!(await activeLocale(target.localeId))
				)
					continue;
				if (
					args.quality === "confirmed" &&
					(target.valueState !== "settled" || target.firstReviewPending)
				)
					continue;
				if (
					hydrated >= MAX_SEARCH_SCAN_KEYS ||
					hydratedBytes >= MAX_DISCOVERY_READ_BYTES
				)
					return finish(continuation(row.catalogIndex, targetIndex));
				hydrated++;
				const current = await currentWorkspaceTarget(
					ctx,
					token.projectId,
					row.messageId,
					target.localeId,
				);
				hydratedBytes += byteLength(current);
				const matches = matchedFields(options, {
					key: row.messageId,
					source: current.source.value,
					target: current.value,
				});
				if (matches.length === 0) continue;
				const evidence = await readWorkspaceTargetEvidence(ctx, current);
				if (
					args.quality === "confirmed" &&
					(!evidence.confirmation ||
						!evidence.sourceMatchesCurrent ||
						!evidence.contract.valid ||
						evidence.firstReviewPending ||
						current.value.length === 0)
				)
					continue;
				const entry =
					args.view === "compact"
						? {
								characterLimit: current.characterLimit,
								messageId: row.messageId,
								localeCode: target.localeCode,
								source: {
									value: current.source.value,
									pendingProposal: current.pendingSourceProposal,
								},
								target: { value: current.value },
								evidence,
								matchedFields: matches,
							}
						: { ...discoveryEntry(current), evidence, matchedFields: matches };
				const bytes = byteLength(entry);
				if (resultBytes + bytes > MAX_DISCOVERY_RESPONSE_BYTES - 4096) {
					if (!results.length)
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message:
								"One search result exceeds the response envelope; request a compact view or a smaller context.",
						});
					return finish(continuation(row.catalogIndex, targetIndex));
				}
				results.push(entry);
				resultBytes += bytes;
				if (results.length === options.limit) {
					const nextRow = rows[rowIndex + 1];
					const next =
						targetIndex + 1 < row.targets.length
							? continuation(row.catalogIndex, targetIndex + 1)
							: nextRow
								? continuation(nextRow.catalogIndex, 0)
								: !indexedPage.isDone
									? continuation(row.catalogIndex + 1, 0)
									: null;
					return finish(next);
				}
			}
		}
		const last = rows[rows.length - 1];
		return finish(
			!indexedPage.isDone && last
				? continuation(last.catalogIndex + 1, 0)
				: null,
		);
	},
});

/** Exhaustive, low-read discovery for translation work. The Navigation Index
 * owns ordering and classification; this query scans only a bounded index
 * window and hydrates full Source/target values for matches. The cursor pins
 * the exact projection so a Baseline change cannot silently splice two runs. */
export const workspaceWorkPage = internalQuery({
	args: {
		token: v.string(),
		cursor: v.string(),
		limit: v.number(),
		localeCode: v.optional(v.string()),
		reasons: v.optional(v.array(translationWorkReasonValidator)),
		q: v.optional(v.string()),
	},
	returns: translationWorkPageValidator,
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "search");
		if (
			!Number.isSafeInteger(args.limit) ||
			args.limit < 1 ||
			args.limit > MAX_WORK_QUEUE_ITEMS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Translation work pages contain 1–${MAX_WORK_QUEUE_ITEMS} items.`,
			});
		}
		const requestedReasons = args.reasons ?? [...ALL_TRANSLATION_WORK_REASONS];
		const reasonSet = new Set<TranslationWorkReason>();
		for (const reason of requestedReasons) {
			if (reasonSet.has(reason)) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Translation work reasons must be unique.",
				});
			}
			reasonSet.add(reason);
		}
		if (reasonSet.size === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "At least one translation work reason is required.",
			});
		}

		const projection = await activeProjectionFor(ctx, token.projectId);
		if (!projection) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "No active Baseline Catalog is available for this project.",
			});
		}
		await readyNavigationStateFor(ctx, {
			projectId: token.projectId,
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		});
		const decodedCursor = decodeTranslationWorkCursor(args.cursor);
		if (decodedCursor && decodedCursor.projectionId !== projection._id) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The Baseline changed while translation work was being paged; restart from the first page.",
			});
		}
		const cursor: TranslationWorkCursor = decodedCursor ?? {
			projectionId: projection._id,
			catalogIndex: 0,
			targetIndex: 0,
		};
		const indexedPage = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", token.projectId)
					.eq("projectionId", projection._id)
					.gte("catalogIndex", cursor.catalogIndex),
			)
			.paginate({
				cursor: null,
				numItems: MAX_WORK_QUEUE_SCAN_ROWS,
				maximumBytesRead: MAX_DISCOVERY_INDEX_BYTES,
			});
		const rows = indexedPage.page;
		const pageRows = rows;
		const matchOptions = normalizedSearch({ q: args.q });

		const localeIds = new Set(
			rows.flatMap((row) => row.targets.map((target) => target.localeId)),
		);
		const locales = await Promise.all(
			[...localeIds].map((localeId) => ctx.db.get(localeId)),
		);
		const activeLocaleIds = new Set(
			locales.flatMap((locale) =>
				locale &&
				locale.projectId === token.projectId &&
				locale.archivedAt === undefined
					? [locale._id]
					: [],
			),
		);
		const items: Array<{
			messageId: string;
			localeCode: string;
			reasons: TranslationWorkReason[];
			characterLimit?: number;
			sourceValue: string;
			targetValue: string;
		}> = [];

		let hydratedBytes = 0;
		let hydrated = 0;
		for (let rowIndex = 0; rowIndex < pageRows.length; rowIndex += 1) {
			const row = pageRows[rowIndex];
			if (!row) continue;
			const targetStart =
				row.catalogIndex === cursor.catalogIndex ? cursor.targetIndex : 0;
			if (
				targetStart > row.targets.length &&
				row.catalogIndex === cursor.catalogIndex
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Translation work pagination cursor is invalid.",
				});
			}
			for (
				let targetIndex = targetStart;
				targetIndex < row.targets.length;
				targetIndex += 1
			) {
				const target = row.targets[targetIndex];
				if (
					!target ||
					!activeLocaleIds.has(target.localeId) ||
					(args.localeCode && target.localeCode !== args.localeCode)
				) {
					continue;
				}
				const reasons = translationWorkReasons(row, target).filter((reason) =>
					reasonSet.has(reason),
				);
				if (reasons.length === 0) continue;
				if (
					hydratedBytes >= MAX_DISCOVERY_READ_BYTES ||
					hydrated >= MAX_SEARCH_SCAN_KEYS
				)
					return {
						projectionId: projection._id,
						items,
						nextCursor: encodeTranslationWorkCursor({
							projectionId: projection._id,
							catalogIndex: row.catalogIndex,
							targetIndex,
						}),
					};
				hydrated++;
				const current = await currentWorkspaceTarget(
					ctx,
					token.projectId,
					row.messageId,
					target.localeId,
				);
				hydratedBytes += byteLength(current);
				// An empty Source value is source-data evidence, not untranslated
				// target work and not an Intentional Blank. Keep it out of every
				// translation-repair reason instead of asking agents to invent text.
				if (
					current.source.value.length === 0 ||
					matchedFields(matchOptions, {
						key: row.messageId,
						source: current.source.value,
						target: current.value,
					}).length === 0
				)
					continue;
				const item = {
					messageId: row.messageId,
					localeCode: target.localeCode,
					reasons,
					characterLimit: current.characterLimit,
					sourceValue: current.source.value,
					targetValue: current.value,
				};
				if (byteLength([...items, item]) > MAX_WORK_QUEUE_RESPONSE_BYTES) {
					if (items.length === 0) {
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message:
								"One translation work item exceeds the response envelope.",
						});
					}
					return {
						projectionId: projection._id,
						items,
						nextCursor: encodeTranslationWorkCursor({
							projectionId: projection._id,
							catalogIndex: row.catalogIndex,
							targetIndex,
						}),
					};
				}
				items.push(item);
				if (items.length === args.limit) {
					return {
						projectionId: projection._id,
						items,
						nextCursor: nextTranslationWorkCursor(
							rows,
							rowIndex,
							targetIndex,
							projection._id,
							!indexedPage.isDone,
						),
					};
				}
			}
		}
		const last = rows[rows.length - 1];
		return {
			projectionId: projection._id,
			items,
			nextCursor:
				!indexedPage.isDone && last
					? encodeTranslationWorkCursor({
							projectionId: projection._id,
							catalogIndex: last.catalogIndex + 1,
							targetIndex: 0,
						})
					: null,
		};
	},
});
