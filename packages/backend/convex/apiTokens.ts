import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { isReviewOnlyToken } from "./agentReviewModel";
import { requireUser } from "./auth";
import { now, sha256Hex, tokenScopeValidator } from "./lib";
import { requireOwner, requireViewer } from "./permissions";

/** Preserve existing token hashes while using the shared Web Crypto digest. */
export async function hashToken(rawToken: string): Promise<string> {
	return `sha256:${await sha256Hex(rawToken)}`;
}

function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return `loc_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const list = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const tokens = await ctx.db
			.query("apiTokens")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect();
		return tokens.map(({ tokenHash: _tokenHash, ...token }) => token);
	},
});

export const create = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
		scopes: v.array(tokenScopeValidator),
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		await requireOwner(ctx, args.projectId);
		if (args.scopes.includes("review") && !isReviewOnlyToken(args.scopes)) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A reviewer token may have only read, search, and review scopes. Use a separate translator token.",
			});
		}
		const rawToken = randomToken();
		const tokenId = await ctx.db.insert("apiTokens", {
			projectId: args.projectId,
			name: args.name.trim(),
			tokenHash: await hashToken(rawToken),
			scopes: args.scopes,
			createdByUserId: user.id,
			createdAt: now(),
		});
		return { tokenId, token: rawToken };
	},
});

export const revoke = mutation({
	args: { tokenId: v.id("apiTokens") },
	handler: async (ctx, args) => {
		const token = await ctx.db.get(args.tokenId);
		if (!token)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "API token not found.",
			});
		await requireOwner(ctx, token.projectId);
		await ctx.db.patch(args.tokenId, { revokedAt: now() });
		return null;
	},
});
