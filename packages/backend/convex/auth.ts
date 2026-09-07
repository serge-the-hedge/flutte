import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import { queuePasswordResetEmail, queueVerificationEmail } from "./emails";

function requiredEnv(name: string) {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required for Better Auth.`);
	}
	return value;
}

function parseOrigins(value: string | undefined) {
	return (value ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}

const siteUrl = requiredEnv("SITE_URL");
// Convex provides the deployment-specific HTTP Actions URL automatically. This
// keeps preview deployments self-contained while still allowing a custom auth
// domain to be supplied explicitly.
const authBaseUrl =
	process.env.BETTER_AUTH_URL ?? process.env.CONVEX_SITE_URL ?? siteUrl;
const trustedOrigins = Array.from(
	new Set([siteUrl, ...parseOrigins(process.env.TRUSTED_ORIGINS)]),
);

export const authComponent = createClient<DataModel>(components.betterAuth);

export function getTrustedOrigins() {
	return trustedOrigins;
}

function createAuth(ctx: GenericCtx<DataModel>) {
	return betterAuth({
		baseURL: authBaseUrl,
		trustedOrigins,
		database: authComponent.adapter(ctx),
		emailVerification: {
			sendVerificationEmail: async ({ user, url }) => {
				await queueVerificationEmail(ctx, { email: user.email, url });
			},
		},
		emailAndPassword: {
			enabled: true,
			// Personal workspaces remain usable without email delivery. Email-based
			// invitations independently require verification before granting access.
			requireEmailVerification: false,
			revokeSessionsOnPasswordReset: true,
			resetPasswordTokenExpiresIn: 60 * 60,
			sendResetPassword: async ({ user, url }) => {
				await queuePasswordResetEmail(ctx, { email: user.email, url });
			},
		},
		plugins: [
			crossDomain({ siteUrl }),
			convex({
				authConfig,
				jwksRotateOnTokenGenerationError: true,
			}),
		],
	});
}

export { createAuth };

export const getCurrentUser = query({
	args: {},
	handler: async (ctx) => {
		return await authComponent.safeGetAuthUser(ctx);
	},
});

type AuthUserLike = {
	_id?: string;
	userId?: string | null;
	id?: string;
	email?: string;
	emailVerified?: boolean;
	name?: string;
	user?: {
		_id?: string;
		id?: string;
		email?: string;
		emailVerified?: boolean;
		name?: string;
	};
};

export function normalizeAuthUser(authUser: unknown): {
	id: string;
	email?: string;
	emailVerified: boolean;
	name?: string;
} | null {
	const user = authUser as AuthUserLike | null;
	if (!user) {
		return null;
	}
	const id =
		user.userId ?? user.id ?? user._id ?? user.user?.id ?? user.user?._id;
	if (!id) {
		return null;
	}
	return {
		id,
		email: user.email ?? user.user?.email,
		emailVerified: (user.emailVerified ?? user.user?.emailVerified) === true,
		name: user.name ?? user.user?.name,
	};
}

export async function getAnyUserById(ctx: QueryCtx | MutationCtx, id: string) {
	// Memberships use the app userId when present; older accounts and fixtures
	// can retain that mapping instead of the Better Auth document ID.
	const mappedUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: "user",
		where: [{ field: "userId", value: id }],
	});
	return normalizeAuthUser(
		mappedUser ?? (await authComponent.getAnyUserById(ctx, id)),
	);
}

export async function getAnyUserByEmail(
	ctx: QueryCtx | MutationCtx,
	emailLower: string,
) {
	const authUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: "user",
		where: [{ field: "email", value: emailLower }],
	});
	return normalizeAuthUser(authUser);
}

export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<{
	id: string;
	email?: string;
	emailVerified: boolean;
	name?: string;
}> {
	const authUser = normalizeAuthUser(await authComponent.safeGetAuthUser(ctx));
	if (!authUser) {
		throw new ConvexError({
			code: "UNAUTHENTICATED",
			message: "Sign in required.",
		});
	}
	return authUser;
}
