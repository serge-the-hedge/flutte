/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import type { UserIdentity } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";

import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob([
	"../convex/**/*.ts",
	"!../convex/**/*.test.ts",
]);

export type Backend = TestConvex<typeof schema>;
export type AuthenticatedBackend = Awaited<
	ReturnType<typeof authenticatedBackend>
>;

/**
 * A backend with the components these tests touch already registered. Every
 * suite wants this in a `beforeEach`, since convexTest state is per instance.
 */
export function createBackend(
	options: { transactionLimits?: boolean } = {},
): Backend {
	const t = convexTest({ schema, modules, ...options });
	betterAuthTest.register(t);
	rateLimiterTest.register(t);
	return t;
}

/**
 * A backend acting as a signed-in user. The user and their session are created
 * through the auth component rather than faked, so anything the code under
 * test asks about identity gets a real answer.
 */
export async function authenticatedBackend(
	t: Backend,
	userId: string,
	// Real-catalog integration tests may legitimately run for more than a
	// minute on CI. Keep authentication outside their 120-second test budget so
	// a slow runner cannot turn a product assertion into an auth failure.
	sessionDurationMs = 5 * 60_000,
) {
	const timestamp = Date.now();
	const authUser = await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "user",
			data: {
				userId,
				name: `Test user ${userId}`,
				email: `${userId}@example.test`,
				emailVerified: true,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		},
	});
	const session = await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "session",
			data: {
				userId: authUser._id,
				token: `session-${userId}`,
				expiresAt: timestamp + sessionDurationMs,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		},
	});
	return t.withIdentity({
		subject: authUser._id,
		sessionId: session._id,
	} as Partial<UserIdentity>);
}

/**
 * A project owned by the given user, with English as its source Locale.
 */
export async function createProject(
	user: AuthenticatedBackend,
	overrides: { name?: string; slug?: string } = {},
) {
	return await user.mutation(api.projects.create, {
		name: overrides.name ?? "Primary project",
		slug: overrides.slug ?? "primary-project",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
}

/** Retained collection fixtures model data authored before standalone Basic projects. */
export async function createLegacyCollection(
	t: Backend,
	args: {
		projectId: Id<"projects">;
		name: string;
		localeIds: Id<"locales">[];
	},
) {
	return await t.run(async (ctx) => {
		const collectionId = await ctx.db.insert("contentCollections", {
			projectId: args.projectId,
			name: args.name,
			membershipRevision: 1,
			createdAt: Date.now(),
		});
		for (const localeId of args.localeIds)
			await ctx.db.insert("contentCollectionLocales", {
				projectId: args.projectId,
				collectionId,
				localeId,
				active: true,
			});
		return collectionId;
	});
}

/**
 * The windowed stand-in for the retired whole-catalog read in tests: read
 * the Navigation read for order and identity, then compose exactly the
 * active keys' cards through the Window read. Test catalogs stay inside
 * the 32-key window cap.
 */
export async function readWorkspaceKeyCards(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const navigation = await user.query(
		api.catalogWorkspaceNavigation.navigation,
		{ projectId },
	);
	if (navigation.kind !== "ready") {
		throw new Error("Expected a ready Catalog Navigation read.");
	}
	const messageIds = navigation.keys.map((key) => key.messageId);
	const keys =
		messageIds.length === 0
			? []
			: await user.query(api.catalogWorkspaceNavigation.window, {
					projectId,
					expectedProjectionId: navigation.projectionId,
					messageIds,
				});
	return {
		projectionId: navigation.projectionId,
		canEdit: navigation.canEdit,
		valueStateCounts: navigation.valueStateCounts,
		keys,
	};
}

/** Collect a pinned public catalog for tests that explicitly inspect all rows. */
export async function readAllCatalogPages(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const first = await user.query(api.catalogProjection.getActive, {
		projectId,
	});
	if (!first) return null;
	const keys = new Map<string, (typeof first.keys)[number]>();
	let page = first;
	for (;;) {
		for (const key of page.keys) {
			const previous = keys.get(key.id);
			const values = new Map(
				previous?.values.map((value) => [value.localeId, value]),
			);
			for (const value of key.values) values.set(value.localeId, value);
			keys.set(key.id, {
				...key,
				values: [...values.values()].sort(
					(a, b) =>
						Number(b.isSource) - Number(a.isSource) ||
						a.localeCode.localeCompare(b.localeCode),
				),
			});
		}
		if (page.isDone) break;
		const next = await user.query(api.catalogProjection.getActive, {
			projectId,
			projectionId: first.projectionId,
			cursor: page.continueCursor,
		});
		if (!next) throw new Error("Pinned catalog disappeared");
		page = next;
	}
	return { ...first, keys: [...keys.values()] };
}
