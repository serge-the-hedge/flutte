import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { MAX_CONTENT_COLLECTIONS, MAX_MANAGED_LOCALES } from "./contentModel";
import { requireEditor, requireViewer } from "./permissions";

type ReadCtx = QueryCtx | MutationCtx;
export async function requireManagedCollection(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	collectionId: Id<"contentCollections">,
) {
	const collection = await ctx.db.get(collectionId);
	if (!collection || collection.projectId !== projectId)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Collection not found.",
		});
	return collection;
}
export async function collectionMemberships(
	ctx: ReadCtx,
	collectionId: Id<"contentCollections">,
) {
	const rows = await ctx.db
		.query("contentCollectionLocales")
		.withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
		.take(MAX_MANAGED_LOCALES + 1);
	if (rows.length > MAX_MANAGED_LOCALES)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Collection language configuration exceeds its bounds.",
		});
	return rows;
}
export async function readCollections(ctx: ReadCtx, projectId: Id<"projects">) {
	const [project, collections] = await Promise.all([
		ctx.db.get(projectId),
		ctx.db
			.query("contentCollections")
			.withIndex("by_project", (q) => q.eq("projectId", projectId))
			.take(MAX_CONTENT_COLLECTIONS + 1),
	]);
	if (!project)
		throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
	if (collections.length > MAX_CONTENT_COLLECTIONS)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Project collection configuration exceeds its bounds.",
		});
	return [
		{
			id: "app" as const,
			kind: "repository" as const,
			name: "App",
			membershipRevision: project.localeBindingRevision ?? 0,
		},
		...collections.map((collection) => ({
			id: collection._id,
			kind: "managed" as const,
			name: collection.name,
			membershipRevision: collection.membershipRevision,
		})),
	];
}
export async function readManagedCollection(
	ctx: ReadCtx,
	input: { projectId: Id<"projects">; collectionId: Id<"contentCollections"> },
) {
	const collection = await requireManagedCollection(
		ctx,
		input.projectId,
		input.collectionId,
	);
	const members = await collectionMemberships(ctx, input.collectionId);
	return {
		id: collection._id,
		kind: "managed" as const,
		name: collection.name,
		membershipRevision: collection.membershipRevision,
		localeIds: members.filter((m) => m.active).map((m) => m.localeId),
	};
}
export const get = query({
	args: {
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return readManagedCollection(ctx, args);
	},
});
async function validateLocales(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	localeIds: Id<"locales">[],
) {
	if (
		localeIds.length > MAX_MANAGED_LOCALES ||
		new Set(localeIds).size !== localeIds.length
	)
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"Choose distinct project target languages within the supported bounds.",
		});
	for (const id of localeIds) {
		const locale = await ctx.db.get(id);
		if (
			!locale ||
			locale.projectId !== projectId ||
			locale.isSource ||
			locale.archivedAt !== undefined
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Choose active project target languages.",
			});
	}
}
export const list = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return readCollections(ctx, args.projectId);
	},
});
export const create = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
		localeIds: v.array(v.id("locales")),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const name = args.name.trim();
		if (!name || name.length > 128)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Collection name must contain 1–128 characters.",
			});
		const collections = await ctx.db
			.query("contentCollections")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(MAX_CONTENT_COLLECTIONS);
		if (collections.length >= MAX_CONTENT_COLLECTIONS)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "A project supports at most 64 managed collections.",
			});
		if (
			collections.some((c) => c.name.toLowerCase() === name.toLowerCase()) ||
			name.toLowerCase() === "app"
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Collection name already exists.",
			});
		await validateLocales(ctx, args.projectId, args.localeIds);
		const id = await ctx.db.insert("contentCollections", {
			projectId: args.projectId,
			name,
			membershipRevision: 1,
			createdAt: Date.now(),
		});
		for (const localeId of args.localeIds)
			await ctx.db.insert("contentCollectionLocales", {
				projectId: args.projectId,
				collectionId: id,
				localeId,
				active: true,
			});
		return id;
	},
});
export const setLocales = mutation({
	args: {
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		localeIds: v.array(v.id("locales")),
		expectedMembershipRevision: v.number(),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const collection = await requireManagedCollection(
			ctx,
			args.projectId,
			args.collectionId,
		);
		if (collection.membershipRevision !== args.expectedMembershipRevision)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Collection languages changed. Reload before saving.",
			});
		await validateLocales(ctx, args.projectId, args.localeIds);
		const rows = await collectionMemberships(ctx, args.collectionId);
		const selected = new Set(args.localeIds);
		const retainedLocales = new Set([
			...rows.map((row) => row.localeId),
			...args.localeIds,
		]);
		if (retainedLocales.size > MAX_MANAGED_LOCALES)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"Collection language history exceeds its configuration bounds.",
			});
		if (
			rows.filter((r) => r.active).length === selected.size &&
			rows.every((r) => r.active === selected.has(r.localeId))
		)
			return collection.membershipRevision;
		for (const row of rows)
			if (row.active !== selected.has(row.localeId))
				await ctx.db.patch(row._id, { active: selected.has(row.localeId) });
		const existing = new Set(rows.map((r) => r.localeId));
		for (const localeId of args.localeIds)
			if (!existing.has(localeId))
				await ctx.db.insert("contentCollectionLocales", {
					projectId: args.projectId,
					collectionId: args.collectionId,
					localeId,
					active: true,
				});
		const revision = collection.membershipRevision + 1;
		await ctx.db.patch(collection._id, { membershipRevision: revision });
		return revision;
	},
});
