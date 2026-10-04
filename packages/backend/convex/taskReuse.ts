import { ConvexError, getConvexSize, type Infer, v } from "convex/values";
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
import { reuseOutcome, reusePage } from "./taskReuseModel";

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

// Stop normal pages with room for another item. The full item also runs under
// an actual remaining-budget cap, including its first attempt and nested writes.
// Two MiB of read headroom covers a maximum 1 MiB document overshoot plus the
// receipt; supporting metadata is not assumed to be small.
const NEXT_ITEM_READ_RESERVE = 8 * 1024 * 1024;
const NEXT_ITEM_WRITE_RESERVE = 1024 * 1024;
const MEMBERSHIP_READ_BYTES = 1024 * 1024;
const ITEM_READ_HEADROOM = 2 * 1024 * 1024;
// Keep the receipt comfortably below the 1 MiB document and write reserves.
const RECEIPT_ITEM_BYTES = 512 * 1024;

function capacityFailure(): never {
	fail(
		"LIMIT_EXCEEDED",
		"Task reuse cannot fit one complete item with receipt headroom. Shorten unusually large project, token, task, Locale or collection metadata, or submit this item through the ordinary candidate workflow. No empty receipt was recorded.",
	);
}

async function requirePlanningHeadroom(ctx: ReadCtx, bytes: number) {
	if ((await ctx.meta.getTransactionMetrics()).bytesRead.remaining < bytes)
		capacityFailure();
}

/** Stream actual stored rows: repository task rows retain both Source and
 * target text. At most 1 MiB plus one maximum-size lookahead row is read. */
