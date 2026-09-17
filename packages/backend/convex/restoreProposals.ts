import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	activeProjectionFor,
	archiveStateEnvelopeFor,
	MAX_PROJECTED_LOCALES,
	MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES,
} from "./catalogProjection";
import { now } from "./lib";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
	requireEditor,
	requireViewer,
} from "./permissions";
import { advanceSourceProposalSetRevision } from "./sourceProposalState";
import { publishedResolutionFor } from "./sourceProposals";

const MAX_RESTORE_PROPOSAL_SOURCE_VALUE_BYTES = 256 * 1024;
// Lookup stays small because it is run over every source key in a candidate
// catalog. Each lookup reads at most eight small resolution heads per key.
export const MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP = 64;

type ArchivedKeyState = {
	source: Doc<"catalogProjectionArchiveStateValues">;
	targets: Doc<"catalogProjectionArchiveStateValues">[];
};

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function messageIdByteLength(messageId: string): number {
	return new TextEncoder().encode(messageId).byteLength;
}

export function supportsRestoreProposalMessageId(messageId: string): boolean {
	return (
		messageId.length > 0 &&
		messageIdByteLength(messageId) <= MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES
	);
}

function assertRestoreProposalMessageId(messageId: string): void {
	if (!supportsRestoreProposalMessageId(messageId)) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Restore Proposal message identifier exceeds its envelope.",
		});
	}
}

async function archivedKeyState(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
	messageId: string,
): Promise<ArchivedKeyState> {
	const rows = await ctx.db
		.query("catalogProjectionArchiveStateValues")
		.withIndex("by_projection_and_messageId", (q) =>
			q.eq("projectionId", projectionId).eq("messageId", messageId),
		)
		.take(MAX_PROJECTED_LOCALES + 1);
	if (rows.length === 0) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "No archived source key was found for this Restore Proposal.",
		});
	}
	if (
		rows.length > MAX_PROJECTED_LOCALES ||
		rows.some(
			(row) =>
				row.projectId !== projectId ||
				!row.keyArchived ||
				row.messageId !== messageId,
		)
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The archived key state exceeds its supported envelope.",
		});
	}
	const source = rows.filter((row) => row.isSource);
	if (
		source.length !== 1 ||
		rows.some((row) => row.catalogIndex !== source[0]?.catalogIndex)
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The archived key state does not form one source-key group.",
		});
	}
	const [archivedSource] = source;
	if (!archivedSource) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The archived key state is missing its source value.",
		});
	}
	return {
		source: archivedSource,
		targets: rows
			.filter((row) => !row.isSource)
			.sort((left, right) => left.localeCode.localeCompare(right.localeCode)),
	};
}

async function currentProposalHeadFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	messageId: string,
) {
	const head = await ctx.db
		.query("sourceProposalOpenHeads")
		.withIndex("by_project_and_messageId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.unique();
	if (head && (head.projectId !== projectId || head.messageId !== messageId)) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Restore Proposal head points outside its key group.",
		});
	}
	return head;
}

/** Request a Restore Proposal from immutable archive evidence. This leaves the
 * active Catalog Projection unchanged: Git remains Release Truth until the key
 * actually returns in a Source Snapshot. */
export const request = mutation({
	args: {
		projectId: v.id("projects"),
		messageId: v.string(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		assertRestoreProposalMessageId(args.messageId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "An accepted Baseline Snapshot is required for restoration.",
			});
		}
		archiveStateEnvelopeFor(projection);
		const activeRows = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId", (q) =>
				q.eq("projectionId", projection._id).eq("messageId", args.messageId),
			)
			.take(MAX_PROJECTED_LOCALES + 1);
		if (activeRows.length > MAX_PROJECTED_LOCALES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The active catalog exceeds its supported Locale envelope.",
			});
		}
		if (activeRows.some((row) => row.isSource)) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Git already contains this source key; a Restore Proposal would not be a recovery.",
			});
		}
		const currentHead = await currentProposalHeadFor(
			ctx,
			args.projectId,
			args.messageId,
		);
		if (currentHead) {
			const existing = await ctx.db.get(currentHead.proposalId);
			if (
				!existing ||
				existing.projectId !== args.projectId ||
				existing.kind !== "restore" ||
				existing.messageId !== args.messageId
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Restore Proposal head does not match its evidence.",
				});
			}
			const resolved = await publishedResolutionFor(ctx, existing);
			if (
				!resolved &&
				existing.status !== "landed" &&
				existing.status !== "superseded"
			) {
				return { proposalId: existing._id, reused: true };
			}
		}

		const archived = await archivedKeyState(
			ctx,
			args.projectId,
			projection._id,
			args.messageId,
		);
		if (
			encodedSize(archived.source.value) >
			MAX_RESTORE_PROPOSAL_SOURCE_VALUE_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Restore Proposal source value exceeds the supported envelope.",
			});
		}
		const timestamp = now();
		const proposalId = await ctx.db.insert("sourceProposals", {
			projectId: args.projectId,
			kind: "restore",
			archiveStateProjectionId: projection._id,
			messageId: args.messageId,
			sourceValue: archived.source.value,
			sourceFingerprint: archived.source.sourceFingerprint,
			evidenceSnapshotId: archived.source.evidenceSnapshotId,
			status: "open",
			createdBy: { kind: "user", id: userId },
			createdAt: timestamp,
		});
		if (currentHead) {
			await ctx.db.patch(currentHead._id, { proposalId });
		} else {
			await ctx.db.insert("sourceProposalOpenHeads", {
				projectId: args.projectId,
				messageId: args.messageId,
				proposalId,
			});
		}
		await advanceSourceProposalSetRevision(ctx, project);
		return { proposalId, reused: false };
	},
});

