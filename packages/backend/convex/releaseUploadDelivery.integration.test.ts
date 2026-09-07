import { expect, test } from "vitest";
import { createBackend } from "../test/support";
import { sha256Hex } from "./lib";
import type { ReleaseBundleManifest } from "./releaseBundleModel";
import {
	applyStoredReleaseFile,
	applyStoredReleaseTree,
} from "./releaseUploadDelivery";

test("applies catalog chunks in order with original Source conflicts and verifies each chunk", async () => {
	const t = createBackend();
	const chunks: ReleaseBundleManifest["chunks"] = [];
	for (const [catalogIndex, messageId, source, target] of [
		[0, "one", "One", "Eins"],
		[1, "two", "Two", "Zwei"],
	] as const) {
		const content = JSON.stringify([
			{
				catalogIndex,
				messageId,
				baselineSourceValue: source,
				values: [
					{
						localeCode: "de",
						catalogPath: "de.arb",
						isSource: false,
						baselineValue: "",
						value: target,
					},
				],
			},
		]);
		const storageId = await t.run(
			async (ctx) => await ctx.storage.store(new Blob([content])),
		);
		chunks.push({
			catalogPath: "de.arb",
			storageId,
			contentHash: await sha256Hex(content),
			byteLength: new Blob([content]).size,
			changeKeyCount: 1,
		});
	}
	const bundle: ReleaseBundleManifest = {
		version: 2,
		changeKeyCount: 2,
		chunks,
		releaseRecord: {
			id: "record",
			projectId: "project",
			baselineSnapshotId: "snapshot",
			repository: "repo",
			baselineCommit: "baseline",
			manifestHash: "hash",
			integrationBranch: "main",
		},
		catalogs: [
			{ localeCode: "en", catalogPath: "en.arb", isSource: true },
			{ localeCode: "de", catalogPath: "de.arb", isSource: false },
		],
	};
	const target = {
		catalogPath: "de.arb",
		content: '{"@@locale":"de","one":"Alt","two":"Alt"}',
	};
	const source = {
		catalogPath: "en.arb",
		content: '{"@@locale":"en","one":"One","two":"Changed"}',
	};
	const result = await t.action(
		async (ctx) => await applyStoredReleaseFile(ctx, bundle, target, source),
	);
	expect(result.files[0]?.content).toBe(
		'{"@@locale":"de","one":"Eins","two":"Alt"}',
	);
	expect(result.applied).toEqual(["one"]);
	expect(result.skipped).toEqual([
		{ messageId: "two", reason: "source_changed" },
	]);
	const corrupt = {
		...bundle,
		chunks: bundle.chunks.map((chunk, index) =>
			index === 1 ? { ...chunk, contentHash: "wrong" } : chunk,
		),
	};
	await expect(
		t.action(
			async (ctx) => await applyStoredReleaseFile(ctx, corrupt, target, source),
		),
	).rejects.toThrow("integrity check");
});

test("rejects a malformed unchanged catalog even when its manifest has no chunks", async () => {
	const t = createBackend();
	const bundle: ReleaseBundleManifest = {
		version: 2,
		changeKeyCount: 0,
		chunks: [],
		releaseRecord: {
			id: "record",
			projectId: "project",
			baselineSnapshotId: "snapshot",
			repository: "repo",
			baselineCommit: "baseline",
			manifestHash: "hash",
			integrationBranch: "main",
		},
		catalogs: [
			{ localeCode: "en", catalogPath: "en.arb", isSource: true },
			{ localeCode: "de", catalogPath: "de.arb", isSource: false },
		],
	};
	await expect(
		t.action(
			async (ctx) =>
				await applyStoredReleaseFile(
					ctx,
					bundle,
					{ catalogPath: "de.arb", content: "not JSON" },
					{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				),
		),
	).rejects.toThrow();
});

test("bounds expanded compatibility output and directs the caller to per-file delivery", async () => {
	const t = createBackend();
	const chunks: ReleaseBundleManifest["chunks"] = [];
	const sourceMessages = Object.fromEntries(
		Array.from({ length: 18 }, (_, index) => [`key${index}`, "Source"]),
	);
	const sourceChanges = Object.keys(sourceMessages).map(
		(messageId, catalogIndex) => ({
			messageId,
			catalogIndex,
			baselineSourceValue: "Source",
			values: [],
		}),
	);
	const value = "x".repeat(240 * 1024);
	for (const localeCode of ["en", "de", "fr"]) {
		const catalogPath = `${localeCode}.arb`;
		for (let offset = 0; offset < sourceChanges.length; offset += 3) {
			const changes = sourceChanges.slice(offset, offset + 3).map((change) => ({
				...change,
				values:
					localeCode === "en"
						? []
						: [
								{
									localeCode,
									catalogPath,
									isSource: false,
									baselineValue: "",
									value,
								},
							],
			}));
			const content = JSON.stringify(changes);
			const storageId = await t.run(
				async (ctx) => await ctx.storage.store(new Blob([content])),
			);
			chunks.push({
				catalogPath,
				storageId,
				contentHash: await sha256Hex(content),
				byteLength: new Blob([content]).size,
				changeKeyCount: changes.length,
			});
		}
	}
	const bundle: ReleaseBundleManifest = {
		version: 2,
		changeKeyCount: 18,
		chunks,
		releaseRecord: {
			id: "record",
			projectId: "project",
			baselineSnapshotId: "snapshot",
			repository: "repo",
			baselineCommit: "baseline",
			manifestHash: "hash",
			integrationBranch: "main",
		},
		catalogs: ["en", "de", "fr"].map((localeCode) => ({
			localeCode,
			catalogPath: `${localeCode}.arb`,
			isSource: localeCode === "en",
		})),
	};
	const files = [
		{
			catalogPath: "en.arb",
			content: JSON.stringify({ "@@locale": "en", ...sourceMessages }),
		},
		{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
		{ catalogPath: "fr.arb", content: '{"@@locale":"fr"}' },
	];
	await expect(
		t.action(async (ctx) => await applyStoredReleaseTree(ctx, bundle, files)),
	).rejects.toThrow("current Blabla CLI");
});