async function boundedMembership(
	ctx: ReadCtx,
	query: AsyncIterable<{ messageId: string; catalogIndex: number }>,
) {
	const initial = (await ctx.meta.getTransactionMetrics()).bytesRead.used;
	const messages: string[] = [];
	const catalogIndices: number[] = [];
	let nextCursor: number | null = null;
	for await (const row of query) {
		const used =
			(await ctx.meta.getTransactionMetrics()).bytesRead.used - initial;
		if (
			messages.length === 16 ||
			(messages.length > 0 && used > MEMBERSHIP_READ_BYTES)
		) {
			nextCursor = row.catalogIndex;
			break;
		}
		messages.push(row.messageId);
		catalogIndices.push(row.catalogIndex);
	}
	return { messages, catalogIndices, nextCursor };
}

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
		const rows = ctx.db
			.query("translationTaskTargets")
			.withIndex("by_proposal_and_catalogIndex", (q) =>
				q.eq("proposalId", source._id).gte("catalogIndex", cursor),
			);
		return await boundedMembership(ctx, rows);
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
	const rows = ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
			q
				.eq("projectionId", publication.projectionId)
				.eq("isSource", true)
				.gte("catalogIndex", cursor),
		);
	return await boundedMembership(ctx, rows);
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
		if (page.messages.length === 0)
			return {
				kind: "plan" as const,
				items: [],
				nextCursor: null,
				destinationSnapshotId: null,
				destinationStorageId: null,
			};
		// Projection + legacy Source file references require at most five maximum-size
		// documents. Each origin head/revision + legacy file path requires at most five.
		// The larger guards leave headroom even when these metadata records are huge.
		await requirePlanningHeadroom(ctx, 7 * 1024 * 1024);
		const projection =
			source.target.kind === "managedCollection"
				? null
				: await activeProjectionFor(ctx, source.projectId);
		const destinationSnapshotId = projection?.snapshotId;
		const destinationStorageId = destinationSnapshotId
			? await sourceFile(ctx, source.projectId, destinationSnapshotId)
			: null;
		const items = [];
		let nextCursor = page.nextCursor;
		for (const [index, messageId] of page.messages.entries()) {
			if (
				(await ctx.meta.getTransactionMetrics()).bytesRead.remaining <
				6 * 1024 * 1024
			) {
				if (items.length === 0) capacityFailure();
				nextCursor = page.catalogIndices[index] ?? null;
				break;
			}
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
			nextCursor,
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

/** All eligibility reads and nested ordinary writes share this subtransaction
 * cap. A failed capacity attempt cannot leave a candidate behind. Outer access
 * and membership checks authorize these task IDs in the same transaction. */
export const processItem = internalMutation({
	args: {
		token: v.string(),
		sourceTaskId: v.id("agentTranslationProposals"),
		destinationTaskId: v.id("agentTranslationProposals"),
		destinationSnapshotId: v.union(v.id("sourceSnapshots"), v.null()),
		checked: checkedContract,
		receiptBytes: v.number(),
	},
	returns: reuseOutcome,
	handler: async (ctx, args): Promise<Outcome> => {
		const execute = async (): Promise<Outcome> => {
			const source = await ctx.db.get(args.sourceTaskId);
			const destination = await ctx.db.get(args.destinationTaskId);
			if (!source || !destination) fail("INTEGRITY", "Reuse task disappeared.");
			const checked = args.checked;
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
				return out("sourceChanged");
			}
			if (!origin) {
				return out("unreviewed");
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
				return out("unreviewed");
			}
			const existing = await candidateFor(ctx, destination, messageId);
			if (existing) {
				const revision = existing.latestRevisionId
					? await ctx.db.get(existing.latestRevisionId)
					: null;
				const sameOrigin = revision?.reusedFrom?.revisionId === origin._id;
				return {
					...out(sameOrigin ? "alreadyCopied" : "occupiedDestination"),
					...(sameOrigin && revision ? { revisionId: revision._id } : {}),
				};
			}
			if (origin.basis.kind !== "managed" && !checked.compatible) {
				return out("incompatibleSource");
			}
			if (destination.taskScope) {
				const target = await ctx.db
					.query("translationTaskTargets")
					.withIndex("by_proposal_and_messageId", (q) =>
						q.eq("proposalId", destination._id).eq("messageId", messageId),
					)
					.unique();
				if (!target) {
					return out("outsideDestination");
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
					return out("incompatibleSource");
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
					return out("incompatibleSource");
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
					return out("occupiedDestination");
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
				return {
					...out("copied"),
					revisionId: result.revisions[0]?.revisionId,
				};
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
				return out(
					"invalidDestination",
					"message" in error.data
						? String(error.data.message)
						: String(error.data.code),
				);
			}
		};
		const result = await execute();
		if (getConvexSize(result) > args.receiptBytes) capacityFailure();
		return result;
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
			args.checked.length > page.messages.length ||
			(args.checked.length === 0 && page.messages.length > 0) ||
			JSON.stringify(page.messages.slice(0, args.checked.length)) !==
				JSON.stringify(args.checked.map((item) => item.messageId))
		)
			fail("CONFLICT", "Source scope changed while preparing reuse.");
		const items: Outcome[] = [];
		let nextCursor =
			page.catalogIndices[args.checked.length] ?? page.nextCursor;
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

			const bytesRead = metrics.bytesRead.remaining - ITEM_READ_HEADROOM;
			const bytesWritten =
				metrics.bytesWritten.remaining - NEXT_ITEM_WRITE_RESERVE;
			if (bytesRead <= 0 || bytesWritten <= 0) {
				if (items.length === 0) capacityFailure();
				nextCursor = page.catalogIndices[index] ?? null;
				break;
			}
			try {
				const outcome: Outcome = await ctx.runMutation(
					internal.taskReuse.processItem,
					{
						token: args.token,
						sourceTaskId: source._id,
						destinationTaskId: destination._id,
						destinationSnapshotId: args.destinationSnapshotId,
						checked,
						receiptBytes: RECEIPT_ITEM_BYTES - getConvexSize(items),
					},
					{ transactionLimits: { bytesRead, bytesWritten } },
				);
				items.push(outcome);
			} catch (error) {
				const after = await ctx.meta.getTransactionMetrics();
				const hitReadCap =
					after.bytesRead.used - metrics.bytesRead.used >= bytesRead ||
					(error instanceof Error &&
						error.message.includes("Read too much data"));
				const hitWriteCap =
					error instanceof Error &&
					error.message.includes("Wrote too much data");
				const oversizedReceipt =
					error instanceof ConvexError &&
					typeof error.data === "object" &&
					error.data !== null &&
					"message" in error.data &&
					String(error.data.message).startsWith(
						"Task reuse cannot fit one complete item",
					);
				if (!hitReadCap && !hitWriteCap && !oversizedReceipt) throw error;
				if (items.length === 0) capacityFailure();
				nextCursor = page.catalogIndices[index] ?? null;
				break;
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
	try {
		return await ctx.runMutation(internal.taskReuse.commitPage, {
			...args,
			destinationSnapshotId: page.destinationSnapshotId,
			checked,
		});
	} catch (error) {
		// Convex exhausts its own OCC retries before throwing this system error.
		// Only this atomic, receipt-backed commit is safe to classify for replay;
		// application conflicts and unknown failures keep their original meaning.
		if (
			error instanceof Error &&
			!(error instanceof ConvexError) &&
			/Documents read from or written to the (?:"[^"\r\n]+" table|table "[^"\r\n]+") changed while this mutation was being run and on every subsequent retry\./.test(
				error.message,
			)
		) {
			throw new ConvexError({
				code: "WRITE_CONTENTION",
				message:
					"Task reuse is temporarily busy with another write. Resume the same reuse key and cursor after the retry delay.",
				retryAfter: 1000,
			});
		}
		throw error;
	}
}
