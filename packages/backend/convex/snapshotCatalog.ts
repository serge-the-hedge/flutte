import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import { navigationStateFor } from "./catalogWorkspaceNavigation";
import { encodedSize } from "./catalogWorkspaceView";
import { requireEditor, requireViewer } from "./permissions";

const snapshotSummary = v.object({
	snapshotId: v.id("sourceSnapshots"),
	name: v.union(v.string(), v.null()),
	commit: v.string(),
	createdAt: v.number(),
	initialCatalog: v.boolean(),
});

/** Only published projections prove that a snapshot was accepted. `kind` is
 * mutable: an earlier baseline becomes a preview when the next one arrives. */
export async function acceptedProjectionFor(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	return await ctx.db
		.query("catalogProjections")
		.withIndex("by_project_and_snapshot_and_status", (q) =>
			q
				.eq("projectId", projectId)
				.eq("snapshotId", snapshotId)
				.eq("status", "published"),
		)
		.order("asc")
		.first();
}

function summary(
	snapshot: Doc<"sourceSnapshots">,
	projection: Doc<"catalogProjections">,
) {
	return {
		snapshotId: snapshot._id,
		name: snapshot.name ?? null,
		commit: snapshot.commit,
		createdAt: snapshot.createdAt,
		initialCatalog: !projection.previousBaselineSnapshotId && !snapshot.lineage,
	};
}

async function acceptedSnapshot(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	const snapshot = await ctx.db.get(snapshotId);
	const projection =
		snapshot?.projectId === projectId
			? await acceptedProjectionFor(ctx, projectId, snapshotId)
			: null;
	if (!snapshot || !projection)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Choose an accepted snapshot from this project.",
		});
	return { snapshot, projection };
}

export const list = query({
	args: {
		projectId: v.id("projects"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		page: v.array(snapshotSummary),
		isDone: v.boolean(),
		continueCursor: v.string(),
		canRename: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const { member } = await requireViewer(ctx, args.projectId);
		const batch = await ctx.db
			.query("sourceSnapshots")
			.withIndex("by_project_and_createdAt", (q) =>
				q.eq("projectId", args.projectId),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(4, Math.max(1, args.paginationOpts.numItems)),
				maximumBytesRead: 256 * 1024,
			});
		const page = [];
		for (const snapshot of batch.page) {
			const projection = await acceptedProjectionFor(
				ctx,
				args.projectId,
				snapshot._id,
			);
			if (projection) page.push(summary(snapshot, projection));
		}
		return {
			page,
			isDone: batch.isDone,
			continueCursor: batch.continueCursor,
			canRename: hasMinimumRole(member.role, "editor"),
		};
	},
});

export const getSelected = query({
	args: {
		projectId: v.id("projects"),
		snapshotIds: v.array(v.id("sourceSnapshots")),
	},
	returns: v.array(snapshotSummary),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		if (args.snapshotIds.length > 4)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Read up to 4 snapshot labels at a time.",
			});
		return await Promise.all(
			[...new Set(args.snapshotIds)].map(async (id) => {
				const { snapshot, projection } = await acceptedSnapshot(
					ctx,
					args.projectId,
					id,
				);
				return summary(snapshot, projection);
			}),
		);
	},
});

export const rename = mutation({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		name: v.string(),
		expectedName: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const { snapshot } = await acceptedSnapshot(
			ctx,
			args.projectId,
			args.snapshotId,
		);
		const name = args.name.trim();
		if (
			name.length > 120 ||
			[...name].some(
				(character) =>
					character.charCodeAt(0) < 32 ||
					character.charCodeAt(0) === 127 ||
					character === "\u2028" ||
					character === "\u2029",
			)
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Use a snapshot name of up to 120 characters on one line.",
			});
		if ((snapshot.name ?? null) !== args.expectedName)
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The snapshot name changed. Check the latest name and try again.",
			});
		await ctx.db.patch(snapshot._id, { name: name || undefined });
		return null;
	},
});

/** An old source can be assigned an origin only when an immutable accepted
 * transition proves it was absent from both the previous catalog and archive.
 * Missing archive-era evidence stays unknown instead of guessing from dates. */
async function provedOrigin(
	ctx: QueryCtx,
	projection: Doc<"catalogProjections">,
	snapshot: Doc<"sourceSnapshots">,
	source: Doc<"catalogProjectionMessages">,
	previous: Doc<"catalogProjections"> | null,
) {
	if (!source.isSource) return false;
	if (source.firstSeenProjectionId)
		return source.firstSeenProjectionId === projection._id;
	if (!projection.previousCatalogProjectionId) {
		return !projection.previousBaselineSnapshotId && !snapshot.lineage;
	}
	if (
		previous?.status !== "published" ||
		previous.projectId !== projection.projectId ||
		previous.archiveStateStatus !== "staged"
	)
		return false;
	const active = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_messageId_and_isSource", (q) =>
			q
				.eq("projectionId", previous._id)
				.eq("messageId", source.messageId)
				.eq("isSource", true),
		)
		.unique();
	if (active) return false;
	const retained = await ctx.db
		.query("catalogProjectionArchiveStateValues")
		.withIndex("by_projection_and_messageId_and_isSource", (q) =>
			q
				.eq("projectionId", previous._id)
				.eq("messageId", source.messageId)
				.eq("isSource", true),
		)
		.unique();
	return !retained;
}

