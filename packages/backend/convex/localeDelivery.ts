import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
	query,
} from "./_generated/server";
import { isHumanOrAuthorizedReview } from "./agentReviewModel";
import { type CatalogDocument, parse } from "./catalogDocument";
import {
	MAX_PROJECTED_LOCALES,
	MAX_WORKING_CATALOG_KEYS,
	projectionPublicationStateFor,
} from "./catalogProjection";
import {
	decisionRecordByteLength,
	decisionStateFor,
	recordDecisions,
} from "./catalogWorkspace";
import { sourceContractsMatch } from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import { backfillLegacyDeliveryMetadata } from "./localeProposals";
import {
	authorizeProjectIngestion,
	type RepositoryAdapterActor,
	repositoryAdapterActorValidator,
	requireViewer,
} from "./permissions";

/** Immutable ingest files plus explicit, published binding realizations. The
 * original Snapshot files stay unchanged, including their ingest-time roles. */
export async function snapshotCatalogFiles(
	ctx: QueryCtx | MutationCtx,
	snapshotId: Id<"sourceSnapshots">,
) {
	const [original, realized] = await Promise.all([
		ctx.db
			.query("sourceSnapshotFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
			.take(MAX_PROJECTED_LOCALES + 1),
		ctx.db
			.query("localeBindingRealizations")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
			.take(MAX_PROJECTED_LOCALES + 1),
	]);
	const files = [...original, ...realized];
	if (files.length > MAX_PROJECTED_LOCALES)
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: "Bound Snapshot catalogs exceed the supported Locale envelope.",
		});
	return files;
}

const ARTIFACT_CANDIDATE_PAGE_SIZE = 16;
const MAX_ARTIFACT_CANDIDATE_PAGES = 32;

export const matchingArtifact = internalQuery({
	args: {
		projectId: v.id("projects"),
		catalogPath: v.string(),
		contentHash: v.string(),
		repository: v.string(),
		commit: v.string(),
		cursor: v.union(v.string(), v.null()),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const matches = await ctx.db
			.query("localeProposals")
			.withIndex("by_project_and_catalogPath_and_catalogContentHash", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("catalogPath", args.catalogPath)
					.eq("catalogContentHash", args.contentHash),
			)
			.order("desc")
			.paginate({
				numItems: ARTIFACT_CANDIDATE_PAGE_SIZE,
				cursor: args.cursor,
			});
		const proposals = [];
		for (const proposal of matches.page) {
			if (proposal.status !== "ready") continue;
			const sourceSnapshot = await ctx.db.get(proposal.sourceSnapshotId);
			if (
				sourceSnapshot?.repository === args.repository &&
				sourceSnapshot.commit !== args.commit
			)
				proposals.push(proposal);
		}
		return {
			proposals,
			isDone: matches.isDone,
			continueCursor: matches.continueCursor,
		};
	},
});

export const observe = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		proposalId: v.id("localeProposals"),
		catalogPath: v.string(),
		contentHash: v.string(),
		localeId: v.optional(v.id("locales")),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const [projection, proposal] = await Promise.all([
			ctx.db.get(args.projectionId),
			ctx.db.get(args.proposalId),
		]);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			!proposal ||
			proposal.projectId !== args.projectId ||
			proposal.status !== "ready" ||
			proposal.catalogPath !== args.catalogPath ||
			proposal.catalogContentHash !== args.contentHash
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Locale delivery evidence changed while staging.",
			});
		if (args.localeId) {
			const locale = await ctx.db.get(args.localeId);
			if (
				!locale ||
				locale.projectId !== args.projectId ||
				locale.code !== proposal.localeCode ||
				locale.isSource ||
				locale.archivedAt !== undefined
			)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Locale delivery cannot supply decisions for this binding.",
				});
		}
		return await ctx.db.insert("localeDeliveryObservations", {
			projectId: args.projectId,
			projectionId: args.projectionId,
			proposalId: args.proposalId,
			catalogPath: args.catalogPath,
			catalogContentHash: args.contentHash,
			localeCode: proposal.localeCode,
			...(args.localeId ? { localeId: args.localeId } : {}),
			decisionsStaged: !args.localeId,
			observedAt: now(),
		});
	},
});

