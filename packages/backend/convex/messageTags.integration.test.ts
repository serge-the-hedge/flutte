import { describe, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "tag-owner");
	const projectId = await owner.mutation(api.projects.create, {
		name: "Marketing",
		type: "basic",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
	const project = await owner.query(api.projects.get, { projectId });
	if (!project.managedCollectionId) throw Error("Missing content");
	const address = { projectId, collectionId: project.managedCollectionId };
	const { localeId } = await owner.mutation(api.contentCollections.addLocale, {
		...address,
		code: "fr",
	});
	const messageId = await owner.mutation(api.managedContent.createMessage, {
		...address,
		sourceValue: "Build something",
		translations: [{ localeId, value: "Construisez" }],
	});
	const createTag = (name: string) =>
		owner.mutation(api.messageTags.create, { projectId, name });
	return { t, owner, projectId, address, localeId, messageId, createTag };
}

describe("current message tags", () => {
	test("overlapping assignments preserve reviewed content, names, and optimistic concurrency", async () => {
		const s = await setup();
		const app = await s.createTag("App Store");
		const play = await s.createTag("Google Play");
		expect(await s.createTag(" app store ")).toBe(app);
		const input = {
			...s.address,
			messageIds: [s.messageId],
			localeIds: [s.localeId],
		};
		const before = await s.owner.query(api.managedContent.context, input);
		await s.owner.mutation(api.messageTags.setTags, {
			...s.address,
			messageId: s.messageId,
			expectedTagIds: [],
			tagIds: [app, play],
		});
		expect(await s.owner.query(api.managedContent.context, input)).toEqual(
			before,
		);
		await expect(
			s.owner.mutation(api.messageTags.setTags, {
				...s.address,
				messageId: s.messageId,
				expectedTagIds: [],
				tagIds: [app],
			}),
		).rejects.toThrow("Tags changed");
		await s.owner.mutation(api.messageTags.rename, {
			projectId: s.projectId,
			tagId: app,
			expectedName: "App Store",
			name: "Apple store",
		});
		expect(
			await s.owner.query(api.messageTags.forMessages, {
				...s.address,
				messageIds: [s.messageId, "unknown"],
			}),
		).toEqual([
			{ messageId: s.messageId, tagIds: [app, play].sort() },
			{ messageId: "unknown", tagIds: [] },
		]);
		const list = await s.owner.query(api.messageTags.list, {
			projectId: s.projectId,
		});
		await s.owner.mutation(api.messageTags.updateMany, {
			...s.address,
			messageIds: [s.messageId],
			removeTagIds: [play],
		});
		await expect(
			s.owner.query(api.managedContent.exportSelection, {
				...input,
				mode: "reviewed",
				expectedTagRevision: list.revision,
			}),
		).rejects.toThrow("Tags changed");
		const exported = await s.owner.query(api.managedContent.exportSelection, {
			...input,
			mode: "reviewed",
		});
		expect(exported.document.values).toEqual([
			{
				messageId: s.messageId,
				values: [{ localeCode: "fr", value: "Construisez" }],
			},
		]);
		expect(JSON.parse(exported.text).values[s.messageId].fr).toBe(
			"Construisez",
		);
	});

	test("filters OR tags before hydration, walks empty pages, and rejects changed membership", async () => {
		const s = await setup();
		const app = await s.createTag("App Store");
		const play = await s.createTag("Google Play");
		const keys = [s.messageId];
		for (let index = 0; index < 35; index++)
			keys.push(
				await s.owner.mutation(api.managedContent.createMessage, {
					...s.address,
					sourceValue: `Line ${index}`,
				}),
			);
		const last = keys[keys.length - 1];
		if (!last) throw Error("Missing last key");
		await s.owner.mutation(api.messageTags.updateMany, {
			...s.address,
			messageIds: [last],
			addTagIds: [app, play],
		});
		const first = await s.owner.query(api.managedContent.page, {
			...s.address,
			tagIds: [app, play],
		});
		expect(first.items).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		const found: string[] = [];
		let cursor = first.nextCursor;
		while (cursor) {
			const page = await s.owner.query(api.managedContent.page, {
				...s.address,
				tagIds: [play, app],
				cursor,
				expectedTagRevision: first.tagRevision,
			});
			found.push(...page.items.map((item) => item.messageId));
			cursor = page.nextCursor;
		}
		expect(found).toEqual([last]);
		await s.owner.mutation(api.messageTags.updateMany, {
			...s.address,
			messageIds: [s.messageId],
			addTagIds: [app],
		});
		await expect(
			s.owner.query(api.managedContent.page, {
				...s.address,
				tagIds: [app, play],
				cursor: first.nextCursor ?? undefined,
				expectedTagRevision: first.tagRevision,
			}),
		).rejects.toThrow("Tags changed");
		await expect(
			s.owner.query(api.managedContent.page, {
				...s.address,
				tagIds: [app, play],
				cursor: first.nextCursor ?? undefined,
			}),
		).rejects.toMatchObject({ data: { code: "STALE_BASIS" } });
	});

	test("rejects unauthorized and foreign-project writes and retains archived message assignments", async () => {
		const s = await setup();
		const app = await s.createTag("App Store");
		await expect(
			s.t.query(api.messageTags.list, { projectId: s.projectId }),
		).rejects.toThrow();
		const otherProject = await createProject(s.owner, { slug: "other" });
		const foreign = await s.owner.mutation(api.messageTags.create, {
			projectId: otherProject,
			name: "Foreign",
		});
		await expect(
			s.owner.mutation(api.messageTags.updateMany, {
				...s.address,
				messageIds: [s.messageId],
				addTagIds: [foreign],
			}),
		).rejects.toThrow("Tag not found");
		await s.owner.mutation(api.messageTags.updateMany, {
			...s.address,
			messageIds: [s.messageId],
			addTagIds: [app],
		});
		const current = await s.owner.query(api.managedContent.context, {
			...s.address,
			messageIds: [s.messageId],
			localeIds: [s.localeId],
		});
		const target = current.items[0];
		if (!target) throw Error("Missing target");
		await s.owner.mutation(api.managedContent.archiveMessage, {
			...s.address,
			messageId: s.messageId,
			expectedSourceRevision: target.basis.sourceRevision,
		});
		await expect(
			s.owner.mutation(api.messageTags.updateMany, {
				...s.address,
				messageIds: [s.messageId],
				removeTagIds: [app],
			}),
		).rejects.toThrow("String not found");
		expect(
			(
				await s.owner.query(api.managedContent.page, {
					...s.address,
					tagIds: [app],
				})
			).items,
		).toEqual([]);
	});

	test("HTTP discovery and assignment require deliberate scope and leave retired writes retired", async () => {
		const s = await setup();
		const writer = await s.owner.mutation(api.apiTokens.create, {
			projectId: s.projectId,
			name: "Organizer",
			scopes: ["read", "search", "tags-write"],
		});
		const reader = await s.owner.mutation(api.apiTokens.create, {
			projectId: s.projectId,
			name: "Reader",
			scopes: ["read", "search"],
		});
		const request = (
			token: string,
			path: string,
			method = "GET",
			body?: unknown,
		) =>
			s.t.fetch(`/api/agent/v1${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		expect(
			(await request(reader.token, "/tags", "POST", { name: "App Store" }))
				.status,
		).toBe(401);
		await expect(
			s.owner.mutation(api.apiTokens.create, {
				projectId: s.projectId,
				name: "Unsafe reviewer",
				scopes: ["read", "review", "tags-write"],
			}),
		).rejects.toThrow("reviewer token");
		const created = await request(writer.token, "/tags", "POST", {
			name: "App Store",
		});
		expect(created.status).toBe(200);
		const tagId = (await created.json()) as Id<"tags">;
		expect(
			(
				await request(writer.token, "/workspace/tags", "PATCH", {
					keys: [s.messageId],
					addTagIds: [tagId],
				})
			).status,
		).toBe(200);
		expect(
			await (
				await request(
					reader.token,
					`/workspace/tags?key=${s.messageId}&key=unknown`,
				)
			).json(),
		).toEqual([
			{ messageId: s.messageId, tagIds: [tagId] },
			{ messageId: "unknown", tagIds: [] },
		]);
		const search = await request(
			reader.token,
			`/workspace/search?tagId=${tagId}`,
		);
		expect(search.status).toBe(200);
		expect(await search.json()).toMatchObject({
			items: [{ messageId: s.messageId, tagIds: [tagId] }],
		});
		expect(
			(await request(writer.token, "/strings/tags", "POST", {})).status,
		).toBe(410);
		expect(await (await request(reader.token, "/tags")).json()).toMatchObject({
			items: [{ id: tagId, name: "App Store" }],
		});
	});

	test("repository tags survive a new projection and restrict Focus counts", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		try {
			const t = createBackend({ transactionLimits: true });
			const owner = await authenticatedBackend(t, "repository-tag-owner");
			const projectId = await createProject(owner);
			const [source] = await owner.query(api.locales.list, { projectId });
			if (!source) throw Error("Missing source");
			const fr = await owner.mutation(api.locales.create, {
				projectId,
				code: "fr",
			});
			for (const [localeId, code] of [
				[source._id, "en"],
				[fr, "fr"],
			] as const)
				await owner.action(api.locales.bind, {
					localeId,
					catalogPath: `${code}.arb`,
				});
			const files = ["en", "fr"].map((code) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({
					"@@locale": code,
					one: `${code} one`,
					two: `${code} two`,
				}),
			}));
			await owner.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: "first",
				files,
			});
			const tagId = await owner.mutation(api.messageTags.create, {
				projectId,
				name: "Store",
			});
			await owner.mutation(api.messageTags.updateMany, {
				projectId,
				messageIds: ["two"],
				addTagIds: [tagId],
			});
			await owner.action(api.snapshots.ingest, {
				projectId,
				repository: "repo",
				commit: "second",
				lineage: {
					baselineCommit: "first",
					relationship: "descendant",
					mergeBase: "first",
				},
				files,
			});
			const overview = await owner.query(api.catalogBrowse.overview, {
				projectId,
			});
			if (overview.kind !== "ready") throw Error("Expected catalog");
			const args = {
				projectId,
				projectionId: overview.projectionId,
				tagIds: [tagId],
			};
			expect(
				(await owner.query(api.catalogBrowse.page, args)).keys.map(
					(key) => key.messageId,
				),
			).toEqual(["two"]);
			const counts = await owner.query(api.catalogBrowse.scopeCounts, {
				...args,
				localeIds: [fr],
				revision: overview.revision,
			});
			expect(counts.counts.unconfirmedImport).toBe(1);
			const metadata = await owner.query(api.messageTags.list, { projectId });
			const staleCounts = await owner.query(api.catalogBrowse.scopeCounts, {
				...args,
				localeIds: [fr],
				revision: overview.revision,
				expectedTagRevision: metadata.revision - 1,
			});
			expect(staleCounts).toEqual({
				stale: true,
				cursor: null,
				counts: {
					waiting: 0,
					unconfirmedImport: 0,
					stale: 0,
					settled: 0,
					introduced: 0,
				},
			});
			await expect(
				owner.query(api.catalogBrowse.page, {
					...args,
					expectedTagRevision: metadata.revision - 1,
				}),
			).rejects.toThrow("Tags changed");
			const token = await owner.mutation(api.apiTokens.create, {
				projectId,
				name: "Reader",
				scopes: ["read", "search"],
			});
			const response = await t.fetch(
				`/api/agent/v1/workspace/search?tagId=${tagId}`,
				{ headers: { Authorization: `Bearer ${token.token}` } },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				results: [{ messageId: "two", tagIds: [tagId] }],
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
