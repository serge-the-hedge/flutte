import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import {
	matchedFields as findMatchedFields,
	normalizedSearch,
	searchOptions,
} from "./catalogSearch";
import { encodedSize } from "./catalogWorkspaceView";
import {
	collectionMemberships,
	readCollections,
	requireManagedCollection,
} from "./contentCollections";
import { sha256Hex } from "./lib";
import {
	exportManagedSelection,
	readManagedContext,
	readManagedTarget,
} from "./managedContent";
import { readGuidance } from "./translationGuidance";

const MAX_RESPONSE_BYTES = 1024 * 1024;
// Collection names and generated key/Locale cursors fit within this reserve.
const SEARCH_RESPONSE_OVERHEAD_BYTES = 4096;

function boundedResponse<T>(response: T): T {
	if (encodedSize(response) > MAX_RESPONSE_BYTES)
		fail(
			"LIMIT_EXCEEDED",
			"Collection response exceeds 1 MiB. Reduce the selection or search limit.",
		);
	return response;
}

function searchEntry(
	current: Awaited<ReturnType<typeof readManagedTarget>>,
	matchedFields: string[],
) {
	return {
		collectionId: current.collection._id,
		messageId: current.source.key,
		localeCode: current.locale.code,
		source: {
			value: current.source.sourceValue,
			fingerprint: current.source.sourceFingerprint,
			revision: current.source.sourceRevision,
		},
		target: {
			value: current.value,
			fingerprint: current.valueFingerprint,
			revision: current.workspaceRevision,
			valueState: current.valueState,
			intentionalBlankReason: current.intentionalBlank,
		},
		basis: current.basis,
		confirmation:
			current.valueState === "settled" && current.target
				? {
						actor: current.target.actor,
						reviewAuthorization: current.target.reviewAuthorization ?? null,
					}
				: null,
		matchedFields,
	};
}

const address = { token: v.string(), collectionId: v.id("contentCollections") };
function fail(code: string, message: string): never {
	throw new ConvexError({ code, message });
}

async function resolveLocales(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	collectionId: Id<"contentCollections">,
	codes?: string[],
	maxCodes = 20,
) {
	const memberships = (await collectionMemberships(ctx, collectionId)).filter(
		(m) => m.active,
	);
	const locales: Doc<"locales">[] = [];
	for (const membership of memberships) {
		const locale = await ctx.db.get(membership.localeId);
		if (
			locale &&
			locale.projectId === projectId &&
			locale.archivedAt === undefined &&
			!locale.isSource
		)
			locales.push(locale);
	}
	locales.sort((a, b) => a.code.localeCompare(b.code));
	if (codes) {
		if (codes.length > maxCodes || new Set(codes).size !== codes.length)
			fail(
				"VALIDATION",
				`Choose at most ${maxCodes} distinct collection languages.`,
			);
		return codes.map((code) => {
			const locale = locales.find((l) => l.code === code);
			if (!locale)
				fail(
					"NOT_FOUND",
					`Language ${code} is not enabled in this collection.`,
				);
			return locale;
		});
	}
	return locales;
}

export const list = internalQuery({
	args: { token: v.string() },
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		return { collections: await readCollections(ctx, token.projectId) };
	},
});
export const detail = internalQuery({
	args: address,
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		const collection = await requireManagedCollection(
			ctx,
			token.projectId,
			args.collectionId,
		);
		const project = await ctx.db.get(token.projectId);
		const source = project?.sourceLocaleId
			? await ctx.db.get(project.sourceLocaleId)
			: null;
		return {
			collection: {
				id: collection._id,
				name: collection.name,
				kind: "managed" as const,
				membershipRevision: collection.membershipRevision,
			},
			sourceLocale: source?.code ?? null,
			locales: (
				await resolveLocales(ctx, token.projectId, args.collectionId)
			).map((l) => ({ id: l._id, code: l.code, label: l.label })),
			syntax: "plain" as const,
		};
	},
});
export const context = internalQuery({
	args: { ...address, keys: v.array(v.string()), locales: v.array(v.string()) },
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		const collection = await requireManagedCollection(
			ctx,
			token.projectId,
			args.collectionId,
		);
		const locales = await resolveLocales(
			ctx,
			token.projectId,
			args.collectionId,
			args.locales,
		);
		const result = await readManagedContext(ctx, {
			projectId: token.projectId,
			collectionId: args.collectionId,
			messageIds: args.keys,
			localeIds: locales.map((l) => l._id),
		});
		const sources = new Map(
			result.items.map((item) => [item.messageId, item.sourceValue]),
		);
		const guidance = await readGuidance(ctx, token.projectId, {
			texts: [...sources.values()],
			localeCodes: args.locales,
			syntax: "plain",
		});
		return boundedResponse({
			collection: { id: collection._id, name: collection.name },
			...result,
			guidanceSourceKeys: [...sources.keys()],
			guidance,
		});
	},
});

/** Key/Locale continuation is scoped to query options and membership. Values are
 * live per page; callers doing exhaustive repair need a fresh final pass. */
