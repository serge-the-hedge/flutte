import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	type AgentReviewAuthorization,
	isHumanOrAuthorizedReview,
} from "./agentReviewModel";
import {
	assertCharacterLimit,
	validateCharacterLimit,
} from "./characterLimits";
import { requireManagedCollection } from "./contentCollections";
import {
	MAX_MANAGED_CONTEXT_LOCALES,
	MAX_MANAGED_CONTEXT_PAIRS,
	MAX_MANAGED_RESPONSE_BYTES,
	MAX_MANAGED_VALUE_BYTES,
	type ManagedBasis,
	type ManagedIntent,
	managedBasisValidator,
	managedIntentValidator,
} from "./contentModel";
import { type Actor, sha256Hex } from "./lib";
import {
	assertMessageCharacterLimit,
	readCharacterLimit,
	writeCharacterLimit,
} from "./messageConstraints";
import { requireEditor, requireViewer } from "./permissions";

type ReadCtx = QueryCtx | MutationCtx;
type CollectionAddress = {
	projectId: Id<"projects">;
	collectionId: Id<"contentCollections">;
};
type TargetAddress = CollectionAddress & {
	messageId: string;
	localeId: Id<"locales">;
};
const addressFields = {
	projectId: v.id("projects"),
	collectionId: v.id("contentCollections"),
};
const targetFields = {
	...addressFields,
	messageId: v.string(),
	localeId: v.id("locales"),
};
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
function fail(code: string, message: string): never {
	throw new ConvexError({ code, message });
}
function assertText(sourceValue: string, context?: string) {
	if (
		new TextEncoder().encode(sourceValue).byteLength > MAX_MANAGED_VALUE_BYTES
	)
		fail("LIMIT_EXCEEDED", "One managed value exceeds 256 KiB.");
	if (
		context !== undefined &&
		new TextEncoder().encode(context).byteLength > 8192
	)
		fail("LIMIT_EXCEEDED", "Context exceeds 8 KiB.");
}
async function sourceFor(
	ctx: ReadCtx,
	input: CollectionAddress & { messageId: string },
) {
	const source = await ctx.db
		.query("managedMessages")
		.withIndex("by_collection_key", (q) =>
			q.eq("collectionId", input.collectionId).eq("key", input.messageId),
		)
		.unique();
	if (
		!source ||
		source.projectId !== input.projectId ||
		source.archivedAt !== undefined
	)
		fail("NOT_FOUND", "Managed string is not active.");
	return source;
}
async function targetMembership(
	ctx: ReadCtx,
	input: CollectionAddress & { localeId: Id<"locales"> },
) {
	const [locale, membership] = await Promise.all([
		ctx.db.get(input.localeId),
		ctx.db
			.query("contentCollectionLocales")
			.withIndex("by_collection_locale", (q) =>
				q.eq("collectionId", input.collectionId).eq("localeId", input.localeId),
			)
			.unique(),
	]);
	if (
		!locale ||
		locale.projectId !== input.projectId ||
		locale.isSource ||
		locale.archivedAt !== undefined ||
		!membership?.active
	)
		fail("NOT_FOUND", "Target language is not enabled in this collection.");
	return locale;
}
/** Read current managed content without importing repository evidence. Caller owns authentication. */
export async function readManagedTarget(ctx: ReadCtx, input: TargetAddress) {
	const [collection, source, locale, target] = await Promise.all([
		requireManagedCollection(ctx, input.projectId, input.collectionId),
		sourceFor(ctx, input),
		targetMembership(ctx, input),
		ctx.db
			.query("managedTargets")
			.withIndex("by_value", (q) =>
				q
					.eq("collectionId", input.collectionId)
					.eq("messageId", input.messageId)
					.eq("localeId", input.localeId),
			)
			.unique(),
	]);
	const value = target?.value ?? "";
	const intentionalBlank = target?.intentionalBlankReason ?? null;
	const sourceFingerprint = source.sourceFingerprint;
	const basis: ManagedBasis = {
		kind: "managed",
		collectionId: input.collectionId,
		sourceRevision: source.sourceRevision,
		targetRevision: target?.revision ?? 0,
		sourceFingerprint,
		membershipRevision: collection.membershipRevision,
	};
	const valueState =
		value.length === 0 && !intentionalBlank
			? ("waiting" as const)
			: target?.sourceFingerprint !== sourceFingerprint
				? ("stale" as const)
				: ("settled" as const);
	return {
		collection,
		source,
		characterLimit: await readCharacterLimit(ctx, input),
		target,
		locale,
		value,
		valueFingerprint: await sha256Hex(value),
		workspaceRevision: basis.targetRevision,
		sourceFingerprint,
		basis,
		valueState,
		intentionalBlank,
	};
}
/** Human saves and independently reviewed candidates cross this same compare-and-save seam. */
export async function commitManagedTarget(
	ctx: MutationCtx,
	input: TargetAddress & {
		basis: ManagedBasis;
		intent: ManagedIntent;
		actor: Actor;
		reviewAuthorization?: AgentReviewAuthorization;
	},
) {
	if (!isHumanOrAuthorizedReview(input.actor, input.reviewAuthorization))
		fail(
			"FORBIDDEN",
			"Managed target application requires a human or authorized independent reviewer.",
		);
	const current = await readManagedTarget(ctx, input);
	const expected = input.basis;
	if (
		expected.kind !== "managed" ||
		expected.collectionId !== input.collectionId ||
		expected.sourceRevision !== current.basis.sourceRevision ||
		expected.targetRevision !== current.basis.targetRevision ||
		expected.sourceFingerprint !== current.sourceFingerprint ||
		expected.membershipRevision !== current.basis.membershipRevision
	)
		fail(
			"CONFLICT",
			"Managed content changed. Reload before saving or reviewing.",
		);
	return writeManagedTarget(ctx, input, current);
}