export const previewOrigins = query({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		page: v.array(v.object({ messageId: v.string() })),
		isDone: v.boolean(),
		continueCursor: v.string(),
		projectionId: v.id("catalogProjections"),
		initialCatalog: v.boolean(),
	}),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const { snapshot, projection } = await acceptedSnapshot(
			ctx,
			args.projectId,
			args.snapshotId,
		);
		const batch = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
				q.eq("projectionId", projection._id).eq("isSource", true),
			)
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(16, Math.max(1, args.paginationOpts.numItems)),
				maximumBytesRead: 256 * 1024,
			});
		const previous = projection.previousCatalogProjectionId
			? await ctx.db.get(projection.previousCatalogProjectionId)
			: null;
		const page = [];
		for (const source of batch.page)
			if (await provedOrigin(ctx, projection, snapshot, source, previous))
				page.push({ messageId: source.messageId });
		return {
			page,
			isDone: batch.isDone,
			continueCursor: batch.continueCursor,
			projectionId: projection._id,
			initialCatalog: summary(snapshot, projection).initialCatalog,
		};
	},
});

export const applyOrigins = mutation({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		projectionId: v.id("catalogProjections"),
		messageIds: v.array(v.string()),
	},
	returns: v.object({ applied: v.number(), alreadyRecorded: v.number() }),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		if (
			args.messageIds.length > 16 ||
			new Set(args.messageIds).size !== args.messageIds.length
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Recover up to 16 distinct string origins at a time.",
			});
		const { snapshot, projection } = await acceptedSnapshot(
			ctx,
			args.projectId,
			args.snapshotId,
		);
		if (projection._id !== args.projectionId)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Preview this snapshot again before recovering its history.",
			});
		const previous = projection.previousCatalogProjectionId
			? await ctx.db.get(projection.previousCatalogProjectionId)
			: null;
		let applied = 0;
		let alreadyRecorded = 0;
		for (const messageId of args.messageIds) {
			const source = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", messageId)
						.eq("isSource", true),
				)
				.unique();
			if (
				!source ||
				!(await provedOrigin(ctx, projection, snapshot, source, previous))
			)
				throw new ConvexError({
					code: "VALIDATION",
					message: "This snapshot does not prove the string's introduction.",
				});
			const existing = await ctx.db
				.query("catalogMessageOrigins")
				.withIndex("by_project_and_messageId", (q) =>
					q.eq("projectId", args.projectId).eq("messageId", messageId),
				)
				.unique();
			if (existing) {
				if (existing.firstSeenProjectionId !== projection._id)
					throw new ConvexError({
						code: "CONFLICT",
						message:
							"A different introduction has already been recorded for this string.",
					});
				alreadyRecorded++;
			} else {
				await ctx.db.insert("catalogMessageOrigins", {
					projectId: args.projectId,
					messageId,
					firstSeenProjectionId: projection._id,
				});
				applied++;
			}
		}
		if (applied) {
			const navigation = await navigationStateFor(ctx, args.projectId);
			if (navigation)
				await ctx.db.patch(navigation._id, {
					revision: (navigation.revision ?? 0) + 1,
				});
		}
		return { applied, alreadyRecorded };
	},
});

/** Bounded per-page resolver shared by browsing and focus counts. */
export async function snapshotOriginFilter(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	snapshotIds?: readonly Id<"sourceSnapshots">[],
	introducedOriginUnknown = false,
) {
	if (introducedOriginUnknown && snapshotIds?.length)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Choose snapshots or strings with unknown introductions.",
		});
	if (!snapshotIds?.length && !introducedOriginUnknown)
		return async (_row: Doc<"catalogWorkspaceNavigationRows">) => true;
	if (
		(snapshotIds?.length ?? 0) > 32 ||
		new Set(snapshotIds).size !== (snapshotIds?.length ?? 0)
	)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Choose up to 32 distinct snapshots.",
		});
	const selected = new Set(snapshotIds);
	const origins = new Map<Id<"catalogProjections">, boolean>();
	let legacyReadBytes = 0;
	function legacyProjection(projection: Doc<"catalogProjections"> | null) {
		legacyReadBytes += encodedSize(projection);
		if (legacyReadBytes > 4 * 1024 * 1024)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Choose fewer older snapshots.",
			});
		return projection;
	}
	for (const id of selected) {
		const publication = await ctx.db
			.query("catalogProjectionPublicationStates")
			.withIndex("by_project_and_snapshot", (q) =>
				q.eq("projectId", projectId).eq("snapshotId", id),
			)
			.first();
		if (publication?.status === "published") {
			origins.set(publication.projectionId, true);
			continue;
		}
		const legacy = legacyProjection(
			await acceptedProjectionFor(ctx, projectId, id),
		);
		if (!legacy)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Choose an accepted snapshot from this project.",
			});
		origins.set(legacy._id, true);
	}
	return async (row: Doc<"catalogWorkspaceNavigationRows">) => {
		let origin = row.firstSeenProjectionId;
		if (!origin)
			origin = (
				await ctx.db
					.query("catalogMessageOrigins")
					.withIndex("by_project_and_messageId", (q) =>
						q.eq("projectId", projectId).eq("messageId", row.messageId),
					)
					.unique()
			)?.firstSeenProjectionId;
		if (introducedOriginUnknown) return origin === undefined;
		if (!origin) return false;
		const cached = origins.get(origin);
		if (cached !== undefined) return cached;
		const publication = await ctx.db
			.query("catalogProjectionPublicationStates")
			.withIndex("by_projection", (q) => q.eq("projectionId", origin))
			.unique();
		const projection =
			publication ?? legacyProjection(await ctx.db.get(origin));
		const matches = Boolean(
			projection?.projectId === projectId &&
				projection.status === "published" &&
				projection.snapshotId &&
				selected.has(projection.snapshotId),
		);
		origins.set(origin, matches);
		return matches;
	};
}
