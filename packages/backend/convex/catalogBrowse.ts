import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import { focusCandidateQuery, preparedBrowseState } from "./catalogBrowseIndex";
import {
	originCountBatch,
	originPageBatch,
	preparedOrigins,
} from "./catalogBrowseOrigins";
import {
	activeProjectionFor,
	MAX_PROJECTED_LOCALES,
} from "./catalogProjection";
import { searchSourceText, searchTargetText } from "./catalogSearchText";
import {
	backfillStepIsPending,
	navigationReadIdentity,
	navigationStateFor,
	navigationStateIsReady,
	normalizedOrdinaryImportCounts,
	readyNavigationStateFor,
} from "./catalogWorkspaceNavigation";
import { encodedSize } from "./catalogWorkspaceView";
import { matchesMessageTags, tagRevision, validateTagIds } from "./messageTags";
import { ORDINARY_IMPORT_CONFIRMATION_POLICY } from "./ordinaryImportConfirmations";
import { requireViewer } from "./permissions";

/** Project-wide status is small and independent of catalog content. */
async function catalogOverview(
	ctx: QueryCtx,
	args: { projectId: Id<"projects"> },
	preferStable: boolean,
) {
	const { member } = await requireViewer(ctx, args.projectId);
	const projection = await activeProjectionFor(ctx, args.projectId);
	if (!projection) return { kind: "noBaseline" as const };
	const browse = await preparedBrowseState(ctx, projection);
	const state =
		preferStable && browse
			? null
			: await navigationStateFor(ctx, args.projectId);
	const identity = {
		...navigationReadIdentity(projection),
		canEdit: hasMinimumRole(member.role, "editor"),
	};
	if (
		!(preferStable && browse) &&
		!navigationStateIsReady(state, {
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		})
	) {
		const current = state?.projectionId === projection._id ? state : null;
		return {
			kind: "incomplete" as const,
			...identity,
			status: current?.status ?? ("missing" as const),
			stepPending: current ? backfillStepIsPending(current) : false,
			failure: current?.backfillFailure ?? null,
			progress: {
				rowCount: current?.rowCount ?? 0,
				expectedRowCount: projection.expectedKeyCount,
				byteLength: current?.byteLength ?? 0,
			},
		};
	}
	const ordinaryImportCounts =
		browse?.ordinaryImportCounts ?? state?.ordinaryImportCounts;
	if (!ordinaryImportCounts)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog counts are missing.",
		});
	const run = await ctx.db
		.query("ordinaryImportRuns")
		.withIndex("by_project_and_projection", (q) =>
			q.eq("projectId", args.projectId).eq("projectionId", projection._id),
		)
		.order("desc")
		.first();
	return {
		kind: "ready" as const,
		...identity,
		keyCount: browse?.keyCount ?? state?.rowCount ?? 0,
		classificationRevision: browse?.classificationRevision,
		classificationGeneration: browse?._id,
		optimizationNeeded: !browse?.indexReady,
		revision: preferStable && browse ? undefined : (state?.revision ?? 0),
		ordinaryImports: {
			...normalizedOrdinaryImportCounts(ordinaryImportCounts),
			policy: ORDINARY_IMPORT_CONFIRMATION_POLICY,
			run: run
				? {
						status: run.status,
						confirmed: run.confirmed,
						skipped: run.skipped,
						failure: run.failure ?? null,
					}
				: null,
		},
	};
}
export const overview = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const result = await catalogOverview(ctx, args, false);
		return result.kind === "ready"
			? { ...result, revision: result.revision ?? 0 }
			: result;
	},
});
/** Browsing depends on classifications, not every content fingerprint. */
export const readiness = query({
	args: { projectId: v.id("projects") },
	handler: (ctx, args) => catalogOverview(ctx, args, true),
});

/** A page is pinned to one published projection. Search hydrates only the
 * selected languages, preserving literal matching for every writing system.
 * `after` is the last completed key; `scanTargetIndex` resumes its next key. */
