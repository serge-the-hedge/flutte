import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import {
	MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES,
	MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS,
	projectionPublicationStateFor,
} from "./catalogProjection";
import type { Actor } from "./lib";
import { now } from "./lib";
import { assertMessageCharacterLimit } from "./messageConstraints";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
} from "./permissions";

/** A Catalog Workspace read already composes the full 8 MiB working catalog,
 * target heads, and decision evidence. Source Proposal heads stay deliberately
 * smaller so durable candidate history never makes that one public read exceed
 * Convex's envelope. */
export const MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEADS = 64;
export const MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEAD_BYTES = 1024 * 1024;
export const MAX_SOURCE_PROPOSAL_VALUE_BYTES = 256 * 1024;

export type SourceProposalStatus = "pending" | "landed" | "superseded";

type SourceProposalHeadInput = {
	messageId: string;
	proposalId: Id<"sourceProposals">;
	sourceValue: string;
	sourceFingerprint: string;
	basisGitValueFingerprint: string;
	basisGitValueRevision: number;
	revision: number;
	updatedBy: Actor;
	updatedAt: number;
};

type SourceProposalIdentity = Pick<
	Doc<"sourceProposals">,
	"_id" | "projectId" | "messageId"
>;
type SourceValueProposal = Extract<Doc<"sourceProposals">, { kind: "source" }>;

export type PublishedSourceProposalResolution = {
	status: "landed" | "superseded";
	observedSnapshotId: Id<"sourceSnapshots">;
};

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function messageIdByteLength(messageId: string): number {
	return new TextEncoder().encode(messageId).byteLength;
}

function sourceProposalHeadByteLength(head: SourceProposalHeadInput): number {
	return encodedSize({
		messageId: head.messageId,
		proposalId: head.proposalId,
		sourceValue: head.sourceValue,
		sourceFingerprint: head.sourceFingerprint,
		basisGitValueFingerprint: head.basisGitValueFingerprint,
		basisGitValueRevision: head.basisGitValueRevision,
		revision: head.revision,
		updatedBy: head.updatedBy,
		updatedAt: head.updatedAt,
	});
}

function assertSourceProposalHeadFields(
	head: Omit<SourceProposalHeadInput, "proposalId">,
): void {
	if (
		head.messageId.length === 0 ||
		messageIdByteLength(head.messageId) >
			MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES ||
		new TextEncoder().encode(head.sourceValue).byteLength >
			MAX_SOURCE_PROPOSAL_VALUE_BYTES ||
		head.sourceFingerprint.length === 0 ||
		head.basisGitValueFingerprint.length === 0 ||
		!Number.isSafeInteger(head.basisGitValueRevision) ||
		head.basisGitValueRevision < 0 ||
		!Number.isSafeInteger(head.revision) ||
		head.revision < 1
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Source Proposal exceeds the supported Workspace envelope.",
		});
	}
}

async function sourceProposalStateFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogWorkspaceSourceProposalStates"> | null> {
	return await ctx.db
		.query("catalogWorkspaceSourceProposalStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

/** Read the bounded current Source Proposal set. The durable proposal table is
 * intentionally not scanned here: its history grows forever while this head
 * set is exactly what the active Catalog Workspace needs. */
export async function sourceProposalHeadsFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogWorkspaceSourceProposalHeads">[]> {
	const [state, heads] = await Promise.all([
		sourceProposalStateFor(ctx, projectId),
		ctx.db
			.query("catalogWorkspaceSourceProposalHeads")
			.withIndex("by_project", (q) => q.eq("projectId", projectId))
			.take(MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEADS + 1),
	]);
	if (heads.length > MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEADS) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace exceeds its supported Source Proposal head envelope.",
		});
	}
	assertSourceProposalHeadEnvelope(state, heads);
	return heads;
}

