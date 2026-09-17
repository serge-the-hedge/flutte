import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export function sourceProposalStateFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
) {
	return ctx.db
		.query("catalogWorkspaceSourceProposalStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

type Project = Pick<Doc<"projects">, "_id" | "sourceProposalHeadVersion">;

function revisionFor(
	project: Project,
	state: Doc<"catalogWorkspaceSourceProposalStates"> | null,
) {
	// Older projects keep their counter until the first proposal write moves it.
	const revision =
		state?.proposalSetRevision ?? project.sourceProposalHeadVersion ?? 0;
	if (!Number.isSafeInteger(revision) || revision < 0)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Proposal head version is invalid.",
		});
	return revision;
}

/** Strict source/restore proposal identity for staged publication and cursors. */
export async function sourceProposalSetRevision(
	ctx: QueryCtx | MutationCtx,
	project: Project,
) {
	return revisionFor(project, await sourceProposalStateFor(ctx, project._id));
}

/** Proposal writes must not invalidate every reader of stable project metadata. */
export async function advanceSourceProposalSetRevision(
	ctx: MutationCtx,
	project: Project,
) {
	const state = await sourceProposalStateFor(ctx, project._id);
	const proposalSetRevision = revisionFor(project, state) + 1;
	if (state) {
		await ctx.db.patch(state._id, { proposalSetRevision });
	} else {
		await ctx.db.insert("catalogWorkspaceSourceProposalStates", {
			projectId: project._id,
			headCount: 0,
			headByteLength: 0,
			proposalSetRevision,
		});
	}
}
