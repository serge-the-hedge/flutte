import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	internalMutation,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	navigationStateFor,
	stampNavigationOrigin,
} from "./catalogWorkspaceNavigation";
import { encodedSize } from "./catalogWorkspaceView";
import { requireViewer } from "./permissions";
import { acceptedSnapshot, provedOrigin } from "./snapshotCatalog";

function indexFor(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	return ctx.db
		.query("snapshotOriginIndexes")
		.withIndex("by_project_and_snapshot", (q) =>
			q.eq("projectId", projectId).eq("snapshotId", snapshotId),
		)
		.unique();
}

/** Opening a filter prepares disposable metadata, never historical content or review evidence. */
export const prepare = mutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		snapshotId: v.id("sourceSnapshots"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const navigation = await navigationStateFor(ctx, args.projectId);
		if (
			navigation?.projectionId !== args.projectionId ||
			navigation.status !== "ready"
		)
			throw new ConvexError({
				code: "STALE_BASIS",
				message: "The catalog changed. Try this snapshot again.",
			});
		const existing = await indexFor(ctx, args.projectId, args.snapshotId);
		if (
			existing?.projectionId === args.projectionId &&
			(existing.status === "ready" ||
				(existing.status === "building" &&
					existing.updatedAt > Date.now() - 60_000))
		)
			return null;
		const { projection } = await acceptedSnapshot(
			ctx,
			args.projectId,
			args.snapshotId,
		);
		const jobId = crypto.randomUUID();
		const fields = {
			...args,
			originProjectionId: projection._id,
			jobId,
			status: "building" as const,
			cursor: null,
			processed: 0,
			expected: projection.expectedKeyCount,
			failure: undefined,
			updatedAt: Date.now(),
		};
		const indexId = existing
			? existing._id
			: await ctx.db.insert("snapshotOriginIndexes", fields);
		if (existing) await ctx.db.patch(indexId, fields);
		await ctx.scheduler.runAfter(0, internal.snapshotOriginIndex.step, {
			indexId,
			jobId,
		});
		return null;
	},
});

export const status = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		snapshotIds: v.array(v.id("sourceSnapshots")),
	},
	returns: v.object({
		ready: v.boolean(),
		snapshots: v.array(
			v.object({
				snapshotId: v.id("sourceSnapshots"),
				status: v.union(
					v.literal("missing"),
					v.literal("building"),
					v.literal("ready"),
					v.literal("failed"),
				),
				processed: v.number(),
				expected: v.number(),
				failure: v.union(v.string(), v.null()),
				updatedAt: v.union(v.number(), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		if (args.snapshotIds.length > 32)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Choose up to 32 snapshots.",
			});
		const snapshots = await Promise.all(
			[...new Set(args.snapshotIds)].map(async (snapshotId) => {
				const index = await indexFor(ctx, args.projectId, snapshotId);
				if (!index || index.projectionId !== args.projectionId)
					return {
						snapshotId,
						status: "missing" as const,
						processed: 0,
						expected: 0,
						failure: null,
						updatedAt: null,
					};
				return {
					snapshotId,
					status: index.status,
					processed: index.processed,
					expected: index.expected,
					failure: index.failure ?? null,
					updatedAt: index.updatedAt,
				};
			}),
		);
		return {
			ready: snapshots.every((item) => item.status === "ready"),
			snapshots,
		};
	},
});

export const step = internalMutation({
	args: { indexId: v.id("snapshotOriginIndexes"), jobId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const index = await ctx.db.get(args.indexId);
		if (!index || index.jobId !== args.jobId || index.status !== "building")
			return null;
		try {
			const navigation = await navigationStateFor(ctx, index.projectId);
			if (
				navigation?.projectionId !== index.projectionId ||
				navigation.status !== "ready"
			)
				throw new Error("The catalog changed. Try this snapshot again.");
			const { snapshot, projection } = await acceptedSnapshot(
				ctx,
				index.projectId,
				index.snapshotId,
			);
			if (projection._id !== index.originProjectionId)
				throw new Error("The snapshot introduction changed. Try again.");
			const previous = projection.previousCatalogProjectionId
				? await ctx.db.get(projection.previousCatalogProjectionId)
				: null;
			const batch = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("isSource", true)
						.gt(
							"catalogIndex",
							index.cursor === null ? -1 : Number(index.cursor),
						),
				)
				.paginate({
					cursor: null,
					numItems: 128,
					maximumBytesRead: 128 * 1024,
				});
			let bytes = 0;
			const accountRead = (value: unknown) => {
				bytes += encodedSize(value);
			};
			let processed = 0;
			let cursor = index.cursor;
			for (const source of batch.page) {
				if (bytes >= 4 * 1024 * 1024) break;
				processed++;
				cursor = String(source.catalogIndex);
				if (
					!(await provedOrigin(
						ctx,
						projection,
						snapshot,
						source,
						previous,
						accountRead,
					))
				)
					continue;
				const origin = await ctx.db
					.query("catalogMessageOrigins")
					.withIndex("by_project_and_messageId", (q) =>
						q
							.eq("projectId", index.projectId)
							.eq("messageId", source.messageId),
					)
					.unique();
				if (origin && origin.firstSeenProjectionId !== projection._id)
					throw new Error("Conflicting snapshot introduction evidence.");
				if (!origin)
					await ctx.db.insert("catalogMessageOrigins", {
						projectId: index.projectId,
						messageId: source.messageId,
						firstSeenProjectionId: projection._id,
					});
				await stampNavigationOrigin(ctx, {
					projectId: index.projectId,
					projectionId: index.projectionId,
					messageId: source.messageId,
					originProjectionId: projection._id,
					accountRead,
				});
			}
			if (
				batch.isDone &&
				processed === batch.page.length &&
				index.processed + processed !== index.expected
			)
				throw new Error(
					"This snapshot no longer retains complete source evidence.",
				);
			await ctx.db.patch(index._id, {
				cursor,
				processed: index.processed + processed,
				status:
					batch.isDone && processed === batch.page.length
						? "ready"
						: "building",
				updatedAt: Date.now(),
			});
			if (!batch.isDone || processed < batch.page.length)
				await ctx.scheduler.runAfter(
					0,
					internal.snapshotOriginIndex.step,
					args,
				);
		} catch (error) {
			await ctx.db.patch(index._id, {
				status: "failed",
				failure:
					error instanceof Error
						? error.message
						: "Could not prepare this snapshot. Try again.",
				updatedAt: Date.now(),
			});
		}
		return null;
	},
});
