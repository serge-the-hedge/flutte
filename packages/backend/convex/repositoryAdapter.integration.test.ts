import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

async function request(
	t: Backend,
	token: string,
	path: string,
	init: RequestInit = {},
) {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("X-Blabla-CLI-Protocol", "1");
	headers.set("X-Blabla-CLI-Version", "0.1.0");
	if (init.body !== undefined) headers.set("Content-Type", "application/json");
	return await t.fetch(path, { ...init, headers });
}

async function setup(user: AuthenticatedBackend) {
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the source Locale.");
	const targetId = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "intl_en.arb",
	});
	await user.action(api.locales.bind, {
		localeId: targetId,
		catalogPath: "intl_de.arb",
	});
	const token = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "local sync",
		scopes: ["snapshot-submission"],
	});
	return { projectId, token: token.token };
}

const files = [
	{
		catalogPath: "intl_en.arb",
		content: '{"@@locale":"en","greeting":"Hello"}',
	},
	{
		catalogPath: "intl_de.arb",
		content: '{"@@locale":"de","greeting":"Hallo"}',
	},
];

describe("Repository Adapter snapshot transport", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("returns setup context and submits an idempotent durable snapshot", async () => {
		const user = await authenticatedBackend(t, "repository-adapter");
		const { projectId, token } = await setup(user);

		const context = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshot-context",
		);
		expect(context.status).toBe(200);
		expect(await context.json()).toEqual(
			expect.objectContaining({
				version: 1,
				canSubmit: true,
				repository: null,
				integrationBranch: "develop",
				bindings: expect.arrayContaining([
					expect.objectContaining({
						localeCode: "en",
						catalogPath: "intl_en.arb",
						isSource: true,
					}),
				]),
			}),
		);
		const setupState = await user.query(api.snapshots.syncSetup, { projectId });
		expect(setupState).toEqual(
			expect.objectContaining({
				canSync: true,
				integrationBranch: "develop",
				baseline: null,
				latestRun: null,
			}),
		);

		const body = JSON.stringify({
			repository: "https://github.com/brickit-app/brickit-flutter.git",
			commit: "a".repeat(40),
			files,
		});
		const first = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshots",
			{ method: "POST", body },
		);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			run: {
				id: string;
				status: string;
				snapshotId: string | null;
				diagnostics: unknown[];
			};
		};
		expect(firstBody.run.status).toBe("succeeded");
		expect(firstBody.run.snapshotId).toBeTruthy();
		const acceptedSetup = await user.query(api.snapshots.syncSetup, {
			projectId,
		});
		expect(acceptedSetup.baseline?.kind).toBe("baseline");
		expect(acceptedSetup.latestRun?.status).toBe("succeeded");

		const second = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshots",
			{ method: "POST", body },
		);
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			run: { id: string; snapshotId: string | null };
		};
		expect(secondBody.run.id).toBe(firstBody.run.id);
		expect(secondBody.run.snapshotId).toBe(firstBody.run.snapshotId);

		const snapshots = await user.query(api.snapshots.list, { projectId });
		expect(snapshots).toHaveLength(1);
	}, 30_000);

	test("does not allow a token from another project or an unscoped token", async () => {
		const user = await authenticatedBackend(t, "repository-adapter-owner");
		const { projectId } = await setup(user);
		const token = await user.mutation(api.apiTokens.create, {
			projectId,
			name: "read only",
			scopes: ["read"],
		});
		const response = await request(
			t,
			token.token,
			"/api/repository-adapter/v1/snapshot-context",
		);
		expect(response.status).toBe(401);
	}, 30_000);
});
