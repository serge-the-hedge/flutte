import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import {
	candidateRevisionInputValidator,
	currentLocaleProposalTarget,
	latestCandidateReview,
	proposalForToken,
	selectedTaskCurrent,
	submitCandidateRevisions,
} from "./agentTranslationProposals";
import { type CatalogMessage, parse } from "./catalogDocument";
import { activeProjectionFor } from "./catalogProjection";
import { decisionForIdentity } from "./catalogWorkspaceDecisionQueries";
import { readWorkspaceTarget } from "./catalogWorkspaceRead";
import { completeSourceContractsMatch } from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import { type reuseOutcome, reusePage } from "./taskReuseModel";

const address = {
	token: v.string(),
	sourceTaskId: v.id("agentTranslationProposals"),
	destinationTaskId: v.id("agentTranslationProposals"),
	clientReuseKey: v.string(),
	cursor: v.number(),
};
const addressValidator = v.object(address);
type Address = Infer<typeof addressValidator>;
type ReadCtx = QueryCtx | MutationCtx;
type Task = Doc<"agentTranslationProposals">;
type Outcome = Infer<typeof reuseOutcome>;

// One item can reread 256 KiB origin/source values through ordinary submission,
// a 512 KiB edited review, and workspace overlays. Reserve half the 16 MiB read
// budget (well above those repeated payloads) plus write/receipt headroom before
// starting another item. Small values still share a full 16-item transaction.
const NEXT_ITEM_READ_RESERVE = 8 * 1024 * 1024;
const NEXT_ITEM_WRITE_RESERVE = 1024 * 1024;

function fail(code: string, message: string): never {
	throw new ConvexError({ code, message });
}
function isTask(task: Task) {
	return (
		task.taskScope !== undefined ||
		(task.target.kind === "localeProposal" &&
			task.localeProposalTaskScope?.localeProposalId ===
				task.target.localeProposalId)
	);
}

async function access(ctx: ReadCtx, args: Address) {
	const token = await authenticateAgent(ctx, args.token, "read");
	await authenticateAgent(ctx, args.token, "propose");
	if (
		!Number.isSafeInteger(args.cursor) ||
		args.cursor < 0 ||
		!args.clientReuseKey.trim() ||
		new TextEncoder().encode(args.clientReuseKey).length > 256
	)
		fail(
			"VALIDATION",
			"Provide a bounded reuse key and non-negative integer cursor.",
		);
	const source = await proposalForToken(ctx, args.sourceTaskId, token._id);
	const destination = await proposalForToken(
		ctx,
		args.destinationTaskId,
		token._id,
	);
	if (!isTask(source) || !isTask(destination) || source._id === destination._id)
		fail(
			"VALIDATION",
			"Choose distinct accessible Translation Tasks in the same project.",
		);
	// Plain source belongs to its collection. Repository contracts belong to the project.
	if (
		(source.target.kind === "managedCollection" ||
			destination.target.kind === "managedCollection") &&
		!(
			source.target.kind === "managedCollection" &&
			destination.target.kind === "managedCollection" &&
			source.target.collectionId === destination.target.collectionId
		)
	)
		fail("VALIDATION", "Both tasks must share the same source workspace.");
	const pages = ctx.db
		.query("translationTaskReusePages")
		.withIndex(
			"by_projectId_and_createdByTokenId_and_clientReuseKey_and_cursor",
			(q) =>
				q
					.eq("projectId", token.projectId)
					.eq("createdByTokenId", token._id)
					.eq("clientReuseKey", args.clientReuseKey),
		);
	const first = await pages.first();
	if (
		first &&
		(first.result.sourceTaskId !== source._id ||
			first.result.destinationTaskId !== destination._id)
	)
		fail(
			"IDEMPOTENCY_KEY_REUSED",
			"This reuse key belongs to another task pair.",
		);
	const receipt = await ctx.db
		.query("translationTaskReusePages")
		.withIndex(
			"by_projectId_and_createdByTokenId_and_clientReuseKey_and_cursor",
			(q) =>
				q
					.eq("projectId", token.projectId)
					.eq("createdByTokenId", token._id)
					.eq("clientReuseKey", args.clientReuseKey)
					.eq("cursor", args.cursor),
		)
		.unique();
	return { token, source, destination, receipt };
}

function taskLocale(task: Task) {
	const localeId = task.taskScope?.localeId;
	if (!localeId) fail("INTEGRITY", "Task lost its Locale scope.");
	return localeId;
}

