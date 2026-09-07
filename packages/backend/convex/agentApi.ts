import { ConvexError, v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { isReviewOnlyToken } from "./agentReviewModel";
import { hashToken } from "./apiTokens";
import { assertProjectExists } from "./permissions";

const scopeValidator = v.union(
	v.literal("read"),
	v.literal("review"),
	v.literal("search"),
	v.literal("propose"),
	v.literal("export"),
	v.literal("snapshot-submission"),
);

async function authenticate(
	ctx: QueryCtx | MutationCtx,
	rawToken: string,
	scope:
		| "read"
		| "search"
		| "review"
		| "propose"
		| "export"
		| "snapshot-submission",
) {
	const tokenHash = await hashToken(rawToken);
	const token = await ctx.db
		.query("apiTokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
		.unique();
	if (
		!token ||
		token.revokedAt !== undefined ||
		!token.scopes.includes(scope) ||
		(token.scopes.includes("review") && !isReviewOnlyToken(token.scopes))
	) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "Invalid or insufficient API token.",
		});
	}
	await assertProjectExists(ctx, token.projectId);
	return token;
}

export const authenticateToken = internalQuery({
	args: { token: v.string(), scope: scopeValidator },
	handler: async (ctx, args) => await authenticate(ctx, args.token, args.scope),
});

export const cliCompatibility = internalQuery({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		return {
			minimumVersion: project.minimumCliVersion,
			minimumProtocol: project.minimumCliProtocol,
		};
	},
});

export const touchToken = internalMutation({
	args: { tokenId: v.id("apiTokens") },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.tokenId, { lastUsedAt: Date.now() });
		return null;
	},
});

export const currentProject = internalQuery({
	args: { token: v.string() },
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const project = await assertProjectExists(ctx, token.projectId);
		const sourceLocale = project.sourceLocaleId
			? await ctx.db.get(project.sourceLocaleId)
			: null;
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
			.collect();
		const screens = await ctx.db
			.query("screens")
			.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
			.collect();
		const tags = await ctx.db
			.query("tags")
			.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
			.collect();
		return {
			projectId: token.projectId,
			name: project.name,
			sourceLocale: sourceLocale?.code ?? null,
			locales: locales
				.filter((locale) => locale.archivedAt === undefined)
				.map((locale) => locale.code),
			screens: screens
				.filter((screen) => screen.archivedAt === undefined)
				.map((screen) => ({ id: screen._id, slug: screen.slug })),
			tags: tags
				.filter((tag) => tag.archivedAt === undefined)
				.map((tag) => ({ id: tag._id, slug: tag.slug })),
		};
	},
});

export const getChangeSet = internalQuery({
	args: { token: v.string(), changeSetId: v.id("changeSets") },
	handler: async (ctx, args) => {
		const token = await authenticate(ctx, args.token, "read");
		const changeSet = await ctx.db.get(args.changeSetId);
		if (!changeSet || changeSet.projectId !== token.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Change set not found.",
			});
		}
		const items = await ctx.db
			.query("changeSetItems")
			.withIndex("by_changeSet", (q) => q.eq("changeSetId", args.changeSetId))
			.take(51);
		if (items.length > 50)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Historical Change Set exceeds the 50-item read limit.",
			});
		return {
			...changeSet,
			items,
			retired: true,
			migration:
				"Historical evidence only. Create a Translation Task to propose current catalog values.",
		};
	},
});
