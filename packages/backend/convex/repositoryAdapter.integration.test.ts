import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";

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

	test("discovers accepted files, rejects stale binding, and clears discovery after realization", async () => {
		const user = await authenticatedBackend(t, "catalog-discovery");
		const { projectId, token } = await setup(user);
		const submittedFiles = [
			...files,
			{
				catalogPath: "intl_fr.arb",
				content: '{"@@locale":"fr","greeting":"Bonjour"}',
			},
		];
		const body = JSON.stringify({
			repository: "https://github.com/brickit-app/brickit-flutter.git",
			commit: "a".repeat(40),
			files: submittedFiles,
		});
		const response = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshots",
			{ method: "POST", body },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			run: {
				unboundLocaleFileCount: 1,
				unboundLocaleFiles: [
					{
						catalogPath: "intl_fr.arb",
						declaredLocaleCode: "fr",
						messageCount: 1,
					},
				],
			},
		});
		const discovered = await user.query(api.locales.discoveredCatalogs, {
			projectId,
		});
		expect(discovered.files).toMatchObject([
			{ catalogPath: "intl_fr.arb", suggestedCode: "fr", issue: null },
		]);
		const file = discovered.files[0];
		if (!file || !discovered.snapshotId)
			throw new Error("Expected accepted discovery");
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
			label: "French",
		});
		const preview = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "https://github.com/brickit-app/brickit-flutter.git",
			commit: "b".repeat(40),
			files: submittedFiles,
		});
		if (!preview.snapshotId) throw new Error("Expected preview snapshot");
		expect(
			(await user.query(api.locales.discoveredCatalogs, { projectId }))
				.snapshotId,
		).toBe(discovered.snapshotId);
		await expect(
			user.action(api.locales.bind, {
				localeId,
				catalogPath: file.catalogPath,
				expectedSnapshotId: preview.snapshotId,
				expectedUnboundFileId: file.id,
			}),
		).rejects.toThrow("accepted catalog changed");
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: file.catalogPath,
			expectedSnapshotId: discovered.snapshotId,
			expectedUnboundFileId: file.id,
		});
		expect(
			(await user.query(api.locales.discoveredCatalogs, { projectId })).files,
		).toEqual([]);
		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(discovered.snapshotId);
		const repeated = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshots",
			{ method: "POST", body },
		);
		expect(await repeated.json()).toMatchObject({
			run: { unboundLocaleFileCount: 0, unboundLocaleFiles: [] },
		});
		const outsider = await authenticatedBackend(t, "catalog-outsider");
		await expect(
			outsider.query(api.locales.discoveredCatalogs, { projectId }),
		).rejects.toThrow();
	});

	test("suggests configured identity without guessing filenames and exposes binding conflicts", async () => {
		const user = await authenticatedBackend(t, "catalog-discovery-suggestions");
		const { projectId } = await setup(user);
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "it",
			label: "Italian",
			catalogPath: "configured.arb",
			runtimeLocale: "it-IT",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "https://github.com/brickit-app/brickit-flutter.git",
			commit: "a".repeat(40),
			files: [
				...files,
				{ catalogPath: "configured.arb", content: '{"greeting":"Ciao"}' },
				{ catalogPath: "intl_ja.arb", content: '{"greeting":"Hello"}' },
				{
					catalogPath: "duplicate_de.arb",
					content: '{"@@locale":"de","greeting":"Hallo"}',
				},
			],
		});
		const discovery = await user.query(api.locales.discoveredCatalogs, {
			projectId,
		});
		expect(discovery.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					catalogPath: "configured.arb",
					suggestedCode: "it",
					suggestedLabel: "Italian",
					issue: null,
				}),
				expect.objectContaining({
					catalogPath: "intl_ja.arb",
					suggestedCode: "",
					declaredLocaleCode: null,
					issue: null,
				}),
				expect.objectContaining({
					catalogPath: "duplicate_de.arb",
					suggestedCode: "de",
					issue:
						"This language already uses intl_de.arb. Review its binding in Sync.",
				}),
			]),
		);
	});

	test("publishes a new discovered language atomically and reclaims failed reservations", async () => {
		const user = await authenticatedBackend(t, "catalog-atomic-add");
		const { projectId } = await setup(user);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "https://github.com/brickit-app/brickit-flutter.git",
			commit: "a".repeat(40),
			files: [
				...files,
				{
					catalogPath: "intl_fr.arb",
					content: '{"@@locale":"fr","greeting":"Bonjour"}',
				},
				{ catalogPath: "broken.arb", content: "{broken" },
			],
		});
		const discovery = await user.query(api.locales.discoveredCatalogs, {
			projectId,
		});
		const french = discovery.files.find((file) => file.suggestedCode === "fr");
		const broken = discovery.files.find(
			(file) => file.catalogPath === "broken.arb",
		);
		if (!discovery.snapshotId || !french || !broken)
			throw new Error("Missing discovery");
		const args = {
			projectId,
			snapshotId: discovery.snapshotId,
			unboundFileId: french.id,
			code: "fr",
			label: "French",
		};
		const reserved = await user.mutation(
			internal.locales.prepareDiscoveredBinding,
			args,
		);
		expect(
			(
				await user.query(api.locales.list, { projectId, includeArchived: true })
			).some((locale) => locale.code === "fr"),
		).toBe(false);
		await expect(
			user.mutation(api.locales.create, { projectId, code: "fr" }),
		).rejects.toThrow("being added");
		await user.mutation(internal.locales.discardPendingBinding, {
			localeId: reserved.localeId,
		});
		await user.action(api.locales.addDiscovered, args);
		const published = (await user.query(api.locales.list, { projectId })).find(
			(locale) => locale.code === "fr",
		);
		expect(published).toMatchObject({
			label: "French",
			catalogPath: "intl_fr.arb",
		});
		expect(published?.pendingBinding).toBeUndefined();
		const failedArgs = {
			...args,
			unboundFileId: broken.id,
			code: "ja",
			label: "Japanese",
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				user.action(api.locales.addDiscovered, failedArgs),
			).rejects.toThrow();
			expect(
				await t.run(
					async (ctx) =>
						await ctx.db
							.query("locales")
							.withIndex("by_project_code", (q) =>
								q.eq("projectId", projectId).eq("code", "ja"),
							)
							.unique(),
				),
			).toBeNull();
		}
		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(discovery.snapshotId);
	});

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
