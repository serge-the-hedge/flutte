import { type Infer, v } from "convex/values";

export const managedBasisValidator = v.object({
	kind: v.literal("managed"),
	collectionId: v.id("contentCollections"),
	sourceRevision: v.number(),
	targetRevision: v.number(),
	sourceFingerprint: v.string(),
	membershipRevision: v.number(),
});
export type ManagedBasis = Infer<typeof managedBasisValidator>;
export const managedIntentValidator = v.union(
	v.object({ kind: v.literal("save"), value: v.string() }),
	v.object({ kind: v.literal("confirm") }),
	v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
);
export type ManagedIntent = Infer<typeof managedIntentValidator>;
export const MAX_CONTENT_COLLECTIONS = 64;
export const MAX_MANAGED_LOCALES = 1000;
export const MAX_MANAGED_VALUE_BYTES = 256 * 1024;
export const MAX_MANAGED_RESPONSE_BYTES = 1024 * 1024;
export const MAX_MANAGED_CONTEXT_PAIRS = 128;
export const MAX_MANAGED_CONTEXT_LOCALES = 20;
