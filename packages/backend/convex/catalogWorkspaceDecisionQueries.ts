import { ConvexError } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

import { projectionPublicationStateFor } from "./catalogProjection";
import { decisionIdentity } from "./catalogWorkspaceView";

/** Private delivery decisions become history only with their complete projection.
 * The projector may include its own private decisions while building Navigation. */
export async function visibleDecisionRecords(
	ctx: QueryCtx | MutationCtx,
	records: readonly Doc<"catalogWorkspaceDecisionRecords">[],
	stagingProjectionId?: Id<"catalogProjections">,
): Promise<Doc<"catalogWorkspaceDecisionRecords">[]> {
	const ids = [
		...new Set(
			records.flatMap((record) =>
				record.deliveryProjectionId ? [record.deliveryProjectionId] : [],
			),
		),
	];
	const states = new Map(
		await Promise.all(
			ids.map(
				async (id) =>
					[id, await projectionPublicationStateFor(ctx, id)] as const,
			),
		),
	);
	const result = new Map<string, Doc<"catalogWorkspaceDecisionRecords">>();
	for (const record of records) {
		if (
			record.deliveryProjectionId &&
			record.deliveryProjectionId !== stagingProjectionId &&
			states.get(record.deliveryProjectionId)?.status !== "published"
		)
			continue;
		const identity = decisionIdentity(record);
		const existing = result.get(identity);
		if (!existing || record.recordedAt < existing.recordedAt)
			result.set(identity, record);
	}
	return [...result.values()];
}

type DecisionContext = MutationCtx | QueryCtx;
type DecisionRecord = Doc<"catalogWorkspaceDecisionRecords">;

/** Read the one decision for an exact Source/value identity without opening
 * the history for the Locale value. Duplicate identities are an integrity
 * failure, not a reason to make every caller scan more evidence. */
export async function decisionForIdentity(
	ctx: DecisionContext,
	input: {
		projectId: Id<"projects">;
		messageId: string;
		localeId: Id<"locales">;
		sourceFingerprint: string;
		valueFingerprint: string;
	},
	stagingProjectionId?: Id<"catalogProjections">,
): Promise<DecisionRecord | null> {
	const records = await ctx.db
		.query("catalogWorkspaceDecisionRecords")
		.withIndex("by_value_identity", (q) =>
			q
				.eq("projectId", input.projectId)
				.eq("messageId", input.messageId)
				.eq("localeId", input.localeId)
				.eq("sourceFingerprint", input.sourceFingerprint)
				.eq("valueFingerprint", input.valueFingerprint),
		)
		.take(65);
	if (records.length > 64) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace contains duplicate decision identities.",
		});
	}
	return (
		(await visibleDecisionRecords(ctx, records, stagingProjectionId))[0] ?? null
	);
}

/** Return the most recent decision attached to one value fingerprint. This is
 * the only history fact needed to classify a current value as previously
 * confirmed; the exact current identity is read separately above. */
export async function latestDecisionForValue(
	ctx: DecisionContext,
	input: {
		projectId: Id<"projects">;
		messageId: string;
		localeId: Id<"locales">;
		valueFingerprint: string;
	},
): Promise<DecisionRecord | null> {
	const records = ctx.db
		.query("catalogWorkspaceDecisionRecords")
		.withIndex("by_value_and_recordedAt", (q) =>
			q
				.eq("projectId", input.projectId)
				.eq("messageId", input.messageId)
				.eq("localeId", input.localeId)
				.eq("valueFingerprint", input.valueFingerprint),
		)
		.order("desc");
	let scanned = 0;
	for await (const record of records) {
		if (++scanned > 64)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "Private decision attempts exceed their bounded lookup.",
			});
		if ((await visibleDecisionRecords(ctx, [record])).length) return record;
	}
	return null;
}