export const stageDecisions = internalMutation({
	args: {
		observationId: v.id("localeDeliveryObservations"),
		after: v.optional(v.string()),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		const observation = await ctx.db.get(args.observationId);
		if (!observation?.localeId)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Bound Locale delivery observation not found.",
			});
		await authorizeProjectIngestion(ctx, observation.projectId, args.actor);
		const projection = await ctx.db.get(observation.projectionId);
		if (projection?.status !== "staging")
			throw new ConvexError({
				code: "CONFLICT",
				message: "Locale delivery projection is no longer staging.",
			});
		const localeId = observation.localeId;
		const values = await ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal_and_messageId", (q) =>
				args.after === undefined
					? q.eq("proposalId", observation.proposalId)
					: q
							.eq("proposalId", observation.proposalId)
							.gt("messageId", args.after),
			)
			.take(16);
		const next = [];
		for (const value of values) {
			if (
				!isHumanOrAuthorizedReview(value.updatedBy, value.reviewAuthorization)
			)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A delivered Locale value lacks authorized review.",
				});
			const target = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_localeId", (q) =>
					q
						.eq("projectionId", observation.projectionId)
						.eq("messageId", value.messageId)
						.eq("localeId", localeId),
				)
				.unique();
			if (
				!target ||
				target.value !== value.value ||
				target.sourceFingerprint !== value.sourceFingerprint
			)
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Delivered Locale value does not match its reviewed Source/value pair.",
				});
			const basis = {
				deliveryProjectionId: observation.projectionId,
				localeProposalId: observation.proposalId,
				messageId: value.messageId,
				localeId: observation.localeId,
				sourceFingerprint: value.sourceFingerprint,
				valueFingerprint: await sha256Hex(value.value),
				recordedBy: value.updatedBy,
				...(value.reviewAuthorization
					? { reviewAuthorization: value.reviewAuthorization }
					: {}),
				recordedAt: value.updatedAt,
			};
			if (value.value.length === 0) {
				if (!value.intentionalBlankReason)
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"A delivered empty value lacks its Intentional Blank reason.",
					});
				next.push({
					...basis,
					kind: "intentionalBlank" as const,
					reason: value.intentionalBlankReason,
				});
			} else next.push({ ...basis, kind: "translatorConfirmation" as const });
		}
		await recordDecisions(ctx, {
			projectId: observation.projectId,
			state: await decisionStateFor(ctx, observation.projectId),
			next,
		});
		const done = values.length < 16;
		if (done) await ctx.db.patch(observation._id, { decisionsStaged: true });
		return { done, after: values[values.length - 1]?.messageId };
	},
});

export async function assertDeliveryStaged(
	ctx: MutationCtx,
	projectionId: Id<"catalogProjections">,
) {
	const observations = await ctx.db
		.query("localeDeliveryObservations")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(129);
	if (
		observations.length > 128 ||
		observations.some((observation) => !observation.decisionsStaged)
	)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Locale delivery evidence is incomplete.",
		});
}

/** Observe only exact artifact bytes at the pinned path, with an unchanged
 * executable Source Contract. Neither a preview nor a delivery command receipt
 * publishes these records; visibility follows the accepted projection. */
export async function stageLocaleDeliveries(
	ctx: ActionCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		repository: string;
		commit: string;
		source: CatalogDocument;
		files: readonly { catalogPath: string; content: string }[];
		boundFiles: readonly {
			catalogPath: string;
			localeId: Id<"locales">;
			localeCode: string;
			isSource: boolean;
		}[];
		actor?: RepositoryAdapterActor;
	},
) {
	await backfillLegacyDeliveryMetadata(ctx, input.projectId);
	const currentSource = new Map(
		input.source.messages.map((message) => [message.id, message]),
	);
	let observations = 0;
	for (const file of input.files) {
		const bound = input.boundFiles.find(
			(bound) => bound.catalogPath === file.catalogPath,
		);
		if (bound?.isSource) continue;
		const contentHash = await sha256Hex(file.content);
		let proposal: Doc<"localeProposals"> | undefined;
		let cursor: string | null = null;
		let candidatesDone = false;
		// Identical target bytes can have different reviewed Source Contracts. The
		// newest matching Source Contract supplies provenance, not just the newest hash.
		for (
			let page = 0;
			page < MAX_ARTIFACT_CANDIDATE_PAGES && !proposal && !candidatesDone;
			page++
		) {
			const candidates: {
				proposals: Doc<"localeProposals">[];
				isDone: boolean;
				continueCursor: string;
			} = await ctx.runQuery(internal.localeDelivery.matchingArtifact, {
				projectId: input.projectId,
				catalogPath: file.catalogPath,
				contentHash,
				repository: input.repository,
				commit: input.commit,
				cursor,
				actor: input.actor,
			});
			cursor = candidates.continueCursor;
			candidatesDone = candidates.isDone;
			for (const candidate of candidates.proposals) {
				if (bound && bound.localeCode !== candidate.localeCode) continue;
				const sourceBlob = await ctx.storage.get(candidate.sourceStorageId);
				if (!sourceBlob)
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Delivered Locale Proposal source evidence is missing.",
					});
				const source = parse(await sourceBlob.text());
				if (
					source.messages.length === currentSource.size &&
					source.messages.every((message) => {
						const next = currentSource.get(message.id);
						return next && sourceContractsMatch(message, next);
					})
				) {
					proposal = candidate;
					break;
				}
			}
		}
		if (!proposal && !candidatesDone)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"Locale delivery artifact matching exceeded its bounded proposal history.",
			});
		if (!proposal) continue;
		// Proposal source snapshots are created from an accepted Baseline. The action
		// only runs inside a prospective accepted descendant or explicit realization.
		if (++observations > 128)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"A Snapshot supports at most 128 Locale delivery observations.",
			});
		const observationId: Id<"localeDeliveryObservations"> =
			await ctx.runMutation(internal.localeDelivery.observe, {
				projectId: input.projectId,
				projectionId: input.projectionId,
				proposalId: proposal._id,
				catalogPath: file.catalogPath,
				contentHash,
				...(bound ? { localeId: bound.localeId } : {}),
				actor: input.actor,
			});
		if (!bound) continue;
		let after: string | undefined;
		let done = false;
		for (
			let page = 0;
			page <= Math.ceil(MAX_WORKING_CATALOG_KEYS / 16) && !done;
			page++
		) {
			const result: { done: boolean; after?: string } = await ctx.runMutation(
				internal.localeDelivery.stageDecisions,
				{ observationId, after, actor: input.actor },
			);
			done = result.done;
			after = result.after;
		}
		if (!done)
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Locale delivery decisions exceeded their bounded staging steps.",
			});
	}
}

