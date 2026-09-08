import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getMembership } from "./permissions";
export type GuidanceScope = {
	projectId?: Id<"projects">;
	dictionaryId?: Id<"dictionaries">;
};
type Ctx = MutationCtx | QueryCtx;
export function dictionaryError(code: string, message: string): never {
	throw new ConvexError({ code, message });
}
export async function projectDictionaryConnection(
	ctx: Ctx,
	projectId: Id<"projects">,
) {
	return await ctx.db
		.query("projectDictionaryConnections")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}
export async function dictionaryAccess(
	ctx: Ctx,
	dictionaryId: Id<"dictionaries">,
	userId: string,
) {
	const dictionary = await ctx.db.get(dictionaryId);
	if (!dictionary) dictionaryError("NOT_FOUND", "Dictionary not found.");
	const isOwner = dictionary.ownerUserId === userId;
	const editor = isOwner
		? null
		: await ctx.db
				.query("dictionaryEditors")
				.withIndex("by_dictionary_user", (q) =>
					q.eq("dictionaryId", dictionaryId).eq("userId", userId),
				)
				.unique();
	return { dictionary, isOwner, canEdit: isOwner || editor !== null };
}
export async function requireDictionaryEdit(
	ctx: Ctx,
	dictionaryId: Id<"dictionaries">,
	userId: string,
) {
	const access = await dictionaryAccess(ctx, dictionaryId, userId);
	if (!access.canEdit)
		dictionaryError(
			"FORBIDDEN",
			"Dictionary editing requires its owner or editor permission.",
		);
	return access;
}
export async function requireDictionaryRead(
	ctx: Ctx,
	dictionaryId: Id<"dictionaries">,
	userId: string,
) {
	const access = await dictionaryAccess(ctx, dictionaryId, userId);
	if (access.canEdit) return access;
	for await (const link of ctx.db
		.query("projectDictionaryConnections")
		.withIndex("by_dictionary", (q) => q.eq("dictionaryId", dictionaryId))) {
		const project = await ctx.db.get(link.projectId);
		if (
			project &&
			project.archivedAt === undefined &&
			(await getMembership(ctx, link.projectId, userId))
		)
			return access;
	}
	dictionaryError("FORBIDDEN", "Dictionary access required.");
}
export function guidanceState(ctx: Ctx, scope: GuidanceScope) {
	return scope.dictionaryId
		? ctx.db
				.query("translationGuidanceStates")
				.withIndex("by_dictionary", (q) =>
					q.eq("dictionaryId", scope.dictionaryId),
				)
				.unique()
		: ctx.db
				.query("translationGuidanceStates")
				.withIndex("by_project", (q) => q.eq("projectId", scope.projectId))
				.unique();
}
export function guidanceEntries(ctx: Ctx, scope: GuidanceScope) {
	return scope.dictionaryId
		? ctx.db
				.query("translationGuidanceEntries")
				.withIndex("by_dictionary_and_key", (q) =>
					q.eq("dictionaryId", scope.dictionaryId),
				)
		: ctx.db
				.query("translationGuidanceEntries")
				.withIndex("by_project_and_key", (q) =>
					q.eq("projectId", scope.projectId),
				);
}
export function guidanceEntry(ctx: Ctx, scope: GuidanceScope, key: string) {
	return scope.dictionaryId
		? ctx.db
				.query("translationGuidanceEntries")
				.withIndex("by_dictionary_and_key", (q) =>
					q.eq("dictionaryId", scope.dictionaryId).eq("key", key),
				)
				.unique()
		: ctx.db
				.query("translationGuidanceEntries")
				.withIndex("by_project_and_key", (q) =>
					q.eq("projectId", scope.projectId).eq("key", key),
				)
				.unique();
}
export async function resolveDictionaryWrite(
	ctx: Ctx,
	input: GuidanceScope & {
		authoredBy: { kind: "user" | "agent"; id: string };
		expectedDictionaryId?: Id<"dictionaries">;
		expectedConnectionRevision?: number;
	},
): Promise<GuidanceScope> {
	if (input.dictionaryId) {
		if (input.authoredBy.kind !== "user")
			dictionaryError(
				"FORBIDDEN",
				"Standalone Dictionary writes require a Dictionary editor.",
			);
		await requireDictionaryEdit(ctx, input.dictionaryId, input.authoredBy.id);
		return { dictionaryId: input.dictionaryId };
	}
	if (!input.projectId)
		dictionaryError("VALIDATION", "Dictionary owner missing.");
	const link = await projectDictionaryConnection(ctx, input.projectId);
	if (!link?.dictionaryId) {
		const project = await ctx.db.get(input.projectId);
		if (project?.type !== undefined)
			dictionaryError("BAD_STATE", "Connect a Dictionary first.");
		if (input.expectedDictionaryId !== undefined)
			dictionaryError("STALE_BASIS", "Dictionary connection changed.");
		return { projectId: input.projectId };
	}
	if (input.authoredBy.kind === "user")
		await requireDictionaryEdit(ctx, link.dictionaryId, input.authoredBy.id);
	if (
		input.expectedDictionaryId !== link.dictionaryId ||
		input.expectedConnectionRevision !== link.revision
	)
		dictionaryError(
			"STALE_BASIS",
			"Read the connected Dictionary and include its identity and connection revision before writing.",
		);
	if (input.authoredBy.kind === "agent" && !link.agentWriteEnabled)
		dictionaryError(
			"FORBIDDEN",
			"This Dictionary has not granted agent writes to this project.",
		);
	return { dictionaryId: link.dictionaryId };
}
