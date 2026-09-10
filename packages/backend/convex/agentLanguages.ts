import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type QueryCtx,
} from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import { MAX_PROJECTED_LOCALES } from "./catalogProjection";
import { addManagedLocale, collectionMemberships } from "./contentCollections";
import { isRepositoryLocale, normalizeLocaleCode } from "./lib";
import {
	configuredIntroductionTargets,
	introductionTargetFor,
	saveIntroductionTarget,
} from "./localeIntroductionTargets";
import { updateLocaleMetadata } from "./locales";

const languageValidator = v.object({
	id: v.id("locales"),
	code: v.string(),
	label: v.string(),
	isSource: v.boolean(),
	canEditCode: v.boolean(),
	canEditLabel: v.boolean(),
});
const targetValidator = v.object({
	id: v.id("localeIntroductionTargets"),
	localeCode: v.string(),
	label: v.string(),
	catalogPath: v.string(),
	runtimeLocale: v.string(),
	updatedAt: v.number(),
});

/** Managed membership bounds target languages; the Source is additional. */
async function basicLanguages(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	collectionId: Id<"contentCollections"> | undefined,
) {
	const [source, memberships] = await Promise.all([
		ctx.db
			.query("locales")
			.withIndex("by_project_source", (q) =>
				q.eq("projectId", projectId).eq("isSource", true),
			)
			.unique(),
		collectionId ? collectionMemberships(ctx, collectionId) : [],
	]);
	const targets = await Promise.all(
		memberships
			.filter((row) => row.active)
			.map((row) => ctx.db.get(row.localeId)),
	);
	return [source, ...targets].flatMap((locale) =>
		locale !== null &&
		locale.projectId === projectId &&
		locale.archivedAt === undefined
			? [locale]
			: [],
	);
}

/** Installed languages and planned repository targets are distinct identities. */
export const list = internalQuery({
	args: { token: v.string() },
	returns: v.object({
		projectType: v.union(v.literal("basic"), v.literal("repository")),
		canWrite: v.boolean(),
		languages: v.array(languageValidator),
		introductionTargets: v.array(targetValidator),
	}),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "read");
		const basic = token.projectType === "basic";
		const locales = basic
			? await basicLanguages(ctx, token.projectId, token.managedCollectionId)
			: await ctx.db
					.query("locales")
					.withIndex("by_project", (q) => q.eq("projectId", token.projectId))
					.take(MAX_PROJECTED_LOCALES + 1);
		if (!basic && locales.length > MAX_PROJECTED_LOCALES)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Language configuration exceeds the supported project size.",
			});
		const canWrite = token.scopes.includes("languages-write");
		const languages = locales
			.filter(
				(locale) =>
					!locale.pendingBinding && (basic || isRepositoryLocale(locale)),
			)
			.map((locale) => ({
				id: locale._id,
				code: locale.code,
				label: locale.label,
				isSource: locale.isSource,
				canEditCode: canWrite && basic,
				canEditLabel: canWrite,
			}));
		const installedCodes = new Set(
			locales.filter(isRepositoryLocale).map((locale) => locale.code),
		);
		const introductionTargets = basic
			? []
			: (await configuredIntroductionTargets(ctx, token.projectId))
					.filter((target) => !installedCodes.has(target.localeCode))
					.map((target) => ({
						id: target._id,
						localeCode: target.localeCode,
						label: target.label,
						catalogPath: target.catalogPath,
						runtimeLocale: target.runtimeLocale,
						updatedAt: target.updatedAt,
					}));
		return {
			projectType: token.projectType,
			canWrite,
			languages,
			introductionTargets,
		};
	},
});

/** Basic additions activate membership; repository additions only configure a future proposal. */
export const add = internalMutation({
	args: {
		token: v.string(),
		code: v.string(),
		label: v.optional(v.string()),
		catalogPath: v.optional(v.string()),
		runtimeLocale: v.optional(v.string()),
		expectedUpdatedAt: v.optional(v.number()),
	},
	returns: v.union(
		v.object({
			kind: v.literal("language"),
			localeId: v.id("locales"),
			membershipRevision: v.number(),
		}),
		v.object({
			kind: v.literal("introductionTarget"),
			targetId: v.id("localeIntroductionTargets"),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "languages-write");
		if (token.projectType === "basic") {
			if (
				args.catalogPath !== undefined ||
				args.runtimeLocale !== undefined ||
				args.expectedUpdatedAt !== undefined
			)
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"Basic projects accept code and label only; repository configuration does not apply.",
				});
			if (!token.managedCollectionId)
				throw new ConvexError({
					code: "BAD_STATE",
					message: "The Basic project's content is not ready.",
				});
			return {
				kind: "language" as const,
				...(await addManagedLocale(ctx, {
					projectId: token.projectId,
					collectionId: token.managedCollectionId,
					code: args.code,
					label: args.label,
				})),
			};
		}
		if (
			args.label === undefined ||
			args.catalogPath === undefined ||
			args.runtimeLocale === undefined
		)
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Repository languages require label, catalogPath, and runtimeLocale. This configures an introduction target. Translate and review its proposal, merge it, then sync and bind the new catalog in Sync.",
			});
		const existing = await introductionTargetFor(
			ctx,
			token.projectId,
			normalizeLocaleCode(args.code),
		);
		if (existing && args.expectedUpdatedAt !== existing.updatedAt)
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"Read /languages and provide the target's expectedUpdatedAt before editing its configuration.",
			});
		if (!existing && args.expectedUpdatedAt !== undefined)
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The introduction target no longer exists. Read /languages before adding it again.",
			});
		const targetId = await saveIntroductionTarget(
			ctx,
			{
				projectId: token.projectId,
				localeCode: args.code,
				label: args.label,
				catalogPath: args.catalogPath,
				runtimeLocale: args.runtimeLocale,
			},
			`agent:${token._id}`,
		);
		const target = await ctx.db.get(targetId);
		if (!target) throw new Error("Saved language target is missing.");
		return {
			kind: "introductionTarget" as const,
			targetId,
			updatedAt: target.updatedAt,
		};
	},
});

export const update = internalMutation({
	args: {
		token: v.string(),
		localeId: v.id("locales"),
		code: v.string(),
		label: v.string(),
		expectedCode: v.string(),
		expectedLabel: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { token: rawToken, ...args }) => {
		const token = await authenticateAgent(ctx, rawToken, "languages-write");
		await updateLocaleMetadata(
			ctx,
			{ projectId: token.projectId, ...args },
			{ kind: "agent", id: token._id },
		);
		return null;
	},
});
