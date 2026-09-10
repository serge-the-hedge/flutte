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
import { readCatalogDiscovery } from "./catalogDiscovery";
import { normalizeCatalogPath } from "./catalogPaths";
import { normalizeLocaleCode, now } from "./lib";
import { configuredIntroductionTargets } from "./localeIntroductionTargets";
import {
	assertProjectExists,
	requireEditor,
	requireViewer,
} from "./permissions";
import { realizeLocaleBinding } from "./snapshots";
import { correctGuidanceLocaleCode } from "./translationGuidance";

export { normalizeCatalogPath } from "./catalogPaths";

/** The same accepted spelling and name bounds apply when adding or editing. */
export function normalizeLocaleMetadata(
	codeInput: string,
	labelInput?: string,
) {
	const code = normalizeLocaleCode(codeInput);
	if (code.length > 64 || !/^[a-z]{2,8}(?:-[A-Z0-9]{1,8})*$/.test(code))
		throw new ConvexError({
			code: "VALIDATION",
			message: "Enter a language code such as fr or pt-BR.",
		});
	if (
		labelInput !== undefined &&
		(Array.from(labelInput.trim()).length > 256 ||
			Array.from(labelInput).some((character) => {
				const point = character.codePointAt(0) ?? 0;
				return point < 32 || (point >= 127 && point <= 159);
			}))
	)
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"Language names support at most 256 characters without controls.",
		});
	return { code, label: labelInput?.trim() || code };
}

const metadataArgs = {
	projectId: v.id("projects"),
	localeId: v.id("locales"),
	code: v.string(),
	label: v.string(),
	expectedCode: v.string(),
	expectedLabel: v.string(),
};

/** Change presentation metadata without replacing the identity used by values and history.
 * The caller authorizes editing; repository codes belong to immutable catalog evidence. */
export async function updateLocaleMetadata(
	ctx: MutationCtx,
	args: {
		projectId: Id<"projects">;
		localeId: Id<"locales">;
		code: string;
		label: string;
		expectedCode: string;
		expectedLabel: string;
	},
	authoredBy: { kind: "user" | "agent"; id: string },
) {
	const project = await assertProjectExists(ctx, args.projectId);
	if (project.migrationPending)
		throw new ConvexError({
			code: "BAD_STATE",
			message:
				"Project content is still moving. Editing is available after completion.",
		});
	const locale = await ctx.db.get(args.localeId);
	if (
		!locale ||
		locale.projectId !== args.projectId ||
		locale.archivedAt !== undefined ||
		locale.pendingBinding
	)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Active language not found.",
		});
	if (project.type === "basic" && locale._id !== project.sourceLocaleId) {
		const collectionId = project.managedCollectionId;
		const membership = collectionId
			? await ctx.db
					.query("contentCollectionLocales")
					.withIndex("by_collection_locale", (q) =>
						q.eq("collectionId", collectionId).eq("localeId", locale._id),
					)
					.unique()
			: null;
		if (!membership?.active)
			throw new ConvexError({
				code: "NOT_FOUND",
				message:
					"Active language not found. Add the language again before editing it.",
			});
	}
	if (locale.code !== args.expectedCode || locale.label !== args.expectedLabel)
		throw new ConvexError({
			code: "CONFLICT",
			message: "This language changed. Reload its code and name before saving.",
		});
	const { code, label } = normalizeLocaleMetadata(args.code, args.label);
	if (code !== locale.code) {
		if (project.type !== "basic")
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Repository language codes cannot be edited here. Correct the binding in Sync before the first snapshot; existing snapshots retain their language codes.",
			});
		const existing = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", args.projectId).eq("code", code),
			)
			.unique();
		if (existing && existing._id !== locale._id)
			throw new ConvexError({
				code: "CONFLICT",
				message: `The language code "${code}" is already in use, including retained language history.`,
			});
		await correctGuidanceLocaleCode(ctx, {
			projectId: args.projectId,
			fromCode: locale.code,
			toCode: code,
			isSource: locale.isSource,
			authoredBy,
		});
	}
	if (code !== locale.code || label !== locale.label) {
		await ctx.db.patch(locale._id, { code, label });
		await ctx.db.patch(project._id, { updatedAt: now() });
	}
	return locale._id;
}

export const updateMetadata = mutation({
	args: metadataArgs,
	returns: v.id("locales"),
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		return await updateLocaleMetadata(ctx, args, { kind: "user", id: userId });
	},
});

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
		return locales.filter(
			(locale) =>
				!locale.pendingBinding &&
				(args.includeArchived || locale.archivedAt === undefined),
		);
	},
});