/** Persist a validated human/reviewer decision; creation supplies its fresh basis directly. */
async function writeManagedTarget(
	ctx: MutationCtx,
	input: TargetAddress & {
		intent: ManagedIntent;
		actor: Actor;
		reviewAuthorization?: AgentReviewAuthorization;
	},
	current: Pick<
		Awaited<ReturnType<typeof readManagedTarget>>,
		"target" | "value" | "workspaceRevision" | "sourceFingerprint" | "basis"
	>,
) {
	const value =
		input.intent.kind === "save"
			? input.intent.value
			: input.intent.kind === "intentionalBlank"
				? ""
				: current.value;
	let intentionalBlankReason =
		input.intent.kind === "intentionalBlank"
			? input.intent.reason.trim()
			: input.intent.kind === "confirm"
				? current.target?.intentionalBlankReason
				: undefined;
	assertText(value);
	await assertMessageCharacterLimit(ctx, input, value);
	if (
		input.intent.kind === "intentionalBlank" &&
		(!intentionalBlankReason ||
			new TextEncoder().encode(intentionalBlankReason).byteLength > 4096)
	)
		fail("VALIDATION", "An intentional blank needs a reason of at most 4 KiB.");
	if (value.length === 0 && !intentionalBlankReason)
		fail("VALIDATION", "An empty target needs an intentional blank reason.");
	if (value.length > 0) intentionalBlankReason = undefined;
	const revision = current.workspaceRevision + 1;
	const timestamp = Date.now();
	const fields = {
		projectId: input.projectId,
		collectionId: input.collectionId,
		messageId: input.messageId,
		localeId: input.localeId,
		value,
		sourceFingerprint: current.sourceFingerprint,
		revision,
		intentionalBlankReason,
		actor: input.actor,
		reviewAuthorization: input.reviewAuthorization,
	};
	if (current.target)
		await ctx.db.replace(current.target._id, {
			...fields,
			updatedAt: timestamp,
		});
	else
		await ctx.db.insert("managedTargets", { ...fields, updatedAt: timestamp });
	await ctx.db.insert("managedTargetRevisions", {
		...fields,
		createdAt: timestamp,
	});
	return {
		workspaceRevision: revision,
		sourceFingerprint: current.sourceFingerprint,
		basis: { ...current.basis, targetRevision: revision },
	};
}
/** Missing names belong to older key-based clients; explicit null is unnamed. */
export function managedMessageName(source: {
	key: string;
	name?: string | null;
}): string | null {
	return source.name === undefined ? source.key : source.name;
}
function normalizedName(name: string | null): string | null {
	if (name === null) return null;
	if (
		Array.from(name).some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || (code >= 127 && code <= 159);
		})
	)
		fail("VALIDATION", "String names cannot contain control characters.");
	const trimmed = name.trim();
	if (Array.from(trimmed).length > 256)
		fail("VALIDATION", "String names support at most 256 characters.");
	return trimmed || null;
}
async function sourceEntry(
	ctx: ReadCtx,
	source: Awaited<ReturnType<typeof sourceFor>>,
) {
	return {
		characterLimit: await readCharacterLimit(ctx, {
			projectId: source.projectId,
			collectionId: source.collectionId,
			messageId: source.key,
		}),
		messageId: source.key,
		key: source.key,
		name: managedMessageName(source),
		sourceValue: source.sourceValue,
		context: source.context,
		sourceRevision: source.sourceRevision,
		sourceFingerprint: source.sourceFingerprint,
	};
}
function contextEntry(current: Awaited<ReturnType<typeof readManagedTarget>>) {
	return {
		characterLimit: current.characterLimit,
		messageId: current.source.key,
		name: managedMessageName(current.source),
		localeId: current.locale._id,
		localeCode: current.locale.code,
		sourceValue: current.source.sourceValue,
		context: current.source.context,
		value: current.value,
		valueFingerprint: current.valueFingerprint,
		valueState: current.valueState,
		intentionalBlank: current.intentionalBlank,
		basis: current.basis,
	};
}
function parseCursor(
	cursor: string | undefined,
	collectionId: Id<"contentCollections">,
	q: string,
) {
	if (cursor === undefined) return null;
	if (cursor.length > 8192)
		fail("VALIDATION", "Invalid browse cursor. Restart from the first page.");
	try {
		const parsed: unknown = JSON.parse(cursor);
		// Old key-sorted page links restart when switching to creation order.
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"collectionId" in parsed &&
			parsed.collectionId === collectionId &&
			"q" in parsed &&
			parsed.q === q &&
			!("version" in parsed) &&
			"key" in parsed &&
			typeof parsed.key === "string" &&
			parsed.key.length <= 256
		)
			return null;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"collectionId" in parsed &&
			"q" in parsed &&
			"version" in parsed &&
			parsed.version === 2 &&
			"cursor" in parsed &&
			parsed.collectionId === collectionId &&
			parsed.q === q &&
			typeof parsed.cursor === "string" &&
			parsed.cursor.length > 0
		)
			return parsed.cursor;
	} catch {}
	fail(
		"VALIDATION",
		"This cursor does not belong to the collection and search. Restart from the first page.",
	);
}
/** Creation-ordered browse with one native pagination call. Whole pages are consumed,
 * including filtered rows; oversized pages are retried by the client with a lower limit. */
