import { describe, expect, test } from "vitest";
import { authenticatedBackend, createBackend } from "../test/support";
import { api } from "./_generated/api";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "language-owner");
	const projectId = await owner.mutation(api.projects.create, {
		name: "Basic",
		slug: "basic",
		type: "basic",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
	const project = await owner.query(api.projects.get, { projectId });
	if (!project.managedCollectionId) throw Error("Missing collection");
	return {
		t,
		owner,
		projectId,
		address: { projectId, collectionId: project.managedCollectionId },
	};
}
describe("immediate managed language changes", () => {
	test("adds existing and new identities directly without replacing other languages", async () => {
		const s = await setup();
		const existing = await s.owner.mutation(api.locales.create, {
			projectId: s.projectId,
			code: "fr",
			label: "French",
		});
		const first = await s.owner.mutation(api.contentCollections.addLocale, {
			...s.address,
			code: "fr",
		});
		expect(first.localeId).toBe(existing);
		const second = await s.owner.mutation(api.contentCollections.addLocale, {
			...s.address,
			code: "pt_br",
			label: "Portuguese",
		});
		const selected = await s.owner.query(api.contentCollections.get, s.address);
		expect(selected.localeIds).toEqual([existing, second.localeId]);
		expect(
			await s.owner.mutation(api.contentCollections.addLocale, {
				...s.address,
				code: "pt-BR",
			}),
		).toEqual(second);
		const locales = await s.owner.query(api.locales.list, {
			projectId: s.projectId,
		});
		expect(locales.find((l) => l._id === second.localeId)).toMatchObject({
			code: "pt-BR",
			label: "Portuguese",
			isSource: false,
		});
		expect(
			locales.find((l) => l._id === second.localeId)?.catalogPath,
		).toBeUndefined();
	});
	test("removal is idempotent and re-add restores settled translations and history", async () => {
		const s = await setup();
		const added = await s.owner.mutation(api.contentCollections.addLocale, {
			...s.address,
			code: "fr",
			label: "French",
		});
		const messageId = await s.owner.mutation(api.managedContent.createMessage, {
			...s.address,
			sourceValue: "Hello",
		});
		const input = {
			...s.address,
			messageIds: [messageId],
			localeIds: [added.localeId],
		};
		const before = await s.owner.query(api.managedContent.context, input);
		const target = before.items[0];
		if (!target) throw Error("Missing target");
		await s.owner.mutation(api.managedContent.commit, {
			...s.address,
			messageId,
			localeId: added.localeId,
			basis: target.basis,
			intent: { kind: "save", value: "Bonjour" },
		});
		const removed = await s.owner.mutation(
			api.contentCollections.removeLocale,
			{ ...s.address, localeId: added.localeId },
		);
		expect(
			await s.owner.mutation(api.contentCollections.removeLocale, {
				...s.address,
				localeId: added.localeId,
			}),
		).toEqual(removed);
		await expect(
			s.owner.query(api.managedContent.context, input),
		).rejects.toThrow("not enabled");
		const restored = await s.owner.mutation(api.contentCollections.addLocale, {
			...s.address,
			code: "fr",
			label: "Français",
		});
		expect(restored.localeId).toBe(added.localeId);
		expect(await s.t.run((ctx) => ctx.db.get(added.localeId))).toMatchObject({
			label: "Français",
		});
		await expect(
			s.owner.mutation(api.contentCollections.addLocale, {
				...s.address,
				code: "fr",
				label: "French",
			}),
		).rejects.toThrow("Edit its name");
		expect(
			(await s.owner.query(api.managedContent.context, input)).items[0],
		).toMatchObject({ value: "Bonjour", valueState: "settled" });
		expect(
			await s.t.run((ctx) =>
				ctx.db
					.query("managedTargetRevisions")
					.withIndex("by_collection", (q) =>
						q.eq("collectionId", s.address.collectionId),
					)
					.take(16),
			),
		).toHaveLength(1);
		await s.owner.mutation(api.contentCollections.removeLocale, {
			...s.address,
			localeId: added.localeId,
		});
		await s.owner.mutation(api.contentCollections.addLocale, {
			...s.address,
			code: "fr",
			label: " ",
		});
		expect(await s.t.run((ctx) => ctx.db.get(added.localeId))).toMatchObject({
			label: "Français",
		});
	});
	test("rejects source, malformed codes and unauthorized changes without partial creation", async () => {
		const s = await setup();
		const viewer = await authenticatedBackend(s.t, "language-viewer");
		await s.owner.mutation(api.projects.addMember, {
			projectId: s.projectId,
			userId: "language-viewer",
			role: "viewer",
		});
		await expect(
			viewer.mutation(api.contentCollections.addLocale, {
				...s.address,
				code: "de",
			}),
		).rejects.toThrow("permissions");
		await expect(
			s.owner.mutation(api.contentCollections.addLocale, {
				...s.address,
				code: "en",
			}),
		).rejects.toThrow("source language");
		await expect(
			s.owner.mutation(api.contentCollections.addLocale, {
				...s.address,
				code: "!!",
			}),
		).rejects.toThrow("language code");
		expect(
			(await s.owner.query(api.locales.list, { projectId: s.projectId })).map(
				(l) => l.code,
			),
		).toEqual(["en"]);
	});
});

describe("language metadata", () => {
	test("renames a populated Basic target in place, retaining history and moving only project guidance", async () => {
		const s = await setup();
		const { localeId } = await s.owner.mutation(
			api.contentCollections.addLocale,
			{ ...s.address, code: "pt", label: "Portuguese" },
		);
		const messageId = await s.owner.mutation(api.managedContent.createMessage, {
			...s.address,
			sourceValue: "Hello",
		});
		const query = {
			...s.address,
			messageIds: [messageId],
			localeIds: [localeId],
		};
		const before = await s.owner.query(api.managedContent.context, query);
		const target = before.items[0];
		if (!target) throw Error("Missing target");
		await s.owner.mutation(api.managedContent.commit, {
			...s.address,
			messageId,
			localeId,
			basis: target.basis,
			intent: { kind: "save", value: "Olá" },
		});
		const revisionsBefore = await s.t.run((ctx) =>
			ctx.db
				.query("managedTargetRevisions")
				.withIndex("by_collection", (q) =>
					q.eq("collectionId", s.address.collectionId),
				)
				.take(16),
		);
		const dictionaryId = await s.owner.mutation(api.dictionaries.create, {
			name: "Shared terminology",
		});
		await s.owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId,
			expectedRevision: 0,
			term: {
				kind: "translated",
				sourceTerm: "Hello",
				definition: "A greeting",
				renderings: [{ localeCode: "pt", value: "Olá" }],
			},
		});
		await s.owner.mutation(api.dictionaries.connect, {
			projectId: s.projectId,
			dictionaryId,
			expectedConnectionRevision: 0,
		});
		const dictionaryBefore = await s.owner.query(api.dictionaries.detail, {
			dictionaryId,
		});

		await s.owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId: s.projectId,
			expectedRevision: 0,
			localeCode: "pt",
			text: "Keep it warm.",
			examples: [],
		});
		const id = await s.owner.mutation(api.locales.updateMetadata, {
			projectId: s.projectId,
			localeId,
			expectedCode: "pt",
			expectedLabel: "Portuguese",
			code: "pt_br",
			label: " Brazilian Portuguese ",
		});
		expect(id).toBe(localeId);
		expect(await s.t.run((ctx) => ctx.db.get(localeId))).toMatchObject({
			code: "pt-BR",
			label: "Brazilian Portuguese",
		});
		expect(
			(await s.owner.query(api.managedContent.context, query)).items[0],
		).toMatchObject({ value: "Olá", valueState: "settled" });
		expect(
			await s.t.run((ctx) =>
				ctx.db
					.query("managedTargetRevisions")
					.withIndex("by_collection", (q) =>
						q.eq("collectionId", s.address.collectionId),
					)
					.take(16),
			),
		).toEqual(revisionsBefore);
		const guidance = await s.owner.query(api.translationGuidance.list, {
			projectId: s.projectId,
		});
		expect(
			await s.owner.query(api.dictionaries.detail, { dictionaryId }),
		).toEqual(dictionaryBefore);
		expect(guidance.guides).toMatchObject([
			{ localeCode: "pt-BR", text: "Keep it warm." },
		]);
		expect(
			await s.t.run((ctx) =>
				ctx.db
					.query("translationGuidanceRevisions")
					.withIndex("by_project_and_revision", (q) =>
						q.eq("projectId", s.projectId),
					)
					.take(16),
			),
		).toHaveLength(3);
	});

	test("edits the Basic source identity without replacing its source role", async () => {
		const s = await setup();
		const source = (
			await s.owner.query(api.locales.list, { projectId: s.projectId })
		).find((locale) => locale.isSource);
		if (!source) throw Error("Missing source");
		await s.owner.mutation(api.locales.updateMetadata, {
			projectId: s.projectId,
			localeId: source._id,
			expectedCode: "en",
			expectedLabel: "English",
			code: "en_gb",
			label: "British English",
		});
		expect(await s.t.run((ctx) => ctx.db.get(source._id))).toMatchObject({
			code: "en-GB",
			label: "British English",
			isSource: true,
		});
		expect(
			(await s.owner.query(api.projects.get, { projectId: s.projectId }))
				.sourceLocaleId,
		).toBe(source._id);
	});

	test("rejects stale forms, duplicate archived codes, invalid names, viewers and moving projects atomically", async () => {
		const s = await setup();
		const { localeId } = await s.owner.mutation(
			api.contentCollections.addLocale,
			{ ...s.address, code: "fr", label: "French" },
		);
		const other = await s.owner.mutation(api.locales.create, {
			projectId: s.projectId,
			code: "de",
		});
		await s.owner.mutation(api.locales.archive, { localeId: other });
		const args = {
			projectId: s.projectId,
			localeId,
			expectedCode: "fr",
			expectedLabel: "French",
			code: "fr-CA",
			label: "Canadian French",
		};
		await expect(
			s.owner.mutation(api.locales.updateMetadata, {
				...args,
				expectedLabel: "old",
			}),
		).rejects.toThrow("changed");
		await expect(
			s.owner.mutation(api.locales.updateMetadata, { ...args, code: "de" }),
		).rejects.toThrow("already in use");
		await expect(
			s.owner.mutation(api.locales.updateMetadata, {
				...args,
				label: "bad\nname",
			}),
		).rejects.toThrow("controls");
		const viewer = await authenticatedBackend(s.t, "metadata-viewer");
		await s.owner.mutation(api.projects.addMember, {
			projectId: s.projectId,
			userId: "metadata-viewer",
			role: "viewer",
		});
		await expect(
			viewer.mutation(api.locales.updateMetadata, args),
		).rejects.toThrow("permissions");
		await s.t.run((ctx) =>
			ctx.db.patch(s.projectId, { migrationPending: true }),
		);
		await expect(
			s.owner.mutation(api.locales.updateMetadata, args),
		).rejects.toThrow("moving");
		expect(await s.t.run((ctx) => ctx.db.get(localeId))).toMatchObject({
			code: "fr",
			label: "French",
		});
	});

	test("repository languages allow display names but preserve their catalog codes", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "repo-language-owner");
		const projectId = await owner.mutation(api.projects.create, {
			name: "Repo",
			slug: "repo",
			sourceLocaleCode: "en",
			sourceLocaleLabel: "English",
		});
		const localeId = (await owner.query(api.projects.get, { projectId }))
			.sourceLocaleId;
		if (!localeId) throw Error("Missing source");
		const args = {
			projectId,
			localeId,
			expectedCode: "en",
			expectedLabel: "English",
			code: "en",
			label: "Source English",
		};
		await expect(
			owner.mutation(api.locales.updateMetadata, { ...args, code: "en-GB" }),
		).rejects.toThrow("Repository language codes");
		await owner.mutation(api.locales.updateMetadata, args);
		expect(await t.run((ctx) => ctx.db.get(localeId))).toMatchObject({
			code: "en",
			label: "Source English",
		});
	});
});
