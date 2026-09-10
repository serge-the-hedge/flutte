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
	return { projectId, token: token.token, tokenId: token.tokenId };
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
		expect(firstBody.run).toMatchObject({
			status: "succeeded",
			reused: false,
			commit: "a".repeat(40),
			snapshotKind: "baseline",
			summary: {
				outcome: "initial",
				sourceKeyCount: 1,
				addedKeyCount: 1,
				changedSourceKeyCount: 0,
				removedKeyCount: 0,
				targetValueChangeCount: 0,
			},
		});
		expect(firstBody.run.snapshotId).toBeTruthy();
		const acceptedSetup = await user.query(api.snapshots.syncSetup, {
			projectId,
		});
		expect(acceptedSetup.baseline?.kind).toBe("baseline");
		expect(acceptedSetup.latestRun).toMatchObject({
			status: "succeeded",
			summary: { outcome: "initial", sourceKeyCount: 1, addedKeyCount: 1 },
		});

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
		expect(secondBody.run).toMatchObject({
			reused: true,
			summary: { outcome: "initial", addedKeyCount: 1 },
		});
		expect(secondBody.run.id).toBe(firstBody.run.id);
		expect(secondBody.run.snapshotId).toBe(firstBody.run.snapshotId);

		// Rebuilding derived evidence is still the same accepted sync, not another
		// introduction of every original key.
		const originalProjectionId = await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			if (!project?.activeCatalogProjectionId)
				throw new Error("Missing projection");
			await ctx.db.patch(project.activeCatalogProjectionId, {
				localeReviewEvidenceVersion: 0,
			});
			return project.activeCatalogProjectionId;
		});
		const repaired = await request(
			t,
			token,
			"/api/repository-adapter/v1/snapshots",
			{ method: "POST", body },
		);
		expect(repaired.status).toBe(200);
		expect(await repaired.json()).toMatchObject({
			run: { reused: true, summary: { outcome: "initial", addedKeyCount: 1 } },
		});
		expect(
			await t.run(
				async (ctx) => (await ctx.db.get(projectId))?.activeCatalogProjectionId,
			),
		).not.toBe(originalProjectionId);

		const snapshots = await user.query(api.snapshots.list, { projectId });
		expect(snapshots).toHaveLength(1);
	}, 30_000);

	test("shares recorded transition counts between receipts and Sync without inventing preview counts", async () => {
		const user = await authenticatedBackend(t, "sync-summary");
		const { projectId, tokenId } = await setup(user);
		const repository = "https://github.com/brickit-app/brickit-flutter.git";
		async function submit(
			commit: string,
			catalogs: typeof files,
			baselineCommit?: string,
		) {
			const actor = { kind: "repositoryAdapter" as const, id: tokenId };
			const result = await t.action(
				internal.snapshots.ingestFromRepositoryAdapter,
				{
					projectId,
					repository,
					commit,
					files: catalogs,
					actor,
					...(baselineCommit
						? {
								lineage: {
									baselineCommit,
									relationship: "descendant" as const,
									mergeBase: baselineCommit,
								},
							}
						: {}),
				},
			);
			return await t.query(internal.snapshots.repositoryAdapterReceipt, {
				runId: result.runId,
				reused: result.reused,
				actor,
			});
		}
		await submit("a".repeat(40), [
			{
				catalogPath: "intl_en.arb",
				content:
					'{"@@locale":"en","greeting":"Hello","removed":"Bye","metadata":"Context"}',
			},
			{
				catalogPath: "intl_de.arb",
				content:
					'{"@@locale":"de","greeting":"Hallo","removed":"Tschüss","metadata":"Kontext"}',
			},
		]);
		const updatedFiles = [
			{
				catalogPath: "intl_en.arb",
				content:
					'{"@@locale":"en","greeting":"Hello again","added":"New","metadata":"Context","@metadata":{"description":"More context"}}',
			},
			{
				catalogPath: "intl_de.arb",
				content:
					'{"@@locale":"de","greeting":"Hallo wieder","added":"Neu","metadata":"Kontext"}',
			},
		];
		const updated = await submit("b".repeat(40), updatedFiles, "a".repeat(40));
		const summary = {
			outcome: "updated",
			sourceKeyCount: 3,
			addedKeyCount: 1,
			changedSourceKeyCount: 2,
			removedKeyCount: 1,
			targetValueChangeCount: 1,
		};
		expect(updated).toMatchObject({
			run: { reused: false, snapshotKind: "baseline", summary },
		});
		expect(
			(await user.query(api.snapshots.syncSetup, { projectId })).latestRun,
		).toMatchObject({ summary });
		const quiet = await submit("c".repeat(40), updatedFiles, "b".repeat(40));
		expect(quiet).toMatchObject({
			run: {
				reused: false,
				summary: {
					outcome: "updated",
					sourceKeyCount: 3,
					addedKeyCount: 0,
					changedSourceKeyCount: 0,
					removedKeyCount: 0,
					targetValueChangeCount: 0,
				},
			},
		});
		const preview = await submit("d".repeat(40), files);
		expect(preview).toMatchObject({
			run: { reused: false, snapshotKind: "preview", summary: null },
		});
		const promoted = await submit("d".repeat(40), files, "c".repeat(40));
		expect(promoted).toMatchObject({
			run: {
				reused: false,
				snapshotKind: "baseline",
				summary: { outcome: "updated" },
			},
		});
		const failed = await submit("e".repeat(40), [
			{ catalogPath: "intl_en.arb", content: "broken JSON" },
		]);
		expect(failed).toMatchObject({
			run: { status: "failed", summary: null, snapshotKind: null },
		});
		// Historic accepted transitions keep their statistics after baseline advances.
		const replay = await submit("b".repeat(40), updatedFiles);
		expect(replay).toMatchObject({ run: { reused: true, summary } });
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