export async function readManagedPage(
	ctx: ReadCtx,
	input: CollectionAddress & {
		cursor?: string;
		q?: string;
		limit?: number;
		focusKey?: string;
	},
) {
	await requireManagedCollection(ctx, input.projectId, input.collectionId);
	const q = (input.q ?? "").trim().toLowerCase();
	const limit = input.limit ?? 16;
	if (
		q.length > 2048 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 50
	)
		fail("VALIDATION", "Invalid page search or limit.");
	const focusKey = input.focusKey;
	if (focusKey !== undefined) {
		if (input.cursor !== undefined || focusKey.length > 256)
			fail(
				"VALIDATION",
				"A focused key cannot be combined with a page cursor.",
			);
		const source = await ctx.db
			.query("managedMessages")
			.withIndex("by_collection_key", (index) =>
				index.eq("collectionId", input.collectionId).eq("key", focusKey),
			)
			.unique();
		const items =
			source && source.archivedAt === undefined
				? [await sourceEntry(ctx, source)]
				: [];
		const result = { items, nextCursor: null };
		if (bytes(result) > MAX_MANAGED_RESPONSE_BYTES)
			fail(
				"LIMIT_EXCEEDED",
				"This source string exceeds the 1 MiB encoded browse limit. Shorten its text or context before browsing it.",
			);
		return result;
	}
	const cursor = parseCursor(input.cursor, input.collectionId, q);
	const page = await ctx.db
		.query("managedMessages")
		.withIndex("by_collection", (index) =>
			index.eq("collectionId", input.collectionId),
		)
		.order("asc")
		.paginate({ cursor, numItems: limit, maximumRowsRead: 16 });
	const items = await Promise.all(
		page.page
			.filter(
				(row) =>
					row.archivedAt === undefined &&
					(q.length === 0 ||
						row.key.toLowerCase().includes(q) ||
						(managedMessageName(row)?.toLowerCase().includes(q) ?? false) ||
						row.sourceValue.toLowerCase().includes(q)),
			)
			.map((source) => sourceEntry(ctx, source)),
	);
	const result = {
		items,
		nextCursor: page.isDone
			? null
			: JSON.stringify({
					version: 2,
					collectionId: input.collectionId,
					q,
					cursor: page.continueCursor,
				}),
	};
	if (bytes(result) > MAX_MANAGED_RESPONSE_BYTES)
		fail(
			"LIMIT_EXCEEDED",
			"This page exceeds the 1 MiB encoded browse limit. Request fewer strings; if one string still exceeds it, shorten its text or context.",
		);
	return result;
}

