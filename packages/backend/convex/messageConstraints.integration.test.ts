import { afterEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createLegacyCollection,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import { characterCount } from "./characterLimits";

afterEach(() => vi.useRealTimers());
async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "limit-owner");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	const collectionId = await createLegacyCollection(t, {
		projectId,
		name: "Marketing",
		localeIds: [localeId],
	});
	const messageId = await owner.mutation(api.managedContent.createMessage, {
		projectId,
		collectionId,
		sourceValue: "Hello",
	});
	const address = { projectId, collectionId, messageId };
	const page = () =>
		owner.query(api.managedContent.page, { projectId, collectionId });
	return { t, owner, address, localeId, page };
}
test("limits persist independently of source edits, can be cleared, and detect concurrent edits", async () => {
	const s = await setup();
	await s.owner.mutation(api.messageConstraints.setCharacterLimit, {
		...s.address,
		characterLimit: 4,
		expectedCharacterLimit: null,
	});
	let source = (await s.page()).items[0];
	expect(source).toMatchObject({
		sourceValue: "Hello",
		characterLimit: 4,
		sourceRevision: 1,
	});
	await expect(
		s.owner.mutation(api.managedContent.saveSource, {
			...s.address,
			sourceValue: "Hello!",
			expectedSourceRevision: 1,
		}),
	).rejects.toThrow("Remove at least 2 characters");
	await s.owner.mutation(api.managedContent.saveSource, {
		...s.address,
		sourceValue: "Hey",
		expectedSourceRevision: 1,
	});
	source = (await s.page()).items[0];
	expect(source).toMatchObject({
		sourceValue: "Hey",
		characterLimit: 4,
		sourceRevision: 2,
	});
	await expect(
		s.owner.mutation(api.messageConstraints.setCharacterLimit, {
			...s.address,
			characterLimit: 8,
			expectedCharacterLimit: null,
		}),
	).rejects.toThrow("changed");
	await s.owner.mutation(api.managedContent.saveSource, {
		...s.address,
		sourceValue: "Hey",
		expectedSourceRevision: 2,
		characterLimit: null,
		expectedCharacterLimit: 4,
	});
	expect((await s.page()).items[0]).toMatchObject({ sourceRevision: 2 });
	expect((await s.page()).items[0]?.characterLimit).toBeUndefined();
});
test("validates limits, requires editor access, and scopes metadata to a collection", async () => {
	const s = await setup();
	for (const characterLimit of [
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		Number.POSITIVE_INFINITY,
	]) {
		await expect(
			s.owner.mutation(api.messageConstraints.setCharacterLimit, {
				...s.address,
				characterLimit,
				expectedCharacterLimit: null,
			}),
		).rejects.toThrow("positive whole number");
	}
	const outsider = await authenticatedBackend(s.t, "outsider");
	await s.t.run(async (ctx) => {
		await ctx.db.insert("projectMembers", {
			projectId: s.address.projectId,
			userId: "outsider",
			role: "viewer",
			createdAt: Date.now(),
		});
	});
	await expect(
		outsider.mutation(api.messageConstraints.setCharacterLimit, {
			...s.address,
			characterLimit: 4,
			expectedCharacterLimit: null,
		}),
	).rejects.toThrow("permissions");
	await expect(
		s.owner.mutation(api.messageConstraints.setCharacterLimit, {
			projectId: s.address.projectId,
			messageId: s.address.messageId,
			characterLimit: 4,
			expectedCharacterLimit: null,
		}),
	).rejects.toThrow("not found");
});
test("new strings and translations enforce code point limits atomically", async () => {
	const s = await setup();
	expect(characterCount("😀 é\n")).toBe(4);
	const input = {
		projectId: s.address.projectId,
		collectionId: s.address.collectionId,
		sourceValue: "😀😀",
		characterLimit: 2,
		translations: [{ localeId: s.localeId, value: "oui" }],
	};
	await expect(
		s.owner.mutation(api.managedContent.createMessage, input),
	).rejects.toThrow("Remove at least 1 character");
	expect((await s.page()).items).toHaveLength(1);
	const messageId = await s.owner.mutation(api.managedContent.createMessage, {
		...input,
		translations: [{ localeId: s.localeId, value: "😀😀" }],
	});
	const context = await s.owner.query(api.managedContent.context, {
		projectId: s.address.projectId,
		collectionId: s.address.collectionId,
		messageIds: [messageId],
		localeIds: [s.localeId],
	});
	const target = context.items[0];
	if (!target) throw new Error("Missing target");
	expect(target.characterLimit).toBe(2);
	await expect(
		s.owner.mutation(api.managedContent.commit, {
			...s.address,
			messageId,
			localeId: s.localeId,
			basis: target.basis,
			intent: { kind: "save", value: "long" },
		}),
	).rejects.toThrow("Remove at least 2 characters");
});
test("repository limits survive later snapshots and appear on current key cards", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "repo-owner");
	const projectId = await createProject(owner);
	const locales = await owner.query(api.locales.list, { projectId });
	const sourceLocale = locales[0];
	if (!sourceLocale) throw new Error("Missing source locale");
	await owner.action(api.locales.bind, {
		localeId: sourceLocale._id,
		catalogPath: "en.arb",
	});
	const ingest = (commit: string, value: string, parentCommit?: string) =>
		owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			lineage: parentCommit
				? {
						relationship: "descendant",
						baselineCommit: parentCommit,
						mergeBase: parentCommit,
					}
				: undefined,
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({ "@@locale": "en", title: value }),
				},
			],
		});
	await ingest("first", "Hello");
	await owner.mutation(api.messageConstraints.setCharacterLimit, {
		projectId,
		messageId: "title",
		characterLimit: 4,
		expectedCharacterLimit: null,
	});
	await ingest("second", "Hello from Git", "first");
	const overview = await owner.query(api.catalogBrowse.overview, { projectId });
	if (overview.kind !== "ready") throw new Error("Expected catalog");
	const cards = await owner.query(api.catalogWorkspaceNavigation.window, {
		projectId,
		expectedProjectionId: overview.projectionId,
		messageIds: ["title"],
	});
	expect(cards[0]).toMatchObject({ id: "title", characterLimit: 4 });
	await t.finishAllScheduledFunctions(() => vi.runAllTimers());
});