/** Suggest bindings only from the accepted catalog, never a failed run or Preview. */
export const discoveredCatalogs = query({
	args: { projectId: v.id("projects") },
	returns: v.object({
		canEdit: v.boolean(),
		snapshotId: v.union(v.id("sourceSnapshots"), v.null()),
		files: v.array(
			v.object({
				id: v.id("sourceSnapshotUnboundFiles"),
				catalogPath: v.string(),
				declaredLocaleCode: v.union(v.string(), v.null()),
				messageCount: v.union(v.number(), v.null()),
				suggestedCode: v.string(),
				suggestedLabel: v.string(),
				existingLocaleId: v.union(v.id("locales"), v.null()),
				issue: v.union(v.string(), v.null()),
			}),
		),
	}),
	handler: async (ctx, { projectId }) => {
		const { member } = await requireViewer(ctx, projectId);
		const project = await assertProjectExists(ctx, projectId);
		const canEdit =
			(member.role === "owner" || member.role === "editor") &&
			!project.migrationPending;
		const snapshotId = project.baselineSnapshotId ?? null;
		if (!snapshotId || project.type === "basic")
			return { canEdit, snapshotId: null, files: [] };
		const [{ files, locales }, targets] = await Promise.all([
			readCatalogDiscovery(ctx, projectId, snapshotId),
			configuredIntroductionTargets(ctx, projectId),
		]);
		return {
			canEdit,
			snapshotId,
			files: files.map((file) => {
				const configured = targets.find(
					(target) => target.catalogPath === file.catalogPath,
				);
				const suggestedCode =
					file.declaredLocaleCode ?? configured?.localeCode ?? "";
				const existing = locales.find(
					(locale) => locale.code === suggestedCode,
				);
				const claimant = locales.find(
					(locale) => locale.catalogPath === file.catalogPath,
				);
				let issue: string | null = null;
				if (existing?.pendingBinding) {
					issue = "This language is being added. Please wait for it to finish.";
				} else if (
					claimant?.archivedAt !== undefined ||
					existing?.archivedAt !== undefined
				) {
					issue =
						"This file or language is archived. Restore the language before binding it.";
				} else if (existing?.isSource) {
					issue =
						"This file declares the source language. Source changes require ordinary sync.";
				} else if (existing?.catalogPath) {
					issue = `This language already uses ${existing.catalogPath}. Review its binding in Sync.`;
				} else if (
					configured &&
					file.declaredLocaleCode &&
					configured.localeCode !== file.declaredLocaleCode
				) {
					issue = `The file declares ${file.declaredLocaleCode}, but this path is configured for ${configured.localeCode}. Correct the configuration or file first.`;
				}
				return {
					id: file._id,
					catalogPath: file.catalogPath,
					declaredLocaleCode: file.declaredLocaleCode ?? null,
					messageCount: file.messageCount ?? null,
					suggestedCode,
					suggestedLabel: existing?.label ?? configured?.label ?? "",
					existingLocaleId: existing?._id ?? null,
					issue,
				};
			}),
		};
	},
});

const discoveredBindingArgs = {
	projectId: v.id("projects"),
	snapshotId: v.id("sourceSnapshots"),
	unboundFileId: v.id("sourceSnapshotUnboundFiles"),
	code: v.string(),
	label: v.string(),
};

export const discardPendingBinding = internalMutation({
	args: { localeId: v.id("locales") },
	returns: v.null(),
	handler: async (ctx, { localeId }) => {
		const locale = await ctx.db.get(localeId);
		if (
			locale?.pendingBinding &&
			locale.archivedAt !== undefined &&
			!locale.catalogPath
		)
			await ctx.db.delete(localeId);
		return null;
	},
});

