import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import {
	readGuidance,
	removeDictionaryTerm,
	saveDictionaryTerm,
} from "./translationGuidance";

async function setup() {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "guidance-owner");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	return { t, owner, projectId, localeId };
}

const term = {
	sourceTerm: "Brickit",
	definition: "The product name stays unchanged.",
	kind: "untranslatable" as const,
};

describe("authored translation guidance", () => {
	test("includes the general voice once in every context, alongside only requested Locale add-ons", async () => {
		const { t, owner, projectId } = await setup();
		const saved = await owner.mutation(
			api.translationGuidance.saveProjectVoiceGuide,
			{
				projectId,
				expectedRevision: 0,
				text: "Be welcoming, concise, and specific.",
				examples: [
					{ source: "An error has occurred", target: "Try scanning again" },
				],
			},
		);
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId,
			expectedRevision: 1,
			localeCode: "de",
			text: "Use du.",
			examples: [],
		});
		for (const localeCodes of [[], ["pt"], ["de", "pt"]]) {
			const context = await t.run((ctx) =>
				readGuidance(ctx, projectId, { texts: [], localeCodes }),
			);
			expect(context.projectGuide).toMatchObject({
				text: "Be welcoming, concise, and specific.",
				revisionId: saved.revisionId,
			});
			expect(context.guides.map((guide) => guide.localeCode)).toEqual(
				localeCodes.includes("de") ? ["de"] : [],
			);
		}
		expect(
			await owner.query(api.translationGuidance.list, { projectId }),
		).toMatchObject({
			projectGuide: { revision: 1 },
			guides: [{ localeCode: "de" }],
		});
		await owner.mutation(api.translationGuidance.saveProjectVoiceGuide, {
			projectId,
			expectedRevision: 2,
			text: "",
			examples: [],
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId }))
				.projectGuide,
		).toBeNull();
		if (!saved.revisionId) throw new Error("Expected voice citation.");
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: saved.revisionId,
			}),
		).toMatchObject({
			content: {
				kind: "projectVoiceGuide",
				text: "Be welcoming, concise, and specific.",
			},
		});
	});

	test("supports Dictionary renderings and optional voice add-ons for dozens of Locales with bounded context batches", async () => {
		const { t, owner, projectId } = await setup();
		const localeCodes = Array.from(
			{ length: 64 },
			(_, index) => `fr-${String(index + 1).padStart(3, "0")}`,
		);
		for (const code of localeCodes)
			await owner.mutation(api.locales.create, { projectId, code });
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term: {
				sourceTerm: "Start",
				definition: "Begin the chosen activity",
				kind: "translated",
				renderings: localeCodes.map((localeCode) => ({
					localeCode,
					value: "Commencer",
				})),
			},
		});
		for (const [index, localeCode] of localeCodes.entries()) {
			await owner.mutation(api.translationGuidance.saveVoiceGuide, {
				projectId,
				expectedRevision: index + 1,
				localeCode,
				text: "Keep labels concise.",
				examples: [],
			});
		}
		await owner.mutation(api.translationGuidance.saveProjectVoiceGuide, {
			projectId,
			expectedRevision: 65,
			text: "Be useful and clear.",
			examples: [],
		});
		const all = await owner.query(api.translationGuidance.list, { projectId });
		expect(all.guides).toHaveLength(64);
		expect(all.terms[0]?.term).toMatchObject({ renderings: expect.any(Array) });
		if (all.terms[0]?.term.kind !== "translated")
			throw new Error("Expected translated term.");
		expect(all.terms[0].term.renderings).toHaveLength(64);
		const context = await t.run((ctx) =>
			readGuidance(ctx, projectId, {
				texts: ["Start"],
				localeCodes: localeCodes.slice(0, 20),
			}),
		);
		expect(context.projectGuide?.text).toBe("Be useful and clear.");
		expect(context.guides).toHaveLength(20);
		if (context.terms[0]?.term.kind !== "translated")
			throw new Error("Expected translated term.");
		expect(context.terms[0].term.renderings).toHaveLength(20);
		await expect(
			t.run((ctx) =>
				readGuidance(ctx, projectId, {
					texts: ["Start"],
					localeCodes: localeCodes.slice(0, 21),
				}),
			),
		).rejects.toThrow("20 Locales");
	});

	test("retains agent authorship through Dictionary context, replacement, and removal", async () => {
		const { t, owner, projectId } = await setup();
		const authoredBy = { kind: "agent" as const, id: "dictionary-agent-token" };
		const saved = await t.run((ctx) =>
			saveDictionaryTerm(ctx, {
				projectId,
				expectedRevision: 0,
				term,
				authoredBy,
			}),
		);
		expect(
			await t.run((ctx) =>
				readGuidance(ctx, projectId, {
					texts: ["Brickit"],
					localeCodes: ["de"],
				}),
			),
		).toMatchObject({ terms: [{ authoredBy, revisionId: saved.revisionId }] });
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 1,
			term: { ...term, definition: "Preserve the product spelling." },
		});
		await t.run((ctx) =>
			removeDictionaryTerm(ctx, {
				projectId,
				expectedRevision: 2,
				sourceTerm: term.sourceTerm,
				authoredBy,
			}),
		);
		if (!saved.revisionId) throw new Error("Expected term citation.");
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: saved.revisionId,
			}),
		).toMatchObject({ authoredBy, content: { term } });
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).terms,
		).toEqual([]);
	});

	test("starts empty and does not infer a Dictionary or voice from the catalog", async () => {
		const { t, owner, projectId } = await setup();
		expect(
			await owner.query(api.translationGuidance.list, { projectId }),
		).toEqual({ revision: 0, terms: [], guides: [], projectGuide: null });
		expect(
			await t.run((ctx) =>
				readGuidance(ctx, projectId, {
					texts: ["Brickit Start"],
					localeCodes: ["de", "pt"],
				}),
			),
		).toEqual({ revision: 0, terms: [], guides: [], projectGuide: null });
	});

	test("matches case-sensitive literal terms once per batch, excluding ICU syntax", async () => {
		const { t, owner, projectId } = await setup();
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term,
		});
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 1,
			term: {
				sourceTerm: "Start",
				definition: "Begin an activity.",
				kind: "translated",
				renderings: [
					{ localeCode: "de", value: "Starten" },
					{ localeCode: "pt", value: "Iniciar" },
				],
			},
		});
		const guidance = await t.run((ctx) =>
			readGuidance(ctx, projectId, {
				texts: [
					"Start Brickit",
					"start brickit Restart",
					"{Start} {amount, number, Start}",
					"{count, plural, one{Start now} other{Start again}}",
					"{Start, select, Start{Done} other{Done}}",
					"'{Start}'",
					"Start{name}",
				],
				localeCodes: ["de"],
			}),
		);
		expect(guidance.terms).toHaveLength(2);
		expect(
			guidance.terms.find((entry) => entry.term.sourceTerm === "Brickit"),
		).toMatchObject({ matchedTextIndexes: [0] });
		expect(
			guidance.terms.find((entry) => entry.term.sourceTerm === "Start"),
		).toMatchObject({
			term: { renderings: [{ localeCode: "de", value: "Starten" }] },
			matchedTextIndexes: [0, 3, 5, 6],
			authoredBy: { kind: "user" },
		});
	});

	test("retains exact citations after edits and removal, without revisions for unchanged saves", async () => {
		const { owner, projectId } = await setup();
		const original = await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term,
		});
		if (!original.revisionId) throw new Error("Expected immutable revision.");
		expect(
			await owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 1,
				term,
			}),
		).toEqual(original);
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 1,
			term: { ...term, definition: "Product name, including its spelling." },
		});
		await expect(
			owner.mutation(api.translationGuidance.removeTerm, {
				projectId,
				expectedRevision: 1,
				sourceTerm: "Brickit",
			}),
		).rejects.toThrow("guidance changed");
		const removed = await owner.mutation(api.translationGuidance.removeTerm, {
			projectId,
			expectedRevision: 2,
			sourceTerm: "Brickit",
		});
		if (!removed.revisionId) throw new Error("Expected removal revision.");
		expect(
			await owner.query(api.translationGuidance.list, { projectId }),
		).toEqual({ revision: 3, terms: [], guides: [], projectGuide: null });
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: original.revisionId,
			}),
		).toMatchObject({ revision: 1, content: { kind: "term", term } });
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: removed.revisionId,
			}),
		).toMatchObject({ revision: 3, content: null });
	});

	test("matches literal terms in source scripts that do not separate words with spaces", async () => {
		const { t, owner, projectId } = await setup();
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term: {
				sourceTerm: "积木",
				definition: "Building bricks.",
				kind: "translated",
				renderings: [{ localeCode: "de", value: "Bausteine" }],
			},
		});
		const guidance = await t.run((ctx) =>
			readGuidance(ctx, projectId, {
				texts: ["请扫描积木"],
				localeCodes: ["de"],
			}),
		);
		expect(guidance.terms[0]).toMatchObject({
			term: { sourceTerm: "积木" },
			matchedTextIndexes: [0],
		});
	});

	test("enforces the project term cap while allowing replacement and removal", async () => {
		const { owner, projectId } = await setup();
		for (let index = 0; index < 256; index++) {
			await owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: index,
				term: { ...term, sourceTerm: `Brand ${index}` },
			});
		}
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 256,
				term,
			}),
		).rejects.toThrow("256 Dictionary terms");
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 256,
			term: {
				...term,
				sourceTerm: "Brand 0",
				definition: "Updated name guidance.",
			},
		});
		await owner.mutation(api.translationGuidance.removeTerm, {
			projectId,
			expectedRevision: 257,
			sourceTerm: "Brand 1",
		});
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 258,
			term,
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).terms,
		).toHaveLength(256);
	});

	test("allows only project editors to author and protects old citations across projects", async () => {
		const { t, owner, projectId } = await setup();
		const viewer = await authenticatedBackend(t, "guidance-viewer");
		await owner.mutation(api.projects.addMember, {
			projectId,
			userId: "guidance-viewer",
			role: "viewer",
		});
		const editor = await authenticatedBackend(t, "guidance-editor");
		await owner.mutation(api.projects.addMember, {
			projectId,
			userId: "guidance-editor",
			role: "editor",
		});
		await expect(
			viewer.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 0,
				term,
			}),
		).rejects.toThrow("Insufficient project permissions");
		await expect(
			t.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 0,
				term,
			}),
		).rejects.toThrow();
		const saved = await editor.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term,
		});
		if (!saved.revisionId) throw new Error("Expected revision.");
		expect(
			(await viewer.query(api.translationGuidance.list, { projectId })).terms,
		).toHaveLength(1);
		const outsider = await authenticatedBackend(t, "guidance-outsider");
		const otherProjectId = await createProject(outsider, {
			slug: "other-project",
		});
		await expect(
			outsider.query(api.translationGuidance.list, { projectId }),
		).rejects.toThrow("Insufficient project permissions");
		await expect(
			outsider.query(api.translationGuidance.getRevision, {
				projectId: otherProjectId,
				revisionId: saved.revisionId,
			}),
		).rejects.toThrow("not found for this project");
	});

	test("serves Locale-specific voice and permits removal after that Locale is archived", async () => {
		const { t, owner, projectId, localeId } = await setup();
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId,
			expectedRevision: 0,
			localeCode: "pt",
			text: "Use short, encouraging sentences.",
			examples: [{ source: "Try again", target: "Tente de novo" }],
		});
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId,
			expectedRevision: 1,
			localeCode: "de",
			text: "Address the reader as du.",
			examples: [],
		});
		const guidance = await t.run((ctx) =>
			readGuidance(ctx, projectId, { texts: [], localeCodes: ["pt"] }),
		);
		expect(guidance.guides).toHaveLength(1);
		expect(guidance.guides[0]).toMatchObject({
			localeCode: "pt",
			revision: 1,
			examples: [{ source: "Try again", target: "Tente de novo" }],
		});
		await owner.mutation(api.locales.archive, { localeId });
		await expect(
			owner.mutation(api.translationGuidance.saveVoiceGuide, {
				projectId,
				expectedRevision: 2,
				localeCode: "de",
				text: "Changed guidance",
				examples: [],
			}),
		).rejects.toThrow("not an active target");
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId,
			expectedRevision: 2,
			localeCode: "de",
			text: "",
			examples: [],
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).guides,
		).toHaveLength(1);
	});

	test("rejects invalid locales and blank or ambiguous term renderings", async () => {
		const { owner, projectId } = await setup();
		for (const localeCode of ["en", "fr", "pt_BR", "DE"]) {
			await expect(
				owner.mutation(api.translationGuidance.saveVoiceGuide, {
					projectId,
					expectedRevision: 0,
					localeCode,
					text: "Some guidance",
					examples: [],
				}),
			).rejects.toThrow();
		}
		for (const renderings of [
			[],
			[{ localeCode: "de", value: " " }],
			[
				{ localeCode: "de", value: "Start" },
				{ localeCode: "de", value: "Beginn" },
			],
		]) {
			await expect(
				owner.mutation(api.translationGuidance.saveTerm, {
					projectId,
					expectedRevision: 0,
					term: {
						sourceTerm: "Start",
						definition: "Begin an activity",
						kind: "translated",
						renderings,
					},
				}),
			).rejects.toThrow();
		}
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 0,
				term: { ...term, definition: " " },
			}),
		).rejects.toThrow("cannot be blank");
	});

	test("bounds authored entries and context work without changing the revision on failure", async () => {
		const { t, owner, projectId } = await setup();
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 0,
				term: { ...term, definition: "x".repeat(16 * 1024) },
			}),
		).rejects.toThrow("16 KiB");
		await expect(
			owner.mutation(api.translationGuidance.saveVoiceGuide, {
				projectId,
				expectedRevision: 0,
				localeCode: "de",
				text: "x".repeat(8192),
				examples: [],
			}),
		).rejects.toThrow("8 KiB");
		await expect(
			owner.mutation(api.translationGuidance.saveVoiceGuide, {
				projectId,
				expectedRevision: 0,
				localeCode: "de",
				text: "Voice",
				examples: Array.from({ length: 6 }, () => ({
					source: "Go",
					target: "Los",
				})),
			}),
		).rejects.toThrow("five curated examples");
		await expect(
			t.run((ctx) =>
				readGuidance(ctx, projectId, {
					texts: Array.from({ length: 51 }, () => "Hello"),
					localeCodes: ["de"],
				}),
			),
		).rejects.toThrow("50 source texts");
		await expect(
			t.run((ctx) =>
				readGuidance(ctx, projectId, {
					texts: ["x".repeat(512 * 1024)],
					localeCodes: ["de"],
				}),
			),
		).rejects.toThrow("512 KiB");
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).revision,
		).toBe(0);
	});

	test("keeps archived renderings when another part of a term changes, but does not edit them", async () => {
		const { owner, projectId, localeId } = await setup();
		const translated = {
			sourceTerm: "Start",
			definition: "Begin an activity",
			kind: "translated" as const,
			renderings: [
				{ localeCode: "de", value: "Starten" },
				{ localeCode: "pt", value: "Iniciar" },
			],
		};
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term: translated,
		});
		await owner.mutation(api.locales.archive, { localeId });
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 1,
			term: { ...translated, definition: "Begin the selected activity." },
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).terms[0]
				?.term,
		).toMatchObject({
			definition: "Begin the selected activity.",
			renderings: translated.renderings,
		});
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 2,
				term: {
					...translated,
					renderings: [{ localeCode: "de", value: "Los" }],
				},
			}),
		).rejects.toThrow("not an active target");
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 2,
				term: { ...translated, sourceTerm: "Begin" },
			}),
		).rejects.toThrow("not an active target");
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 2,
			term: {
				...translated,
				renderings: [{ localeCode: "pt", value: "Começar" }],
			},
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).terms[0]
				?.term,
		).toMatchObject({ renderings: [{ localeCode: "pt", value: "Começar" }] });
	});

	test("reads automatic task guidance while reintroducing an archived Portuguese Locale", async () => {
		const { t, owner, projectId, localeId } = await setup();
		const source = (await owner.query(api.locales.list, { projectId })).find(
			(locale) => locale.isSource,
		);
		if (!source) throw new Error("Expected source Locale.");
		await owner.mutation(api.locales.bind, {
			localeId: source._id,
			catalogPath: "en.arb",
		});
		await owner.mutation(api.locales.bind, { localeId, catalogPath: "de.arb" });
		const pt = await owner.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		await owner.mutation(api.locales.archive, { localeId: pt });
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","greeting":"Hello"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","greeting":"Hallo"}',
				},
			],
		});
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId,
			expectedRevision: 0,
			localeCode: "pt",
			text: "Use informal, encouraging wording.",
			examples: [],
		});
		const token = await owner.mutation(api.apiTokens.create, {
			projectId,
			name: "Portuguese translator",
			scopes: ["read", "propose"],
		});
		const headers = {
			Authorization: `Bearer ${token.token}`,
			"Content-Type": "application/json",
		};
		const created = await t.fetch("/api/agent/v1/translation-tasks", {
			method: "POST",
			headers,
			body: JSON.stringify({
				clientTaskKey: "reintroduce-pt",
				target: { kind: "newLocale", localeCode: "pt" },
			}),
		});
		expect(created.status).toBe(200);
		const { taskId } = (await created.json()) as { taskId: string };
		const task = await t.fetch(`/api/agent/v1/translation-tasks/${taskId}`, {
			headers,
		});
		expect(task.status).toBe(200);
		expect(await task.json()).toMatchObject({
			guidance: {
				guides: [
					{ localeCode: "pt", text: "Use informal, encouraging wording." },
				],
			},
		});
		const context = await t.fetch("/api/agent/v1/guidance/context", {
			method: "POST",
			headers,
			body: JSON.stringify({ texts: ["Hello"], locales: ["pt"] }),
		});
		expect(context.status).toBe(200);
	});

	test("matches a term whose ordinary possessive apostrophe ends the source text", async () => {
		const { t, owner, projectId } = await setup();
		await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term: {
				sourceTerm: "Players'",
				definition: "Plural possessive form.",
				kind: "translated",
				renderings: [{ localeCode: "de", value: "der Spieler" }],
			},
		});
		const guidance = await t.run((ctx) =>
			readGuidance(ctx, projectId, {
				texts: ["Players'"],
				localeCodes: ["de"],
			}),
		);
		expect(guidance.terms[0]).toMatchObject({
			term: { sourceTerm: "Players'" },
			matchedTextIndexes: [0],
		});
	});

	test("carries guidance through pre-Snapshot Locale code correction and retains old citations", async () => {
		const { t, owner, projectId, localeId } = await setup();
		const termSaved = await owner.mutation(api.translationGuidance.saveTerm, {
			projectId,
			expectedRevision: 0,
			term: {
				sourceTerm: "Start",
				definition: "Begin an activity",
				kind: "translated",
				renderings: [{ localeCode: "de", value: "Starten" }],
			},
		});
		const guideSaved = await owner.mutation(
			api.translationGuidance.saveVoiceGuide,
			{
				projectId,
				expectedRevision: 1,
				localeCode: "de",
				text: "Address the reader as du.",
				examples: [],
			},
		);
		if (!termSaved.revisionId || !guideSaved.revisionId)
			throw new Error("Expected guidance citations.");
		await owner.mutation(api.locales.correctSetupBinding, {
			localeId,
			code: "de-DE",
			catalogPath: "de.arb",
		});
		const guidance = await t.run((ctx) =>
			readGuidance(ctx, projectId, {
				texts: ["Start"],
				localeCodes: ["de-DE"],
			}),
		);
		expect(guidance.revision).toBeGreaterThan(2);
		expect(guidance.terms[0]).toMatchObject({
			term: { renderings: [{ localeCode: "de-DE", value: "Starten" }] },
		});
		expect(guidance.guides).toMatchObject([
			{ localeCode: "de-DE", text: "Address the reader as du." },
		]);
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: guideSaved.revisionId,
			}),
		).toMatchObject({
			content: { localeCode: "de", text: "Address the reader as du." },
		});
		expect(
			await owner.query(api.translationGuidance.getRevision, {
				projectId,
				revisionId: termSaved.revisionId,
			}),
		).toMatchObject({
			content: {
				term: { renderings: [{ localeCode: "de", value: "Starten" }] },
			},
		});
		await expect(
			owner.mutation(api.translationGuidance.saveVoiceGuide, {
				projectId,
				expectedRevision: 2,
				localeCode: "de-DE",
				text: "A stale edit",
				examples: [],
			}),
		).rejects.toThrow("guidance changed");
	});

	test.each(["guide", "term"] as const)(
		"rejects conflicting destination %s guidance without partially correcting setup",
		async (kind) => {
			const { owner, projectId, localeId } = await setup();
			const destinationId = await owner.mutation(api.locales.create, {
				projectId,
				code: "de-DE",
			});
			if (kind === "guide") {
				await owner.mutation(api.translationGuidance.saveVoiceGuide, {
					projectId,
					expectedRevision: 0,
					localeCode: "de",
					text: "Use informal address.",
					examples: [],
				});
				await owner.mutation(api.translationGuidance.saveVoiceGuide, {
					projectId,
					expectedRevision: 1,
					localeCode: "de-DE",
					text: "Use formal address.",
					examples: [],
				});
			} else {
				await owner.mutation(api.translationGuidance.saveTerm, {
					projectId,
					expectedRevision: 0,
					term: {
						sourceTerm: "Start",
						definition: "Begin an activity",
						kind: "translated",
						renderings: [
							{ localeCode: "de", value: "Starten" },
							{ localeCode: "de-DE", value: "Beginnen" },
						],
					},
				});
			}
			const before = await owner.query(api.translationGuidance.list, {
				projectId,
			});
			await expect(
				owner.mutation(api.locales.correctSetupBinding, {
					localeId,
					code: "de-DE",
					catalogPath: "de.arb",
				}),
			).rejects.toThrow("Locale correction would replace");
			expect(
				await owner.query(api.translationGuidance.list, { projectId }),
			).toEqual(before);
			const locales = await owner.query(api.locales.list, { projectId });
			expect(locales.find((locale) => locale._id === localeId)?.code).toBe(
				"de",
			);
			expect(locales.find((locale) => locale._id === destinationId)?.code).toBe(
				"de-DE",
			);
		},
	);

	test.each(["guide", "term"] as const)(
		"protects configured new-Locale %s guidance when correcting the Source code",
		async (kind) => {
			const { owner, projectId } = await setup();
			const source = (await owner.query(api.locales.list, { projectId })).find(
				(locale) => locale.isSource,
			);
			if (!source) throw new Error("Expected source Locale.");
			if (kind === "guide") {
				await owner.mutation(api.translationGuidance.saveVoiceGuide, {
					projectId,
					expectedRevision: 0,
					localeCode: "pt",
					text: "Keep the Portuguese tone friendly.",
					examples: [],
				});
			} else {
				await owner.mutation(api.translationGuidance.saveTerm, {
					projectId,
					expectedRevision: 0,
					term: {
						sourceTerm: "Start",
						definition: "Begin an activity",
						kind: "translated",
						renderings: [{ localeCode: "pt", value: "Iniciar" }],
					},
				});
			}
			const before = await owner.query(api.translationGuidance.list, {
				projectId,
			});
			await expect(
				owner.mutation(api.locales.correctSetupBinding, {
					localeId: source._id,
					code: "pt",
					catalogPath: "pt.arb",
				}),
			).rejects.toThrow("has target translation guidance");
			expect(
				await owner.query(api.translationGuidance.list, { projectId }),
			).toEqual(before);
			expect(
				(await owner.query(api.locales.list, { projectId })).find(
					(locale) => locale.isSource,
				)?.code,
			).toBe("en");
		},
	);
});