async function candidateFor(ctx: ReadCtx, task: Task, messageId: string) {
	if (task.target.kind === "localeProposal") {
		const localeProposalId = task.target.localeProposalId;
		return await ctx.db
			.query("agentTranslationCandidates")
			.withIndex("by_proposal_and_messageId_and_localeProposalId", (q) =>
				q
					.eq("proposalId", task._id)
					.eq("messageId", messageId)
					.eq("localeProposalId", localeProposalId),
			)
			.unique();
	}
	if (!task.taskScope) fail("INTEGRITY", "Task lost its frozen scope.");
	const localeId = task.taskScope.localeId;
	return await ctx.db
		.query("agentTranslationCandidates")
		.withIndex("by_proposal_and_messageId_and_localeId", (q) =>
			q
				.eq("proposalId", task._id)
				.eq("messageId", messageId)
				.eq("localeId", localeId),
		)
		.unique();
}

async function sourceFile(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	const snapshot = await ctx.db.get(snapshotId);
	if (!snapshot || snapshot.projectId !== projectId)
		fail("INTEGRITY", "Source Snapshot belongs to another project.");
	const file = await ctx.db
		.query("sourceSnapshotFiles")
		.withIndex("by_snapshot_and_isSource", (q) =>
			q.eq("snapshotId", snapshotId).eq("isSource", true),
		)
		.unique();
	if (!file) {
		// Older immutable snapshots did not record the source role on the file.
		const project = await ctx.db.get(projectId);
		if (!project?.sourceLocaleId)
			fail("INTEGRITY", "Project lost its source Locale.");
		const sourceLocaleId = project.sourceLocaleId;
		const legacy = await ctx.db
			.query("sourceSnapshotFiles")
			.withIndex("by_snapshot_and_localeId", (q) =>
				q.eq("snapshotId", snapshotId).eq("localeId", sourceLocaleId),
			)
			.unique();
		if (!legacy) fail("INTEGRITY", "Source Catalog Document is missing.");
		return legacy.storageId;
	}
	return file.storageId;
}

async function frozenSourcePage(ctx: ReadCtx, source: Task, cursor: number) {
	if (source.taskScope) {
		const rows = await ctx.db
			.query("translationTaskTargets")
			.withIndex("by_proposal_and_catalogIndex", (q) =>
				q.eq("proposalId", source._id).gte("catalogIndex", cursor),
			)
			.take(17);
		return {
			messages: rows.slice(0, 16).map((row) => row.messageId),
			catalogIndices: rows.slice(0, 16).map((row) => row.catalogIndex),
			nextCursor: rows[16]?.catalogIndex ?? null,
		};
	}
	if (source.target.kind !== "localeProposal")
		fail("INTEGRITY", "Source task lost its scope.");
	const localeProposal = await ctx.db.get(source.target.localeProposalId);
	if (!localeProposal || localeProposal.projectId !== source.projectId)
		fail("INTEGRITY", "Source task lost its Locale Proposal.");
	const publication = await ctx.db
		.query("catalogProjectionPublicationStates")
		.withIndex("by_project_and_snapshot", (q) =>
			q
				.eq("projectId", source.projectId)
				.eq("snapshotId", localeProposal.sourceSnapshotId),
		)
		.first();
	if (!publication)
		fail("INTEGRITY", "Source task lost its frozen projection.");
	const rows = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
			q
				.eq("projectionId", publication.projectionId)
				.eq("isSource", true)
				.gte("catalogIndex", cursor),
		)
		.take(17);
	return {
		messages: rows.slice(0, 16).map((row) => row.messageId),
		catalogIndices: rows.slice(0, 16).map((row) => row.catalogIndex),
		nextCursor: rows[16]?.catalogIndex ?? null,
	};
}

/** Managed metadata is mutable. Compare the captured source revision with the
 * current source inside the write transaction; missing history cannot qualify. */
