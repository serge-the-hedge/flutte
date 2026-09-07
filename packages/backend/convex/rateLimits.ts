import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const agentRateLimiter = new RateLimiter(components.rateLimiter, {
	agentRead: {
		kind: "token bucket",
		rate: 120,
		period: MINUTE,
		capacity: 40,
	},
	agentSearch: {
		kind: "token bucket",
		rate: 80,
		period: MINUTE,
		capacity: 25,
	},
	agentLocaleProposal: {
		kind: "token bucket",
		rate: 30,
		period: MINUTE,
		capacity: 8,
	},
	agentTranslationProposal: {
		kind: "token bucket",
		rate: 60,
		period: MINUTE,
		capacity: 12,
	},
	repositorySnapshotContext: {
		kind: "token bucket",
		rate: 60,
		period: MINUTE,
		capacity: 12,
	},
	repositorySnapshotSubmit: {
		kind: "token bucket",
		rate: 20,
		period: MINUTE,
		capacity: 4,
	},
	repositoryReleaseDelivery: {
		kind: "token bucket",
		rate: 12,
		period: MINUTE,
		capacity: 3,
	},
});

export const consume = internalMutation({
	args: {
		name: v.union(
			v.literal("agentRead"),
			v.literal("agentSearch"),
			v.literal("agentLocaleProposal"),
			v.literal("agentTranslationProposal"),
			v.literal("repositorySnapshotContext"),
			v.literal("repositorySnapshotSubmit"),
			v.literal("repositoryReleaseDelivery"),
		),
		key: v.string(),
	},
	handler: async (ctx, args) => {
		const status = await agentRateLimiter.limit(ctx, args.name, {
			key: args.key,
		});
		if (!status.ok) {
			throw new ConvexError({
				code: "RATE_LIMITED",
				message: "Rate limit exceeded.",
				retryAfter: status.retryAfter,
			});
		}
		return status;
	},
});
