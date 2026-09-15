import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { encodedSize } from "./catalogWorkspaceView";

type CatalogIdentity = {
	projectId: Id<"projects">;
	projectionId: Id<"catalogProjections">;
};
type Origin = Id<"catalogProjections"> | undefined;

/** New navigation generations inherit the immutable origin registry. Reuse a
 * finished index only when it completed before staging that projection began;
 * preparation overlapping staging may still need to stamp missing rows. */
export function originIndexReadyForProjection(
	index: Doc<"snapshotOriginIndexes"> | null,
	projection: Pick<
		Doc<"catalogProjections">,
		"_id" | "createdAt" | "projectId" | "status"
	> | null,
) {
	return Boolean(
		index?.status === "ready" &&
			projection?.status === "published" &&
			projection.projectId === index.projectId &&
			(index.projectionId === projection._id ||
				index.updatedAt < projection.createdAt),
	);
}

/** Never substitute an empty result while historical membership is still being
 * reconstructed. Completed origins survive subsequent catalog publications. */
export async function preparedOrigins(
	ctx: QueryCtx,
	args: CatalogIdentity & {
		introducedSnapshotIds?: Id<"sourceSnapshots">[];
		introducedOriginUnknown?: boolean;
	},
	projection: Doc<"catalogProjections">,
): Promise<Origin[] | null> {
	const selected = args.introducedSnapshotIds ?? [];
	if (args.introducedOriginUnknown && selected.length)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Choose snapshots or strings with unknown introductions.",
		});
	if (selected.length > 32 || new Set(selected).size !== selected.length)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Choose up to 32 distinct snapshots.",
		});
	if (args.introducedOriginUnknown) return [undefined];
	if (!selected.length) return null;
	const origins = [];
	for (const snapshotId of selected) {
		const state = await ctx.db
			.query("snapshotOriginIndexes")
			.withIndex("by_project_and_snapshot", (q) =>
				q.eq("projectId", args.projectId).eq("snapshotId", snapshotId),
			)
			.unique();
		if (!state || !originIndexReadyForProjection(state, projection))
			throw new ConvexError({
				code: "FILTER_NOT_READY",
				message:
					"Snapshot filtering is still being prepared. Wait for preparation to finish or retry it.",
			});
		origins.push(state.originProjectionId);
	}
	return [...new Set(origins)].sort();
}

function originRows(
	ctx: QueryCtx,
	args: CatalogIdentity,
	origin: Origin,
	after = -1,
) {
	return ctx.db
		.query("catalogWorkspaceNavigationRows")
		.withIndex(
			"by_projectId_projectionId_firstSeenProjectionId_catalogIndex",
			(q) =>
				q
					.eq("projectId", args.projectId)
					.eq("projectionId", args.projectionId)
					.eq("firstSeenProjectionId", origin)
					.gt("catalogIndex", after),
		);
}

/** Merge indexed cohorts in current Catalog Order. One buffered row per cohort
 * avoids loading an old snapshot or walking unrelated current keys. The whole
 * navigation generation has an 8 MiB envelope; output is additionally bounded. */
export async function originPageBatch(
	ctx: QueryCtx,
	args: CatalogIdentity,
	origins: Origin[],
	after: number,
) {
	// A single selected snapshot needs no merge: native pagination fetches the
	// bounded cohort in one database call rather than one iterator call per key.
	if (origins.length === 1)
		return originRows(ctx, args, origins[0], after).paginate({
			cursor: null,
			numItems: 64,
			maximumBytesRead: 512 * 1024,
		});
	const streams = origins.map((origin) =>
		originRows(ctx, args, origin, after)[Symbol.asyncIterator](),
	);
	try {
		const heads = await Promise.all(streams.map((stream) => stream.next()));
		const page: Doc<"catalogWorkspaceNavigationRows">[] = [];
		let bytes = 0;
		while (page.length < 64) {
			let next = -1;
			for (let index = 0; index < heads.length; index++) {
				const head = heads[index];
				const candidate = heads[next];
				if (
					head &&
					!head.done &&
					(!candidate ||
						candidate.done ||
						head.value.catalogIndex < candidate.value.catalogIndex)
				)
					next = index;
			}
			const head = heads[next];
			if (!head || head.done) break;
			const size = encodedSize(head.value);
			if (page.length && bytes + size > 512 * 1024) break;
			page.push(head.value);
			bytes += size;
			const stream = streams[next];
			if (!stream) throw new Error("Missing snapshot navigation stream");
			heads[next] = await stream.next();
		}
		return { page, isDone: heads.every((head) => head.done) };
	} finally {
		await Promise.all(streams.map((stream) => stream.return?.()));
	}
}

function countPosition(
	cursor: string | undefined,
	scope: string,
	count: number,
) {
	if (!cursor) return { index: 0, cursor: null };
	try {
		if (cursor.length > 16_384) throw new Error("Oversized cursor");
		const value: unknown = JSON.parse(cursor);
		if (
			typeof value !== "object" ||
			value === null ||
			!("scope" in value) ||
			value.scope !== scope ||
			!("index" in value) ||
			typeof value.index !== "number" ||
			!Number.isSafeInteger(value.index) ||
			value.index < 0 ||
			value.index >= count ||
			!("cursor" in value) ||
			(value.cursor !== null && typeof value.cursor !== "string")
		)
			throw new Error("Invalid cursor");
		return { index: value.index, cursor: value.cursor };
	} catch {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Invalid snapshot count cursor. Restart the count.",
		});
	}
}

/** Counting needs no merged ordering, so each request uses one native bounded
 * pagination call and advances to the next selected cohort when exhausted. */
export async function originCountBatch(
	ctx: QueryCtx,
	args: CatalogIdentity & { cursor?: string },
	origins: Origin[],
) {
	const scope = JSON.stringify([args.projectId, args.projectionId, origins]);
	const position = countPosition(args.cursor, scope, origins.length);
	const batch = await originRows(ctx, args, origins[position.index]).paginate({
		cursor: position.cursor,
		numItems: 64,
		maximumBytesRead: 512 * 1024,
	});
	const index = batch.isDone ? position.index + 1 : position.index;
	return {
		page: batch.page,
		isDone: index >= origins.length,
		continueCursor: JSON.stringify({
			scope,
			index,
			cursor: batch.isDone ? null : batch.continueCursor,
		}),
	};
}
