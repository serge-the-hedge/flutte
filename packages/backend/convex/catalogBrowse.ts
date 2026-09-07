import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import { activeProjectionFor } from "./catalogProjection";
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
 * selected language, preserving literal matching for every writing system. */
export const page = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.optional(v.id("locales")),
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
			};
		}
		await readyNavigationStateFor(ctx, {
			projectId: args.projectId,
			projectionId: projection._id,
			expectedRowCount: projection.expectedKeyCount,
		});
		const after = args.after ?? -1;
		const needle = (args.q ?? "").trim().toLowerCase();
		if (
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
		if (args.localeId) {
			const locale = await ctx.db.get(args.localeId);
			if (
				!locale ||
				locale.projectId !== args.projectId ||
				locale.archivedAt !== undefined ||
				locale.isSource ||
				!locale.catalogPath
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Choose an active target language.",
				});
			}
		}
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
		let last = after;
		for (const row of batch.page) {
			last = row.catalogIndex;
			if (membership && !membership.has(row.messageId)) continue;
			const targets = args.localeId
				? row.targets.filter((target) => target.localeId === args.localeId)
				: [];
			const target = targets[0];
			const matchesScope =
				args.scope === undefined ||
				(args.scope === "introduced"
					? targets.some((value) => value.firstReviewPending)
					: targets.some((value) => value.valueState === args.scope));
			if (!matchesScope) continue;
			let matches = !needle || row.messageId.toLowerCase().includes(needle);
			if (!matches && target) {
				const current = await readWorkspaceTarget(
					ctx,
					args.projectId,
					row.messageId,
					target.localeId,
				);
				readBytes += encodedSize(current);
				matches =
					current.source.value.toLowerCase().includes(needle) ||
					current.value.toLowerCase().includes(needle);
			}
			if (!matches && !target) {
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
				for (const value of targets) counts[value.valueState]++;
				keys.push({
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
				});
			}
			if (keys.length >= 32 || readBytes >= 2 * 1024 * 1024) break;
		}
		const remaining =
			!batch.isDone || last !== batch.page[batch.page.length - 1]?.catalogIndex;
		return {
			stale: false,
			keys,
			counts,
			nextAfter: batch.page.length && remaining ? last : null,
		};
	},
});
