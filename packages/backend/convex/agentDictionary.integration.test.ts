import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup() {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "dictionary-owner");
	const projectId = await createProject(owner);
	await owner.mutation(api.locales.create, { projectId, code: "de" });
	const writer = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Dictionary editor",
		scopes: ["read", "dictionary-write"],
	});
	const reader = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose"],
	});
	function request(
		token: string,
		path = "/dictionary",
		method = "GET",
		body?: unknown,
	) {
		return t.fetch(`/api/agent/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}
	return { t, owner, projectId, writer, reader, request };
}

const productTerm = {
	kind: "untranslatable" as const,
	sourceTerm: "Brickit",
	definition: "Product name; preserve spelling.",
};

describe("agent Dictionary authoring", () => {
	test("requires deliberate write scope, retains actual authorship, and respects revocation", async () => {
		const f = await setup();
		const input = {
			expectedRevision: 0,
			terms: [productTerm],
			authoredBy: { kind: "user", id: "spoofed" },
		};
		expect(
			(await f.request(f.reader.token, "/dictionary/terms", "POST", input))
				.status,
		).toBe(401);
		await expect(
			f.owner.mutation(api.apiTokens.create, {
				projectId: f.projectId,
				name: "Invalid reviewer",
				scopes: ["read", "review", "dictionary-write"],
			}),
		).rejects.toThrow("reviewer token");
		const save = await f.request(
			f.writer.token,
			"/dictionary/terms",
			"POST",
			input,
		);
		expect(save.status).toBe(200);
		const saved = (await save.json()) as {
			revision: number;
			entries: Array<{ revisionId: Id<"translationGuidanceRevisions"> }>;
		};
		expect(saved.revision).toBe(1);
		const list = await f.request(f.reader.token);
		expect(await list.json()).toMatchObject({
			revision: 1,
			terms: [
				{
					term: productTerm,
					authoredBy: { kind: "agent", id: f.writer.tokenId },
				},
			],
		});
		await f.owner.mutation(api.apiTokens.revoke, { tokenId: f.writer.tokenId });
		expect(
			(
				await f.request(f.writer.token, "/dictionary/terms", "POST", {
					expectedRevision: 1,
					terms: [productTerm],
				})
			).status,
		).toBe(401);
		const citation = await f.request(
			f.reader.token,
			`/guidance/revisions/${saved.entries[0]?.revisionId}`,
		);
		expect(citation.status).toBe(200);
		expect(await citation.json()).toMatchObject({
			authoredBy: { kind: "agent", id: f.writer.tokenId },
		});
	});

	test("writes batches atomically, rejects stale revisions, and keeps superseded citations", async () => {
		const f = await setup();
		const invalid = await f.request(
			f.writer.token,
			"/dictionary/terms",
			"POST",
			{
				expectedRevision: 0,
				terms: [
					productTerm,
					{
						kind: "translated",
						sourceTerm: "Build",
						definition: "Assemble",
						renderings: [{ localeCode: "unknown", value: "invalid" }],
					},
				],
			},
		);
		expect(invalid.status).toBe(400);
		expect(await (await f.request(f.reader.token)).json()).toEqual({
			revision: 0,
			terms: [],
			nextCursor: null,
		});
		const input = { expectedRevision: 0, terms: [productTerm] };
		const first = (await (
			await f.request(f.writer.token, "/dictionary/terms", "POST", input)
		).json()) as { entries: Array<{ revisionId: string }> };
		expect(
			(await f.request(f.writer.token, "/dictionary/terms", "POST", input))
				.status,
		).toBe(409);
		const unchanged = await f.request(
			f.writer.token,
			"/dictionary/terms",
			"POST",
			{ ...input, expectedRevision: 1 },
		);
		expect(await unchanged.json()).toMatchObject({
			revision: 1,
			entries: [{ revisionId: first.entries[0]?.revisionId }],
		});
		const removed = await f.request(
			f.writer.token,
			"/dictionary/terms",
			"DELETE",
			{ expectedRevision: 1, sourceTerm: "Brickit" },
		);
		expect(await removed.json()).toMatchObject({ revision: 2 });
		expect(await (await f.request(f.reader.token)).json()).toEqual({
			revision: 2,
			terms: [],
			nextCursor: null,
		});
		const citation = await f.request(
			f.reader.token,
			`/guidance/revisions/${first.entries[0]?.revisionId}`,
		);
		expect(await citation.json()).toMatchObject({
			content: { kind: "term", term: productTerm },
		});
		const duplicate = await f.request(
			f.writer.token,
			"/dictionary/terms",
			"POST",
			{
				expectedRevision: 2,
				terms: [productTerm, { ...productTerm, sourceTerm: " Brickit " }],
			},
		);
		expect(duplicate.status).toBe(400);
	});

	test("pages beyond one batch, finds exact terms, and invalidates changed search bases", async () => {
		const f = await setup();
		const terms = Array.from({ length: 75 }, (_, index) => ({
			...productTerm,
			sourceTerm: `Term${String(index).padStart(3, "0")}`,
		}));
		for (let offset = 0; offset < terms.length; offset += 32) {
			const result = await f.request(
				f.writer.token,
				"/dictionary/terms",
				"POST",
				{ expectedRevision: offset, terms: terms.slice(offset, offset + 32) },
			);
			expect(result.status).toBe(200);
		}
		const first = (await (
			await f.request(f.reader.token, "/dictionary?limit=50")
		).json()) as {
			terms: Array<{ term: { sourceTerm: string } }>;
			nextCursor: string;
		};
		expect(first.terms).toHaveLength(50);
		const second = (await (
			await f.request(
				f.reader.token,
				`/dictionary?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`,
			)
		).json()) as typeof first;
		expect(second.terms).toHaveLength(25);
		expect(second.nextCursor).toBeNull();
		expect(
			new Set(
				[...first.terms, ...second.terms].map(({ term }) => term.sourceTerm),
			).size,
		).toBe(75);
		const exact = await (
			await f.request(f.reader.token, "/dictionary?sourceTerm=Term074")
		).json();
		expect(exact).toMatchObject({
			terms: [{ term: { sourceTerm: "Term074" } }],
			nextCursor: null,
		});
		const sparse = (await (
			await f.request(f.reader.token, "/dictionary?q=term074")
		).json()) as typeof first;
		expect(sparse.terms).toEqual([]);
		expect(sparse.nextCursor).toBeTypeOf("string");
		expect(
			await (
				await f.request(
					f.reader.token,
					`/dictionary?q=term074&cursor=${encodeURIComponent(sparse.nextCursor)}`,
				)
			).json(),
		).toMatchObject({
			terms: [{ term: { sourceTerm: "Term074" } }],
			nextCursor: null,
		});
		await f.owner.mutation(api.translationGuidance.saveProjectVoiceGuide, {
			projectId: f.projectId,
			expectedRevision: 75,
			text: "Friendly and concise.",
			examples: [],
		});
		expect(
			(
				await f.request(
					f.reader.token,
					`/dictionary?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).status,
		).toBe(409);
	});

	test("isolates projects and rejects oversized or invalid requests without changing guidance", async () => {
		const f = await setup();
		const otherProject = await createProject(f.owner, {
			slug: "other-dictionary-project",
		});
		const other = await f.owner.mutation(api.apiTokens.create, {
			projectId: otherProject,
			name: "Other",
			scopes: ["read", "dictionary-write"],
		});
		const saved = (await (
			await f.request(f.writer.token, "/dictionary/terms", "POST", {
				expectedRevision: 0,
				terms: [productTerm],
			})
		).json()) as { entries: Array<{ revisionId: string }> };
		expect(await (await f.request(other.token)).json()).toEqual({
			revision: 0,
			terms: [],
			nextCursor: null,
		});
		expect(
			(
				await f.request(
					other.token,
					`/guidance/revisions/${saved.entries[0]?.revisionId}`,
				)
			).status,
		).toBe(404);
		for (const body of [
			{
				expectedRevision: 1,
				terms: Array.from({ length: 33 }, (_, index) => ({
					...productTerm,
					sourceTerm: String(index),
				})),
			},
			{
				expectedRevision: 1,
				terms: [{ ...productTerm, definition: "x".repeat(256 * 1024) }],
			},
		])
			expect(
				(await f.request(f.writer.token, "/dictionary/terms", "POST", body))
					.status,
			).toBe(413);
		expect(
			(
				await f.request(f.writer.token, "/dictionary/terms", "POST", {
					expectedRevision: -1,
					terms: [productTerm],
				})
			).status,
		).toBe(400);
		expect(
			(await f.request(f.reader.token, "/dictionary?limit=0")).status,
		).toBe(400);
		expect(
			(await f.request(f.reader.token, "/dictionary?cursor=invalid")).status,
		).toBe(400);
		expect(await (await f.request(f.reader.token)).json()).toMatchObject({
			revision: 1,
			terms: [{ term: productTerm }],
		});
	});
});
