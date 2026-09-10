import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { activeProjectionFor } from "./catalogProjection";
import { decisionForIdentity } from "./catalogWorkspaceDecisionQueries";
import { isCurrentHeadForRow } from "./catalogWorkspaceView";
import { sha256Hex } from "./lib";

type WithoutSystemFields<T> = T extends unknown
	? Omit<T, "_id" | "_creationTime">
	: never;

type HistoryInput = Omit<
	Doc<"catalogWorkspaceValueHistory">,
	"_id" | "_creationTime"
>;

export async function appendTranslationHistory(
	ctx: MutationCtx,
	input: HistoryInput,
) {
	await ctx.db.insert("catalogWorkspaceValueHistory", input);
}

/** Capture the last surviving pre-history head before an edit or Git retires it.
 * Its original author and time are known; earlier overwritten values are not. */
export async function retainWorkspaceValue(
	ctx: MutationCtx,
	head: Doc<"catalogWorkspaceValueHeads"> | null,
) {
	if (!head) return;
	const existing = await latestTranslationHistory(ctx, head);
	if (existing) return;
	const decision = await decisionForIdentity(ctx, {
		projectId: head.projectId,
		messageId: head.messageId,
		localeId: head.localeId,
		sourceFingerprint: head.sourceFingerprint,
		valueFingerprint: head.valueFingerprint ?? (await sha256Hex(head.value)),
	});
	await appendTranslationHistory(ctx, {
		projectId: head.projectId,
		messageId: head.messageId,
		localeId: head.localeId,
		kind: "retained",
		value: head.value,
		sourceFingerprint: head.sourceFingerprint,
		actor: head.updatedBy,
		reviewAuthorization: head.reviewAuthorization,
		recordedAt: head.updatedAt,
		intentionalBlankReason:
			decision?.kind === "intentionalBlank" ? decision.reason : undefined,
	});
}

export async function latestTranslationHistory(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		messageId: string;
		localeId: Id<"locales">;
	},
) {
	return await ctx.db
		.query("catalogWorkspaceValueHistory")
		.withIndex("by_project_and_messageId_and_localeId_and_recordedAt", (q) =>
			q
				.eq("projectId", input.projectId)
				.eq("messageId", input.messageId)
				.eq("localeId", input.localeId),
		)
		.order("desc")
		.first();
}

/** Record full bytes for a new exact confirmation. Saves have already appended
 * their event in this transaction; private delivery evidence remains private. */
export async function recordTranslationConfirmation(
	ctx: MutationCtx,
	next: WithoutSystemFields<Doc<"catalogWorkspaceDecisionRecords">>,
) {
	if (next.deliveryProjectionId) return;
	const last = await latestTranslationHistory(ctx, next);
	if (
		last?.recordedAt === next.recordedAt &&
		last.sourceFingerprint === next.sourceFingerprint &&
		last.actor.kind === next.recordedBy.kind &&
		last.actor.id === next.recordedBy.id &&
		(await sha256Hex(last.value)) === next.valueFingerprint
	)
		return;
	const head = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q
				.eq("projectId", next.projectId)
				.eq("messageId", next.messageId)
				.eq("localeId", next.localeId),
		)
		.unique();
	await retainWorkspaceValue(ctx, head);
	const projection = await activeProjectionFor(ctx, next.projectId);
	const target = projection
		? await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_localeId", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", next.messageId)
						.eq("localeId", next.localeId),
				)
				.unique()
		: null;
	const value =
		target && isCurrentHeadForRow(target, head) ? head?.value : target?.value;
	if (value === undefined || (await sha256Hex(value)) !== next.valueFingerprint)
		return;
	await appendTranslationHistory(ctx, {
		projectId: next.projectId,
		messageId: next.messageId,
		localeId: next.localeId,
		kind: "confirmed",
		value,
		sourceFingerprint: next.sourceFingerprint,
		actor: next.recordedBy,
		reviewAuthorization: next.reviewAuthorization,
		recordedAt: next.recordedAt,
		intentionalBlankReason:
			next.kind === "intentionalBlank" ? next.reason : undefined,
	});
}
