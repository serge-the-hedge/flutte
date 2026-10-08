import { type Infer, v } from "convex/values";
export const sourceFactValidator = v.object({
	messageId: v.string(),
	catalogIndex: v.number(),
	value: v.string(),
	sourceFingerprint: v.string(),
	icuType: v.union(v.literal("plain"), v.literal("icu")),
	argumentNames: v.array(v.string()),
	argumentNamesComplete: v.boolean(),
	declaredPlaceholderNames: v.array(v.string()),
	declaredPlaceholderNamesComplete: v.boolean(),
	metadataJson: v.optional(v.string()),
});
export type SourceFact = Infer<typeof sourceFactValidator>;
