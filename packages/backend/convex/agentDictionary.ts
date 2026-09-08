import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import { encodedSize } from "./catalogWorkspaceView";
import { guidanceState, projectDictionaryConnection } from "./dictionaryAccess";
import { sha256Hex } from "./lib";
import {
	guidanceSaveResultValidator,
	removeDictionaryTerm,
	saveDictionaryTerm,
} from "./translationGuidance";
import {
	dictionaryTermEvidenceFields,
	dictionaryTermValidator,
} from "./translationGuidanceModel";

const MAX_BATCH_TERMS = 32;
const MAX_PAGE_TERMS = 50;
const MAX_SCAN_TERMS = 64;
const MAX_BYTES = 256 * 1024;
const entryValidator = v.object(dictionaryTermEvidenceFields);

function validation(message: string): never {
	throw new ConvexError({ code: "VALIDATION", message });
}

/** An indexed Dictionary read returns complete entries for deliberate edits.
 * Its revision also protects a subsequent batch write from concurrent changes. */
export const list = internalQuery({
	args: {
		token: v.string(),
		q: v.optional(v.string()),
		sourceTerm: v.optional(v.string()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	returns: v.object({
		revision: v.number(),
		dictionaryId: v.optional(v.id("dictionaries")),
		connectionRevision: v.optional(v.number()),
		agentWriteEnabled: v.optional(v.boolean()),
		terms: v.array(entryValidator),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		const limit = args.limit ?? 16;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_TERMS)
			validation("Dictionary pages contain 1–50 terms.");
		if (encodedSize([args.q ?? "", args.sourceTerm ?? ""]) > 2048)
			validation("Dictionary search text exceeds 2 KiB.");
		const q = (args.q ?? "").trim().toLowerCase();
		const connection = await projectDictionaryConnection(ctx, token.projectId);
		const dictionaryId = connection?.dictionaryId ?? undefined;
		const connectionRevision = connection?.revision;
		const state = await guidanceState(
			ctx,
			dictionaryId ? { dictionaryId } : { projectId: token.projectId },
		);
		const revision = state?.revision ?? 0;
		const basis = await sha256Hex(
			JSON.stringify({
				projectId: token.projectId,
				dictionaryId,
				connectionRevision,
				revision,
				q,
				sourceTerm: args.sourceTerm,
			}),
		);
		let after: string | null = null;
		if (args.cursor !== undefined) {
			let cursor: unknown;
			try {
				if (args.cursor.length > 4096) validation("Invalid Dictionary cursor.");
				cursor = JSON.parse(args.cursor);
			} catch {
				validation("Invalid Dictionary cursor.");
			}
			if (
				!cursor ||
				typeof cursor !== "object" ||
				!("version" in cursor) ||
				cursor.version !== 1 ||
				!("basis" in cursor) ||
				typeof cursor.basis !== "string" ||
				!("after" in cursor) ||
				typeof cursor.after !== "string" ||
				!cursor.after.startsWith("term:")
			)
				validation("Invalid Dictionary cursor.");
			if (cursor.basis !== basis)
				throw new ConvexError({
					code: "STALE_BASIS",
					message:
						"Guidance or Dictionary search changed; restart from the first page.",
				});
			after = cursor.after;
		}
		const localRows = ctx.db
			.query("translationGuidanceEntries")
			.withIndex("by_project_and_key", (query) => {
				const scoped = query.eq("projectId", token.projectId);
				if (args.sourceTerm !== undefined)
					return scoped.eq("key", `term:${args.sourceTerm}`);
				return after === null
					? scoped.gte("key", "term:").lt("key", "term;")
					: scoped.gt("key", after).lt("key", "term;");
			});
		const sharedRows = ctx.db
			.query("translationGuidanceEntries")
			.withIndex("by_dictionary_and_key", (query) => {
				const scoped = query.eq("dictionaryId", dictionaryId);
				if (args.sourceTerm !== undefined)
					return scoped.eq("key", `term:${args.sourceTerm}`);
				return after === null
					? scoped.gte("key", "term:").lt("key", "term;")
					: scoped.gt("key", after).lt("key", "term;");
			});
		const rows = dictionaryId ? sharedRows : localRows;
		const terms = [];
		let bytes = 4096;
		let scanned = 0;
		let lastScanned = after;
		let hasMore = false;
		for await (const entry of rows) {
			if (entry.content.kind !== "term") continue;
			const { term } = entry.content;
			const matches =
				!q ||
				[
					term.sourceTerm,
					term.definition,
					...(term.kind === "translated"
						? term.renderings.map((item) => item.value)
						: []),
				].some((value) => value.toLowerCase().includes(q));
			if (matches) {
				const item = {
					term,
					revisionId: entry.revisionId,
					revision: entry.revision,
					authoredBy: entry.authoredBy,
					authoredAt: entry.authoredAt,
				};
				const size = encodedSize(item);
				if (bytes + size > MAX_BYTES) {
					hasMore = true;
					break;
				}
				terms.push(item);
				bytes += size;
			}
			lastScanned = entry.key;
			if (args.sourceTerm !== undefined) break;
			if (++scanned >= MAX_SCAN_TERMS || terms.length >= limit) {
				hasMore = true;
				break;
			}
		}
		return {
			revision,
			dictionaryId,
			connectionRevision,
			agentWriteEnabled: dictionaryId
				? connection?.agentWriteEnabled
				: undefined,
			terms,
			nextCursor: hasMore
				? JSON.stringify({ version: 1, basis, after: lastScanned })
				: null,
		};
	},
});

/** One authenticated transaction for the entire batch. Each changed entry gets
 * its own immutable citation; any validation failure rolls back every change. */
export const save = internalMutation({
	args: {
		token: v.string(),
		expectedRevision: v.number(),
		expectedDictionaryId: v.optional(v.id("dictionaries")),
		expectedConnectionRevision: v.optional(v.number()),
		terms: v.array(dictionaryTermValidator),
	},
	returns: v.object({
		revision: v.number(),
		entries: v.array(
			v.object({
				sourceTerm: v.string(),
				revisionId: v.union(v.id("translationGuidanceRevisions"), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "dictionary-write");
		if (
			args.terms.length < 1 ||
			args.terms.length > MAX_BATCH_TERMS ||
			encodedSize(args.terms) > MAX_BYTES
		)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Dictionary writes contain 1–32 terms and at most 256 KiB.",
			});
		if (
			new Set(args.terms.map((term) => term.sourceTerm.trim())).size !==
			args.terms.length
		)
			validation("Each Dictionary term may appear only once in a batch.");
		let revision = args.expectedRevision;
		const entries = [];
		for (const term of args.terms) {
			const saved = await saveDictionaryTerm(ctx, {
				projectId: token.projectId,
				expectedDictionaryId: args.expectedDictionaryId,
				expectedConnectionRevision: args.expectedConnectionRevision,
				expectedRevision: revision,
				term,
				authoredBy: { kind: "agent", id: token._id },
			});
			revision = saved.revision;
			entries.push({
				sourceTerm: term.sourceTerm.trim(),
				revisionId: saved.revisionId,
			});
		}
		return { revision, entries };
	},
});

export const remove = internalMutation({
	args: {
		token: v.string(),
		expectedRevision: v.number(),
		expectedDictionaryId: v.optional(v.id("dictionaries")),
		expectedConnectionRevision: v.optional(v.number()),
		sourceTerm: v.string(),
	},
	returns: guidanceSaveResultValidator,
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "dictionary-write");
		return await removeDictionaryTerm(ctx, {
			projectId: token.projectId,
			expectedDictionaryId: args.expectedDictionaryId,
			expectedConnectionRevision: args.expectedConnectionRevision,
			expectedRevision: args.expectedRevision,
			sourceTerm: args.sourceTerm,
			authoredBy: { kind: "agent", id: token._id },
		});
	},
});
