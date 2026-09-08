import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import { requireUser } from "./auth";
import type { Role } from "./lib";

export type RepositoryAdapterActor = {
	kind: "repositoryAdapter";
	id: string;
};

export const repositoryAdapterActorValidator = v.object({
	kind: v.literal("repositoryAdapter"),
	id: v.string(),
});

/** Authorizes either the signed-in editor path or a previously authenticated
 * Repository Adapter token. Internal staging mutations use this seam so the
 * HTTP transport does not impersonate a browser user. */
export async function authorizeProjectIngestion(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	actor?: RepositoryAdapterActor,
) {
	const project = await assertProjectExists(ctx, projectId);
	if (project.type === "basic")
		throw new ConvexError({
			code: "BAD_STATE",
			message: "Repository sync belongs to a repository project.",
		});
	if (!actor) {
		const { userId } = await requireEditor(ctx, projectId);
		return { kind: "user" as const, id: userId };
	}
	const token = await ctx.db.get(actor.id as Id<"apiTokens">);
	if (
		!token ||
		token.projectId !== projectId ||
		token.revokedAt !== undefined ||
		!token.scopes.includes("snapshot-submission")
	) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "Invalid or insufficient snapshot-submission token.",
		});
	}
	return actor;
}

export async function getMembership(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	userId: string,
): Promise<Doc<"projectMembers"> | null> {
	return await ctx.db
		.query("projectMembers")
		.withIndex("by_project_user", (q) =>
			q.eq("projectId", projectId).eq("userId", userId),
		)
		.unique();
}

export async function requireProjectRole(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	minimumRole: Role,
): Promise<{ userId: string; member: Doc<"projectMembers"> }> {
	const user = await requireUser(ctx);
	const project = await assertProjectExists(ctx, projectId);
	if (project.migrationPending && minimumRole !== "viewer")
		throw new ConvexError({
			code: "BAD_STATE",
			message:
				"Project content is still moving. Editing is available after completion.",
		});
	const member = await getMembership(ctx, projectId, user.id);
	if (!member || !hasMinimumRole(member.role, minimumRole)) {
		throw new ConvexError({
			code: "FORBIDDEN",
			message: "Insufficient project permissions.",
		});
	}
	return { userId: user.id, member };
}

export async function requireViewer(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
) {
	return await requireProjectRole(ctx, projectId, "viewer");
}

export async function requireEditor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
) {
	return await requireProjectRole(ctx, projectId, "editor");
}

export async function requireOwner(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
) {
	return await requireProjectRole(ctx, projectId, "owner");
}

export async function assertProjectExists(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"projects">> {
	const project = await ctx.db.get(projectId);
	if (!project || project.archivedAt !== undefined) {
		throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
	}
	return project;
}