/** Reserve a hidden identity only after rechecking the user's displayed evidence. */
export const prepareDiscoveredBinding = internalMutation({
	args: discoveredBindingArgs,
	returns: v.object({
		localeId: v.id("locales"),
		catalogPath: v.string(),
		pending: v.boolean(),
	}),
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const project = await assertProjectExists(ctx, args.projectId);
		const file = await ctx.db.get(args.unboundFileId);
		if (
			project.type === "basic" ||
			project.baselineSnapshotId !== args.snapshotId ||
			!file ||
			file.snapshotId !== args.snapshotId ||
			file.projectId !== args.projectId
		)
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The accepted catalog changed. Review the discovered file and retry.",
			});
		const code = normalizeLocaleCode(args.code);
		if (!code || (file.declaredLocaleCode && file.declaredLocaleCode !== code))
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Choose the language declared by this catalog, or provide its language if no locale is declared.",
			});
		const claimant = await ctx.db
			.query("locales")
			.withIndex("by_project_catalogPath", (q) =>
				q.eq("projectId", args.projectId).eq("catalogPath", file.catalogPath),
			)
			.first();
		if (claimant)
			throw new ConvexError({
				code: "CONFLICT",
				message: "This catalog path already has a language binding.",
			});
		const existing = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", args.projectId).eq("code", code),
			)
			.unique();
		if (existing) {
			if (existing.pendingBinding)
				throw new ConvexError({
					code: "CONFLICT",
					message: "This language is being added. Retry shortly.",
				});
			if (
				existing.isSource ||
				existing.archivedAt !== undefined ||
				existing.catalogPath
			)
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"Restore or review this language's existing binding in Sync first.",
				});
			return {
				localeId: existing._id,
				catalogPath: file.catalogPath,
				pending: false,
			};
		}
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(1000);
		if (locales.length >= 1000)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "A project supports at most 1,000 languages.",
			});
		const timestamp = now();
		const localeId = await ctx.db.insert("locales", {
			projectId: args.projectId,
			code,
			label: args.label.trim() || code,
			isSource: false,
			createdAt: timestamp,
			archivedAt: timestamp,
			pendingBinding: true,
		});
		// Reclaim abandoned reservations even if the action never reaches its catch block.
		await ctx.scheduler.runAfter(
			24 * 60 * 60 * 1000,
			internal.locales.discardPendingBinding,
			{ localeId },
		);
		return { localeId, catalogPath: file.catalogPath, pending: true };
	},
});

export const addDiscovered = action({
	args: discoveredBindingArgs,
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const prepared = await ctx.runMutation(
			internal.locales.prepareDiscoveredBinding,
			args,
		);
		try {
			await realizeLocaleBinding(ctx, {
				projectId: args.projectId,
				localeId: prepared.localeId,
				catalogPath: prepared.catalogPath,
				snapshotId: args.snapshotId,
				unboundFileId: args.unboundFileId,
				pendingLocale: prepared.pending,
			});
		} catch (error) {
			if (prepared.pending)
				await ctx.runMutation(internal.locales.discardPendingBinding, {
					localeId: prepared.localeId,
				});
			throw error;
		}
		return null;
	},
});

/** Create or revive a Locale identity without assigning a repository binding. Caller authorizes project editing. */
export async function createLocaleIdentity(
	ctx: MutationCtx,
	args: {
		projectId: Id<"projects">;
		code: string;
		label?: string;
		isSource?: boolean;
	},
) {
	const project = await assertProjectExists(ctx, args.projectId);
	const code = normalizeLocaleCode(args.code);
	const existing = await ctx.db
		.query("locales")
		.withIndex("by_project_code", (q) =>
			q.eq("projectId", args.projectId).eq("code", code),
		)
		.unique();
	if (existing?.pendingBinding)
		throw new ConvexError({
			code: "CONFLICT",
			message: "This language is being added. Retry shortly.",
		});
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
}
export const create = mutation({
	args: {
		projectId: v.id("projects"),
		code: v.string(),
		label: v.optional(v.string()),
		isSource: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		return await createLocaleIdentity(ctx, args);
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
		allowPending: v.optional(v.boolean()),
		localeId: v.id("locales"),
		catalogPath: v.string(),
		expectedSnapshotId: v.optional(v.id("sourceSnapshots")),
		expectedUnboundFileId: v.optional(v.id("sourceSnapshotUnboundFiles")),
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
		if (
			args.expectedUnboundFileId &&
			locale.catalogPath &&
			locale.catalogPath !== catalogPath
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"This language already has a catalog. Review its binding in Sync.",
			});
		}
		if (
			(args.expectedSnapshotId && snapshot?._id !== args.expectedSnapshotId) ||
			(args.expectedUnboundFileId &&
				unboundFile?._id !== args.expectedUnboundFileId)
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"The accepted catalog changed. Review the discovered file and retry.",
			});
		}
		const realized = snapshot
			? await ctx.db
					.query("localeBindingRealizations")
					.withIndex("by_snapshot_and_localeCode", (q) =>
						q.eq("snapshotId", snapshot._id).eq("localeCode", locale.code),
					)
					.unique()
			: null;
		if (
			locale.archivedAt !== undefined &&
			!(args.allowPending && locale.pendingBinding)
		)
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
	args: {
		localeId: v.id("locales"),
		catalogPath: v.string(),
		expectedSnapshotId: v.optional(v.id("sourceSnapshots")),
		expectedUnboundFileId: v.optional(v.id("sourceSnapshotUnboundFiles")),
	},
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
				authoredBy: { kind: "user", id: userId },
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
		if (locale.pendingBinding)
			throw new ConvexError({
				code: "CONFLICT",
				message: "This language is being added. Retry shortly.",
			});
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