/** Look up current, unresolved Restore Proposals for a bounded source-key
 * batch. The small per-key head avoids scanning proposal history or reading
 * archived source values for every message in an ingest. */
export const openForMessages = internalQuery({
	args: {
		projectId: v.id("projects"),
		messageIds: v.array(v.string()),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			args.messageIds.length > MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP ||
			args.messageIds.some(
				(messageId) => !supportsRestoreProposalMessageId(messageId),
			) ||
			new Set(args.messageIds).size !== args.messageIds.length
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `A Restore Proposal lookup may contain at most ${MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP} unique message identifiers.`,
			});
		}
		const proposals: {
			proposalId: Id<"sourceProposals">;
			messageId: string;
		}[] = [];
		for (const messageId of args.messageIds) {
			const head = await currentProposalHeadFor(ctx, args.projectId, messageId);
			if (!head) continue;
			const resolution = await publishedResolutionFor(ctx, {
				_id: head.proposalId,
				projectId: args.projectId,
				messageId,
			});
			if (resolution) continue;
			proposals.push({ proposalId: head.proposalId, messageId });
		}
		return {
			proposals,
		};
	},
});

/** Read a Restore Proposal and the archive evidence it was seeded from. */
export const get = query({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("sourceProposals"),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const proposal = await ctx.db.get(args.proposalId);
		if (
			!proposal ||
			proposal.projectId !== args.projectId ||
			proposal.kind !== "restore"
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Restore Proposal not found.",
			});
		}
		const projection = await ctx.db.get(proposal.archiveStateProjectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "published" ||
			projection.snapshotId === undefined
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Restore Proposal points to missing archive state.",
			});
		}
		archiveStateEnvelopeFor(projection);
		const archived = await archivedKeyState(
			ctx,
			args.projectId,
			projection._id,
			proposal.messageId,
		);
		if (
			archived.source.value !== proposal.sourceValue ||
			archived.source.sourceFingerprint !== proposal.sourceFingerprint ||
			archived.source.evidenceSnapshotId !== proposal.evidenceSnapshotId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Restore Proposal does not match its archived source evidence.",
			});
		}
		const resolution = await publishedResolutionFor(ctx, proposal);
		const hasStoredObservation =
			proposal.observedSnapshotId !== undefined ||
			proposal.observedAt !== undefined;
		if (
			(proposal.status === "open" || proposal.status === "resolving") &&
			hasStoredObservation
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Restore Proposal observation state is inconsistent.",
			});
		}
		if (
			(proposal.status === "landed" || proposal.status === "superseded") &&
			(proposal.observedSnapshotId === undefined ||
				proposal.observedAt === undefined)
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Restore Proposal is missing its legacy observation evidence.",
			});
		}
		const status =
			resolution?.status ??
			(proposal.status === "resolving" ? "open" : proposal.status);
		return {
			proposalId: proposal._id,
			messageId: proposal.messageId,
			status,
			...(resolution === undefined || resolution === null
				? proposal.observedSnapshotId === undefined
					? {}
					: { observedSnapshotId: proposal.observedSnapshotId }
				: { observedSnapshotId: resolution.observedSnapshotId }),
			...(resolution !== undefined && resolution !== null
				? {}
				: proposal.observedAt === undefined
					? {}
					: { observedAt: proposal.observedAt }),
			source: {
				catalogPath: archived.source.catalogPath,
				value: archived.source.value,
				...(archived.source.metadataCatalogPath === undefined
					? {}
					: { metadataCatalogPath: archived.source.metadataCatalogPath }),
				...(archived.source.metadataSnapshotId === undefined
					? {}
					: { metadataSnapshotId: archived.source.metadataSnapshotId }),
				sourceFingerprint: archived.source.sourceFingerprint,
				evidenceSnapshotId: archived.source.evidenceSnapshotId,
			},
			targets: archived.targets.map((target) => ({
				localeId: target.localeId,
				localeCode: target.localeCode,
				catalogPath: target.catalogPath,
				value: target.value,
				...(target.metadataCatalogPath === undefined
					? {}
					: { metadataCatalogPath: target.metadataCatalogPath }),
				...(target.metadataSnapshotId === undefined
					? {}
					: { metadataSnapshotId: target.metadataSnapshotId }),
				...(target.restoredFromSnapshotId === undefined
					? {}
					: { restoredFromSnapshotId: target.restoredFromSnapshotId }),
				sourceFingerprint: target.sourceFingerprint,
				evidenceSnapshotId: target.evidenceSnapshotId,
			})),
		};
	},
});
