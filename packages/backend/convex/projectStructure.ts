import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "./_generated/server";
import { collectionMemberships } from "./contentCollections";
import { preparePromotedProjectGuidance } from "./dictionaries";
import { requireOwner, requireViewer } from "./permissions";

const address = {
	projectId: v.id("projects"),
	collectionId: v.id("contentCollections"),
};
const phases: readonly string[] = [
	"members",
	"memberships",
	"messages",
	"sourceHistory",
	"targets",
	"targetHistory",
	"proposals",
];
type Move = Doc<"collectionProjectMoves">;

async function moveFor(
	ctx: MutationCtx,
	collectionId: Id<"contentCollections">,
) {
	return ctx.db
		.query("collectionProjectMoves")
		.withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
		.unique();
}

export const listLegacy = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const project = await ctx.db.get(args.projectId);
		if (project?.type === "basic") return [];
		const collections = await ctx.db
			.query("contentCollections")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(65);
		const moves = await ctx.db
			.query("collectionProjectMoves")
			.withIndex("by_source", (q) => q.eq("sourceProjectId", args.projectId))
			.take(65);
		return [
			...collections
				.filter((c) => !moves.some((m) => m.collectionId === c._id))
				.map((c) => ({
					collectionId: c._id,
					name: c.name,
					projectId: undefined,
					status: "ready" as const,
					error: undefined,
				})),
			...(await Promise.all(
				moves.map(async (m) => ({
					collectionId: m.collectionId,
					name: (await ctx.db.get(m.collectionId))?.name ?? "Content",
					projectId: m.destinationProjectId,
					status: m.status,
					error: m.error,
				})),
			)),
		];
	},
});
export const resolveLegacy = query({
	args: address,
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const move = await ctx.db
			.query("collectionProjectMoves")
			.withIndex("by_collection", (q) =>
				q.eq("collectionId", args.collectionId),
			)
			.unique();
		if (move && move.sourceProjectId === args.projectId)
			return { projectId: move.destinationProjectId, status: move.status };
		const collection = await ctx.db.get(args.collectionId);
		if (!collection || collection.projectId !== args.projectId)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Content not found.",
			});
		const project = await ctx.db.get(args.projectId);
		return {
			projectId:
				project?.managedCollectionId === collection._id ? args.projectId : null,
			status:
				project?.managedCollectionId === collection._id
					? ("complete" as const)
					: ("ready" as const),
		};
	},
});

/** Promotion is explicit and resumable. Existing record and citation IDs stay
 * stable; only project ownership and project-local Locale references move. */
export const promote = mutation({
	args: { ...address, name: v.optional(v.string()) },
	returns: v.id("projects"),
	handler: async (ctx, args) => {
		const { userId } = await requireOwner(ctx, args.projectId);
		const existing = await moveFor(ctx, args.collectionId);
		if (existing) {
			if (existing.sourceProjectId !== args.projectId)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Content not found.",
				});
			if (existing.status === "failed") {
				await ctx.db.patch(existing._id, {
					status: "moving",
					error: undefined,
				});
				await ctx.scheduler.runAfter(0, internal.projectStructure.step, {
					moveId: existing._id,
				});
			}
			return existing.destinationProjectId;
		}
		const source = await ctx.db.get(args.projectId);
		const collection = await ctx.db.get(args.collectionId);
		if (
			!source ||
			!collection ||
			collection.projectId !== source._id ||
			source.type === "basic"
		)
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Choose legacy content from this project.",
			});
		const sourceLocale = source.sourceLocaleId
			? await ctx.db.get(source.sourceLocaleId)
			: null;
		if (!sourceLocale)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Project source language is missing.",
			});
		const name = (args.name ?? collection.name).trim();
		if (!name || name.length > 128)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Project name must contain 1–128 characters.",
			});
		const now = Date.now();
		const destinationProjectId = await ctx.db.insert("projects", {
			name,
			slug: `${source.slug}-${collection._id}`,
			type: "basic",
			managedCollectionId: collection._id,
			migrationPending: true,
			createdByUserId: userId,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("projectMembers", {
			projectId: destinationProjectId,
			userId,
			role: "owner",
			createdAt: now,
		});
		const sourceLocaleId = await ctx.db.insert("locales", {
			projectId: destinationProjectId,
			code: sourceLocale.code,
			label: sourceLocale.label,
			isSource: true,
			createdAt: now,
		});
		await ctx.db.patch(destinationProjectId, { sourceLocaleId });
		const memberships = await collectionMemberships(ctx, collection._id);
		const localeCodes = (
			await Promise.all(
				memberships
					.filter((m) => m.active)
					.map(async (m) => (await ctx.db.get(m.localeId))?.code),
			)
		).filter((code): code is string => code !== undefined);
		await preparePromotedProjectGuidance(ctx, {
			sourceProjectId: source._id,
			destinationProjectId,
			userId,
			localeCodes,
		});
		await ctx.db.patch(collection._id, {
			movingToProjectId: destinationProjectId,
		});
		const moveId = await ctx.db.insert("collectionProjectMoves", {
			sourceProjectId: source._id,
			destinationProjectId,
			collectionId: collection._id,
			status: "moving",
			phase: "members",
			createdAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.projectStructure.step, { moveId });
		return destinationProjectId;
	},
});