async function readContextPairs(
	ctx: ReadCtx,
	input: CollectionAddress & {
		messageIds: string[];
		localeIds: Id<"locales">[];
	},
	limits: { keys: number; locales: number; pairs: number },
) {
	await requireManagedCollection(ctx, input.projectId, input.collectionId);
	if (
		input.messageIds.length > limits.keys ||
		input.localeIds.length > limits.locales ||
		input.messageIds.length * input.localeIds.length > limits.pairs ||
		new Set(input.messageIds).size !== input.messageIds.length ||
		new Set(input.localeIds).size !== input.localeIds.length
	)
		fail(
			"LIMIT_EXCEEDED",
			`This read supports ${limits.keys} keys, ${limits.locales} languages and ${limits.pairs} pairs without duplicates.`,
		);
	const items: ReturnType<typeof contextEntry>[] = [];
	for (const messageId of input.messageIds)
		for (const localeId of input.localeIds) {
			items.push(
				contextEntry(
					await readManagedTarget(ctx, { ...input, messageId, localeId }),
				),
			);
			if (bytes(items) > MAX_MANAGED_RESPONSE_BYTES)
				fail("LIMIT_EXCEEDED", "Context exceeds 1 MiB. Request fewer pairs.");
		}
	return { items };
}
export async function readManagedContext(
	ctx: ReadCtx,
	input: CollectionAddress & {
		messageIds: string[];
		localeIds: Id<"locales">[];
	},
) {
	return readContextPairs(ctx, input, {
		keys: 50,
		locales: MAX_MANAGED_CONTEXT_LOCALES,
		pairs: MAX_MANAGED_CONTEXT_PAIRS,
	});
}
/** A query observes one consistent database version. Export never asserts external publication. */
export async function exportManagedSelection(
	ctx: ReadCtx,
	input: CollectionAddress & {
		messageIds: string[];
		localeIds: Id<"locales">[];
		mode: "reviewed" | "partial" | "draft";
	},
) {
	if (input.messageIds.length === 0 || input.localeIds.length === 0)
		fail("VALIDATION", "Select at least one string and language.");
	const { items } = await readContextPairs(ctx, input, {
		keys: 128,
		locales: 1000,
		pairs: 1024,
	});
	const omitted: {
		messageId: string;
		localeId: Id<"locales">;
		reason: string;
	}[] = [];
	const values: Record<string, Record<string, string>> = Object.create(null);
	const evidence: {
		messageId: string;
		localeId: Id<"locales">;
		basis: ManagedBasis;
	}[] = [];
	for (const item of items) {
		if (item.valueState !== "settled" && input.mode !== "draft") {
			omitted.push({
				messageId: item.messageId,
				localeId: item.localeId,
				reason: item.valueState,
			});
			continue;
		}
		const localized: Record<string, string> =
			values[item.messageId] ?? Object.create(null);
		values[item.messageId] = localized;
		localized[item.localeCode] = item.value;
		evidence.push({
			messageId: item.messageId,
			localeId: item.localeId,
			basis: item.basis,
		});
	}
	if (input.mode === "reviewed" && omitted.length > 0)
		fail(
			"NEEDS_REVIEW",
			"Selected strings include missing or stale translations. Review them, or explicitly choose partial or draft output.",
		);
	const names: Record<string, string | null> = Object.create(null);
	for (const item of items) names[item.messageId] = item.name;
	const text = JSON.stringify(
		{
			names,
			collectionId: input.collectionId,
			mode: input.mode,
			values,
			omitted,
			evidence,
		},
		null,
		2,
	);
	if (new TextEncoder().encode(text).byteLength > MAX_MANAGED_RESPONSE_BYTES)
		fail("LIMIT_EXCEEDED", "Download exceeds 1 MiB. Select fewer values.");
	return { text, omitted, mode: input.mode };
}
export const page = query({
	args: {
		...addressFields,
		cursor: v.optional(v.string()),
		q: v.optional(v.string()),
		limit: v.optional(v.number()),
		focusKey: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return readManagedPage(ctx, args);
	},
});
export const context = query({
	args: {
		...addressFields,
		messageIds: v.array(v.string()),
		localeIds: v.array(v.id("locales")),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return readManagedContext(ctx, args);
	},
});
export const exportSelection = query({
	args: {
		...addressFields,
		messageIds: v.array(v.string()),
		localeIds: v.array(v.id("locales")),
		mode: v.union(
			v.literal("reviewed"),
			v.literal("partial"),
			v.literal("draft"),
		),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return exportManagedSelection(ctx, args);
	},
});
export const commit = mutation({
	args: {
		...targetFields,
		basis: managedBasisValidator,
		intent: managedIntentValidator,
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		return commitManagedTarget(ctx, {
			...args,
			actor: { kind: "user", id: userId },
		});
	},
});
export const createMessage = mutation({
	args: {
		characterLimit: v.optional(v.number()),
		...addressFields,
		key: v.optional(v.string()),
		name: v.optional(v.union(v.string(), v.null())),
		sourceValue: v.string(),
		context: v.optional(v.string()),
		translations: v.optional(
			v.array(v.object({ localeId: v.id("locales"), value: v.string() })),
		),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const collection = await requireManagedCollection(
			ctx,
			args.projectId,
			args.collectionId,
		);
		const { translations = [], characterLimit, ...sourceInput } = args;
		validateCharacterLimit(characterLimit);
		assertCharacterLimit(args.sourceValue, characterLimit);
		for (const translation of translations)
			assertCharacterLimit(translation.value, characterLimit);
		if (
			translations.length > 128 ||
			bytes(translations) > MAX_MANAGED_RESPONSE_BYTES
		)
			fail(
				"LIMIT_EXCEEDED",
				"Add at most 128 translations within 1 MiB with a new string.",
			);
		if (
			new Set(translations.map((translation) => translation.localeId)).size !==
			translations.length
		)
			fail("VALIDATION", "Choose each translation language once.");
		for (const translation of translations) {
			assertText(translation.value);
			if (translation.value.length === 0)
				fail(
					"VALIDATION",
					"Leave empty translation fields out of the new string.",
				);
			await targetMembership(ctx, {
				projectId: args.projectId,
				collectionId: args.collectionId,
				localeId: translation.localeId,
			});
		}
		assertText(args.sourceValue, args.context);
		if (
			args.key !== undefined &&
			(args.key.length === 0 ||
				args.key.length > 256 ||
				args.key !== args.key.trim() ||
				Array.from(args.key).some((character) => character.charCodeAt(0) < 32))
		)
			fail(
				"VALIDATION",
				"Choose a stable key of 1–256 characters without surrounding whitespace or control characters.",
			);
		const providedKey = args.key;
		const existing =
			providedKey === undefined
				? null
				: await ctx.db
						.query("managedMessages")
						.withIndex("by_collection_key", (q) =>
							q.eq("collectionId", args.collectionId).eq("key", providedKey),
						)
						.unique();
		if (existing)
			fail(
				"CONFLICT",
				"This key already exists, including archived history. Choose a new key.",
			);
		const name =
			args.name === undefined
				? args.key === undefined
					? null
					: undefined
				: normalizedName(args.name);
		const timestamp = Date.now();
		const sourceFingerprint = await sha256Hex(args.sourceValue);
		const sourceRevision = 1;
		const id = await ctx.db.insert("managedMessages", {
			...sourceInput,
			key: args.key ?? "",
			name,
			sourceRevision,
			sourceFingerprint,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const key = args.key ?? String(id);
		if (characterLimit !== undefined)
			await writeCharacterLimit(
				ctx,
				{
					projectId: args.projectId,
					collectionId: args.collectionId,
					messageId: key,
				},
				characterLimit,
				null,
			);
		// The generated key becomes visible with its row in the same transaction.
		if (args.key === undefined) await ctx.db.patch(id, { key });
		await ctx.db.insert("managedSourceRevisions", {
			projectId: args.projectId,
			collectionId: args.collectionId,
			messageId: key,
			name: name === undefined ? key : name,
			sourceValue: args.sourceValue,
			context: args.context,
			sourceRevision,
			sourceFingerprint,
			actor: { kind: "user", id: userId },
			createdAt: timestamp,
		});
		for (const translation of translations) {
			await writeManagedTarget(
				ctx,
				{
					projectId: args.projectId,
					collectionId: args.collectionId,
					messageId: key,
					localeId: translation.localeId,
					intent: { kind: "save", value: translation.value },
					actor: { kind: "user", id: userId },
				},
				{
					target: null,
					value: "",
					workspaceRevision: 0,
					sourceFingerprint,
					basis: {
						kind: "managed",
						collectionId: args.collectionId,
						sourceRevision,
						targetRevision: 0,
						sourceFingerprint,
						membershipRevision: collection.membershipRevision,
					},
				},
			);
		}
		return key;
	},
});
export const saveSource = mutation({
	args: {
		characterLimit: v.optional(v.union(v.number(), v.null())),
		expectedCharacterLimit: v.optional(v.union(v.number(), v.null())),
		...addressFields,
		messageId: v.string(),
		sourceValue: v.string(),
		name: v.optional(v.union(v.string(), v.null())),
		context: v.optional(v.string()),
		expectedSourceRevision: v.number(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		await requireManagedCollection(ctx, args.projectId, args.collectionId);
		const source = await sourceFor(ctx, args);
		if (source.sourceRevision !== args.expectedSourceRevision)
			fail("CONFLICT", "Source changed. Reload before saving.");
		if (args.characterLimit !== undefined) {
			if (args.expectedCharacterLimit === undefined)
				fail("VALIDATION", "Expected character limit is required.");
			await writeCharacterLimit(
				ctx,
				{
					projectId: args.projectId,
					collectionId: args.collectionId,
					messageId: args.messageId,
				},
				args.characterLimit,
				args.expectedCharacterLimit,
			);
		}
		assertText(args.sourceValue, args.context);
		const context = args.context ?? source.context;
		const name =
			args.name === undefined
				? managedMessageName(source)
				: normalizedName(args.name);
		if (
			args.characterLimit !== undefined &&
			args.sourceValue === source.sourceValue &&
			name === managedMessageName(source) &&
			context === source.context
		)
			return null;
		if (args.sourceValue !== source.sourceValue)
			await assertMessageCharacterLimit(ctx, args, args.sourceValue);
		const sourceRevision = source.sourceRevision + 1;
		const sourceFingerprint = await sha256Hex(args.sourceValue);
		const timestamp = Date.now();
		await ctx.db.patch(source._id, {
			sourceValue: args.sourceValue,
			name,
			context,
			sourceRevision,
			sourceFingerprint,
			updatedAt: timestamp,
		});
		await ctx.db.insert("managedSourceRevisions", {
			projectId: args.projectId,
			collectionId: args.collectionId,
			messageId: args.messageId,
			sourceValue: args.sourceValue,
			name,
			context,
			sourceRevision,
			sourceFingerprint,
			actor: { kind: "user", id: userId },
			createdAt: timestamp,
		});
		return { sourceRevision, sourceFingerprint };
	},
});
export const archiveMessage = mutation({
	args: {
		...addressFields,
		messageId: v.string(),
		expectedSourceRevision: v.number(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		await requireManagedCollection(ctx, args.projectId, args.collectionId);
		const source = await sourceFor(ctx, args);
		if (source.sourceRevision !== args.expectedSourceRevision)
			fail("CONFLICT", "Source changed. Reload before archiving.");
		const archivedAt = Date.now();
		const sourceRevision = source.sourceRevision + 1;
		await ctx.db.patch(source._id, {
			archivedAt,
			sourceRevision,
			updatedAt: archivedAt,
		});
		await ctx.db.insert("managedSourceRevisions", {
			projectId: args.projectId,
			collectionId: args.collectionId,
			messageId: args.messageId,
			sourceValue: source.sourceValue,
			name: managedMessageName(source),
			context: source.context,
			sourceRevision,
			sourceFingerprint: source.sourceFingerprint,
			actor: { kind: "user", id: userId },
			createdAt: archivedAt,
			archivedAt,
		});
		return null;
	},
});