/** A failed private attempt must not consume the bounded decision-history
 * envelope. Published decisions remain immutable even after Baseline advances. */
export const discardDecisions = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const state = await projectionPublicationStateFor(ctx, args.projectionId);
		if (
			!state ||
			state.projectId !== args.projectId ||
			state.status === "published"
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Published delivery decisions cannot be discarded.",
			});
		const records = await ctx.db
			.query("catalogWorkspaceDecisionRecords")
			.withIndex("by_deliveryProjectionId", (q) =>
				q.eq("deliveryProjectionId", args.projectionId),
			)
			.take(32);
		if (records.length) {
			const envelope = await decisionStateFor(ctx, args.projectId);
			if (!envelope)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Delivery decisions lack their bounded envelope.",
				});
			for (const record of records) await ctx.db.delete(record._id);
			await ctx.db.patch(envelope._id, {
				decisionRecordCount: envelope.decisionRecordCount - records.length,
				decisionRecordByteLength:
					envelope.decisionRecordByteLength -
					records.reduce(
						(total, record) => total + decisionRecordByteLength(record),
						0,
					),
			});
		}
		if (records.length === 32) return false;
		const observations = await ctx.db
			.query("localeDeliveryObservations")
			.withIndex("by_projection", (q) =>
				q.eq("projectionId", args.projectionId),
			)
			.take(32);
		for (const observation of observations)
			await ctx.db.delete(observation._id);
		return observations.length < 32;
	},
});

export const forProposal = query({
	args: { proposalId: v.id("localeProposals") },
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		await requireViewer(ctx, proposal.projectId);
		const project = await ctx.db.get(proposal.projectId);
		if (!project?.baselineSnapshotId) return null;
		const locale = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", proposal.projectId).eq("code", proposal.localeCode),
			)
			.unique();
		const activeProjectionId = project.activeCatalogProjectionId;
		const currentRow =
			locale && locale.archivedAt === undefined && activeProjectionId
				? await ctx.db
						.query("catalogProjectionMessages")
						.withIndex("by_projection_and_localeId_and_valueFingerprint", (q) =>
							q
								.eq("projectionId", activeProjectionId)
								.eq("localeId", locale._id),
						)
						.first()
				: null;
		const observations = await ctx.db
			.query("localeDeliveryObservations")
			.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
			.order("desc")
			.take(64);
		for (const observation of observations) {
			const publication = await projectionPublicationStateFor(
				ctx,
				observation.projectionId,
			);
			if (publication?.status !== "published") continue;
			const bound =
				locale &&
				currentRow &&
				!currentRow.isSource &&
				currentRow.catalogPath === observation.catalogPath &&
				locale.catalogPath === observation.catalogPath &&
				observation.localeId === locale._id;
			// Binding is a completed handoff even when Git later edits the catalog.
			// Unbound observations only offer a binding action on the current Baseline.
			if (!bound && publication.snapshotId !== project.baselineSnapshotId)
				continue;
			return {
				status: bound ? ("bound" as const) : ("observed" as const),
				snapshotId: publication.snapshotId,
				catalogPath: observation.catalogPath,
				localeCode: observation.localeCode,
			};
		}
		return null;
	},
});