export const page = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		introducedSnapshotIds: v.optional(v.array(v.id("sourceSnapshots"))),
		tagIds: v.optional(v.array(v.id("tags"))),
		expectedTagRevision: v.optional(v.number()),
		introducedOriginUnknown: v.optional(v.boolean()),
		localeId: v.optional(v.id("locales")),
		localeIds: v.optional(v.array(v.id("locales"))),
		scanTargetIndex: v.optional(v.number()),
		after: v.optional(v.number()),
		q: v.optional(v.string()),
		scope: v.optional(
			v.union(
				v.literal("waiting"),
				v.literal("unconfirmedImport"),
				v.literal("stale"),
				v.literal("introduced"),
				v.literal("changedInGit"),
			),
		),
		messageIds: v.optional(v.array(v.string())),
		focusKey: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection || projection._id !== args.projectionId) {
			// A subscription may briefly retain old arguments as the overview updates.
			return {
				stale: true,
				keys: [],
				counts: { waiting: 0, unconfirmedImport: 0, stale: 0, settled: 0 },
				nextAfter: null,
				nextTargetIndex: null,
			};
		}
		const browse = await preparedBrowseState(ctx, projection);
		if (!browse)
			await readyNavigationStateFor(ctx, {
				projectId: args.projectId,
				projectionId: projection._id,
				expectedRowCount: projection.expectedKeyCount,
			});
		const tags = await validateTagIds(ctx, args.projectId, args.tagIds);
		const metadataRevision = await tagRevision(ctx, args.projectId);
		if (
			args.expectedTagRevision !== undefined &&
			args.expectedTagRevision !== metadataRevision
		)
			throw new ConvexError({
				code: "STALE_BASIS",
				message: "Tags changed. Restart from the first page.",
			});
		const origins = await preparedOrigins(ctx, args, projection);
		const after = args.after ?? -1;
		const scanTargetIndex = args.scanTargetIndex ?? 0;
		const needle = (args.q ?? "").trim().toLowerCase();
		if (
			!Number.isSafeInteger(scanTargetIndex) ||
			scanTargetIndex < 0 ||
			scanTargetIndex > MAX_PROJECTED_LOCALES ||
			(scanTargetIndex > 0 && args.after === undefined) ||
			!Number.isSafeInteger(after) ||
			after < -1 ||
			encodedSize(needle) > 2050 ||
			(args.messageIds?.length ?? 0) > 8192 ||
			encodedSize(args.messageIds ?? []) > 512 * 1024 ||
			encodedSize(args.focusKey ?? "") > 514
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Catalog page arguments exceed their bounds.",
			});
		}
		if (args.localeId !== undefined && args.localeIds !== undefined)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Use either localeId or localeIds.",
			});
		const selected =
			args.localeIds ?? (args.localeId ? [args.localeId] : undefined);
		if (
			selected &&
			(selected.length > MAX_PROJECTED_LOCALES ||
				new Set(selected).size !== selected.length)
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Language selection exceeds its bounds or repeats a language.",
			});
		const active = new Map<Id<"locales">, boolean>();
		async function isActive(localeId: Id<"locales">) {
			const cached = active.get(localeId);
			if (cached !== undefined) return cached;
			const locale = await ctx.db.get(localeId);
			const valid = Boolean(
				locale &&
					locale.projectId === args.projectId &&
					!locale.isSource &&
					locale.archivedAt === undefined &&
					locale.catalogPath,
			);
			active.set(localeId, valid);
			return valid;
		}
		for (const localeId of selected ?? [])
			if (!(await isActive(localeId)))
				throw new ConvexError({
					code: "VALIDATION",
					message: "Choose an active target language.",
				});
		const selection = selected ? new Set(selected) : undefined;
		// A permalink starts at its key rather than making clients scan earlier pages.
		const focusKey = args.focusKey;
		const focus =
			focusKey && args.after === undefined
				? await ctx.db
						.query("catalogWorkspaceNavigationRows")
						.withIndex("by_project_and_projection_and_messageId", (q) =>
							q
								.eq("projectId", args.projectId)
								.eq("projectionId", projection._id)
								.eq("messageId", focusKey),
						)
						.unique()
				: null;
		const membership = args.messageIds ? new Set(args.messageIds) : null;
		async function matchingTargets(row: Doc<"catalogWorkspaceNavigationRows">) {
			if (membership && !membership.has(row.messageId)) return null;
			if (origins && !origins.includes(row.firstSeenProjectionId)) return null;
			if (
				!(await matchesMessageTags(
					ctx,
					{ projectId: args.projectId, messageId: row.messageId },
					tags,
				))
			)
				return null;
			const targets = [];
			for (const target of row.targets) {
				if (
					(!selection || selection.has(target.localeId)) &&
					(await isActive(target.localeId))
				)
					targets.push(target);
			}
			const matchesScope =
				args.scope === undefined ||
				(args.scope === "introduced"
					? targets.some((value) => value.firstReviewPending)
					: args.scope === "changedInGit"
						? targets.some((value) => value.changedInGitPending)
						: targets.some((value) => value.valueState === args.scope));
			return matchesScope ? targets : null;
		}
		// An exact identifier is the first result. Next continues ordinary literal
		// discovery from the beginning, excluding this already-returned key.
		const exact =
			needle && !focusKey
				? await ctx.db
						.query("catalogWorkspaceNavigationRows")
						.withIndex("by_project_and_projection_and_messageId", (q) =>
							q
								.eq("projectId", args.projectId)
								.eq("projectionId", projection._id)
								.eq("messageId", args.q?.trim() ?? ""),
						)
						.unique()
				: null;
		const exactTargets = exact ? await matchingTargets(exact) : null;
		const prioritizeExact =
			exact !== null && exactTargets !== null && args.after === undefined;
		const batch = prioritizeExact
			? { page: [exact], isDone: false }
			: origins
				? await originPageBatch(
						ctx,
						args,
						origins,
						focus ? focus.catalogIndex - 1 : after,
					)
				: args.scope && browse?.indexReady
					? await focusCandidateQuery(
							ctx,
							args.projectId,
							projection._id,
							args.scope,
							focus ? focus.catalogIndex - 1 : after,
						).paginate({
							cursor: null,
							numItems: 64,
							maximumBytesRead: 512 * 1024,
						})
					: await ctx.db
							.query("catalogWorkspaceNavigationRows")
							.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
								q
									.eq("projectId", args.projectId)
									.eq("projectionId", projection._id)
									.gt("catalogIndex", focus ? focus.catalogIndex - 1 : after),
							)
							.paginate({
								cursor: null,
								numItems: 64,
								maximumBytesRead: 512 * 1024,
							});
		const counts = { waiting: 0, unconfirmedImport: 0, stale: 0, settled: 0 };
		const keys = [];
		let readBytes = 0;
		let hydrated = 0;
		let outputBytes = 0;
		let last = focus ? focus.catalogIndex - 1 : after;
		let resumeTarget = 0;
		let partial = false;
		for (const row of batch.page) {
			if (
				!prioritizeExact &&
				exactTargets !== null &&
				row.messageId === exact?.messageId
			) {
				last = row.catalogIndex;
				continue;
			}
			const targets = prioritizeExact
				? exactTargets
				: await matchingTargets(row);
			if (!targets) {
				last = row.catalogIndex;
				continue;
			}

			let matches = !needle || row.messageId.toLowerCase().includes(needle);
			const start = row === batch.page[0] ? scanTargetIndex : 0;
			if (start > targets.length)
				throw new ConvexError({
					code: "VALIDATION",
					message: "Invalid target search position.",
				});
			const address = {
				projectId: args.projectId,
				projectionId: projection._id,
				messageId: row.messageId,
			};
			if (!matches) {
				const source = await searchSourceText(ctx, address);
				readBytes += source.bytes;
				matches = source.value.toLowerCase().includes(needle);
			}
			for (let index = start; !matches && index < targets.length; index += 8) {
				if (readBytes >= 2 * 1024 * 1024 || hydrated >= 256) {
					resumeTarget = index;
					partial = true;
					break;
				}
				const texts = await Promise.all(
					targets
						.slice(index, index + 8)
						.map((target) => searchTargetText(ctx, address, target.localeId)),
				);
				hydrated += texts.length;
				for (const text of texts) {
					readBytes += text.bytes;
					matches ||= text.value.toLowerCase().includes(needle);
				}
			}
			if (partial) break;
			if (matches) {
				const key = {
					messageId: row.messageId,
					catalogIndex: row.catalogIndex,
					searchCorpus: [],
					source: row.source,
					pendingSourceProposal: row.pendingSourceProposal,
					introductionReviewPending: targets.filter(
						(value) => value.firstReviewPending,
					).length,
					targets: targets.map(
						({ valueFingerprint: _fingerprint, ...value }) => ({
							...value,
							firstReviewPending: value.firstReviewPending === true,
						}),
					),
				};
				const size = encodedSize(key);
				if (size > 512 * 1024)
					throw new ConvexError({
						code: "LIMIT_EXCEEDED",
						message: "A catalog key exceeds its compact page budget.",
					});
				if (keys.length && outputBytes + size > 1024 * 1024) {
					partial = true;
					resumeTarget = 0;
					break;
				}
				outputBytes += size;
				keys.push(key);
				for (const value of targets) counts[value.valueState]++;
			}
			last = row.catalogIndex;
			if (keys.length >= 32 || readBytes >= 2 * 1024 * 1024) break;
		}
		const remaining =
			partial ||
			!batch.isDone ||
			last !== batch.page[batch.page.length - 1]?.catalogIndex;
		return {
			stale: false,
			tagRevision: metadataRevision,
			keys,
			counts,
			nextAfter: prioritizeExact
				? -1
				: batch.page.length && remaining
					? last
					: null,
			nextTargetIndex:
				batch.page.length && remaining
					? keys.length
						? 0
						: resumeTarget
					: null,
		};
	},
});