async function managedSourceMatches(
	ctx: MutationCtx,
	origin: Doc<"agentTranslationCandidateRevisions">,
	collectionId: Id<"contentCollections">,
	current: { value: string; name?: string | null; context?: string },
) {
	const basis = origin.basis;
	if (basis.kind !== "managed" || basis.collectionId !== collectionId)
		return false;
	const previous = await ctx.db
		.query("managedSourceRevisions")
		.withIndex("by_collectionId_and_messageId_and_sourceRevision", (q) =>
			q
				.eq("collectionId", collectionId)
				.eq("messageId", origin.messageId)
				.eq("sourceRevision", basis.sourceRevision),
		)
		.unique();
	return (
		!!previous &&
		previous.projectId === origin.projectId &&
		previous.archivedAt === undefined &&
		previous.sourceFingerprint === basis.sourceFingerprint &&
		completeSourceContractsMatch(
			{
				value: previous.sourceValue,
				metadata: {
					name: previous.name === undefined ? origin.messageId : previous.name,
					context: previous.context,
				},
			},
			{
				value: current.value,
				metadata: { name: current.name, context: current.context },
			},
		)
	);
}

/** Read immutable file references only after checking both task access boundaries. */
export const plan = internalQuery({
	args: address,
	handler: async (ctx, args) => {
		const { source, destination, receipt } = await access(ctx, args);
		if (receipt) return { kind: "receipt" as const, result: receipt.result };
		if (destination.status !== "open")
			fail("BAD_STATE", "The destination task is closed.");
		const page = await frozenSourcePage(ctx, source, args.cursor);
		const projection =
			source.target.kind === "managedCollection"
				? null
				: await activeProjectionFor(ctx, source.projectId);
		const destinationSnapshotId = projection?.snapshotId;
		const destinationStorageId = destinationSnapshotId
			? await sourceFile(ctx, source.projectId, destinationSnapshotId)
			: null;
		const items = [];
		for (const messageId of page.messages) {
			const candidate = await candidateFor(ctx, source, messageId);
			const revision = candidate?.latestRevisionId
				? await ctx.db.get(candidate.latestRevisionId)
				: null;
			items.push({
				messageId,
				revision,
				storageId:
					revision && revision.basis.kind !== "managed"
						? await sourceFile(ctx, source.projectId, revision.basis.snapshotId)
						: null,
			});
		}
		return {
			kind: "plan" as const,
			items,
			nextCursor: page.nextCursor,
			destinationSnapshotId: destinationSnapshotId ?? null,
			destinationStorageId,
		};
	},
});

const checkedContract = v.object({
	messageId: v.string(),
	originRevisionId: v.union(
		v.id("agentTranslationCandidateRevisions"),
		v.null(),
	),
	compatible: v.boolean(),
});

/** Subtransaction boundary: ordinary candidate rules own validation and writes;
 * a failed item leaves no candidate and does not discard the rest of the page. */
export const writeCandidate = internalMutation({
	args: {
		token: v.string(),
		taskId: v.id("agentTranslationProposals"),
		originRevisionId: v.id("agentTranslationCandidateRevisions"),
		reviewId: v.id("agentTranslationCandidateReviews"),
		item: candidateRevisionInputValidator,
	},
	handler: async (ctx, args) => {
		const origin = await ctx.db.get(args.originRevisionId);
		if (!origin) fail("INTEGRITY", "Origin revision is missing.");
		return await submitCandidateRevisions(
			ctx,
			{ token: args.token, proposalId: args.taskId, items: [args.item] },
			{
				taskId: origin.proposalId,
				revisionId: origin._id,
				reviewId: args.reviewId,
			},
		);
	},
});

/** The consumed prefix and its receipt commit atomically. Immutable document
 * comparison happens in the action; the transaction rechecks every mutable fact. */
