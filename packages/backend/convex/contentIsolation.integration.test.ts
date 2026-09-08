import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

async function setup() {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "managed-isolation-owner");
	const projectId = await createProject(owner);
	const french = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	const german = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	const collectionId = await owner.mutation(api.contentCollections.create, {
		projectId,
		name: "Store",
		localeIds: [french],
	});
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose"],
	});
	const request = (path: string, body?: unknown) =>
		t.fetch(`/api/agent/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { t, owner, projectId, french, german, collectionId, request };
}
describe("managed and repository language isolation", () => {
	test("protects managed Locale identity during repository setup and membership removal", async () => {
		const f = await setup();
		await expect(
			f.owner.mutation(api.locales.correctSetupBinding, {
				localeId: f.german,
				code: "fr",
				catalogPath: "lib/de.arb",
			}),
		).rejects.toThrow("managed content");
		await expect(
			f.owner.mutation(api.locales.correctSetupBinding, {
				localeId: f.french,
				code: "fr-CA",
				catalogPath: "lib/fr.arb",
			}),
		).rejects.toThrow("managed content");
		await expect(
			f.owner.mutation(api.locales.archive, { localeId: f.french }),
		).rejects.toThrow("managed collections");
		await f.owner.mutation(api.contentCollections.setLocales, {
			projectId: f.projectId,
			collectionId: f.collectionId,
			localeIds: [],
			expectedMembershipRevision: 1,
		});
		await f.owner.mutation(api.locales.archive, { localeId: f.french });
		expect(
			(await f.owner.query(api.locales.list, { projectId: f.projectId })).some(
				(l) => l._id === f.german,
			),
		).toBe(true);
		await f.owner.mutation(api.locales.create, {
			projectId: f.projectId,
			code: "fr",
		});
		await expect(
			f.owner.mutation(api.locales.correctSetupBinding, {
				localeId: f.french,
				code: "fr-CA",
				catalogPath: "lib/fr.arb",
			}),
		).rejects.toThrow("managed content");
	});
	test("a marketing-only Locale remains available for app introduction and is absent from legacy active targets", async () => {
		const f = await setup();
		const source = (
			await f.owner.query(api.locales.list, { projectId: f.projectId })
		).find((l) => l.isSource);
		if (!source) throw new Error("Missing source");
		await f.owner.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "lib/intl_en.arb",
		});
		await f.owner.action(api.snapshots.ingest, {
			projectId: f.projectId,
			repository: "app",
			commit: "base",
			files: [
				{
					catalogPath: "lib/intl_en.arb",
					content: '{"@@locale":"en","title":"App title"}',
				},
			],
		});
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			localeCode: "fr",
			label: "French",
			catalogPath: "lib/intl_fr.arb",
			runtimeLocale: "fr-FR",
		});
		const discovery = await (await f.request("/projects/current")).json();
		expect(discovery).toMatchObject({
			locales: ["en"],
			capabilities: { newLocaleTargets: ["fr"], collections: true },
		});
		const created = await f.request("/translation-tasks", {
			clientTaskKey: "introduce-marketing-locale-to-app",
			target: { kind: "newLocale", localeCode: "fr" },
		});
		expect(created.status, await created.clone().text()).toBe(200);
		expect(
			await f.owner.query(api.contentCollections.get, {
				projectId: f.projectId,
				collectionId: f.collectionId,
			}),
		).toMatchObject({ localeIds: [f.french] });
	});
});