export const search = internalQuery({
	args: {
		...address,
		...searchOptions,
		localeCode: v.optional(v.string()),
		quality: v.optional(v.union(v.literal("all"), v.literal("confirmed"))),
	},
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "search");
		const collection = await requireManagedCollection(
			ctx,
			token.projectId,
			args.collectionId,
		);
		const options = normalizedSearch(args);
		const { q, limit } = options;
		const locales = await resolveLocales(
			ctx,
			token.projectId,
			args.collectionId,
			args.localeCode ? [args.localeCode] : undefined,
		);
		const basis = await sha256Hex(
			JSON.stringify([
				collection._id,
				collection.membershipRevision,
				q,
				args.localeCode ?? null,
				args.quality ?? "all",
				args.searchIn ?? "all",
				args.match ?? "substring",
				options.keyPrefix,
			]),
		);
		let key = "";
		let localeIndex = 0;
		if (args.cursor) {
			let raw: unknown;
			try {
				if (args.cursor.length > 4096) throw new Error();
				raw = JSON.parse(args.cursor);
			} catch {
				fail("VALIDATION", "Invalid collection search cursor.");
			}
			if (
				!raw ||
				typeof raw !== "object" ||
				!("basis" in raw) ||
				!("key" in raw) ||
				typeof raw.key !== "string" ||
				!("localeIndex" in raw) ||
				typeof raw.localeIndex !== "number" ||
				!Number.isSafeInteger(raw.localeIndex) ||
				raw.localeIndex < 0 ||
				raw.localeIndex >= locales.length
			)
				fail("VALIDATION", "Invalid collection search cursor.");
			if (raw.basis !== basis)
				fail(
					"STALE_BASIS",
					"Collection search or languages changed; restart the search.",
				);
			key = raw.key;
			localeIndex = raw.localeIndex;
		}
		const cursor = (nextKey: string, index: number) =>
			JSON.stringify({ basis, key: nextKey, localeIndex: index });
		const items: ReturnType<typeof searchEntry>[] = [];
		if (locales.length === 0)
			return boundedResponse({
				collection: { id: collection._id, name: collection.name },
				items,
				nextCursor: null,
				consistency: "live" as const,
			});
		const rows = ctx.db
			.query("managedMessages")
			.withIndex("by_collection_key", (index) =>
				index.eq("collectionId", args.collectionId).gte("key", key),
			);
		let scans = 0;
		let readBytes = 0;
		for await (const source of rows) {
			readBytes += encodedSize(source);
			if (source.archivedAt !== undefined) {
				if (++scans >= 64 || readBytes > 4 * 1024 * 1024)
					return boundedResponse({
						collection: { id: collection._id, name: collection.name },
						items,
						nextCursor: cursor(`${source.key}\u0000`, 0),
						consistency: "live" as const,
					});
				continue;
			}
			for (
				let i = source.key === key ? localeIndex : 0;
				i < locales.length;
				i++
			) {
				if (scans >= 64 || readBytes > 4 * 1024 * 1024 || items.length >= limit)
					return boundedResponse({
						collection: { id: collection._id, name: collection.name },
						items,
						nextCursor: cursor(source.key, i),
						consistency: "live" as const,
					});
				const locale = locales[i];
				if (!locale) continue;
				const current = await readManagedTarget(ctx, {
					projectId: token.projectId,
					collectionId: args.collectionId,
					messageId: source.key,
					localeId: locale._id,
				});
				scans++;
				readBytes += encodedSize(current);
				const fields = {
					key: source.key,
					source: source.sourceValue,
					target: current.value,
				};
				const matchedFields = findMatchedFields(options, fields);
				if (
					matchedFields.length === 0 ||
					(args.quality === "confirmed" && current.valueState !== "settled")
				)
					continue;
				const item = searchEntry(current, matchedFields);
				if (
					encodedSize([...items, item]) >
					MAX_RESPONSE_BYTES - SEARCH_RESPONSE_OVERHEAD_BYTES
				) {
					if (items.length === 0)
						fail(
							"LIMIT_EXCEEDED",
							"One search result exceeds 1 MiB; use collection context for a smaller request.",
						);
					return boundedResponse({
						collection: { id: collection._id, name: collection.name },
						items,
						nextCursor: cursor(source.key, i),
						consistency: "live" as const,
					});
				}
				items.push(item);
			}
		}
		return boundedResponse({
			collection: { id: collection._id, name: collection.name },
			items,
			nextCursor: null,
			consistency: "live" as const,
		});
	},
});
export const download = internalQuery({
	args: {
		...address,
		keys: v.array(v.string()),
		locales: v.array(v.string()),
		mode: v.union(
			v.literal("reviewed"),
			v.literal("partial"),
			v.literal("draft"),
		),
	},
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		await requireManagedCollection(ctx, token.projectId, args.collectionId);
		const locales = await resolveLocales(
			ctx,
			token.projectId,
			args.collectionId,
			args.locales,
			1000,
		);
		return exportManagedSelection(ctx, {
			projectId: token.projectId,
			collectionId: args.collectionId,
			messageIds: args.keys,
			localeIds: locales.map((l) => l._id),
			mode: args.mode,
		});
	},
});
