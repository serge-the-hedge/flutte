import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type QueryCtx,
} from "./_generated/server";
import { archivedValueFromRow } from "./archiveReconciliation";
import type { JsonObject } from "./catalogDocument";
import {
	assertProjectedMessage,
	type ProjectedMessage,
	projectedMessageFromRow,
	projectedMessageValidator,
} from "./catalogProjection";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
} from "./permissions";

/** A processing unit is a message across its Locales, independently of the
 * catalog's total size. Large individual keys fail before publication. */
export const MAX_PROCESSING_KEY_BYTES = 6 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
export type ProcessingInput = {
	message: ProjectedMessage;
	metadata?: JsonObject;
};
const scope = {
	projectId: v.id("projects"),
	projectionId: v.id("catalogProjections"),
	actor: v.optional(repositoryAdapterActorValidator),
};
async function staging(
	ctx: QueryCtx,
	args: { projectId: Id<"projects">; projectionId: Id<"catalogProjections"> },
): Promise<Doc<"catalogProjections">> {
	const projection = await ctx.db.get(args.projectionId);
	if (
		!projection ||
		projection.projectId !== args.projectId ||
		projection.status !== "staging"
	)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "A staging catalog projection was not found.",
		});
	return projection;
}
export const basis = internalQuery({
	args: scope,
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const projection = await staging(ctx, args);
		return {
			previousProjectionId: projection.previousCatalogProjectionId ?? null,
			previousSnapshotId: projection.previousBaselineSnapshotId ?? null,
		};
	},
});
export const stageInputs = internalMutation({
	args: {
		...scope,
		inputs: v.array(
			v.object({
				message: projectedMessageValidator,
				metadata: v.optional(v.string()),
			}),
		),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		await staging(ctx, args);
		if (
			args.inputs.length > 500 ||
			new TextEncoder().encode(JSON.stringify(args.inputs)).length > PAGE_BYTES
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "A processing input batch exceeds its byte or row budget.",
			});
		for (const input of args.inputs) {
			assertProjectedMessage(input.message);
			await ctx.db.insert("catalogProcessingInputs", {
				projectionId: args.projectionId,
				messageId: input.message.messageId,
				payload: JSON.stringify({
					message: input.message,
					...(input.metadata === undefined
						? {}
						: { metadata: JSON.parse(input.metadata) }),
				}),
			});
		}
		return null;
	},
});
export const keyPage = internalQuery({
	args: {
		...scope,
		kind: v.union(v.literal("previous"), v.literal("archive")),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const projection = await staging(ctx, args);
		const previousProjectionId = projection.previousCatalogProjectionId;
		if (!previousProjectionId)
			return { page: [], isDone: true, continueCursor: "" };
		const opts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, 500),
			maximumBytesRead: PAGE_BYTES,
		};
		if (args.kind === "previous") {
			const page = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
					q.eq("projectionId", previousProjectionId).eq("isSource", true),
				)
				.paginate(opts);
			return { ...page, page: page.page.map((row) => row.messageId) };
		}
		const page = await ctx.db
			.query("catalogProjectionArchiveStateValues")
			.withIndex("by_projection_and_isSource", (q) =>
				q.eq("projectionId", previousProjectionId).eq("isSource", true),
			)
			.paginate(opts);
		return { ...page, page: page.page.map((row) => row.messageId) };
	},
});
export const valuesPage = internalQuery({
	args: {
		...scope,
		messageId: v.string(),
		endMessageId: v.string(),
		kind: v.union(
			v.literal("input"),
			v.literal("previous"),
			v.literal("archive"),
		),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const projection = await staging(ctx, args);
		const opts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, 500),
			maximumBytesRead: PAGE_BYTES,
		};
		if (args.kind === "input") {
			const page = await ctx.db
				.query("catalogProcessingInputs")
				.withIndex("by_projection_and_messageId", (q) =>
					q
						.eq("projectionId", args.projectionId)
						.gte("messageId", args.messageId)
						.lte("messageId", args.endMessageId),
				)
				.paginate(opts);
			return {
				page: page.page.map(
					(row) => JSON.parse(row.payload) as ProcessingInput,
				),
				isDone: page.isDone,
				continueCursor: page.continueCursor,
			};
		}
		const previousProjectionId = projection.previousCatalogProjectionId;
		if (!previousProjectionId)
			return { page: [], isDone: true, continueCursor: "" };
		if (args.kind === "previous") {
			const page = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId", (q) =>
					q
						.eq("projectionId", previousProjectionId)
						.gte("messageId", args.messageId)
						.lte("messageId", args.endMessageId),
				)
				.paginate(opts);
			return {
				page: page.page.map((row) => ({
					message: projectedMessageFromRow(row),
				})),
				isDone: page.isDone,
				continueCursor: page.continueCursor,
			};
		}
		const page = await ctx.db
			.query("catalogProjectionArchiveStateValues")
			.withIndex("by_projection_and_messageId", (q) =>
				q
					.eq("projectionId", previousProjectionId)
					.gte("messageId", args.messageId)
					.lte("messageId", args.endMessageId),
			)
			.paginate(opts);
		return {
			page: page.page.map((row) => ({ message: archivedValueFromRow(row) })),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
export const discardInputs = internalMutation({
	args: scope,
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		await staging(ctx, args);
		const rows = await ctx.db
			.query("catalogProcessingInputs")
			.withIndex("by_projection", (q) =>
				q.eq("projectionId", args.projectionId),
			)
			.paginate({ numItems: 100, cursor: null, maximumBytesRead: PAGE_BYTES });
		for (const row of rows.page) await ctx.db.delete(row._id);
		return rows.isDone;
	},
});
