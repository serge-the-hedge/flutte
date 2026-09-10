import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import {
	activeProjectionFor,
	MAX_PROJECTED_LOCALES,
} from "./catalogProjection";
import {
	backfillStepIsPending,
	navigationReadIdentity,
	navigationStateFor,
	normalizedOrdinaryImportCounts,
	ORDINARY_IMPORT_POLICY_VERSION,
	readyNavigationStateFor,
} from "./catalogWorkspaceNavigation";
import { readWorkspaceTarget } from "./catalogWorkspaceRead";
import { currentSourceProposalRows, encodedSize } from "./catalogWorkspaceView";
import { ORDINARY_IMPORT_CONFIRMATION_POLICY } from "./ordinaryImportConfirmations";
import { requireViewer } from "./permissions";
import { snapshotOriginFilter } from "./snapshotCatalog";
import {
	publishedResolutionFor,
	sourceProposalHeadFor,
} from "./sourceProposals";

/** Project-wide status is small and independent of catalog content. */
export const overview = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const { member } = await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) return { kind: "noBaseline" as const };
		const state = await navigationStateFor(ctx, args.projectId);
		const identity = {
			...navigationReadIdentity(projection),
			canEdit: hasMinimumRole(member.role, "editor"),
		};
		if (
			!state ||
			state.projectionId !== projection._id ||
			state.status !== "ready" ||
			!state.ordinaryImportCounts ||
			state.ordinaryImportPolicyVersion !== ORDINARY_IMPORT_POLICY_VERSION ||
			state.rowCount !== projection.expectedKeyCount ||
			state.expectedRowCount !== projection.expectedKeyCount
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
			keyCount: state.rowCount,
			revision: state.revision ?? 0,
			ordinaryImports: {
				...normalizedOrdinaryImportCounts(state.ordinaryImportCounts),
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
	},
});

/** A page is pinned to one published projection. Search hydrates only the
 * selected languages, preserving literal matching for every writing system.
 * `after` is the last completed key; `scanTargetIndex` resumes its next key. */
export const page = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		introducedSnapshotIds: v.optional(v.array(v.id("sourceSnapshots"))),
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
		await readyNavigationStateFor(ctx, {
			projectId: args.projectId,
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		});
		const matchesOrigin = await snapshotOriginFilter(
			ctx,
			args.projectId,
			args.introducedSnapshotIds,
			args.introducedOriginUnknown,
		);
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
		const batch = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("projectionId", projection._id)
					.gt("catalogIndex", focus ? focus.catalogIndex - 1 : after),
			)
			.paginate({ cursor: null, numItems: 64, maximumBytesRead: 512 * 1024 });
		const counts = { waiting: 0, unconfirmedImport: 0, stale: 0, settled: 0 };
		const keys = [];
		const membership = args.messageIds ? new Set(args.messageIds) : null;
		let readBytes = 0;
		let hydrated = 0;
		let outputBytes = 0;
		let last = focus ? focus.catalogIndex - 1 : after;
		let resumeTarget = 0;
		let partial = false;
		for (const row of batch.page) {
			if (
				(membership && !membership.has(row.messageId)) ||
				!(await matchesOrigin(row))
			) {
				last = row.catalogIndex;
				continue;
			}
			const targets = [];
			for (const target of row.targets)
				if (
					(!selection || selection.has(target.localeId)) &&
					(await isActive(target.localeId))
				)
					targets.push(target);
			const matchesScope =
				args.scope === undefined ||
				(args.scope === "introduced"
					? targets.some((value) => value.firstReviewPending)
					: targets.some((value) => value.valueState === args.scope));
			if (!matchesScope) {
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
			for (let index = start; !matches && index < targets.length; index++) {
				if (readBytes >= 2 * 1024 * 1024 || hydrated >= 64) {
					resumeTarget = index;
					partial = true;
					break;
				}
				const target = targets[index];
				if (!target) continue;
				const current = await readWorkspaceTarget(
					ctx,
					args.projectId,
					row.messageId,
					target.localeId,
				);
				hydrated++;
				readBytes += encodedSize(current);
				matches =
					current.source.value.toLowerCase().includes(needle) ||
					current.value.toLowerCase().includes(needle);
			}
			if (partial) break;
			if (!matches && targets.length === 0) {
				const [source, head] = await Promise.all([
					ctx.db
						.query("catalogProjectionMessages")
						.withIndex("by_projection_and_messageId_and_isSource", (q) =>
							q
								.eq("projectionId", projection._id)
								.eq("messageId", row.messageId)
								.eq("isSource", true),
						)
						.unique(),
					sourceProposalHeadFor(ctx, args.projectId, row.messageId),
				]);
				if (!source)
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Catalog key is missing its Source.",
					});
				const resolution = head
					? await publishedResolutionFor(ctx, {
							_id: head.proposalId,
							projectId: args.projectId,
							messageId: row.messageId,
						})
					: null;
				const [effective] = currentSourceProposalRows(
					[source],
					new Map(head ? [[row.messageId, head]] : []),
					new Map(head && resolution ? [[head.proposalId, resolution]] : []),
				);
				readBytes += encodedSize(source) + encodedSize(head);
				matches = effective?.value.toLowerCase().includes(needle) ?? false;
			}
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
			keys,
			counts,
			nextAfter: batch.page.length && remaining ? last : null,
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
		introducedOriginUnknown: v.optional(v.boolean()),
		revision: v.number(),
		localeIds: v.array(v.id("locales")),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		const state = await navigationStateFor(ctx, args.projectId);
		const counts = {
			waiting: 0,
			unconfirmedImport: 0,
			stale: 0,
			settled: 0,
			introduced: 0,
		};
		if (
			!projection ||
			projection._id !== args.projectionId ||
			state?.projectionId !== args.projectionId ||
			state.status !== "ready" ||
			(state.revision ?? 0) !== args.revision
		)
			return { stale: true, counts, cursor: null };
		if (
			!Number.isSafeInteger(args.revision) ||
			args.revision < 0 ||
			args.localeIds.length > MAX_PROJECTED_LOCALES ||
			new Set(args.localeIds).size !== args.localeIds.length
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Invalid catalog count request.",
			});
		const matchesOrigin = await snapshotOriginFilter(
			ctx,
			args.projectId,
			args.introducedSnapshotIds,
			args.introducedOriginUnknown,
		);
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
		const batch = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q.eq("projectId", args.projectId).eq("projectionId", args.projectionId),
			)
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 64,
				maximumBytesRead: 512 * 1024,
			});
		for (const row of batch.page) {
			if (!(await matchesOrigin(row))) continue;
			let introduced = false;
			for (const target of row.targets) {
				if (!selected.has(target.localeId)) continue;
				counts[target.valueState]++;
				introduced ||= target.firstReviewPending === true;
			}
			if (introduced) counts.introduced++;
		}
		return {
			stale: false,
			counts,
			cursor: batch.isDone ? null : batch.continueCursor,
		};
	},
});
