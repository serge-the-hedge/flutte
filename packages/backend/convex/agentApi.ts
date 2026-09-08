import { ConvexError, v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { isReviewOnlyToken } from "./agentReviewModel";
import { hashToken } from "./apiTokens";
import { MAX_PROJECTED_LOCALES } from "./catalogProjection";
import { collectionMemberships } from "./contentCollections";
import { projectDictionaryConnection } from "./dictionaryAccess";
import {
	isRepositoryLocale,
	type TokenScope,
	tokenScopeValidator,
} from "./lib";
import { configuredIntroductionTargets } from "./localeIntroductionTargets";
import { assertProjectExists } from "./permissions";

export async function authenticateAgent(
	ctx: QueryCtx | MutationCtx,
	rawToken: string,
	scope: TokenScope,
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
	const project = await assertProjectExists(ctx, token.projectId);
	if (project.migrationPending)
		throw new ConvexError({
			code: "BAD_STATE",
			message: "Project content is still moving. Retry after completion.",
		});
	return {
		...token,
		projectType: project.type ?? ("repository" as const),
		managedCollectionId: project.managedCollectionId,
	};
}

export const authenticateToken = internalQuery({
	args: { token: v.string(), scope: tokenScopeValidator },
	handler: async (ctx, args) =>
		await authenticateAgent(ctx, args.token, args.scope),
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
		const token = await authenticateAgent(ctx, args.token, "read");
		const project = await assertProjectExists(ctx, token.projectId);
		const dictionary = await projectDictionaryConnection(ctx, token.projectId);
		const sourceLocale = project.sourceLocaleId
			? await ctx.db.get(project.sourceLocaleId)
			: null;
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
			.collect();

		const introductionTargets = (
			await configuredIntroductionTargets(ctx, token.projectId)
		)
			.filter(
				(target) =>
					!locales.some(
						(locale) =>
							locale.code === target.localeCode && isRepositoryLocale(locale),
					),
			)
			.map(({ localeCode, label, catalogPath, runtimeLocale }) => ({
				localeCode,
				label,
				catalogPath,
				runtimeLocale,
			}));
		const basicLocaleIds =
			project.type === "basic" && project.managedCollectionId
				? new Set(
						(await collectionMemberships(ctx, project.managedCollectionId))
							.filter((m) => m.active)
							.map((m) => m.localeId),
					)
				: null;
		return {
			projectId: token.projectId,
			name: project.name,
			type: project.type ?? "repository",
			managedCollectionId: project.managedCollectionId ?? null,
			sourceLocale: sourceLocale?.code ?? null,
			locales: locales
				.filter((locale) =>
					project.type === "basic"
						? locale.archivedAt === undefined &&
							(locale.isSource || basicLocaleIds?.has(locale._id))
						: isRepositoryLocale(locale),
				)
				.map((locale) => locale.code),
			tokenScopes: token.scopes,
			localeIntroductionTargets: introductionTargets,
			capabilities: {
				collections: project.type === undefined,
				format: project.type === "basic" ? "plain" : "icu",
				download: project.type === "basic",
				search: {
					engine: "literal",
					fields: ["key", "source", "target"],
					modes: ["substring", "exact"],
					maxResults: 50,
					continuation: true,
					confirmedExamples: true,
				},
				context: {
					maxKeys: 50,
					maxLocales: 20,
					maxPairs: 128,
					guidance: true,
					codeContext: "unavailable",
				},
				newLocaleTargets: introductionTargets.map(
					(target) => target.localeCode,
				),
				maxBoundLocales: MAX_PROJECTED_LOCALES,
				reviewedProposalExamples: true,
				dictionary: {
					batchWrites: true,
					writeScope: "dictionary-write",
					canWrite:
						token.scopes.includes("dictionary-write") &&
						(dictionary?.dictionaryId
							? dictionary.agentWriteEnabled
							: project.type === undefined),
					id: dictionary?.dictionaryId ?? null,
				},
			},
		};
	},
});

export const getChangeSet = internalQuery({
	args: { token: v.string(), changeSetId: v.id("changeSets") },
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
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