function assertSourceProposalHeadEnvelope(
	state: Doc<"catalogWorkspaceSourceProposalStates"> | null,
	heads: readonly Doc<"catalogWorkspaceSourceProposalHeads">[],
): void {
	const byteLength = heads.reduce(
		(total, head) => total + sourceProposalHeadByteLength(head),
		0,
	);
	if (
		heads.length > MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEADS ||
		byteLength > MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEAD_BYTES ||
		(state === null && heads.length > 0) ||
		(state !== null &&
			(!Number.isInteger(state.headCount) ||
				!Number.isInteger(state.headByteLength) ||
				state.headCount < 0 ||
				state.headByteLength < 0 ||
				state.headCount !== heads.length ||
				state.headByteLength !== byteLength))
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace does not match its declared Source Proposal head envelope.",
		});
	}
}

/** Return a checked, indexed Source Proposal head for one source key. */
export async function sourceProposalHeadFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	messageId: string,
): Promise<Doc<"catalogWorkspaceSourceProposalHeads"> | null> {
	const head = await ctx.db
		.query("catalogWorkspaceSourceProposalHeads")
		.withIndex("by_project_and_messageId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.unique();
	if (head && (head.projectId !== projectId || head.messageId !== messageId)) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Proposal head points outside its source-key group.",
		});
	}
	return head;
}

export function sourceProposalHeadMap(
	heads: readonly Doc<"catalogWorkspaceSourceProposalHeads">[],
): Map<string, Doc<"catalogWorkspaceSourceProposalHeads">> {
	const result = new Map<string, Doc<"catalogWorkspaceSourceProposalHeads">>();
	for (const head of heads) {
		if (result.has(head.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace contains duplicate Source Proposal heads.",
			});
		}
		result.set(head.messageId, head);
	}
	return result;
}

/** A Source Proposal can overlay only the exact Git value it answered. The Git
 * revision closes the F → G → F stale-edit hole just as it does for targets. */
export function isCurrentSourceProposalHeadForSource(
	source: Pick<
		Doc<"catalogProjectionMessages">,
		"isSource" | "messageId" | "gitValueFingerprint" | "gitValueRevision"
	>,
	head: Doc<"catalogWorkspaceSourceProposalHeads"> | null | undefined,
): head is Doc<"catalogWorkspaceSourceProposalHeads"> {
	return (
		source.isSource &&
		source.gitValueFingerprint !== undefined &&
		head !== null &&
		head !== undefined &&
		head.messageId === source.messageId &&
		head.basisGitValueFingerprint === source.gitValueFingerprint &&
		head.basisGitValueRevision === (source.gitValueRevision ?? 0)
	);
}

function sourceProposalMatchesHead(
	head: Doc<"catalogWorkspaceSourceProposalHeads">,
	proposal: Doc<"sourceProposals"> | null,
): proposal is SourceValueProposal {
	return (
		proposal !== null &&
		proposal.projectId === head.projectId &&
		proposal.kind === "source" &&
		proposal.messageId === head.messageId &&
		proposal.sourceValue === head.sourceValue &&
		proposal.sourceFingerprint === head.sourceFingerprint &&
		proposal.basisGitValueFingerprint === head.basisGitValueFingerprint &&
		proposal.basisGitValueRevision === head.basisGitValueRevision
	);
}

/** A resolution is stored with its private projection and becomes visible only
 * when that projection becomes the accepted Baseline. This avoids an
 * unbounded publication-time update across proposal history. */
