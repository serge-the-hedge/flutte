import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** Snapshot evidence stays immutable; discovery reflects current active bindings. */
export async function readCatalogDiscovery(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	const [files, locales] = await Promise.all([
		ctx.db
			.query("sourceSnapshotUnboundFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
			.take(1001),
		ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", projectId))
			.take(1001),
	]);
	if (files.length > 1000 || locales.length > 1000)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message:
				"Catalog discovery exceeds the supported 1,000-file or language limit.",
		});
	const boundPaths = new Set(
		locales
			.filter((locale) => locale.archivedAt === undefined)
			.map((locale) => locale.catalogPath),
	);
	return {
		locales,
		files: files
			.filter((file) => !boundPaths.has(file.catalogPath))
			.sort((a, b) => a.catalogPath.localeCompare(b.catalogPath)),
	};
}
