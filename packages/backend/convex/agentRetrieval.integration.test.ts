import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup(count = 3) {
	const t = createBackend();
	const user = await authenticatedBackend(t, "retrieval-owner");
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const en = locales.find((locale) => locale.isSource)?._id;
	if (!en) throw new Error("Expected source Locale.");
	const de = await user.mutation(api.locales.create, { projectId, code: "de" });
	const zh = await user.mutation(api.locales.create, { projectId, code: "zh" });
	const files = [];
	for (const [localeId, code] of [
		[en, "en"],
		[de, "de"],
		[zh, "zh"],
	] as const) {
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
		const content: Record<string, string> = { "@@locale": code };
		for (let index = 0; index < count; index++)
			content[`item_${String(index).padStart(3, "0")}`] =
				code === "en"
					? `Build model ${index}`
					: code === "de"
						? `Modell bauen ${index}`
						: `把积木颗粒摊开 ${index}`;
		files.push({
			catalogPath: `${code}.arb`,
			content: JSON.stringify(content),
		});
	}
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files,
	});
	const { token } = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "reader",
		scopes: ["read", "search"],
	});
	async function request(query: string) {
		return t.fetch(`/api/agent/v1/workspace/search?${query}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	}
	async function save(localeId: Id<"locales">, value: string) {
		const catalog = await readWorkspaceKeyCards(user, projectId);
		const current = catalog.keys
			.find((key) => key.id === "item_000")
			?.values.find((row) => row.localeId === localeId);
		if (!current?.gitValueFingerprint) throw new Error("Missing basis");
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "item_000",
			localeId,
			intent: { kind: "save", value },
			expectedGitValueFingerprint: current.gitValueFingerprint,
			expectedGitValueRevision: current.gitValueRevision,
			expectedWorkspaceRevision: current.workspaceRevision,
			expectedSourceFingerprint: current.expectedSourceFingerprint,
		});
	}
	return { t, user, projectId, en, de, zh, token, request, save };
}

describe("Agent literal retrieval", () => {
	test("finds Chinese internal terms and keeps exact keys and phrases precise", async () => {
		const { request } = await setup();
		const chinese = await request(
			"q=积木&localeCode=zh&searchIn=target&view=compact",
		);
		expect(chinese.status).toBe(200);
		expect(await chinese.json()).toMatchObject({
			results: [0, 1, 2].map((index) => ({
				messageId: `item_00${index}`,
				matchedFields: ["target"],
			})),
			nextCursor: null,
		});
		const exact = await request(
			"q=item_001&searchIn=key&match=exact&localeCode=de",
		);
		expect(await exact.json()).toMatchObject({
			results: [{ messageId: "item_001", matchedFields: ["key"] }],
			nextCursor: null,
		});
		expect(
			await (await request("q=model Build&localeCode=de")).json(),
		).toMatchObject({ results: [], nextCursor: null });
		expect(
			await (await request("q=积木&localeCode=de&searchIn=target")).json(),
		).toMatchObject({ results: [], nextCursor: null });
	});

	test("enumerates past 50 results and exposes empty intermediate windows", async () => {
		const { request } = await setup(70);
		let cursor: string | null = null;
		const found: string[] = [];
		do {
			const response = await request(
				`q=Modell&localeCode=de&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			expect(response.status).toBe(200);
			const page = (await response.json()) as {
				results: Array<{ messageId: string }>;
				nextCursor: string | null;
			};
			found.push(...page.results.map((row) => row.messageId));
			cursor = page.nextCursor;
		} while (cursor);
		expect(found).toHaveLength(70);
		expect(new Set(found).size).toBe(70);
		const sparse = (await (
			await request("q=Modell bauen 69&localeCode=de")
		).json()) as { results: unknown[]; nextCursor: string };
		expect(sparse.results).toEqual([]);
		expect(sparse.nextCursor).toBeTruthy();
		expect(
			await (
				await request(
					`q=Modell bauen 69&localeCode=de&cursor=${encodeURIComponent(sparse.nextCursor)}`,
				)
			).json(),
		).toMatchObject({ results: [{ messageId: "item_069" }], nextCursor: null });
	});

	test("uses current source wording and confirmed evidence, invalidating a search after edits", async () => {
		const { request, save, en, de } = await setup();
		const first = (await (await request("localeCode=de&limit=1")).json()) as {
			nextCursor: string;
		};
		await save(en, "Welcome aboard");
		expect(
			await (await request("q=aboard&localeCode=de")).json(),
		).toMatchObject({
			results: [
				{
					source: { value: "Welcome aboard", pendingProposal: true },
					evidence: { sourceMatchesCurrent: false },
				},
			],
		});
		expect(
			await (await request("q=Build model 0&localeCode=de")).json(),
		).toMatchObject({ results: [], nextCursor: null });
		expect(
			await (await request("quality=confirmed&localeCode=de")).json(),
		).toMatchObject({ results: [] });
		await save(de, "Willkommen an Bord");
		expect(
			await (await request("quality=confirmed&localeCode=de")).json(),
		).toMatchObject({
			results: [
				{
					messageId: "item_000",
					evidence: {
						sourceMatchesCurrent: true,
						contract: { valid: true },
						confirmation: { actor: { kind: "user" } },
					},
				},
			],
		});
		expect(
			await (
				await request(
					`localeCode=de&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).json(),
		).toMatchObject({ code: "STALE_BASIS" });
	});

	test("rejects invalid filters and excludes archived Locales consistently", async () => {
		const { request, user, de, t, token } = await setup();
		for (const invalid of [
			"limit=abc",
			"limit=0",
			"limit=51",
			"match=fuzzy",
			"searchIn=unknown",
		]) {
			const response = await request(invalid);
			expect(response.status).toBe(400);
		}
		const first = (await (await request("localeCode=de&limit=1")).json()) as {
			nextCursor: string;
		};
		expect(
			await (
				await request(
					`localeCode=zh&cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).json(),
		).toMatchObject({ code: "VALIDATION" });
		await user.mutation(api.locales.archive, { localeId: de });
		const results = await (await request("q=Modell")).json();
		expect(results).toMatchObject({ results: [] });
		expect((await request("localeCode=de")).status).toBe(404);
		const context = await t.fetch("/api/agent/v1/workspace/context", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ keys: ["item_000"], locales: ["de"] }),
		});
		expect(await context.json()).toMatchObject({
			rows: [],
			missing: [{ messageId: "item_000", localeCode: "de" }],
		});
	});
});

test("case-only Source edit invalidates exact search continuation", async () => {
	const f = await setup();
	await f.save(f.en, "Welcome");
	const first = (await (
		await f.request("q=Welcome&searchIn=source&match=exact&limit=1")
	).json()) as { nextCursor: string };
	expect(first.nextCursor).toBeTruthy();
	await f.save(f.en, "WELCOME");
	const response = await f.request(
		`q=Welcome&searchIn=source&match=exact&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
	);
	expect(response.status).toBe(409);
});
