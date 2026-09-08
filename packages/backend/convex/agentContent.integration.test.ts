import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createLegacyCollection,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "agent-content-owner");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr-CA",
	});
	const collectionId = await createLegacyCollection(t, {
		projectId,
		name: "Store",
		localeIds: [localeId],
	});
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Researcher",
		scopes: ["read", "search"],
	});
	const request = (path: string, body?: unknown, credential = token.token) =>
		t.fetch(`/api/agent/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${credential}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	async function create(key: string, sourceValue: string, value?: string) {
		await owner.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId,
			key,
			sourceValue,
		});
		if (value !== undefined) {
			const context = await owner.query(api.managedContent.context, {
				projectId,
				collectionId,
				messageIds: [key],
				localeIds: [localeId],
			});
			const item = context.items[0];
			if (!item) throw new Error("Missing target");
			await owner.mutation(api.managedContent.commit, {
				projectId,
				collectionId,
				messageId: key,
				localeId,
				basis: item.basis,
				intent: { kind: "save", value },
			});
		}
	}
	return {
		t,
		owner,
		projectId,
		collectionId,
		localeId,
		token,
		request,
		create,
	};
}
describe("managed agent retrieval", () => {
	test("returns and searches display names without treating them as stable keys", async () => {
		const f = await setup();
		const messageId = await f.owner.mutation(api.managedContent.createMessage, {
			projectId: f.projectId,
			collectionId: f.collectionId,
			name: "Café headline",
			sourceValue: "Welcome",
		});
		const path = `/collections/${f.collectionId}`;
		const found = await (
			await f.request(
				`${path}/search?q=${encodeURIComponent("Café headline")}&match=exact&localeCode=fr-CA`,
			)
		).json();
		expect(found.items).toMatchObject([
			{ messageId, name: "Café headline", matchedFields: ["name"] },
		]);
		const keysOnly = await (
			await f.request(
				`${path}/search?q=${encodeURIComponent("Café headline")}&match=exact&searchIn=key&localeCode=fr-CA`,
			)
		).json();
		expect(keysOnly.items).toEqual([]);
		const context = await (
			await f.request(`${path}/context`, {
				keys: [messageId],
				locales: ["fr-CA"],
			})
		).json();
		expect(context.items[0]).toMatchObject({
			messageId,
			name: "Café headline",
		});
	});

	test("discovers collections, searches exact reviewed target text, and preserves continuation", async () => {
		const f = await setup();
		await f.create("one", "Make it", "Créez {Brickit}");
		await f.create("two", "More", "Créez {Brickit}");
		await f.create("three", "Waiting");
		const collections = await (await f.request("/collections")).json();
		expect(collections.collections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "app", kind: "repository" }),
				expect.objectContaining({ id: f.collectionId, kind: "managed" }),
			]),
		);
		const detail = await (
			await f.request(`/collections/${f.collectionId}`)
		).json();
		expect(detail).toMatchObject({
			syntax: "plain",
			locales: [{ code: "fr-CA" }],
		});
		const query = `q=${encodeURIComponent("Créez {Brickit}")}&localeCode=fr-CA&searchIn=target&match=exact&quality=confirmed&limit=1`;
		const first = await (
			await f.request(`/collections/${f.collectionId}/search?${query}`)
		).json();
		expect(first.items).toHaveLength(1);
		expect(first.items[0]).toMatchObject({
			collectionId: f.collectionId,
			target: { value: "Créez {Brickit}", valueState: "settled" },
			confirmation: { actor: { kind: "user" } },
			matchedFields: ["target"],
		});
		expect(typeof first.nextCursor).toBe("string");
		const second = await (
			await f.request(
				`/collections/${f.collectionId}/search?${query}&cursor=${encodeURIComponent(first.nextCursor)}`,
			)
		).json();
		expect(second.items).toHaveLength(1);
		expect(second.items[0].messageId).not.toBe(first.items[0].messageId);
		const changed = await f.request(
			`/collections/${f.collectionId}/search?q=other&cursor=${encodeURIComponent(first.nextCursor)}`,
		);
		expect(changed.status).toBe(409);
		const draft = await f.request(`/collections/${f.collectionId}/download`, {
			keys: ["three"],
			locales: ["fr-CA"],
		});
		expect(draft.status).toBe(409);
		const partial = await (
			await f.request(`/collections/${f.collectionId}/download`, {
				keys: ["one", "three"],
				locales: ["fr-CA"],
				mode: "partial",
			})
		).json();
		expect(partial.omitted).toEqual([
			{ messageId: "three", localeId: f.localeId, reason: "waiting" },
		]);
		expect(JSON.parse(partial.text).values.one["fr-CA"]).toBe(
			"Créez {Brickit}",
		);
	});
	test("keeps literal-brace Dictionary evidence and rejects cross-project and revoked access", async () => {
		const f = await setup();
		await f.create("title", "Use {Brickit}");
		await f.owner.mutation(api.translationGuidance.saveTerm, {
			projectId: f.projectId,
			expectedRevision: 0,
			term: {
				kind: "untranslatable",
				sourceTerm: "Brickit",
				definition: "Product name",
			},
		});
		const response = await f.request(`/collections/${f.collectionId}/context`, {
			keys: ["title"],
			locales: ["fr-CA"],
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			guidance: { terms: [{ term: { sourceTerm: "Brickit" } }] },
		});
		const stranger = await authenticatedBackend(f.t, "another-content-owner");
		const otherProject = await createProject(stranger, {
			slug: "other-content",
		});
		const otherToken = await stranger.mutation(api.apiTokens.create, {
			projectId: otherProject,
			name: "Wrong project",
			scopes: ["read", "search"],
		});
		expect(
			(
				await f.request(
					`/collections/${f.collectionId}`,
					undefined,
					otherToken.token,
				)
			).status,
		).toBe(404);
		await f.owner.mutation(api.apiTokens.revoke, { tokenId: f.token.tokenId });
		expect((await f.request(`/collections/${f.collectionId}`)).status).toBe(
			401,
		);
	});
	test("membership changes invalidate search cursors without leaking another collection", async () => {
		const f = await setup();
		await f.create("a", "A", "Un");
		await f.create("b", "B", "Deux");
		const first = await (
			await f.request(`/collections/${f.collectionId}/search?limit=1`)
		).json();
		const other = await createLegacyCollection(f.t, {
			projectId: f.projectId,
			name: "Screenshots",
			localeIds: [f.localeId],
		});
		expect(
			(
				await f.request(
					`/collections/${other}/search?cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).status,
		).toBe(409);
		const de = await f.owner.mutation(api.locales.create, {
			projectId: f.projectId,
			code: "de",
		});
		await f.owner.mutation(api.contentCollections.setLocales, {
			projectId: f.projectId,
			collectionId: f.collectionId,
			localeIds: [f.localeId, de],
			expectedMembershipRevision: 1,
		});
		expect(
			(
				await f.request(
					`/collections/${f.collectionId}/search?cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).status,
		).toBe(409);
	});
});

test("collection context budgets guidance together with selected values", async () => {
	const f = await setup();
	const keys = ["large_a", "large_b", "large_c", "large_d"];
	for (const key of keys)
		await f.create(key, "Brickit Cloud", "v".repeat(250 * 1024));
	for (const [index, sourceTerm] of ["Brickit", "Cloud"].entries())
		await f.owner.mutation(api.translationGuidance.saveTerm, {
			projectId: f.projectId,
			expectedRevision: index,
			term: {
				kind: "untranslatable",
				sourceTerm,
				definition: "d".repeat(15 * 1024),
			},
		});
	const tooLarge = await f.request(`/collections/${f.collectionId}/context`, {
		keys,
		locales: ["fr-CA"],
	});
	expect(tooLarge.status).toBe(413);
	expect(await tooLarge.json()).toMatchObject({ code: "LIMIT_EXCEEDED" });
	const smaller = await f.request(`/collections/${f.collectionId}/context`, {
		keys: keys.slice(0, 3),
		locales: ["fr-CA"],
	});
	expect(smaller.status).toBe(200);
	const text = await smaller.text();
	expect(new TextEncoder().encode(text).byteLength).toBeLessThan(1024 * 1024);
	expect(JSON.parse(text).guidance.terms).toHaveLength(2);
});
