import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
} from "./_generated/server";
import { activeProjectionFor } from "./catalogProjection";
import {
	navigationStateFor,
	navigationStateIsReady,
	ORDINARY_IMPORT_POLICY_VERSION,
	readyNavigationStateFor,
} from "./catalogWorkspaceNavigation";
import { requireViewer } from "./permissions";

type Digest = Pick<
	Doc<"catalogWorkspaceNavigationRows">,
	"catalogIndex" | "messageId" | "firstSeenProjectionId" | "targets"
>;
type BrowseState = Doc<"catalogBrowseStates">;

export function focusFlags(row: Digest) {
	return {
		hasWaiting: row.targets.some((target) => target.valueState === "waiting"),
		hasUnconfirmedImport: row.targets.some(
			(target) => target.valueState === "unconfirmedImport",
		),
		hasStale: row.targets.some((target) => target.valueState === "stale"),
		hasIntroduced: row.targets.some((target) => target.firstReviewPending),
		hasChangedInGit: row.targets.some((target) => target.changedInGitPending),
	};
}
export async function browseStateFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
) {
	return ctx.db
		.query("catalogBrowseStates")
		.withIndex("by_projectId", (q) => q.eq("projectId", projectId))
		.unique();
}
export async function preparedBrowseState(
	ctx: QueryCtx | MutationCtx,
	projection: Doc<"catalogProjections">,
) {
	const state = await browseStateFor(ctx, projection.projectId);
	return state?.projectionId === projection._id &&
		state.policyVersion === ORDINARY_IMPORT_POLICY_VERSION &&
		state.keyCount === projection.expectedKeyCount
		? state
		: null;
}
export async function invalidateBrowseState(
	ctx: MutationCtx,
	projectId: Id<"projects">,
) {
	const state = await browseStateFor(ctx, projectId);
	if (state) await ctx.db.delete(state._id);
}
function classification(row: Digest) {
	return JSON.stringify([
		row.messageId,
		row.catalogIndex,
		row.firstSeenProjectionId,
		row.targets.map((target) => [
			target.localeId,
			target.valueState,
			target.firstReviewPending === true,
			target.changedInGitPending === true,
		]),
	]);
}
function adjustCounts(
	state: Pick<BrowseState, "localeCounts" | "introduced" | "changedInGit">,
	row: Digest,
	direction: 1 | -1,
	byLocale = new Map(
		state.localeCounts.map((count) => [count.localeId, count]),
	),
) {
	const flags = focusFlags(row);
	state.introduced += Number(flags.hasIntroduced) * direction;
	state.changedInGit += Number(flags.hasChangedInGit) * direction;
	for (const target of row.targets) {
		let counts = byLocale.get(target.localeId);
		if (!counts) {
			counts = {
				localeId: target.localeId,
				waiting: 0,
				unconfirmedImport: 0,
				stale: 0,
				settled: 0,
			};
			state.localeCounts.push(counts);
			byLocale.set(target.localeId, counts);
		}
		counts[target.valueState] += direction;
	}
}
/** Text changes retain the strict navigation revision but do not invalidate
 * focus membership or counts. During backfill, only its completed prefix is
 * included in aggregate totals; concurrent edits update that prefix atomically. */
export async function updateBrowseClassification(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
	previous: Digest | null,
	next: Digest | null,
) {
	if (previous && next && classification(previous) === classification(next))
		return;
	const state = await browseStateFor(ctx, projectId);
	if (!state || state.projectionId !== projectionId) return;
	if (previous && (state.indexReady || previous.catalogIndex <= state.after))
		adjustCounts(state, previous, -1);
	if (next && (state.indexReady || next.catalogIndex <= state.after))
		adjustCounts(state, next, 1);
	await ctx.db.patch(state._id, {
		classificationRevision: state.classificationRevision + 1,
		localeCounts: state.localeCounts,
		introduced: state.introduced,
		changedInGit: state.changedInGit,
	});
}
export async function syncBrowseOrdinaryCounts(
	ctx: MutationCtx,
	state: Doc<"catalogWorkspaceNavigationStates">,
) {
	const browse = await browseStateFor(ctx, state.projectId);
	if (
		browse?.projectionId === state.projectionId &&
		state.ordinaryImportCounts &&
		Object.keys(state.ordinaryImportCounts).some(
			(field) =>
				browse.ordinaryImportCounts[
					field as keyof typeof state.ordinaryImportCounts
				] !==
				state.ordinaryImportCounts?.[
					field as keyof typeof state.ordinaryImportCounts
				],
		)
	)
		await ctx.db.patch(browse._id, {
			ordinaryImportCounts: state.ordinaryImportCounts,
		});
}