export async function publishedResolutionFor(
	ctx: QueryCtx | MutationCtx,
	proposal: SourceProposalIdentity,
): Promise<PublishedSourceProposalResolution | null> {
	const heads = await ctx.db
		.query("restoreProposalResolutionHeads")
		.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
		.take(MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS + 1);
	if (heads.length > MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Proposal observations exceed their supported envelope.",
		});
	}
	const published: PublishedSourceProposalResolution[] = [];
	for (const head of heads) {
		if (
			head.projectId !== proposal.projectId ||
			head.messageId !== proposal.messageId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal resolution does not match its proposal.",
			});
		}
		const projection = await projectionPublicationStateFor(
			ctx,
			head.projectionId,
		);
		if (
			!projection ||
			projection.projectionId !== head.projectionId ||
			projection.projectId !== proposal.projectId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal resolution points outside its project.",
			});
		}
		if (
			projection.status === "published" &&
			projection.snapshotId !== undefined
		) {
			published.push({
				status: head.status,
				observedSnapshotId: projection.snapshotId,
			});
		}
	}
	if (published.length > 1) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"A Source Proposal was resolved by more than one accepted Baseline.",
		});
	}
	return published[0] ?? null;
}

/** Resolve every bounded Source Proposal head for one public Workspace read. */
export async function sourceProposalStatusesFor(
	ctx: QueryCtx | MutationCtx,
	heads: readonly Doc<"catalogWorkspaceSourceProposalHeads">[],
): Promise<Map<Id<"sourceProposals">, PublishedSourceProposalResolution>> {
	const statuses = new Map<
		Id<"sourceProposals">,
		PublishedSourceProposalResolution
	>();
	for (const head of heads) {
		const proposal = await ctx.db.get(head.proposalId);
		if (!sourceProposalMatchesHead(head, proposal)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal head does not match its durable evidence.",
			});
		}
		const resolution = await publishedResolutionFor(ctx, proposal);
		if (resolution) statuses.set(head.proposalId, resolution);
	}
	return statuses;
}

async function upsertSourceProposalHead(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		state: Doc<"catalogWorkspaceSourceProposalStates"> | null;
		previous: Doc<"catalogWorkspaceSourceProposalHeads"> | null;
		next: SourceProposalHeadInput;
	},
): Promise<void> {
	assertSourceProposalHeadFields(input.next);
	if (!input.state && input.previous) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Proposal heads are missing their Workspace envelope.",
		});
	}
	const previousByteLength = input.previous
		? sourceProposalHeadByteLength(input.previous)
		: 0;
	const nextByteLength = sourceProposalHeadByteLength(input.next);
	const nextCount = (input.state?.headCount ?? 0) + (input.previous ? 0 : 1);
	const nextTotalByteLength =
		(input.state?.headByteLength ?? 0) - previousByteLength + nextByteLength;
	if (
		nextCount > MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEADS ||
		nextTotalByteLength > MAX_CATALOG_WORKSPACE_SOURCE_PROPOSAL_HEAD_BYTES
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message:
				"Catalog Workspace exceeds its supported Source Proposal head envelope.",
		});
	}
	if (input.previous) {
		await ctx.db.patch(input.previous._id, input.next);
	} else {
		await ctx.db.insert("catalogWorkspaceSourceProposalHeads", {
			projectId: input.projectId,
			...input.next,
		});
	}
	if (input.state) {
		await ctx.db.patch(input.state._id, {
			headCount: nextCount,
			headByteLength: nextTotalByteLength,
		});
	} else {
		await ctx.db.insert("catalogWorkspaceSourceProposalStates", {
			projectId: input.projectId,
			headCount: nextCount,
			headByteLength: nextTotalByteLength,
		});
	}
}

/** Save a value-only candidate without ever changing the Source Contract.
 * Repeated edits update its current candidate evidence; a resolved candidate
 * gets a fresh durable record while the old evidence remains readable. */
