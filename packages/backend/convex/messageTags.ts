import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import { activeProjectionFor } from "./catalogProjection";
import { requireManagedCollection } from "./contentCollections";
import { requireEditor, requireViewer } from "./permissions";

const MAX_TAGS = 32;
const addressFields = {
	projectId: v.id("projects"),
	collectionId: v.optional(v.id("contentCollections")),
};
const tagView = v.object({ id: v.id("tags"), name: v.string() });
const listView = v.object({ items: v.array(tagView), revision: v.number() });
type ReadCtx = QueryCtx | MutationCtx;
type Address = {
	projectId: Id<"projects">;
	collectionId?: Id<"contentCollections">;
	messageId: string;
};
function fail(code: string, message: string): never {
	throw new ConvexError({ code, message });
}
function tagState(ctx: ReadCtx, projectId: Id<"projects">) {
	return ctx.db
		.query("messageTagState")
		.withIndex("by_projectId", (q) => q.eq("projectId", projectId))
		.unique();
}
export async function tagRevision(ctx: ReadCtx, projectId: Id<"projects">) {
	return (await tagState(ctx, projectId))?.revision ?? 0;
}
async function changed(ctx: MutationCtx, projectId: Id<"projects">) {
	const state = await tagState(ctx, projectId);
	if (state) await ctx.db.patch(state._id, { revision: state.revision + 1 });
	else await ctx.db.insert("messageTagState", { projectId, revision: 1 });
}
function assignments(ctx: ReadCtx, address: Address) {
	return ctx.db
		.query("messageTagAssignments")
		.withIndex("by_projectId_and_collectionId_and_messageId_and_tagId", (q) =>
			q
				.eq("projectId", address.projectId)
				.eq("collectionId", address.collectionId)
				.eq("messageId", address.messageId),
		);
}
export async function readMessageTagIds(ctx: ReadCtx, address: Address) {
	return (await assignments(ctx, address).take(MAX_TAGS + 1))
		.map((row) => row.tagId)
		.sort();
}
export async function validateTagIds(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	tagIds: Id<"tags">[] = [],
) {
	if (tagIds.length > MAX_TAGS || new Set(tagIds).size !== tagIds.length)
		fail("VALIDATION", "Choose up to 32 distinct tags.");
	for (const id of tagIds) {
		const tag = await ctx.db.get(id);
		if (!tag || tag.projectId !== projectId || tag.archivedAt !== undefined)
			fail("NOT_FOUND", "Tag not found in this project.");
	}
	return [...tagIds].sort();
}
/** Filter stable metadata before loading source/target text; retain native browse order. */
export async function matchesMessageTags(
	ctx: ReadCtx,
	address: Address,
	tagIds: readonly Id<"tags">[],
) {
	if (!tagIds.length) return true;
	const assigned = await readMessageTagIds(ctx, address);
	return tagIds.some((id) => assigned.includes(id));
}
async function assertMessage(ctx: ReadCtx, address: Address) {
	const collectionId = address.collectionId;
	if (collectionId) {
		await requireManagedCollection(ctx, address.projectId, collectionId);
		const source = await ctx.db
			.query("managedMessages")
			.withIndex("by_collection_key", (q) =>
				q.eq("collectionId", collectionId).eq("key", address.messageId),
			)
			.unique();
		if (
			!source ||
			source.projectId !== address.projectId ||
			source.archivedAt !== undefined
		)
			fail("NOT_FOUND", "String not found.");
	} else {
		const projection = await activeProjectionFor(ctx, address.projectId);
		const source =
			projection &&
			(await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", address.messageId)
						.eq("isSource", true),
				)
				.unique());
		if (!source) fail("NOT_FOUND", "String not found.");
	}
}
async function readTags(ctx: ReadCtx, projectId: Id<"projects">) {
	const tags = await ctx.db
		.query("tags")
		.withIndex("by_projectId_and_archivedAt", (q) =>
			q.eq("projectId", projectId).eq("archivedAt", undefined),
		)
		.take(257);
	if (tags.length > 256)
		fail("LIMIT_EXCEEDED", "This project exceeds the 256-tag limit.");
	return {
		items: tags
			.map((tag) => ({ id: tag._id, name: tag.name }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		revision: await tagRevision(ctx, projectId),
	};
}
function cleanName(raw: string) {
	const name = raw.trim();
	if (!name || Array.from(name).length > 80 || /[\p{Cc}]/u.test(name))
		fail(
			"VALIDATION",
			"Tag names need 1–80 characters without control characters.",
		);
	return name;
}
async function createTag(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	raw: string,
) {
	const name = cleanName(raw);
	const tags = await readTags(ctx, projectId);
	const existing = tags.items.find(
		(tag) => tag.name.toLowerCase() === name.toLowerCase(),
	);
	if (existing) return existing.id;
	if (tags.items.length >= 256)
		fail("LIMIT_EXCEEDED", "A project supports up to 256 tags.");
	const id = await ctx.db.insert("tags", {
		projectId,
		name,
		slug: name.toLowerCase(),
		createdAt: Date.now(),
	});
	await changed(ctx, projectId);
	return id;
}
const bulkFields = {
	...addressFields,
	messageIds: v.array(v.string()),
	addTagIds: v.optional(v.array(v.id("tags"))),
	removeTagIds: v.optional(v.array(v.id("tags"))),
};
async function updateAssignments(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		collectionId?: Id<"contentCollections">;
		messageIds: string[];
		addTagIds?: Id<"tags">[];
		removeTagIds?: Id<"tags">[];
	},
) {
	if (
		!input.messageIds.length ||
		input.messageIds.length > 32 ||
		new Set(input.messageIds).size !== input.messageIds.length
	)
		fail("VALIDATION", "Choose 1–32 distinct strings per tag update.");
	const add = await validateTagIds(ctx, input.projectId, input.addTagIds);
	const remove = await validateTagIds(ctx, input.projectId, input.removeTagIds);
	if (add.some((id) => remove.includes(id)))
		fail("VALIDATION", "A tag cannot be added and removed together.");
	let modified = false;
	for (const messageId of input.messageIds) {
		const address = {
			projectId: input.projectId,
			collectionId: input.collectionId,
			messageId,
		};
		await assertMessage(ctx, address);
		const previous = await assignments(ctx, address).take(MAX_TAGS + 1);
		const retained = previous.filter((row) => !remove.includes(row.tagId));
		const additions = add.filter(
			(id) => !previous.some((row) => row.tagId === id),
		);
		if (retained.length + additions.length > MAX_TAGS)
			fail("LIMIT_EXCEEDED", "A string supports up to 32 tags.");
		for (const row of previous)
			if (remove.includes(row.tagId)) {
				await ctx.db.delete(row._id);
				modified = true;
			}
		for (const tagId of additions) {
			await ctx.db.insert("messageTagAssignments", { ...address, tagId });
			modified = true;
		}
	}
	if (modified) await changed(ctx, input.projectId);
	return null;
}
export const list = query({
	args: { projectId: v.id("projects") },
	returns: listView,
	handler: async (ctx, { projectId }) => {
		await requireViewer(ctx, projectId);
		return readTags(ctx, projectId);
	},
});
const assignmentsView = v.array(
	v.object({ messageId: v.string(), tagIds: v.array(v.id("tags")) }),
);
async function messageAssignments(
	ctx: ReadCtx,
	args: {
		projectId: Id<"projects">;
		collectionId?: Id<"contentCollections">;
		messageIds: string[];
	},
) {
	if (args.collectionId)
		await requireManagedCollection(ctx, args.projectId, args.collectionId);
	if (args.messageIds.length > 128)
		fail("VALIDATION", "Request at most 128 strings.");
	return Promise.all(
		args.messageIds.map(async (messageId) => ({
			messageId,
			tagIds: await readMessageTagIds(ctx, { ...args, messageId }),
		})),
	);
}
export const forMessages = query({
	args: { ...addressFields, messageIds: v.array(v.string()) },
	returns: assignmentsView,
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return messageAssignments(ctx, args);
	},
});
export const assignmentsForAgent = internalQuery({
	args: { token: v.string(), keys: v.array(v.string()) },
	returns: assignmentsView,
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		return messageAssignments(ctx, {
			projectId: token.projectId,
			collectionId:
				token.projectType === "basic" ? token.managedCollectionId : undefined,
			messageIds: args.keys,
		});
	},
});
export const create = mutation({
	args: { projectId: v.id("projects"), name: v.string() },
	returns: v.id("tags"),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		return createTag(ctx, args.projectId, args.name);
	},
});
export const rename = mutation({
	args: {
		projectId: v.id("projects"),
		tagId: v.id("tags"),
		name: v.string(),
		expectedName: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		await validateTagIds(ctx, args.projectId, [args.tagId]);
		const tag = await ctx.db.get(args.tagId);
		if (tag?.name !== args.expectedName)
			fail("CONFLICT", "Tag changed. Reload before renaming.");
		const name = cleanName(args.name);
		const { items } = await readTags(ctx, args.projectId);
		if (
			items.some(
				(item) =>
					item.id !== args.tagId &&
					item.name.toLowerCase() === name.toLowerCase(),
			)
		)
			fail("CONFLICT", "A tag with this name already exists.");
		await ctx.db.patch(args.tagId, { name, slug: name.toLowerCase() });
		await changed(ctx, args.projectId);
		return null;
	},
});
export const setTags = mutation({
	args: {
		...addressFields,
		messageId: v.string(),
		tagIds: v.array(v.id("tags")),
		expectedTagIds: v.array(v.id("tags")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const previous = await readMessageTagIds(ctx, args);
		if (
			JSON.stringify(previous) !==
			JSON.stringify([...args.expectedTagIds].sort())
		)
			fail("CONFLICT", "Tags changed. Reload before saving.");
		await validateTagIds(ctx, args.projectId, args.tagIds);
		return updateAssignments(ctx, {
			...args,
			messageIds: [args.messageId],
			addTagIds: args.tagIds.filter((id) => !previous.includes(id)),
			removeTagIds: previous.filter((id) => !args.tagIds.includes(id)),
		});
	},
});
export const updateMany = mutation({
	args: bulkFields,
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		return updateAssignments(ctx, args);
	},
});
export const listForAgent = internalQuery({
	args: { token: v.string() },
	returns: listView,
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		return readTags(ctx, token.projectId);
	},
});
export const createForAgent = internalMutation({
	args: { token: v.string(), name: v.string() },
	returns: v.id("tags"),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "tags-write");
		return createTag(ctx, token.projectId, args.name);
	},
});
export const updateForAgent = internalMutation({
	args: {
		token: v.string(),
		keys: v.array(v.string()),
		addTagIds: v.optional(v.array(v.id("tags"))),
		removeTagIds: v.optional(v.array(v.id("tags"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "tags-write");
		return updateAssignments(ctx, {
			projectId: token.projectId,
			collectionId:
				token.projectType === "basic" ? token.managedCollectionId : undefined,
			messageIds: args.keys,
			addTagIds: args.addTagIds,
			removeTagIds: args.removeTagIds,
		});
	},
});
