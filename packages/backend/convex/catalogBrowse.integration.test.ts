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
			localeIds: [],
		});
		expect(sourceSearch.keys).toEqual([]);
		const sourceMatch = await owner.query(api.catalogBrowse.page, {
			projectId,
			projectionId: overview.projectionId,
			q: "en value 79",
			localeIds: [],
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

test("searches any selected language and resumes a large key without dropping or repeating it", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	try {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "multi-browse");
		const projectId = await createProject(owner);
		const [source] = await owner.query(api.locales.list, { projectId });
		if (!source) throw new Error("Missing Source");
		const codes = [
			"de",
			"es",
			"fr",
			"it",
			"ja",
			"ko",
			"nl",
			"pl",
			"pt",
			"ru",
			"sv",
			"zh",
		];
		const bindings = [{ localeId: source._id, code: "en" }];
		for (const code of codes)
			bindings.push({
				localeId: await owner.mutation(api.locales.create, { projectId, code }),
				code,
			});
		for (const { localeId, code } of bindings)
			await owner.action(api.locales.bind, {
				localeId,
				catalogPath: `${code}.arb`,
			});
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "all",
			files: bindings.map(({ code }) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({
					"@@locale": code,
					z_first:
						code === "en"
							? "Source"
							: code === "zh"
								? "needle"
								: `${code} ${"x".repeat(100_000)}`,
					a_second: code === "zh" ? "needle too" : `${code} other`,
				}),
			})),
		});
		const overview = await owner.query(api.catalogBrowse.overview, {
			projectId,
		});
		if (overview.kind !== "ready") throw new Error("Missing catalog");
		const base = { projectId, projectionId: overview.projectionId };
		const all = await owner.query(api.catalogBrowse.page, base);
		expect(all.keys.map((key) => key.messageId)).toEqual([
			"z_first",
			"a_second",
		]);
		expect(all.keys.every((key) => key.targets.length === codes.length)).toBe(
			true,
		);
		expect(
			Object.values(all.counts).reduce((sum, count) => sum + count, 0),
		).toBe(24);
		const selected = bindings
			.filter((binding) => binding.code === "de" || binding.code === "zh")
			.map((binding) => binding.localeId);
		const subset = await owner.query(api.catalogBrowse.page, {
			...base,
			localeIds: selected,
			q: "needle",
			scope: "unconfirmedImport",
		});
		expect(subset.keys.map((key) => key.messageId)).toEqual([
			"z_first",
			"a_second",
		]);
		expect(
			subset.keys.every(
				(key) =>
					key.targets.map((target) => target.localeCode).join(",") === "de,zh",
			),
		).toBe(true);
		const german = bindings.find((binding) => binding.code === "de");
		if (!german) throw new Error("Missing German");
		expect(
			(
				await owner.query(api.catalogBrowse.page, {
					...base,
					localeIds: [german.localeId],
					q: "needle",
				})
			).keys,
		).toEqual([]);
		let result = await owner.query(api.catalogBrowse.page, {
			...base,
			q: "needle",
		});
		expect(result.keys).toEqual([]);
		expect(result.nextAfter).toBe(-1);
		expect(result.nextTargetIndex).toBeGreaterThan(0);
		const found: string[] = [];
		for (let pages = 0; ; pages++) {
			expect(pages).toBeLessThan(10);
			found.push(...result.keys.map((key) => key.messageId));
			if (result.nextAfter === null) break;
			result = await owner.query(api.catalogBrowse.page, {
				...base,
				q: "needle",
				after: result.nextAfter,
				scanTargetIndex: result.nextTargetIndex ?? 0,
			});
		}
		expect(found).toEqual(["z_first", "a_second"]);
		await expect(
			owner.query(api.catalogBrowse.page, {
				...base,
				localeId: german.localeId,
				localeIds: [],
			}),
		).rejects.toThrow("either");
		await expect(
			owner.query(api.catalogBrowse.page, {
				...base,
				localeIds: [german.localeId, german.localeId],
			}),
		).rejects.toThrow("repeats");
		const otherProject = await createProject(owner, { slug: "other" });
		const foreign = await owner.mutation(api.locales.create, {
			projectId: otherProject,
			code: "it",
		});
		await expect(
			owner.query(api.catalogBrowse.page, { ...base, localeIds: [foreign] }),
		).rejects.toThrow("active target language");
		await owner.mutation(api.locales.archive, { localeId: german.localeId });
		await expect(
			owner.query(api.catalogBrowse.page, {
				...base,
				localeIds: [german.localeId],
			}),
		).rejects.toThrow("active target language");
		expect(
			(await owner.query(api.catalogBrowse.page, base)).keys.every(
				(key) => key.targets.length === codes.length - 1,
			),
		).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
