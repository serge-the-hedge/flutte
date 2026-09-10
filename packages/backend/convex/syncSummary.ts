import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import type { CatalogDocument } from "./catalogDocument";

export const syncSummaryValidator = v.object({
	sourceKeyCount: v.number(),
	addedKeyCount: v.number(),
	changedSourceKeyCount: v.number(),
	removedKeyCount: v.number(),
	targetValueChangeCount: v.number(),
});

function equalMetadata(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object"
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => equalMetadata(value, right[index]))
		);
	const leftEntries = Object.entries(left);
	const rightEntries = new Map(Object.entries(right));
	return (
		leftEntries.length === rightEntries.size &&
		leftEntries.every(
			([key, value]) =>
				rightEntries.has(key) && equalMetadata(value, rightEntries.get(key)),
		)
	);
}

/** Count immutable Git source evidence while ingestion already has both documents.
 * Metadata order and JSON formatting do not manufacture source changes. */
export function sourceSyncSummary(
	previous: CatalogDocument | null,
	current: CatalogDocument,
) {
	const previousById = new Map(
		previous?.messages.map((message) => [message.id, message]),
	);
	let addedKeyCount = 0;
	let changedSourceKeyCount = 0;
	for (const message of current.messages) {
		const before = previousById.get(message.id);
		if (!before) addedKeyCount++;
		else if (
			before.value !== message.value ||
			!equalMetadata(before.metadata, message.metadata)
		)
			changedSourceKeyCount++;
		previousById.delete(message.id);
	}
	return {
		sourceKeyCount: current.messages.length,
		addedKeyCount,
		changedSourceKeyCount,
		removedKeyCount: previousById.size,
		targetValueChangeCount: 0,
	};
}

/** A receipt is a bounded read of recorded transition facts, never a fresh catalog
 * diff. Missing historical statistics stay unknown rather than becoming zeros. */
export async function readSyncSummary(
	ctx: QueryCtx,
	run: Doc<"snapshotIngestionRuns">,
) {
	const snapshot = run.snapshotId ? await ctx.db.get(run.snapshotId) : null;
	const projection = snapshot
		? await ctx.db
				.query("catalogProjections")
				.withIndex("by_project_and_snapshot_and_status", (q) =>
					q
						.eq("projectId", run.projectId)
						.eq("snapshotId", snapshot._id)
						.eq("status", "published"),
				)
				.order("asc")
				.first()
		: null;
	return {
		commit: run.commit,
		snapshotKind: snapshot?.kind ?? null,
		summary: projection?.syncSummary
			? {
					outcome: projection.previousBaselineSnapshotId
						? ("updated" as const)
						: ("initial" as const),
					...projection.syncSummary,
				}
			: null,
	};
}