export async function saveSourceProposal(
	ctx: MutationCtx,
	input: {
		project: Doc<"projects">;
		messageId: string;
		sourceValue: string;
		sourceFingerprint: string;
		basisGitValueFingerprint: string;
		basisGitValueRevision: number;
		evidenceSnapshotId: Id<"sourceSnapshots">;
		actor: Actor;
	},
): Promise<{ workspaceRevision: number }> {
	await assertMessageCharacterLimit(
		ctx,
		{ projectId: input.project._id, messageId: input.messageId },
		input.sourceValue,
	);
	const nextTimestamp = now();
	const [state, previous] = await Promise.all([
		sourceProposalStateFor(ctx, input.project._id),
		sourceProposalHeadFor(ctx, input.project._id, input.messageId),
	]);
	const nextRevision = (previous?.revision ?? 0) + 1;
	const nextHeadFields: Omit<SourceProposalHeadInput, "proposalId"> = {
		messageId: input.messageId,
		sourceValue: input.sourceValue,
		sourceFingerprint: input.sourceFingerprint,
		basisGitValueFingerprint: input.basisGitValueFingerprint,
		basisGitValueRevision: input.basisGitValueRevision,
		revision: nextRevision,
		updatedBy: input.actor,
		updatedAt: nextTimestamp,
	};
	assertSourceProposalHeadFields(nextHeadFields);

	let proposalId: Id<"sourceProposals"> | undefined;
	if (previous) {
		const proposal = await ctx.db.get(previous.proposalId);
		if (
			!proposal ||
			proposal.projectId !== input.project._id ||
			proposal.kind !== "source" ||
			proposal.messageId !== input.messageId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal head does not match its durable evidence.",
			});
		}
		const resolution = await publishedResolutionFor(ctx, proposal);
		if (!resolution && proposal.status === "open") {
			proposalId = proposal._id;
			await ctx.db.patch(proposal._id, {
				sourceValue: input.sourceValue,
				sourceFingerprint: input.sourceFingerprint,
				basisGitValueFingerprint: input.basisGitValueFingerprint,
				basisGitValueRevision: input.basisGitValueRevision,
				updatedBy: input.actor,
				updatedAt: nextTimestamp,
			});
		}
	}
	if (!proposalId) {
		proposalId = await ctx.db.insert("sourceProposals", {
			projectId: input.project._id,
			kind: "source",
			messageId: input.messageId,
			sourceValue: input.sourceValue,
			sourceFingerprint: input.sourceFingerprint,
			basisGitValueFingerprint: input.basisGitValueFingerprint,
			basisGitValueRevision: input.basisGitValueRevision,
			evidenceSnapshotId: input.evidenceSnapshotId,
			status: "open",
			createdBy: input.actor,
			createdAt: nextTimestamp,
			updatedBy: input.actor,
			updatedAt: nextTimestamp,
		});
	}
	await upsertSourceProposalHead(ctx, {
		projectId: input.project._id,
		state,
		previous,
		next: { ...nextHeadFields, proposalId },
	});
	const currentHeadVersion = input.project.sourceProposalHeadVersion ?? 0;
	if (!Number.isSafeInteger(currentHeadVersion) || currentHeadVersion < 0) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Proposal head version is invalid.",
		});
	}
	await ctx.db.patch(input.project._id, {
		sourceProposalHeadVersion: currentHeadVersion + 1,
		updatedAt: nextTimestamp,
	});
	return { workspaceRevision: nextRevision };
}

/** Read the complete, bounded set of unresolved Source Proposals before a
 * candidate Source Snapshot is staged. The caller supplies the snapshot's
 * source values, so only proposals whose keys still exist are observed. */
export const openForProject = internalQuery({
	args: {
		projectId: v.id("projects"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const heads = await sourceProposalHeadsFor(ctx, args.projectId);
		const proposals: {
			proposalId: Id<"sourceProposals">;
			messageId: string;
			basisGitValueFingerprint: string;
		}[] = [];
		for (const head of heads) {
			const proposal = await ctx.db.get(head.proposalId);
			if (
				!sourceProposalMatchesHead(head, proposal) ||
				proposal.projectId !== args.projectId
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Source Proposal head does not match its durable evidence.",
				});
			}
			if (proposal.status !== "open") continue;
			if (await publishedResolutionFor(ctx, proposal)) continue;
			proposals.push({
				proposalId: proposal._id,
				messageId: proposal.messageId,
				basisGitValueFingerprint: proposal.basisGitValueFingerprint,
			});
		}
		return { proposals };
	},
});
