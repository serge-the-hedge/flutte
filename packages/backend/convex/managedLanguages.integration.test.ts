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
		});
		expect(restored.localeId).toBe(added.localeId);
		expect(
			(await s.owner.query(api.managedContent.context, input)).items[0],
		).toMatchObject({ value: "Bonjour", valueState: "settled" });
		expect(
			await s.t.run((ctx) => ctx.db.query("managedTargetRevisions").collect()),
		).toHaveLength(1);
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
