import { expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

test("browses selected language pages and searches beyond an empty scanned page", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	try {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "browse-owner");
		const projectId = await createProject(owner);
		const [source] = await owner.query(api.locales.list, { projectId });
		if (!source) throw new Error("Missing Source");
		const de = await owner.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		const ja = await owner.mutation(api.locales.create, {
			projectId,
			code: "ja",
		});
		for (const [localeId, code] of [
			[source._id, "en"],
			[de, "de"],
			[ja, "ja"],
		] as const)
			await owner.action(api.locales.bind, {
				localeId,
				catalogPath: `${code}.arb`,
			});
		const files = ["en", "de", "ja"].map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				...Object.fromEntries(
					Array.from({ length: 80 }, (_, index) => [
						`message${index}`,
						code === "ja" && index === 79
							? "見つける"
							: `${code} value ${index}`,
					]),
				),
			}),
		}));
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "first",
			files,
		});
		const overview = await owner.query(api.catalogBrowse.overview, {
			projectId,
		});
		expect(overview).toMatchObject({ kind: "ready" });
		if (overview.kind !== "ready")
			throw new Error("Expected published catalog");
		expect(overview.keyCount).toBe(80);
		const args = {
			projectId,
			projectionId: overview.projectionId,
			localeId: ja,
		};
		const first = await owner.query(api.catalogBrowse.page, args);
		expect(first.keys).toHaveLength(32);
		expect(
			first.keys.every(
				(key) =>
					key.targets.length === 1 && key.targets[0]?.localeCode === "ja",
			),
		).toBe(true);
		const second = await owner.query(api.catalogBrowse.page, {
			...args,
			after: first.nextAfter ?? -1,
		});
		expect(second.keys[0]?.messageId).toBe("message32");
		const emptySearch = await owner.query(api.catalogBrowse.page, {
			...args,
			q: "見つける",
		});
		expect(emptySearch.keys).toEqual([]);
		expect(emptySearch.nextAfter).not.toBeNull();
		const match = await owner.query(api.catalogBrowse.page, {
			...args,
			q: "見つける",
			after: emptySearch.nextAfter ?? -1,
		});
		expect(match.keys.map((key) => key.messageId)).toEqual(["message79"]);
		const cards = await owner.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: overview.projectionId,
			messageIds: ["message79"],
			localeIds: [ja],
		});
		expect(cards[0]?.values.map((value) => value.localeCode)).toEqual([
			"en",
			"ja",
		]);
		const sourceSearch = await owner.query(api.catalogBrowse.page, {
			projectId,
			projectionId: overview.projectionId,
			q: "en value 79",
		});
		expect(sourceSearch.keys).toEqual([]);
		const sourceMatch = await owner.query(api.catalogBrowse.page, {
			projectId,
			projectionId: overview.projectionId,
			q: "en value 79",
			after: sourceSearch.nextAfter ?? -1,
		});
		expect(sourceMatch.keys.map((key) => key.messageId)).toEqual(["message79"]);
		expect(sourceMatch.keys[0]?.targets).toEqual([]);
		const unbound = await owner.mutation(api.locales.create, {
			projectId,
			code: "it",
		});
		await expect(
			owner.query(api.catalogBrowse.page, { ...args, localeId: unbound }),
		).rejects.toThrow("active target language");
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: overview.projectionId,
				messageIds: ["message79"],
				localeIds: [unbound],
			}),
		).rejects.toThrow("active bound target languages");
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: overview.projectionId,
				messageIds: ["message79"],
				localeIds: [source._id],
			}),
		).rejects.toThrow("active bound target languages");
		const permalink = await owner.query(api.catalogBrowse.page, {
			...args,
			focusKey: "message70",
		});
		expect(permalink.keys[0]?.messageId).toBe("message70");
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "second",
			files,
			lineage: {
				baselineCommit: "first",
				relationship: "descendant",
				mergeBase: "first",
			},
		});
		expect(await owner.query(api.catalogBrowse.page, args)).toMatchObject({
			stale: true,
			keys: [],
		});
	} finally {
		vi.useRealTimers();
	}
});
