import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { normalizeCatalogPath } from "./catalogPaths";
import { normalizeLocaleCode, now } from "./lib";
import { requireEditor, requireViewer } from "./permissions";

export const MAX_LOCALE_INTRODUCTION_TARGETS = 128;
type ReadCtx = QueryCtx | MutationCtx;

export async function introductionTargetFor(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	localeCode: string,
) {
	return await ctx.db
		.query("localeIntroductionTargets")
		.withIndex("by_project_and_localeCode", (q) =>
			q.eq("projectId", projectId).eq("localeCode", localeCode),
		)
		.unique();
}

export async function configuredIntroductionTargets(
	ctx: ReadCtx,
	projectId: Id<"projects">,
) {
	return await ctx.db
		.query("localeIntroductionTargets")
		.withIndex("by_project_and_localeCode", (q) => q.eq("projectId", projectId))
		.take(MAX_LOCALE_INTRODUCTION_TARGETS);
}

export const list = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return await configuredIntroductionTargets(ctx, args.projectId);
	},
});

/** The current Flutter adapter generates catalogs beside its bound Source file. */
export function assertIntroductionCatalogPath(
	catalogPath: string,
	sourceCatalogPath?: string,
) {
	const basename = catalogPath.slice(catalogPath.lastIndexOf("/") + 1);
	if (
		!/^[A-Za-z0-9_-]+\.arb$/.test(basename) ||
		(sourceCatalogPath !== undefined &&
			catalogPath.slice(0, catalogPath.lastIndexOf("/") + 1) !==
				sourceCatalogPath.slice(0, sourceCatalogPath.lastIndexOf("/") + 1))
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"The Flutter adapter needs an ARB filename containing letters, numbers, underscores or hyphens in the same directory as the bound Source catalog.",
		});
	}
}

const targetFields = {
	localeCode: v.string(),
	label: v.string(),
	catalogPath: v.string(),
	runtimeLocale: v.string(),
};

/** Configuration controls future proposals. Existing proposals retain their pinned identity. */
export const save = mutation({
	args: { projectId: v.id("projects"), ...targetFields },
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const localeCode = normalizeLocaleCode(args.localeCode);
		const label = args.label.trim();
		const catalogPath = normalizeCatalogPath(args.catalogPath);
		const runtimeLocale = args.runtimeLocale.trim();
		if (runtimeLocale.split("-")[0] !== localeCode)
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"The runtime locale must use the same language as the catalog code.",
			});
		if (
			!/^[a-z]{2,3}$/.test(localeCode) ||
			!label ||
			label.length > 128 ||
			catalogPath.length > 512 ||
			!catalogPath.endsWith(".arb") ||
			!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/.test(
				runtimeLocale,
			)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"This Flutter adapter needs a language-only catalog code (2–3 letters), a label, an ARB path, and an explicit runtime locale (language, optional Script and REGION).",
			});
		}
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(MAX_LOCALE_INTRODUCTION_TARGETS + 1);
		if (locales.length > MAX_LOCALE_INTRODUCTION_TARGETS)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Locale setup exceeds its configuration envelope.",
			});
		assertIntroductionCatalogPath(
			catalogPath,
			locales.find((locale) => locale.isSource)?.catalogPath,
		);
		if (
			locales.some(
				(locale) =>
					(locale.code === localeCode && locale.archivedAt === undefined) ||
					(locale.catalogPath === catalogPath && locale.code !== localeCode),
			)
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The Locale is already active or its catalog path is claimed by another Locale.",
			});
		}
		const targets = await configuredIntroductionTargets(ctx, args.projectId);
		if (
			targets.some(
				(target) =>
					target.catalogPath === catalogPath &&
					target.localeCode !== localeCode,
			)
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Another introduction target already uses this catalog path.",
			});
		const existing = targets.find((target) => target.localeCode === localeCode);
		const fields = {
			localeCode,
			label,
			catalogPath,
			runtimeLocale,
			updatedBy: userId,
			updatedAt: now(),
		};
		if (existing) {
			await ctx.db.patch(existing._id, fields);
			return existing._id;
		}
		if (targets.length >= MAX_LOCALE_INTRODUCTION_TARGETS)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "At most 128 Locale introduction targets can be configured.",
			});
		return await ctx.db.insert("localeIntroductionTargets", {
			projectId: args.projectId,
			...fields,
			createdAt: now(),
		});
	},
});

/** Removing setup never removes a prepared proposal or its review evidence. */
export const remove = mutation({
	args: { projectId: v.id("projects"), localeCode: v.string() },
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const target = await introductionTargetFor(
			ctx,
			args.projectId,
			args.localeCode,
		);
		if (target) await ctx.db.delete(target._id);
		return null;
	},
});