/** Catalog-wide focus facts, independent of the visible page, search, and focus.
 * Only compact digests are read. Clients combine bounded pages from one revision
 * and display a total only once the complete scan has finished. */
export const scopeCounts = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		introducedSnapshotIds: v.optional(v.array(v.id("sourceSnapshots"))),
		tagIds: v.optional(v.array(v.id("tags"))),
		expectedTagRevision: v.optional(v.number()),
		introducedOriginUnknown: v.optional(v.boolean()),
		revision: v.optional(v.number()),
		classificationRevision: v.optional(v.number()),
		classificationGeneration: v.optional(v.id("catalogBrowseStates")),
		localeIds: v.array(v.id("locales")),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		const browse = projection
			? await preparedBrowseState(ctx, projection)
			: null;
		const state =
			args.classificationRevision === undefined
				? await navigationStateFor(ctx, args.projectId)
				: null;
		const counts = {
			waiting: 0,
			unconfirmedImport: 0,
			stale: 0,
			settled: 0,
			introduced: 0,
			changedInGit: 0,
		};
		if (
			!projection ||
			projection._id !== args.projectionId ||
			(args.classificationRevision !== undefined
				? !browse ||
					browse.classificationRevision !== args.classificationRevision ||
					(args.classificationGeneration !== undefined &&
						args.classificationGeneration !== browse._id)
				: state?.projectionId !== args.projectionId ||
					state.status !== "ready" ||
					(state.revision ?? 0) !== args.revision)
		)
			return { stale: true, counts, cursor: null };
		if (
			!Number.isSafeInteger(args.classificationRevision ?? args.revision) ||
			(args.classificationRevision ?? args.revision ?? -1) < 0 ||
			args.localeIds.length > MAX_PROJECTED_LOCALES ||
			new Set(args.localeIds).size !== args.localeIds.length
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Invalid catalog count request.",
			});
		const tags = await validateTagIds(ctx, args.projectId, args.tagIds);
		const metadataRevision = await tagRevision(ctx, args.projectId);
		if (
			args.expectedTagRevision !== undefined &&
			args.expectedTagRevision !== metadataRevision
		)
			return { stale: true, counts, cursor: null };
		const origins = await preparedOrigins(ctx, args, projection);
		const selected = new Set(args.localeIds);
		for (const localeId of selected) {
			const locale = await ctx.db.get(localeId);
			if (
				!locale ||
				locale.projectId !== args.projectId ||
				locale.isSource ||
				locale.archivedAt !== undefined ||
				!locale.catalogPath
			)
				throw new ConvexError({
					code: "VALIDATION",
					message: "Choose an active target language.",
				});
		}
		if (selected.size === 0) return { stale: false, counts, cursor: null };
		if (
			!args.cursor &&
			browse?.indexReady &&
			!origins &&
			!tags.length &&
			browse.localeCounts.length === selected.size &&
			browse.localeCounts.every((count) => selected.has(count.localeId))
		) {
			for (const row of browse.localeCounts) {
				counts.waiting += row.waiting;
				counts.unconfirmedImport += row.unconfirmedImport;
				counts.stale += row.stale;
				counts.settled += row.settled;
			}
			counts.introduced = browse.introduced;
			counts.changedInGit = browse.changedInGit;
			return { stale: false, counts, cursor: null };
		}
		const batch = origins
			? await originCountBatch(ctx, args, origins)
			: await ctx.db
					.query("catalogWorkspaceNavigationRows")
					.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
						q
							.eq("projectId", args.projectId)
							.eq("projectionId", args.projectionId),
					)
					.paginate({
						cursor: args.cursor ?? null,
						numItems: 64,
						maximumBytesRead: 512 * 1024,
					});
		for (const row of batch.page) {
			if (
				!(await matchesMessageTags(
					ctx,
					{ projectId: args.projectId, messageId: row.messageId },
					tags,
				))
			)
				continue;
			let introduced = false;
			let changedInGit = false;
			for (const target of row.targets) {
				if (!selected.has(target.localeId)) continue;
				counts[target.valueState]++;
				introduced ||= target.firstReviewPending === true;
				changedInGit ||= target.changedInGitPending === true;
			}
			if (introduced) counts.introduced++;
			if (changedInGit) counts.changedInGit++;
		}
		return {
			stale: false,
			counts,
			cursor: batch.isDone ? null : batch.continueCursor,
		};
	},
});