async function mapLocale(ctx: MutationCtx, move: Move, id: Id<"locales">) {
	const locale = await ctx.db.get(id);
	if (!locale) throw new Error("A retained language is missing.");
	if (locale.projectId === move.destinationProjectId) return locale._id;
	if (locale.projectId !== move.sourceProjectId)
		throw new Error("Language ownership does not match this move.");
	const existing = await ctx.db
		.query("locales")
		.withIndex("by_project_code", (q) =>
			q.eq("projectId", move.destinationProjectId).eq("code", locale.code),
		)
		.unique();
	return (
		existing?._id ??
		(await ctx.db.insert("locales", {
			projectId: move.destinationProjectId,
			code: locale.code,
			label: locale.label,
			isSource: locale.isSource,
			archivedAt: locale.archivedAt,
			createdAt: Date.now(),
		}))
	);
}
async function nextPhase(
	ctx: MutationCtx,
	move: Move,
	phase: string,
	cursor?: string,
) {
	await ctx.db.patch(move._id, { phase, cursor });
}
async function batch(ctx: MutationCtx, move: Move): Promise<void> {
	const opts = { numItems: 4, cursor: move.cursor ?? null };
	const finishPage = async (page: {
		isDone: boolean;
		continueCursor: string;
	}) => {
		const index = phases.indexOf(move.phase);
		if (page.isDone)
			await nextPhase(ctx, move, phases[index + 1] ?? "proposals");
		else await ctx.db.patch(move._id, { cursor: page.continueCursor });
	};
	switch (move.phase) {
		case "members": {
			const page = await ctx.db
				.query("projectMembers")
				.withIndex("by_project", (q) => q.eq("projectId", move.sourceProjectId))
				.paginate(opts);
			for (const row of page.page) {
				const existing = await ctx.db
					.query("projectMembers")
					.withIndex("by_project_user", (q) =>
						q
							.eq("projectId", move.destinationProjectId)
							.eq("userId", row.userId),
					)
					.unique();
				if (!existing)
					await ctx.db.insert("projectMembers", {
						projectId: move.destinationProjectId,
						userId: row.userId,
						role: row.role,
						createdAt: Date.now(),
					});
			}
			await finishPage(page);
			return;
		}
		case "memberships": {
			const page = await ctx.db
				.query("contentCollectionLocales")
				.withIndex("by_collection", (q) =>
					q.eq("collectionId", move.collectionId),
				)
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: await mapLocale(ctx, move, row.localeId),
				});
			await finishPage(page);
			return;
		}
		case "messages": {
			const page = await ctx.db
				.query("managedMessages")
				.withIndex("by_collection", (q) =>
					q.eq("collectionId", move.collectionId),
				)
				.paginate(opts);
			for (const row of page.page) {
				const constraint = await ctx.db
					.query("messageConstraints")
					.withIndex("by_projectId_and_collectionId_and_messageId", (q) =>
						q
							.eq("projectId", move.sourceProjectId)
							.eq("collectionId", move.collectionId)
							.eq("messageId", row.key),
					)
					.unique();
				if (constraint)
					await ctx.db.patch(constraint._id, {
						projectId: move.destinationProjectId,
					});
				await ctx.db.patch(row._id, { projectId: move.destinationProjectId });
			}
			await finishPage(page);
			return;
		}
		case "sourceHistory": {
			const page = await ctx.db
				.query("managedSourceRevisions")
				.withIndex("by_message", (q) => q.eq("collectionId", move.collectionId))
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, { projectId: move.destinationProjectId });
			await finishPage(page);
			return;
		}
		case "targets": {
			const page = await ctx.db
				.query("managedTargets")
				.withIndex("by_collection", (q) =>
					q.eq("collectionId", move.collectionId),
				)
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: await mapLocale(ctx, move, row.localeId),
				});
			await finishPage(page);
			return;
		}
		case "targetHistory": {
			const page = await ctx.db
				.query("managedTargetRevisions")
				.withIndex("by_collection", (q) =>
					q.eq("collectionId", move.collectionId),
				)
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: await mapLocale(ctx, move, row.localeId),
				});
			await finishPage(page);
			return;
		}
		case "proposals": {
			const page = await ctx.db
				.query("agentTranslationProposals")
				.withIndex("by_collection", (q) =>
					q.eq("target.collectionId", move.collectionId),
				)
				.paginate({ numItems: 1, cursor: move.proposalCursor ?? null });
			const proposal = page.page[0];
			if (!proposal) {
				await ctx.db.patch(move.collectionId, {
					projectId: move.destinationProjectId,
					movingToProjectId: undefined,
				});
				await ctx.db.patch(move.destinationProjectId, {
					migrationPending: undefined,
					updatedAt: Date.now(),
				});
				await ctx.db.patch(move._id, {
					status: "complete",
					completedAt: Date.now(),
					cursor: undefined,
				});
				return;
			}
			// Promotion hands existing assignments to the new project while retaining the original creator.
			await ctx.db.patch(proposal._id, {
				projectId: move.destinationProjectId,
				createdByTokenId: undefined,
				taskScope: proposal.taskScope
					? {
							...proposal.taskScope,
							localeId: await mapLocale(ctx, move, proposal.taskScope.localeId),
						}
					: undefined,
			});
			await ctx.db.patch(move._id, {
				proposalId: proposal._id,
				proposalCursor: page.continueCursor,
				phase: "taskTargets",
				cursor: undefined,
			});
			return;
		}
		case "taskTargets": {
			const proposalId = move.proposalId;
			if (!proposalId) throw new Error("Missing task identity.");
			const page = await ctx.db
				.query("translationTaskTargets")
				.withIndex("by_proposal_and_catalogIndex", (q) =>
					q.eq("proposalId", proposalId),
				)
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: await mapLocale(ctx, move, row.localeId),
				});
			await nextPhase(
				ctx,
				move,
				page.isDone ? "candidates" : move.phase,
				page.isDone ? undefined : page.continueCursor,
			);
			return;
		}
		case "candidates": {
			const proposalId = move.proposalId;
			if (!proposalId) throw new Error("Missing task identity.");
			const page = await ctx.db
				.query("agentTranslationCandidates")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: row.localeId
						? await mapLocale(ctx, move, row.localeId)
						: undefined,
				});
			await nextPhase(
				ctx,
				move,
				page.isDone ? "candidateRevisions" : move.phase,
				page.isDone ? undefined : page.continueCursor,
			);
			return;
		}
		case "candidateRevisions": {
			const proposalId = move.proposalId;
			if (!proposalId) throw new Error("Missing task identity.");
			const page = await ctx.db
				.query("agentTranslationCandidateRevisions")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, {
					projectId: move.destinationProjectId,
					localeId: row.localeId
						? await mapLocale(ctx, move, row.localeId)
						: undefined,
				});
			await nextPhase(
				ctx,
				move,
				page.isDone ? "candidateReviews" : move.phase,
				page.isDone ? undefined : page.continueCursor,
			);
			return;
		}
		case "candidateReviews": {
			const proposalId = move.proposalId;
			if (!proposalId) throw new Error("Missing task identity.");
			const page = await ctx.db
				.query("agentTranslationCandidateReviews")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.paginate(opts);
			for (const row of page.page)
				await ctx.db.patch(row._id, { projectId: move.destinationProjectId });
			await nextPhase(
				ctx,
				move,
				page.isDone ? "proposals" : move.phase,
				page.isDone ? undefined : page.continueCursor,
			);
			return;
		}
		default:
			throw new Error("Unknown move phase.");
	}
}
export const step = internalMutation({
	args: { moveId: v.id("collectionProjectMoves") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const move = await ctx.db.get(args.moveId);
		if (move?.status !== "moving") return null;
		try {
			await batch(ctx, move);
			const next = await ctx.db.get(move._id);
			if (next?.status === "moving")
				await ctx.scheduler.runAfter(0, internal.projectStructure.step, args);
		} catch (error) {
			await ctx.db.patch(move._id, {
				status: "failed",
				error:
					error instanceof Error
						? error.message.slice(0, 500)
						: "Move paused. Retry to continue.",
			});
		}
		return null;
	},
});
