import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createLegacyCollection,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import { commitManagedTarget } from "./managedContent";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "managed-owner");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "pt-BR",
	});
	const collectionId = await createLegacyCollection(t, {
		projectId,
		name: "Store copy",
		localeIds: [localeId],
	});
	const address = { projectId, collectionId };
	const messageId = await owner.mutation(api.managedContent.createMessage, {
		...address,
		key: "title",
		sourceValue: "Build {anything}\nIt's yours",
		context: "Store screenshot headline",
	});
	const target = { ...address, messageId, localeId };
	async function current() {
		const result = await owner.query(api.managedContent.context, {
			...address,
			messageIds: [messageId],
			localeIds: [localeId],
		});
		const item = result.items[0];
		if (!item) throw new Error("Missing target");
		return item;
	}
	return {
		t,
		owner,
		projectId,
		localeId,
		collectionId,
		address,
		target,
		current,
	};
}

describe("managed content", () => {
	test("creates a source and its initial translations as one human save", async () => {
		const s = await setup();
		const french = await s.owner.mutation(api.locales.create, {
			projectId: s.projectId,
			code: "fr",
		});
		await s.owner.mutation(api.contentCollections.setLocales, {
			...s.address,
			localeIds: [s.localeId, french],
			expectedMembershipRevision: 1,
		});
		const messageId = await s.owner.mutation(api.managedContent.createMessage, {
			...s.address,
			sourceValue: "Hello {there}",
			translations: [
				{ localeId: s.localeId, value: "Olá {aí}" },
				{ localeId: french, value: "Bonjour" },
			],
		});
		const current = await s.owner.query(api.managedContent.context, {
			...s.address,
			messageIds: [messageId],
			localeIds: [s.localeId, french],
		});
		expect(current.items.map((item) => item.value)).toEqual([
			"Olá {aí}",
			"Bonjour",
		]);
		for (const item of current.items) {
			expect(item.valueState).toBe("settled");
			expect(item.basis).toMatchObject({
				sourceRevision: 1,
				targetRevision: 1,
				membershipRevision: 2,
			});
		}
		const revisions = await s.t.run(async (ctx) =>
			ctx.db
				.query("managedTargetRevisions")
				.withIndex("by_collection", (q) => q.eq("collectionId", s.collectionId))
				.collect(),
		);
		expect(revisions).toHaveLength(2);
		expect(revisions.every((revision) => revision.actor.kind === "user")).toBe(
			true,
		);
	});

	test("rejects an invalid initial translation without creating a partial string", async () => {
		const s = await setup();
		const disabled = await s.owner.mutation(api.locales.create, {
			projectId: s.projectId,
			code: "fr",
		});
		await expect(
			s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key: "atomic",
				sourceValue: "Hello",
				translations: [
					{ localeId: s.localeId, value: "Olá" },
					{ localeId: disabled, value: "Bonjour" },
				],
			}),
		).rejects.toThrow("not enabled");
		await expect(
			s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key: "atomic",
				sourceValue: "Hello",
				translations: [
					{ localeId: s.localeId, value: "Olá" },
					{ localeId: s.localeId, value: "Again" },
				],
			}),
		).rejects.toThrow("once");
		const page = await s.owner.query(api.managedContent.page, {
			...s.address,
			focusKey: "atomic",
		});
		expect(page.items).toEqual([]);
	});

	test("browses creation order independently of keys or renames and never repeats name matches", async () => {
		const s = await setup();
		for (const key of ["zeta", "alpha", "middle"])
			await s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key,
				name: "Shared name",
				sourceValue: "Ordinary",
			});
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: "zeta",
			sourceValue: "Ordinary",
			name: "Shared name renamed",
			expectedSourceRevision: 1,
		});
		expect(
			(await s.owner.query(api.managedContent.page, s.address)).items.map(
				(item) => item.key,
			),
		).toEqual(["title", "zeta", "alpha", "middle"]);
		const oldPageLink = await s.owner.query(api.managedContent.page, {
			...s.address,
			limit: 1,
			cursor: JSON.stringify({
				collectionId: s.address.collectionId,
				q: "",
				key: "middle",
			}),
		});
		expect(oldPageLink.items.map((item) => item.key)).toEqual(["title"]);
		expect(JSON.parse(oldPageLink.nextCursor ?? "null").version).toBe(2);
		const keys: string[] = [];
		let cursor: string | undefined;
		let requests = 0;
		do {
			const page = await s.owner.query(api.managedContent.page, {
				...s.address,
				q: "Shared name",
				limit: 1,
				cursor,
			});
			keys.push(...page.items.map((item) => item.key));
			cursor = page.nextCursor ?? undefined;
			expect(++requests).toBeLessThan(10);
		} while (cursor);
		expect(keys).toEqual(["zeta", "alpha", "middle"]);
	});

	test("creates optional duplicate names independently from generated stable keys", async () => {
		const s = await setup();
		const ids = [];
		for (const name of [
			"  Café — 東京  ",
			"Café — 東京",
			null,
			"   ",
			undefined,
		])
			ids.push(
				await s.owner.mutation(api.managedContent.createMessage, {
					...s.address,
					name,
					sourceValue: "Source",
				}),
			);
		expect(new Set(ids).size).toBe(5);
		const page = await s.owner.query(api.managedContent.page, { ...s.address });
		expect(
			ids.map((id) => page.items.find((item) => item.messageId === id)?.name),
		).toEqual(["Café — 東京", "Café — 東京", null, null, null]);
		expect(page.items.find((item) => item.messageId === "title")?.name).toBe(
			"title",
		);
		for (const name of ["bad\u007fname", "bad\nname", "x".repeat(257)])
			await expect(
				s.owner.mutation(api.managedContent.createMessage, {
					...s.address,
					name,
					sourceValue: "Source",
				}),
			).rejects.toThrow();
		expect(
			(
				await s.owner.query(api.managedContent.page, {
					...s.address,
					q: "東京",
				})
			).items,
		).toHaveLength(2);
	});
	test("renames preserve identity and settled translations while retaining name history", async () => {
		const s = await setup();
		const initial = await s.current();
		await s.owner.mutation(api.managedContent.commit, {
			...s.target,
			basis: initial.basis,
			intent: { kind: "save", value: "Tradução" },
		});
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: s.target.messageId,
			sourceValue: initial.sourceValue,
			name: "Welcome headline",
			expectedSourceRevision: 1,
		});
		const renamed = await s.current();
		expect(renamed.name).toBe("Welcome headline");
		expect(renamed.messageId).toBe(s.target.messageId);
		expect(renamed.basis.sourceFingerprint).toBe(
			initial.basis.sourceFingerprint,
		);
		expect(renamed.valueState).toBe("settled");
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: s.target.messageId,
			sourceValue: initial.sourceValue,
			expectedSourceRevision: 2,
		});
		expect((await s.current()).name).toBe("Welcome headline");
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: s.target.messageId,
			sourceValue: initial.sourceValue,
			name: " ",
			expectedSourceRevision: 3,
		});
		expect((await s.current()).name).toBeNull();
		const history = await s.t.run((ctx) =>
			ctx.db
				.query("managedSourceRevisions")
				.withIndex("by_message", (q) =>
					q
						.eq("collectionId", s.collectionId)
						.eq("messageId", s.target.messageId),
				)
				.collect(),
		);
		expect(history.map((revision) => revision.name)).toEqual([
			"title",
			"Welcome headline",
			"Welcome headline",
			null,
		]);
		const exported = await s.owner.query(api.managedContent.exportSelection, {
			...s.address,
			messageIds: [s.target.messageId],
			localeIds: [s.localeId],
			mode: "reviewed",
		});
		expect(JSON.parse(exported.text)).toMatchObject({
			names: { title: null },
			values: { title: { "pt-BR": "Tradução" } },
		});
	});

	test("authors and exports literal plain text without a Snapshot", async () => {
		const s = await setup();
		expect((await s.current()).valueState).toBe("waiting");
		const value = "Crie {qualquer coisa}\nÉ seu";
		await s.owner.mutation(api.managedContent.commit, {
			...s.target,
			basis: (await s.current()).basis,
			intent: { kind: "save", value },
		});
		const current = await s.current();
		expect(current.value).toBe(value);
		expect(current.valueState).toBe("settled");
		const download = await s.owner.query(api.managedContent.exportSelection, {
			...s.address,
			messageIds: ["title"],
			localeIds: [s.localeId],
			mode: "reviewed",
		});
		expect(JSON.parse(download.text).values.title["pt-BR"]).toBe(value);
		expect(
			await s.t.run((ctx) => ctx.db.query("sourceSnapshots").collect()),
		).toEqual([]);
	});
	test("source edits invalidate stale saves; context edits preserve currency and notes", async () => {
		const s = await setup();
		await s.owner.mutation(api.managedContent.commit, {
			...s.target,
			basis: (await s.current()).basis,
			intent: { kind: "save", value: "Construa" },
		});
		const old = await s.current();
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: "title",
			sourceValue: old.sourceValue,
			context: "New placement",
			expectedSourceRevision: old.basis.sourceRevision,
		});
		expect((await s.current()).valueState).toBe("settled");
		const before = await s.current();
		await s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			messageId: "title",
			sourceValue: "Explore",
			expectedSourceRevision: before.basis.sourceRevision,
		});
		expect((await s.current()).context).toBe("New placement");
		expect((await s.current()).valueState).toBe("stale");
		await expect(
			s.owner.mutation(api.managedContent.commit, {
				...s.target,
				basis: before.basis,
				intent: { kind: "confirm" },
			}),
		).rejects.toThrow("changed");
		await expect(
			s.owner.query(api.managedContent.exportSelection, {
				...s.address,
				messageIds: ["title"],
				localeIds: [s.localeId],
				mode: "reviewed",
			}),
		).rejects.toThrow("missing or stale");
		const partial = await s.owner.query(api.managedContent.exportSelection, {
			...s.address,
			messageIds: ["title"],
			localeIds: [s.localeId],
			mode: "partial",
		});
		expect(partial.omitted).toHaveLength(1);
		await s.owner.mutation(api.managedContent.commit, {
			...s.target,
			basis: (await s.current()).basis,
			intent: { kind: "confirm" },
		});
		expect((await s.current()).valueState).toBe("settled");
	});
	test("collection key namespaces isolate edits and membership changes reject old saves", async () => {
		const s = await setup();
		const second = await createLegacyCollection(s.t, {
			projectId: s.projectId,
			name: "Other",
			localeIds: [s.localeId],
		});
		await s.owner.mutation(api.managedContent.createMessage, {
			projectId: s.projectId,
			collectionId: second,
			key: "title",
			sourceValue: "Other title",
		});
		const old = await s.current();
		await s.owner.mutation(api.contentCollections.setLocales, {
			...s.address,
			localeIds: [],
			expectedMembershipRevision: 1,
		});
		await expect(s.current()).rejects.toThrow("not enabled");
		await s.owner.mutation(api.contentCollections.setLocales, {
			...s.address,
			localeIds: [s.localeId],
			expectedMembershipRevision: 2,
		});
		await expect(
			s.owner.mutation(api.managedContent.commit, {
				...s.target,
				basis: old.basis,
				intent: { kind: "save", value: "Old" },
			}),
		).rejects.toThrow("changed");
		const result = await s.owner.query(api.managedContent.context, {
			projectId: s.projectId,
			collectionId: second,
			messageIds: ["title"],
			localeIds: [s.localeId],
		});
		expect(result.items[0]?.sourceValue).toBe("Other title");
		expect(result.items[0]?.valueState).toBe("waiting");
	});
	test("archive preserves evidence and refuses key reuse and pending application", async () => {
		const s = await setup();
		const old = await s.current();
		await s.owner.mutation(api.managedContent.archiveMessage, {
			...s.address,
			messageId: "title",
			expectedSourceRevision: old.basis.sourceRevision,
		});
		await expect(
			s.owner.mutation(api.managedContent.commit, {
				...s.target,
				basis: old.basis,
				intent: { kind: "save", value: "Archived" },
			}),
		).rejects.toThrow("not active");
		await expect(
			s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key: "title",
				sourceValue: "Replacement",
			}),
		).rejects.toThrow("archived history");
		expect(
			await s.t.run((ctx) => ctx.db.query("managedSourceRevisions").collect()),
		).toHaveLength(2);
	});
	test("only a human or authorized reviewer can confirm, and blank reasons persist", async () => {
		const s = await setup();
		const basis = (await s.current()).basis;
		await expect(
			s.t.run((ctx) =>
				commitManagedTarget(ctx, {
					...s.target,
					basis,
					intent: { kind: "save", value: "Agent" },
					actor: { kind: "agent", id: "translator" },
				}),
			),
		).rejects.toThrow("authorized independent");
		await expect(
			s.owner.mutation(api.managedContent.commit, {
				...s.target,
				basis,
				intent: { kind: "save", value: "" },
			}),
		).rejects.toThrow("blank reason");
		await s.owner.mutation(api.managedContent.commit, {
			...s.target,
			basis,
			intent: { kind: "intentionalBlank", reason: "No text in this placement" },
		});
		expect((await s.current()).intentionalBlank).toBe(
			"No text in this placement",
		);
		expect((await s.current()).valueState).toBe("settled");
		const stranger = await authenticatedBackend(s.t, "stranger");
		await expect(
			stranger.query(api.managedContent.page, s.address),
		).rejects.toThrow();
	});
	test("source browse continues across empty search pages", async () => {
		const s = await setup();
		for (let i = 0; i < 18; i++)
			await s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key: `a${String(i).padStart(2, "0")}`,
				sourceValue: "Ordinary",
			});
		await s.owner.mutation(api.managedContent.createMessage, {
			...s.address,
			key: "late",
			name: "Late named match",
			sourceValue: "Ordinary",
		});
		const first = await s.owner.query(api.managedContent.page, {
			...s.address,
			q: "Late named match",
		});
		expect(first.items).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		const next = await s.owner.query(api.managedContent.page, {
			...s.address,
			q: "Late named match",
			cursor: first.nextCursor ?? undefined,
		});
		expect(next.items.map((item) => item.key)).toEqual(["late"]);
		expect(next.nextCursor).toBeNull();
		const focused = await s.owner.query(api.managedContent.page, {
			...s.address,
			focusKey: "title",
		});
		expect(focused.items.map((item) => item.key)).toEqual(["title"]);
		expect(focused.nextCursor).toBeNull();
		await expect(
			s.owner.query(api.managedContent.page, {
				...s.address,
				q: "different",
				cursor: first.nextCursor ?? undefined,
			}),
		).rejects.toThrow("cursor");
	});
	test("context rejects oversized batches before transaction limits", async () => {
		const s = await setup();
		const long = "x".repeat(256 * 1024);
		for (let i = 0; i < 5; i++)
			await s.owner.mutation(api.managedContent.createMessage, {
				...s.address,
				key: `large${i}`,
				sourceValue: long,
			});
		await expect(
			s.owner.query(api.managedContent.context, {
				...s.address,
				messageIds: ["large0", "large1", "large2", "large3", "large4"],
				localeIds: [s.localeId],
			}),
		).rejects.toThrow("fewer pairs");
		await expect(
			s.owner.query(api.managedContent.page, s.address),
		).rejects.toThrow("Request fewer strings");
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await s.owner.query(api.managedContent.page, {
				...s.address,
				limit: 2,
				cursor,
			});
			keys.push(...page.items.map((item) => item.key));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(keys).toEqual([
			"title",
			"large0",
			"large1",
			"large2",
			"large3",
			"large4",
		]);
	});
	test("an oversized encoded source never becomes false end-of-results", async () => {
		const s = await setup();
		await s.owner.mutation(api.managedContent.createMessage, {
			...s.address,
			key: "a_large",
			sourceValue: String.fromCharCode(1).repeat(192 * 1024),
		});
		await expect(
			s.owner.query(api.managedContent.page, s.address),
		).rejects.toThrow("encoded browse limit");
		await expect(
			s.owner.query(api.managedContent.page, {
				...s.address,
				focusKey: "a_large",
			}),
		).rejects.toThrow("encoded browse limit");
	});
});
