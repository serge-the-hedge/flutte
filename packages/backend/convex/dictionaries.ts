import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { getAnyUserByEmail, getAnyUserById, requireUser } from "./auth";
import { encodedSize } from "./catalogWorkspaceView";
import {
	dictionaryAccess,
	dictionaryError,
	guidanceEntries,
	guidanceState,
	projectDictionaryConnection,
	requireDictionaryEdit,
	requireDictionaryRead,
} from "./dictionaryAccess";
import { requireOwner, requireViewer } from "./permissions";
import {
	localGuidance,
	removeDictionaryTerm,
	saveDictionaryTerm,
	writeEntry,
} from "./translationGuidance";
import { dictionaryTermValidator } from "./translationGuidanceModel";

const MAX_CONNECTIONS = 128;
function nameValue(name: string) {
	const value = name.trim();
	if (!value || encodedSize(value) > 256)
		dictionaryError("VALIDATION", "Dictionary name must contain 1–256 bytes.");
	return value;
}
function dictionarySummary(dictionary: Doc<"dictionaries">) {
	return {
		_id: dictionary._id,
		_creationTime: dictionary._creationTime,
		name: dictionary.name,
		ownerUserId: dictionary.ownerUserId,
	};
}
export const list = query({
	args: {},
	handler: async (ctx) => {
		const user = await requireUser(ctx);
		const owned = await ctx.db
			.query("dictionaries")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", user.id))
			.take(129);
		const editors = await ctx.db
			.query("dictionaryEditors")
			.withIndex("by_user", (q) => q.eq("userId", user.id))
			.take(129);
		if (owned.length + editors.length > 128)
			dictionaryError("LIMIT_EXCEEDED", "Dictionary list exceeds 128 entries.");
		const result = owned.map((d) => ({
			...dictionarySummary(d),
			canEdit: true,
			isOwner: true,
		}));
		for (const e of editors) {
			const d = await ctx.db.get(e.dictionaryId);
			if (d && !result.some((row) => row._id === d._id))
				result.push({ ...dictionarySummary(d), canEdit: true, isOwner: false });
		}
		const memberships = await ctx.db
			.query("projectMembers")
			.withIndex("by_user", (q) => q.eq("userId", user.id))
			.take(129);
		if (memberships.length > 128)
			dictionaryError(
				"LIMIT_EXCEEDED",
				"Dictionary discovery supports at most 128 project memberships.",
			);
		for (const membership of memberships) {
			const project = await ctx.db.get(membership.projectId);
			if (!project || project.archivedAt !== undefined) continue;
			const link = await projectDictionaryConnection(ctx, membership.projectId);
			if (
				!link?.dictionaryId ||
				result.some((d) => d._id === link.dictionaryId)
			)
				continue;
			const d = await ctx.db.get(link.dictionaryId);
			if (d) {
				if (result.length >= 128)
					dictionaryError(
						"LIMIT_EXCEEDED",
						"Dictionary list exceeds 128 entries.",
					);
				result.push({
					...dictionarySummary(d),
					canEdit: false,
					isOwner: false,
				});
			}
		}
		return result;
	},
});
export const create = mutation({
	args: { name: v.string() },
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		const existing = await ctx.db
			.query("dictionaries")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", user.id))
			.take(128);
		if (existing.length >= 128)
			dictionaryError(
				"LIMIT_EXCEEDED",
				"An owner supports at most 128 Dictionaries.",
			);
		return await ctx.db.insert("dictionaries", {
			name: nameValue(args.name),
			ownerUserId: user.id,
		});
	},
});
export const detail = query({
	args: { dictionaryId: v.id("dictionaries") },
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		const access = await requireDictionaryRead(ctx, args.dictionaryId, user.id);
		const current = await localGuidance(ctx, undefined, args.dictionaryId);
		const editors = [];
		const connections = [];
		if (access.canEdit) {
			for (const entry of await ctx.db
				.query("dictionaryEditors")
				.withIndex("by_dictionary_user", (q) =>
					q.eq("dictionaryId", args.dictionaryId),
				)
				.take(128)) {
				const account = await getAnyUserById(ctx, entry.userId);
				editors.push({
					userId: entry.userId,
					name: account?.name ?? null,
					email: account?.email ?? null,
				});
			}
			for (const entry of await ctx.db
				.query("projectDictionaryConnections")
				.withIndex("by_dictionary", (q) =>
					q.eq("dictionaryId", args.dictionaryId),
				)
				.take(MAX_CONNECTIONS)) {
				const project = await ctx.db.get(entry.projectId);
				if (project)
					connections.push({
						projectId: entry.projectId,
						projectName: project.name,
						agentWriteEnabled: entry.agentWriteEnabled,
						revision: entry.revision,
					});
			}
		}
		return {
			...access,
			dictionary: dictionarySummary(access.dictionary),
			revision: current.revision,
			terms: current.terms,
			editors,
			connections,
		};
	},
});
export const saveTerm = mutation({
	args: {
		dictionaryId: v.id("dictionaries"),
		expectedRevision: v.number(),
		term: dictionaryTermValidator,
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		return await saveDictionaryTerm(ctx, {
			...args,
			authoredBy: { kind: "user", id: user.id },
		});
	},
});
export const removeTerm = mutation({
	args: {
		dictionaryId: v.id("dictionaries"),
		expectedRevision: v.number(),
		sourceTerm: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		return await removeDictionaryTerm(ctx, {
			...args,
			authoredBy: { kind: "user", id: user.id },
		});
	},
});
export const setEditor = mutation({
	args: {
		dictionaryId: v.id("dictionaries"),
		userId: v.optional(v.string()),
		email: v.optional(v.string()),
		enabled: v.boolean(),
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		const access = await requireDictionaryEdit(ctx, args.dictionaryId, user.id);
		if (!access.isOwner)
			dictionaryError(
				"FORBIDDEN",
				"Only the Dictionary owner manages editors.",
			);
		if (Boolean(args.userId) === Boolean(args.email))
			dictionaryError("VALIDATION", "Provide one editor email or user ID.");
		const account = args.email
			? await getAnyUserByEmail(ctx, args.email.trim().toLowerCase())
			: args.enabled
				? await getAnyUserById(ctx, args.userId ?? "")
				: null;
		const userId = args.email ? account?.id : args.userId;
		if (!userId || (args.enabled && !account?.emailVerified))
			dictionaryError(
				"NOT_FOUND",
				"An existing account with a verified email is required.",
			);
		if (userId === access.dictionary.ownerUserId)
			dictionaryError(
				"VALIDATION",
				"The Dictionary owner already has permanent access.",
			);
		const existing = await ctx.db
			.query("dictionaryEditors")
			.withIndex("by_dictionary_user", (q) =>
				q.eq("dictionaryId", args.dictionaryId).eq("userId", userId),
			)
			.unique();
		if (args.enabled && !existing) {
			const editors = await ctx.db
				.query("dictionaryEditors")
				.withIndex("by_dictionary_user", (q) =>
					q.eq("dictionaryId", args.dictionaryId),
				)
				.take(128);
			if (editors.length >= 128)
				dictionaryError(
					"LIMIT_EXCEEDED",
					"A Dictionary supports at most 128 editors.",
				);
			await ctx.db.insert("dictionaryEditors", {
				dictionaryId: args.dictionaryId,
				userId,
			});
		}
		if (!args.enabled && existing) await ctx.db.delete(existing._id);
		return null;
	},
});
export async function connectProjectDictionary(
	ctx: MutationCtx,
	args: {
		projectId: Id<"projects">;
		dictionaryId: Id<"dictionaries"> | null;
		userId: string;
		expectedConnectionRevision?: number;
	},
) {
	const current = await projectDictionaryConnection(ctx, args.projectId);
	if (
		args.expectedConnectionRevision !== undefined &&
		args.expectedConnectionRevision !== (current?.revision ?? 0)
	)
		dictionaryError(
			"STALE_BASIS",
			"Dictionary connection changed. Refresh before connecting.",
		);
	if (args.dictionaryId)
		await requireDictionaryEdit(ctx, args.dictionaryId, args.userId);
	if (current?.dictionaryId === args.dictionaryId) return current;
	if (args.dictionaryId) {
		const links = await ctx.db
			.query("projectDictionaryConnections")
			.withIndex("by_dictionary", (q) =>
				q.eq("dictionaryId", args.dictionaryId),
			)
			.take(MAX_CONNECTIONS);
		if (links.length >= MAX_CONNECTIONS)
			dictionaryError(
				"LIMIT_EXCEEDED",
				"A Dictionary supports at most 128 project connections.",
			);
	}
	const next = {
		projectId: args.projectId,
		dictionaryId: args.dictionaryId,
		revision: (current?.revision ?? 0) + 1,
		agentWriteEnabled: false,
	};
	if (current) {
		await ctx.db.replace(current._id, next);
		return { ...current, ...next };
	}
	const id = await ctx.db.insert("projectDictionaryConnections", next);
	return await ctx.db.get(id);
}
export const connect = mutation({
	args: {
		projectId: v.id("projects"),
		dictionaryId: v.union(v.id("dictionaries"), v.null()),
		expectedConnectionRevision: v.number(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireOwner(ctx, args.projectId);
		await connectProjectDictionary(ctx, { ...args, userId });
		return null;
	},
});
export const setConnectionWrites = mutation({
	args: {
		dictionaryId: v.id("dictionaries"),
		projectId: v.id("projects"),
		enabled: v.boolean(),
		expectedConnectionRevision: v.number(),
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		await requireDictionaryEdit(ctx, args.dictionaryId, user.id);
		const connection = await projectDictionaryConnection(ctx, args.projectId);
		if (connection?.dictionaryId !== args.dictionaryId)
			dictionaryError(
				"NOT_FOUND",
				"Project is not connected to this Dictionary.",
			);
		if (
			!Number.isSafeInteger(args.expectedConnectionRevision) ||
			args.expectedConnectionRevision < 0
		)
			dictionaryError(
				"VALIDATION",
				"Connection revision must be a nonnegative integer.",
			);
		if (connection.revision !== args.expectedConnectionRevision)
			dictionaryError(
				"STALE_BASIS",
				"Dictionary connection changed. Refresh before changing agent access.",
			);
		if (connection.agentWriteEnabled !== args.enabled)
			await ctx.db.patch(connection._id, {
				agentWriteEnabled: args.enabled,
				revision: connection.revision + 1,
			});
		return null;
	},
});
export const projectConnection = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const { userId } = await requireViewer(ctx, args.projectId);
		const connection = await projectDictionaryConnection(ctx, args.projectId);
		const access = connection?.dictionaryId
			? await dictionaryAccess(ctx, connection.dictionaryId, userId)
			: null;
		const state = await guidanceState(ctx, { projectId: args.projectId });
		return {
			dictionaryId: connection?.dictionaryId ?? null,
			connectionRevision: connection?.revision ?? 0,
			name: access?.dictionary.name ?? null,
			canEdit: access?.canEdit ?? false,
			agentWriteEnabled: connection?.agentWriteEnabled ?? false,
			legacyTermCount: state?.termCount ?? 0,
		};
	},
});
export const legacyProjectTerms = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const local = await localGuidance(ctx, args.projectId);
		return { revision: local.revision, terms: local.terms };
	},
});
/** Move only current term ownership. Immutable historical citations keep their IDs. */
export async function promoteProjectDictionary(
	ctx: MutationCtx,
	args: { projectId: Id<"projects">; userId: string; name?: string },
) {
	const connection = await projectDictionaryConnection(ctx, args.projectId);
	if (connection?.dictionaryId) {
		await requireDictionaryEdit(ctx, connection.dictionaryId, args.userId);
		return connection.dictionaryId;
	}
	const project = await ctx.db.get(args.projectId);
	if (!project) dictionaryError("NOT_FOUND", "Project not found.");
	const state = await guidanceState(ctx, { projectId: args.projectId });
	const entries = await guidanceEntries(ctx, {
		projectId: args.projectId,
	}).take(386);
	const terms = entries.filter((e) => e.content.kind === "term");
	const dictionaryId = await ctx.db.insert("dictionaries", {
		name: nameValue(args.name ?? `${project.name} Dictionary`),
		ownerUserId: args.userId,
		legacyProjectId: args.projectId,
		legacyTermKeys: terms.map((term) => term.key),
		legacyRevision: state?.revision ?? 0,
	});
	let byteLength = 0;
	for (const term of terms) {
		byteLength += encodedSize(term.content);
		await ctx.db.patch(term._id, { projectId: undefined, dictionaryId });
	}
	await ctx.db.insert("translationGuidanceStates", {
		dictionaryId,
		revision: state?.revision ?? 0,
		termCount: terms.length,
		guideCount: 0,
		byteLength,
	});
	if (state && terms.length)
		await ctx.db.patch(state._id, {
			revision: state.revision + 1,
			termCount: 0,
			byteLength: state.byteLength - byteLength,
		});
	await connectProjectDictionary(ctx, {
		projectId: args.projectId,
		dictionaryId,
		userId: args.userId,
	});
	return dictionaryId;
}
export const promoteProjectTerms = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
		expectedRevision: v.number(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireOwner(ctx, args.projectId);
		const state = await guidanceState(ctx, { projectId: args.projectId });
		if ((state?.revision ?? 0) !== args.expectedRevision)
			dictionaryError(
				"STALE_BASIS",
				"Project terms changed. Refresh before promotion.",
			);
		return await promoteProjectDictionary(ctx, { ...args, userId });
	},
});
export async function preparePromotedProjectGuidance(
	ctx: MutationCtx,
	args: {
		sourceProjectId: Id<"projects">;
		destinationProjectId: Id<"projects">;
		userId: string;
		localeCodes?: readonly string[];
	},
) {
	const connection = await projectDictionaryConnection(
		ctx,
		args.sourceProjectId,
	);
	const state = await guidanceState(ctx, { projectId: args.sourceProjectId });
	const dictionaryId =
		connection?.dictionaryId || state?.termCount
			? await promoteProjectDictionary(ctx, {
					projectId: args.sourceProjectId,
					userId: args.userId,
				})
			: null;
	if (dictionaryId)
		await connectProjectDictionary(ctx, {
			projectId: args.destinationProjectId,
			dictionaryId,
			userId: args.userId,
		});
	const entries = await guidanceEntries(ctx, {
		projectId: args.sourceProjectId,
	}).take(386);
	let revision = 0;
	for (const entry of entries) {
		if (entry.content.kind === "term") continue;
		if (
			entry.content.kind === "voiceGuide" &&
			args.localeCodes &&
			!args.localeCodes.includes(entry.content.localeCode)
		)
			continue;
		const result = await writeEntry(ctx, {
			projectId: args.destinationProjectId,
			expectedRevision: revision,
			key: entry.key,
			content: entry.content,
			authoredBy: { kind: "user", id: args.userId },
		});
		revision = result.revision;
	}
	return { dictionaryId };
}
