import { expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

test("streams two dozen languages through introduction, archival and restoration", async () => {
	const t = createBackend();
	const user = await authenticatedBackend(t, "processing-owner");
	const projectId = await createProject(user);
	const codes = [
		"en",
		"de",
		"es",
		"fr",
		"ru",
		"zh",
		"pt",
		"it",
		"ja",
		"ko",
		"nl",
		"sv",
		"da",
		"fi",
		"no",
		"pl",
		"cs",
		"sk",
		"uk",
		"tr",
		"el",
		"he",
		"ar",
		"hu",
	];
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Source required");
	for (const code of codes) {
		const localeId =
			code === "en"
				? source._id
				: await user.mutation(api.locales.create, { projectId, code });
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	}
	const files = (keys: readonly string[], emptyTargets = false) =>
		codes.map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				...Object.fromEntries(
					(emptyTargets && code !== "en" ? [] : keys).map((key) => [
						key,
						`${code}: ${key}`,
					]),
				),
			}),
		}));
	const initial = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "initial",
		files: files(["retained", "archived"]),
	});
	expect(initial.snapshotId).toBeTruthy();
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "changed",
		lineage: {
			baselineCommit: "initial",
			relationship: "descendant",
			mergeBase: "initial",
		},
		files: files(["retained", "introduced"]),
	});
	await t.run(async (ctx) => {
		const project = await ctx.db.get(projectId);
		if (!project?.activeCatalogProjectionId)
			throw new Error("Projection required");
		const projectionId = project.activeCatalogProjectionId;
		const projection = await ctx.db.get(projectionId);
		expect(projection?.expectedMessageCount).toBe(48);
		expect(projection?.expectedArchiveValueCount).toBe(24);
		const introduced = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_isSource", (q) =>
				q
					.eq("projectionId", projectionId)
					.eq("messageId", "introduced")
					.eq("isSource", true),
			)
			.unique();
		expect(introduced?.introductionLocaleIds).toHaveLength(23);
		expect(await ctx.db.query("catalogProcessingInputs").take(1)).toHaveLength(
			0,
		);
	});
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "restored",
		lineage: {
			baselineCommit: "changed",
			relationship: "descendant",
			mergeBase: "changed",
		},
		files: files(["retained", "introduced", "archived"], true),
	});
	await t.run(async (ctx) => {
		const project = await ctx.db.get(projectId);
		if (!project?.activeCatalogProjectionId)
			throw new Error("Projection required");
		const projectionId = project.activeCatalogProjectionId;
		const projection = await ctx.db.get(projectionId);
		expect(projection?.expectedMessageCount).toBe(72);
		expect(projection?.expectedRestoreValueCount).toBe(23);
		const values = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId", (q) =>
				q.eq("projectionId", projectionId).eq("messageId", "archived"),
			)
			.take(25);
		expect(values).toHaveLength(24);
		expect(
			values.every((row) => row.value === `${row.localeCode}: archived`),
		).toBe(true);
		expect(await ctx.db.query("catalogProcessingInputs").take(1)).toHaveLength(
			0,
		);
	});
});

test("splits a byte-heavy processing partition before publishing", async () => {
	const t = createBackend();
	const user = await authenticatedBackend(t, "processing-owner");
	const projectId = await createProject(user);
	const codes = ["en", "de", "es", "fr", "ru", "zh", "pt", "it", "ja"];
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Source required");
	for (const code of codes) {
		const localeId =
			code === "en"
				? source._id
				: await user.mutation(api.locales.create, { projectId, code });
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	}
	const keys = ["a", "b", "c", "d"];
	const files = codes.map((code) => ({
		catalogPath: `${code}.arb`,
		content: JSON.stringify({
			"@@locale": code,
			...Object.fromEntries(
				keys.map((key) => [key, `${code} ${key} ${"x".repeat(180_000)}`]),
			),
		}),
	}));
	const result = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "partitioned",
		files,
	});
	expect(result.snapshotId).toBeTruthy();
	await t.run(async (ctx) => {
		const project = await ctx.db.get(projectId);
		if (!project?.activeCatalogProjectionId)
			throw new Error("Projection required");
		const projectionId = project.activeCatalogProjectionId;
		const projection = await ctx.db.get(projectionId);
		expect(projection?.expectedMessageCount).toBe(36);
		expect(projection?.expectedByteLength).toBeGreaterThan(6 * 1024 * 1024);
		expect(await ctx.db.query("catalogProcessingInputs").take(1)).toHaveLength(
			0,
		);
	});
});
