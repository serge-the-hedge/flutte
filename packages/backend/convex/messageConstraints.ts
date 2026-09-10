import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
} from "./_generated/server";
import { activeProjectionFor } from "./catalogProjection";
import {
	assertCharacterLimit,
	validateCharacterLimit,
} from "./characterLimits";
import { requireManagedCollection } from "./contentCollections";
import { requireEditor } from "./permissions";

type Address = {
	projectId: Id<"projects">;
	messageId: string;
	collectionId?: Id<"contentCollections">;
};
function constraintFor(ctx: QueryCtx | MutationCtx, address: Address) {
	return ctx.db
		.query("messageConstraints")
		.withIndex("by_projectId_and_collectionId_and_messageId", (q) =>
			q
				.eq("projectId", address.projectId)
				.eq("collectionId", address.collectionId)
				.eq("messageId", address.messageId),
		)
		.unique();
}
/** Stable per-message metadata, independent of source revisions and snapshots. */
export async function readCharacterLimit(
	ctx: QueryCtx | MutationCtx,
	address: Address,
) {
	return (await constraintFor(ctx, address))?.characterLimit;
}
export async function assertMessageCharacterLimit(
	ctx: QueryCtx | MutationCtx,
	address: Address,
	value: string,
) {
	assertCharacterLimit(
		value,
		await readCharacterLimit(ctx, address),
		address.messageId,
	);
}
export async function writeCharacterLimit(
	ctx: MutationCtx,
	address: Address,
	characterLimit: number | null,
	expectedCharacterLimit: number | null,
) {
	validateCharacterLimit(characterLimit);
	validateCharacterLimit(expectedCharacterLimit);
	const previous = await constraintFor(ctx, address);
	if ((previous?.characterLimit ?? null) !== expectedCharacterLimit)
		throw new ConvexError({
			code: "CONFLICT",
			message: "Character limit changed. Reload before saving.",
		});
	if (characterLimit === null) {
		if (previous) await ctx.db.delete(previous._id);
	} else if (previous) await ctx.db.patch(previous._id, { characterLimit });
	else
		await ctx.db.insert("messageConstraints", { ...address, characterLimit });
}
export const setCharacterLimit = mutation({
	args: {
		projectId: v.id("projects"),
		messageId: v.string(),
		collectionId: v.optional(v.id("contentCollections")),
		characterLimit: v.union(v.number(), v.null()),
		expectedCharacterLimit: v.union(v.number(), v.null()),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const collectionId = args.collectionId;
		if (collectionId) {
			await requireManagedCollection(ctx, args.projectId, collectionId);
			const source = await ctx.db
				.query("managedMessages")
				.withIndex("by_collection_key", (q) =>
					q.eq("collectionId", collectionId).eq("key", args.messageId),
				)
				.unique();
			if (
				!source ||
				source.projectId !== args.projectId ||
				source.archivedAt !== undefined
			)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "String not found.",
				});
		} else {
			const projection = await activeProjectionFor(ctx, args.projectId);
			const source =
				projection &&
				(await ctx.db
					.query("catalogProjectionMessages")
					.withIndex("by_projection_and_messageId_and_isSource", (q) =>
						q
							.eq("projectionId", projection._id)
							.eq("messageId", args.messageId)
							.eq("isSource", true),
					)
					.unique());
			if (!source)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "String not found.",
				});
		}
		const { projectId, messageId } = args;
		await writeCharacterLimit(
			ctx,
			{ projectId, messageId, collectionId },
			args.characterLimit,
			args.expectedCharacterLimit,
		);
		return null;
	},
});

/** Bounded metadata read for action-based Locale templates. */
export const limitsForMessages = internalQuery({
	args: { projectId: v.id("projects"), messageIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		if (args.messageIds.length > 128)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Request at most 128 string limits.",
			});
		return await Promise.all(
			args.messageIds.map(async (messageId) => ({
				messageId,
				characterLimit: await readCharacterLimit(ctx, {
					projectId: args.projectId,
					messageId,
				}),
			})),
		);
	},
});