export const commitPage = internalMutation({
	args: {
		...address,
		destinationSnapshotId: v.union(v.id("sourceSnapshots"), v.null()),
		checked: v.array(checkedContract),
	},
	returns: reusePage,
	handler: async (ctx, args): Promise<Infer<typeof reusePage>> => {
		const { source, destination, token, receipt } = await access(ctx, args);
		if (receipt) return receipt.result;
		if (destination.status !== "open")
			fail("BAD_STATE", "The destination task is closed.");
		const page = await frozenSourcePage(ctx, source, args.cursor);
		if (
			page.messages.length > 16 ||
			JSON.stringify(page.messages) !==
				JSON.stringify(args.checked.map((item) => item.messageId))
		)
			fail("CONFLICT", "Source scope changed while preparing reuse.");
		const items: Outcome[] = [];
		let nextCursor = page.nextCursor;
		for (const [index, checked] of args.checked.entries()) {
			const metrics = await ctx.meta.getTransactionMetrics();
			if (
				index > 0 &&
				(metrics.bytesRead.remaining < NEXT_ITEM_READ_RESERVE ||
					metrics.bytesWritten.remaining < NEXT_ITEM_WRITE_RESERVE)
			) {
				// Membership was checked for the entire prepared page. Commit only
				// its consumed prefix and resume at this exact frozen catalog index.
				nextCursor = page.catalogIndices[index] ?? null;
				break;
			}
			const messageId = checked.messageId;
			const sourceCandidate = await candidateFor(ctx, source, messageId);
			const origin = sourceCandidate?.latestRevisionId
				? await ctx.db.get(sourceCandidate.latestRevisionId)
				: null;
			const out = (status: Outcome["status"], reason?: string): Outcome => ({
				messageId,
				status,
				...(origin ? { originRevisionId: origin._id } : {}),
				...(reason ? { reason } : {}),
			});
			if (origin?._id !== (checked.originRevisionId ?? undefined)) {
				items.push(out("sourceChanged"));
				continue;
			}
			if (!origin) {
				items.push(out("unreviewed"));
				continue;
			}
			const review = await latestCandidateReview(ctx, origin._id);
			// Exact candidate authorship only: edited review output is separate evidence.
			if (
				!review ||
				!(
					review.reviewer.kind === "user" ||
					(review.reviewer.kind === "agent" && review.reviewAuthorization)
				) ||
				review.decision.kind === "reject" ||
				review.finalValue !== origin.value ||
				review.finalValueFingerprint !== origin.valueFingerprint ||
				(origin.intentionalBlankReason !== undefined &&
					review.decision.kind === "intentionalBlank" &&
					review.decision.reason !== origin.intentionalBlankReason)
			) {
				items.push(out("unreviewed"));
				continue;
			}
			const existing = await candidateFor(ctx, destination, messageId);
			if (existing) {
				const revision = existing.latestRevisionId
					? await ctx.db.get(existing.latestRevisionId)
					: null;
				const sameOrigin = revision?.reusedFrom?.revisionId === origin._id;
				items.push({
					...out(sameOrigin ? "alreadyCopied" : "occupiedDestination"),
					...(sameOrigin && revision ? { revisionId: revision._id } : {}),
				});
				continue;
			}
			if (origin.basis.kind !== "managed" && !checked.compatible) {
				items.push(out("incompatibleSource"));
				continue;
			}
			if (destination.taskScope) {
				const target = await ctx.db
					.query("translationTaskTargets")
					.withIndex("by_proposal_and_messageId", (q) =>
						q.eq("proposalId", destination._id).eq("messageId", messageId),
					)
					.unique();
				if (!target) {
					items.push(out("outsideDestination"));
					continue;
				}
			}
			try {
				const current =
					destination.target.kind === "localeProposal"
						? await currentLocaleProposalTarget(ctx, destination, messageId)
						: await selectedTaskCurrent(
								ctx,
								destination,
								messageId,
								taskLocale(destination),
							);
				const basis =
					"basis" in current
						? current.basis
						: {
								kind: "localeProposal" as const,
								localeProposalId: current.localeProposal._id,
								snapshotId: current.source.sourceSnapshotId,
								sourceFingerprint: current.source.sourceFingerprint,
							};
				if (
					basis.sourceFingerprint !== origin.basis.sourceFingerprint ||
					(basis.kind !== "managed" &&
						basis.snapshotId !== args.destinationSnapshotId)
				) {
					items.push(out("incompatibleSource"));
					continue;
				}
				if (
					basis.kind === "managed" &&
					(!("value" in current.source) ||
						!(await managedSourceMatches(
							ctx,
							origin,
							basis.collectionId,
							current.source,
						)))
				) {
					items.push(out("incompatibleSource"));
					continue;
				}
				let occupied = false;
				if (destination.target.kind === "localeProposal") {
					const localeProposalId = destination.target.localeProposalId;
					occupied =
						(await ctx.db
							.query("localeProposalValues")
							.withIndex("by_proposal_and_messageId", (q) =>
								q.eq("proposalId", localeProposalId).eq("messageId", messageId),
							)
							.unique()) !== null;
				} else if (destination.target.kind === "managedCollection") {
					const collectionId = destination.target.collectionId;
					const localeId = taskLocale(destination);
					occupied =
						(await ctx.db
							.query("managedTargets")
							.withIndex("by_value", (q) =>
								q
									.eq("collectionId", collectionId)
									.eq("messageId", messageId)
									.eq("localeId", localeId),
							)
							.unique()) !== null;
				} else {
					const target = await readWorkspaceTarget(
						ctx,
						destination.projectId,
						messageId,
						taskLocale(destination),
					);
					const decision = await decisionForIdentity(ctx, {
						projectId: destination.projectId,
						messageId,
						localeId: taskLocale(destination),
						sourceFingerprint: target.source.sourceFingerprint,
						valueFingerprint: target.valueFingerprint,
					});
					occupied =
						target.value.length > 0 ||
						target.workspaceRevision > 0 ||
						decision?.kind === "intentionalBlank";
				}
				if (occupied) {
					items.push(out("occupiedDestination"));
					continue;
				}
				const result = await ctx.runMutation(
					internal.taskReuse.writeCandidate,
					{
						token: args.token,
						taskId: destination._id,
						originRevisionId: origin._id,
						reviewId: review._id,
						item: {
							messageId,
							...(destination.taskScope
								? { localeId: destination.taskScope.localeId }
								: {}),
							value: origin.value,
							...(origin.intentionalBlankReason === undefined
								? {}
								: { intentionalBlankReason: origin.intentionalBlankReason }),
							expectedCandidateRevision: 0,
							clientRevisionKey: `reuse-v1:${origin._id}`,
							basis,
						},
					},
				);
				items.push({
					...out("copied"),
					revisionId: result.revisions[0]?.revisionId,
				});
			} catch (error) {
				if (
					!(error instanceof ConvexError) ||
					typeof error.data !== "object" ||
					error.data === null ||
					!("code" in error.data) ||
					![
						"VALIDATION",
						"STALE_BASIS",
						"NOT_FOUND",
						"LIMIT_EXCEEDED",
						"CHARACTER_LIMIT_EXCEEDED",
					].includes(String(error.data.code))
				)
					throw error;
				items.push(
					out(
						"invalidDestination",
						"message" in error.data
							? String(error.data.message)
							: String(error.data.code),
					),
				);
			}
		}
		const result = {
			sourceTaskId: source._id,
			destinationTaskId: destination._id,
			clientReuseKey: args.clientReuseKey,
			items,
			nextCursor,
		};
		await ctx.db.insert("translationTaskReusePages", {
			projectId: token.projectId,
			createdByTokenId: token._id,
			clientReuseKey: args.clientReuseKey,
			cursor: args.cursor,
			result,
			createdAt: now(),
		});
		return result;
	},
});

