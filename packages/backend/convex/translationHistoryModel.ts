import { v } from "convex/values";

export const translationHistoryKind = v.union(
	v.literal("saved"),
	v.literal("confirmed"),
	v.literal("accepted"),
	v.literal("git"),
	v.literal("retained"),
);

export const translationHistoryEvent = v.object({
	id: v.string(),
	kind: translationHistoryKind,
	value: v.string(),
	recordedAt: v.number(),
	actorLabel: v.union(v.string(), v.null()),
	intentionalBlankReason: v.optional(v.string()),
	snapshot: v.optional(
		v.object({
			id: v.id("sourceSnapshots"),
			commit: v.string(),
			name: v.optional(v.string()),
		}),
	),
});