/** Automatic optimization only: canonical navigation must already be complete.
 * A durable scheduled-function status makes reopening safely retry failed jobs. */
export async function prepareBrowseIndex(
	ctx: MutationCtx,
	projectId: Id<"projects">,
): Promise<void> {
	const projection = await activeProjectionFor(ctx, projectId);
	if (!projection) return;
	const navigation = await navigationStateFor(ctx, projectId);
	if (
		!navigationStateIsReady(navigation, {
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		})
	)
		return;
	let state = await preparedBrowseState(ctx, projection);
	if (!state) {
		await invalidateBrowseState(ctx, projectId);
		const id = await ctx.db.insert("catalogBrowseStates", {
			projectId,
			projectionId: projection._id,
			policyVersion: ORDINARY_IMPORT_POLICY_VERSION,
			classificationRevision: 0,
			keyCount: projection.expectedKeyCount,
			indexReady: false,
			after: -1,
			ordinaryImportCounts: navigation.ordinaryImportCounts,
			localeCounts: [],
			introduced: 0,
			changedInGit: 0,
		});
		state = await ctx.db.get(id);
	}
	if (!state || state.indexReady) return;
	if (state.jobId) {
		const job = await ctx.db.system.get(state.jobId);
		if (job?.state.kind === "pending" || job?.state.kind === "inProgress")
			return;
	}
	const jobId = await ctx.scheduler.runAfter(
		0,
		internal.catalogBrowseIndex.backfill,
		{ projectId, projectionId: projection._id },
	);
	await ctx.db.patch(state._id, { jobId });
}
export const ensurePrepared = mutation({
	args: { projectId: v.id("projects") },
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		await prepareBrowseIndex(ctx, args.projectId);
		return null;
	},
});
export const backfill = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection || projection._id !== args.projectionId) return null;
		const state = await preparedBrowseState(ctx, projection);
		if (!state || state.indexReady) return null;
		await readyNavigationStateFor(ctx, {
			...args,
			expectedRowCount: projection.expectedKeyCount,
		});
		const batch = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("projectionId", args.projectionId)
					.gt("catalogIndex", state.after),
			)
			.paginate({ cursor: null, numItems: 64, maximumBytesRead: 512 * 1024 });
		const byLocale = new Map(
			state.localeCounts.map((count) => [count.localeId, count]),
		);
		for (const row of batch.page) {
			const flags = focusFlags(row);
			if (
				Object.entries(flags).some(
					([field, value]) => row[field as keyof typeof flags] !== value,
				)
			)
				await ctx.db.patch(row._id, flags);
			adjustCounts(state, row, 1, byLocale);
		}
		const jobId = batch.isDone
			? undefined
			: await ctx.scheduler.runAfter(
					0,
					internal.catalogBrowseIndex.backfill,
					args,
				);
		await ctx.db.patch(state._id, {
			indexReady: batch.isDone,
			after: batch.page[batch.page.length - 1]?.catalogIndex ?? state.after,
			localeCounts: state.localeCounts,
			introduced: state.introduced,
			changedInGit: state.changedInGit,
			jobId,
		});
		return null;
	},
});

/** The candidate index keeps Catalog Order; locale, tag, and origin intersections
 * are still checked by the shared matcher, preserving exact filter semantics. */
export function focusCandidateQuery(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
	scope:
		| "waiting"
		| "unconfirmedImport"
		| "stale"
		| "introduced"
		| "changedInGit",
	after: number,
) {
	const rows = ctx.db.query("catalogWorkspaceNavigationRows");
	switch (scope) {
		case "waiting":
			return rows.withIndex(
				"by_projectId_projectionId_hasWaiting_catalogIndex",
				(q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("hasWaiting", true)
						.gt("catalogIndex", after),
			);
		case "unconfirmedImport":
			return rows.withIndex(
				"by_projectId_projectionId_hasUnconfirmedImport_catalogIndex",
				(q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("hasUnconfirmedImport", true)
						.gt("catalogIndex", after),
			);
		case "stale":
			return rows.withIndex(
				"by_projectId_projectionId_hasStale_catalogIndex",
				(q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("hasStale", true)
						.gt("catalogIndex", after),
			);
		case "introduced":
			return rows.withIndex(
				"by_projectId_projectionId_hasIntroduced_catalogIndex",
				(q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("hasIntroduced", true)
						.gt("catalogIndex", after),
			);
		case "changedInGit":
			return rows.withIndex(
				"by_projectId_projectionId_hasChangedInGit_catalogIndex",
				(q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("hasChangedInGit", true)
						.gt("catalogIndex", after),
			);
	}
}
