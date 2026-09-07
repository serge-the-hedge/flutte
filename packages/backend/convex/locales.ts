import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { normalizeLocaleCode, now } from "./lib";
import {
	assertProjectExists,
	requireEditor,
	requireViewer,
} from "./permissions";
import { correctGuidanceLocaleCode } from "./translationGuidance";

/**
 * Check and tidy a repository-relative catalog file path for a Locale Binding.
 * Returns the tidied path; throws when it is not a path inside the repository.
 *
 * Deliberately strict, because a binding names a file the delivery command
 * will later write inside somebody's checkout: a path that escapes the
 * repository or points at an absolute location is refused when it is typed
 * rather than when it is used.
 *
 * `.` segments are dropped so that two spellings of one file — `lib/l10n/x.arb`
 * and `lib/./l10n/x.arb` — cannot be claimed by two different Locales.
 */
export function normalizeCatalogPath(input: string): string {
	const invalid = (reason: string): never => {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Catalog path ${reason}.`,
		});
	};

	const raw = input.trim();
	if (raw.length === 0) invalid("cannot be empty");
	if (raw.startsWith("/")) invalid("must be relative to the repository root");
	if (raw.endsWith("/")) invalid("must name a file, not a directory");
	if (raw.includes("\\")) invalid("must use forward slashes");
	if (raw.includes("\0")) invalid("contains an invalid character");

	const segments = raw.split("/");
	if (segments.some((segment) => segment === "..")) {
		invalid("cannot point outside the repository");
	}
	if (segments.some((segment) => segment.length === 0)) {
		invalid("cannot contain an empty segment");
	}

	const path = segments.filter((segment) => segment !== ".").join("/");
	if (path.length === 0) invalid("must name a file");
	return path;
}

export const list = query({
	args: {
		projectId: v.id("projects"),
		includeArchived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect();
		return args.includeArchived
			? locales
			: locales.filter((locale) => locale.archivedAt === undefined);
	},
});

export const create = mutation({
	args: {
		projectId: v.id("projects"),
		code: v.string(),
		label: v.optional(v.string()),
		isSource: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const project = await assertProjectExists(ctx, args.projectId);
		const code = normalizeLocaleCode(args.code);
		const existing = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", args.projectId).eq("code", code),
			)
			.unique();
		if (existing && existing.archivedAt === undefined) {
			throw new ConvexError({
				code: "CONFLICT",
				message: "Locale already exists.",
			});
		}
		if (args.isSource && project.sourceLocaleId !== undefined) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Project already has a source locale.",
			});
		}
		const isSource =
			args.isSource === true || project.sourceLocaleId === undefined;
		const timestamp = now();
		const localeId =
			existing && existing.archivedAt !== undefined
				? existing._id
				: await ctx.db.insert("locales", {
						projectId: args.projectId,
						code,
						label: args.label?.trim() || code,
						isSource,
						createdAt: timestamp,
					});
		if (existing && existing.archivedAt !== undefined) {
			await ctx.db.patch(existing._id, {
				label: args.label?.trim() || code,
				isSource,
				archivedAt: undefined,
			});
		}
		if (isSource) {
			await ctx.db.patch(args.projectId, {
				sourceLocaleId: localeId,
				updatedAt: timestamp,
			});
		}
		return localeId;
	},
});

/**
 * Bind a Locale to the catalog file it is read from and written to, or move an
 * existing binding to a different path.
 *
 * A path is project-scoped and exclusive: no two Locales in a project may
 * claim the same file, since a snapshot would then have no way to say which
 * Locale it ingested.
 *
 * Archiving does not release the claim. Releasing it would let another Locale
 * take the path while the archived one still records it, so reviving the
 * archived Locale — which `create` does, by clearing `archivedAt` — would put
 * two live Locales on one file. Reusing a path means moving the Locale that
 * holds it.
 */
export const bind = mutation({
	args: {
		localeId: v.id("locales"),
		catalogPath: v.string(),
	},
	handler: async (ctx, args) => {
		const locale = await ctx.db.get(args.localeId);
		if (!locale) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale not found.",
			});
		}
		await requireEditor(ctx, locale.projectId);

		const catalogPath = normalizeCatalogPath(args.catalogPath);
		const claimants = await ctx.db
			.query("locales")
			.withIndex("by_project_catalogPath", (q) =>
				q.eq("projectId", locale.projectId).eq("catalogPath", catalogPath),
			)
			.take(2);
		const claimant = claimants.find(
			(candidate) => candidate._id !== args.localeId,
		);
		if (claimant) {
			throw new ConvexError({
				code: "CONFLICT",
				message: `Catalog path is already bound to the "${claimant.code}" Locale.`,
			});
		}

		await ctx.db.patch(args.localeId, { catalogPath });
		return null;
	},
});

/**
 * Correct a Locale and its binding while a project is still being connected.
 *
 * Locale codes become part of immutable Source Snapshot evidence, so this may
 * change a code only before the first Snapshot is published. The operation is
 * atomic because the Sync form edits the code, label, and path as one setup
 * fact. If the old form already left behind an unbound Locale with the desired
 * code, that empty setup record is removed so the bound Locale and all of its
 * existing values keep their stable identity.
 */
export const correctSetupBinding = mutation({
	args: {
		localeId: v.id("locales"),
		code: v.string(),
		label: v.optional(v.string()),
		catalogPath: v.string(),
	},
	handler: async (ctx, args) => {
		const locale = await ctx.db.get(args.localeId);
		if (!locale || locale.archivedAt !== undefined) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale not found.",
			});
		}
		const { userId } = await requireEditor(ctx, locale.projectId);

		const code = normalizeLocaleCode(args.code);
		const label = args.label?.trim() || code;
		const catalogPath = normalizeCatalogPath(args.catalogPath);
		const codeChanges = code !== locale.code;

		if (codeChanges) {
			const snapshot = await ctx.db
				.query("sourceSnapshots")
				.withIndex("by_project", (q) => q.eq("projectId", locale.projectId))
				.first();
			if (snapshot) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"A Locale code can be corrected only before the first Source Snapshot. Use a Locale Code Migration after sync.",
				});
			}
		}

		const claimants = await ctx.db
			.query("locales")
			.withIndex("by_project_catalogPath", (q) =>
				q.eq("projectId", locale.projectId).eq("catalogPath", catalogPath),
			)
			.take(2);
		const pathConflict = claimants.find(
			(candidate) => candidate._id !== locale._id,
		);

		const codeMatch = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", locale.projectId).eq("code", code),
			)
			.unique();
		if (codeMatch && codeMatch._id !== locale._id) {
			if (
				!codeChanges ||
				locale.isSource ||
				codeMatch.isSource ||
				codeMatch.archivedAt !== undefined ||
				codeMatch.catalogPath !== undefined ||
				(pathConflict !== undefined && pathConflict._id !== codeMatch._id)
			) {
				throw new ConvexError({
					code: "CONFLICT",
					message: `The "${code}" Locale already exists and cannot absorb this binding.`,
				});
			}

			const codeMatchValue = await ctx.db
				.query("translationValues")
				.withIndex("by_locale", (q) => q.eq("localeId", codeMatch._id))
				.first();
			if (codeMatchValue) {
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"The duplicate Locale already has translation values and cannot be removed during setup.",
				});
			}

			await ctx.db.delete(codeMatch._id);
		} else if (pathConflict) {
			throw new ConvexError({
				code: "CONFLICT",
				message: `Catalog path is already bound to the "${pathConflict.code}" Locale.`,
			});
		}

		if (codeChanges) {
			await correctGuidanceLocaleCode(ctx, {
				projectId: locale.projectId,
				fromCode: locale.code,
				toCode: code,
				isSource: locale.isSource,
				userId,
			});
		}
		await ctx.db.patch(locale._id, { code, label, catalogPath });
		return locale._id;
	},
});

export const archive = mutation({
	args: { localeId: v.id("locales") },
	handler: async (ctx, args) => {
		const locale = await ctx.db.get(args.localeId);
		if (!locale)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale not found.",
			});
		await requireEditor(ctx, locale.projectId);
		if (locale.isSource) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Source locale cannot be archived.",
			});
		}
		await ctx.db.patch(args.localeId, { archivedAt: now() });
		return null;
	},
});