/** Explicit reuse of requested text, independent of Locale equivalence. */
export async function reuseTaskPage(
	ctx: ActionCtx,
	args: Address,
): Promise<Infer<typeof reusePage>> {
	const page = await ctx.runQuery(internal.taskReuse.plan, args);
	if (page.kind === "receipt") return page.result;
	const documents = new Map<Id<"_storage">, Map<string, CatalogMessage>>();
	const messageIds = new Set(page.items.map((item) => item.messageId));
	async function document(storageId: Id<"_storage">) {
		let cached = documents.get(storageId);
		if (!cached) {
			const blob = await ctx.storage.get(storageId);
			if (!blob) fail("INTEGRITY", "Source Catalog Document is missing.");
			if (blob.size > 4 * 1024 * 1024)
				fail(
					"LIMIT_EXCEEDED",
					"Task reuse supports Source Catalog Documents up to 4 MiB.",
				);
			cached = new Map(
				parse(await blob.text())
					.messages.filter((message) => messageIds.has(message.id))
					.map((message) => [message.id, message]),
			);
			documents.set(storageId, cached);
		}
		return cached;
	}
	const destination = page.destinationStorageId
		? await document(page.destinationStorageId)
		: null;
	const checked = [];
	for (const item of page.items) {
		const origin = item.revision;
		let compatible = false;
		if (origin && item.storageId && destination) {
			const previous = (await document(item.storageId)).get(item.messageId);
			const current = destination.get(item.messageId);
			compatible =
				!!previous &&
				!!current &&
				(await sha256Hex(previous.value)) === origin.basis.sourceFingerprint &&
				completeSourceContractsMatch(previous, current);
		}
		checked.push({
			messageId: item.messageId,
			originRevisionId: origin?._id ?? null,
			compatible,
		});
	}
	return await ctx.runMutation(internal.taskReuse.commitPage, {
		...args,
		destinationSnapshotId: page.destinationSnapshotId,
		checked,
	});
}
