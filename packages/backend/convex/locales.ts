import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { normalizeCatalogPath } from "./catalogPaths";
import { normalizeLocaleCode, now } from "./lib";
import {
	assertProjectExists,
	requireEditor,
	requireViewer,
} from "./permissions";
import { realizeLocaleBinding } from "./snapshots";
import { correctGuidanceLocaleCode } from "./translationGuidance";

export { normalizeCatalogPath } from "./catalogPaths";

/** Locale identities with managed history cannot be folded into another code. */
async function assertNoManagedLocaleHistory(
	ctx: MutationCtx,
	localeId: Id<"locales">,
	projectId: Id<"projects">,
	isSource: boolean,
) {
	const membership = await ctx.db
		.query("contentCollectionLocales")
		.withIndex("by_locale", (q) => q.eq("localeId", localeId))
		.first();
	const sourceCollection = isSource
		? await ctx.db
				.query("contentCollections")
				.withIndex("by_project", (q) => q.eq("projectId", projectId))
				.first()
		: null;
	if (membership || sourceCollection)
		throw new ConvexError({
			code: "CONFLICT",
			message:
				"This Locale is used by managed content and cannot be renamed or removed during repository setup.",
		});
}

async function advanceBindingRevision(
	ctx: MutationCtx,
	projectId: Id<"projects">,
) {
	const project = await assertProjectExists(ctx, projectId);
	await ctx.db.patch(projectId, {
		localeBindingRevision: (project.localeBindingRevision ?? 0) + 1,
	});
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
		await advanceBindingRevision(ctx, args.projectId);
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
export const bindingPlan = internalQuery({
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

		const project = await assertProjectExists(ctx, locale.projectId);
		if (project.type === "basic")
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Basic project languages have no repository file binding.",
			});
		const snapshot = project.baselineSnapshotId
			? await ctx.db.get(project.baselineSnapshotId)
			: null;
		const unboundFile = snapshot
			? await ctx.db
					.query("sourceSnapshotUnboundFiles")
					.withIndex("by_snapshot_and_catalogPath", (q) =>
						q.eq("snapshotId", snapshot._id).eq("catalogPath", catalogPath),
					)
					.unique()
			: null;
		const realized = snapshot
			? await ctx.db
					.query("localeBindingRealizations")
					.withIndex("by_snapshot_and_localeCode", (q) =>
						q.eq("snapshotId", snapshot._id).eq("localeCode", locale.code),
					)
					.unique()
			: null;
		if (locale.archivedAt !== undefined)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Restore the Locale before binding it.",
			});
		if (unboundFile && !realized && locale.isSource)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Source Locale changes require ordinary ingestion.",
			});
		if (
			unboundFile?.declaredLocaleCode !== undefined &&
			unboundFile.declaredLocaleCode !== locale.code
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "The Unbound Locale File declares a different Locale code.",
			});
		const originalFile = snapshot
			? await ctx.db
					.query("sourceSnapshotFiles")
					.withIndex("by_snapshot_and_localeCode", (q) =>
						q.eq("snapshotId", snapshot._id).eq("localeCode", locale.code),
					)
					.unique()
			: null;
		return {
			locale,
			catalogPath,
			snapshot,
			unboundFile: realized || originalFile ? null : unboundFile,
		};
	},
});

export const commitUnobservedBinding = internalMutation({
	args: {
		localeId: v.id("locales"),
		catalogPath: v.string(),
		expectedCatalogPath: v.optional(v.string()),
		expectedBaselineSnapshotId: v.optional(v.id("sourceSnapshots")),
		expectedLocaleCode: v.string(),
	},
	handler: async (ctx, args) => {
		const locale = await ctx.db.get(args.localeId);
		if (!locale)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale not found.",
			});
		await requireEditor(ctx, locale.projectId);
		const project = await assertProjectExists(ctx, locale.projectId);
		if (
			locale.catalogPath !== args.expectedCatalogPath ||
			locale.archivedAt !== undefined ||
			locale.code !== args.expectedLocaleCode ||
			project.baselineSnapshotId !== args.expectedBaselineSnapshotId
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Binding or Baseline changed. Retry binding the Locale.",
			});
		const other = await ctx.db
			.query("locales")
			.withIndex("by_project_catalogPath", (q) =>
				q.eq("projectId", locale.projectId).eq("catalogPath", args.catalogPath),
			)
			.take(2);
		if (other.some((candidate) => candidate._id !== locale._id))
			throw new ConvexError({
				code: "CONFLICT",
				message: "Catalog path is already bound.",
			});
		if (locale.catalogPath !== args.catalogPath) {
			await ctx.db.patch(locale._id, { catalogPath: args.catalogPath });
			await advanceBindingRevision(ctx, locale.projectId);
		}
		return null;
	},
});

/** Binding an already observed file stages its complete derived projection and
 * publishes the binding with that projection. The Baseline identity is unchanged. */
export const bind = action({
	args: { localeId: v.id("locales"), catalogPath: v.string() },
	handler: async (ctx, args): Promise<null> => {
		const plan = await ctx.runQuery(internal.locales.bindingPlan, args);
		if (plan.snapshot && plan.unboundFile) {
			await realizeLocaleBinding(ctx, {
				localeId: plan.locale._id,
				catalogPath: plan.catalogPath,
				snapshotId: plan.snapshot._id,
				projectId: plan.locale.projectId,
				expectedCatalogPath: plan.locale.catalogPath,
				unboundFileId: plan.unboundFile._id,
			});
		} else {
			await ctx.runMutation(internal.locales.commitUnobservedBinding, {
				localeId: args.localeId,
				catalogPath: plan.catalogPath,
				expectedCatalogPath: plan.locale.catalogPath,
				expectedBaselineSnapshotId: plan.snapshot?._id,
				expectedLocaleCode: plan.locale.code,
			});
		}
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
			await assertNoManagedLocaleHistory(
				ctx,
				locale._id,
				locale.projectId,
				locale.isSource,
			);
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

			await assertNoManagedLocaleHistory(
				ctx,
				codeMatch._id,
				locale.projectId,
				codeMatch.isSource,
			);
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
		await advanceBindingRevision(ctx, locale.projectId);
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
		const managedMemberships = ctx.db
			.query("contentCollectionLocales")
			.withIndex("by_locale", (q) => q.eq("localeId", args.localeId));
		for await (const membership of managedMemberships) {
			if (membership.active)
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"Remove this language from its managed collections before archiving it project-wide.",
				});
		}
		await ctx.db.patch(args.localeId, { archivedAt: now() });
		await advanceBindingRevision(ctx, locale.projectId);
		return null;
	},
});
