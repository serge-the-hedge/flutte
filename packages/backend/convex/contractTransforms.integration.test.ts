import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function bindTwoLocales(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Expected source Locale.");
	const targetId = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await user.action(api.locales.bind, {
		localeId: targetId,
		catalogPath: "de.arb",
	});
	return { sourceId: source._id, targetId };
}

describe("Contract Transforms", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("wraps an unchanged target for a plain-to-plural Source Contract without refreshing its Source Fingerprint", async () => {
		const user = await authenticatedBackend(t, "contract-transform-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","items":"One item"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","items":"Ein Element"}',
				},
			],
		});

		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plural",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One item} other{{count} items}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","items":"Ein Element"}',
				},
			],
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const key = active?.keys.find((entry) => entry.id === "items");
		const source = key?.values.find((value) => value.isSource);
		const target = key?.values.find((value) => value.localeId === targetId);

		expect(target).toMatchObject({
			value: "{count, plural, other{Ein Element}}",
		});
		expect(target?.sourceFingerprint).not.toBe(source?.sourceFingerprint);
	});

	test("quotes a target's literal hash before wrapping it in a new plural", async () => {
		const user = await authenticatedBackend(t, "contract-hash-wrap-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","rank":"Best #1"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","rank":"Beste #1"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plural",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","rank":"{count, plural, other{Best #1}}","@rank":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","rank":"Beste #1"}',
				},
			],
		});

		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "rank")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe("{count, plural, other{Beste '#'1}}");
	});

	test("keeps a target stale when only its metadata changes beside new source wording", async () => {
		const user = await authenticatedBackend(t, "contract-fingerprint-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","welcome":"Willkommen","@welcome":{"description":"before"}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "source-wording",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome back"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","welcome":"Willkommen","@welcome":{"description":"after"}}',
				},
			],
		});

		const key = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys.find((entry) => entry.id === "welcome");
		const source = key?.values.find((value) => value.isSource);
		const target = key?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe("Willkommen");
		expect(target?.sourceFingerprint).not.toBe(source?.sourceFingerprint);
	});

	test("publishes a concrete Translation Residue for a target-only argument", async () => {
		const user = await authenticatedBackend(t, "contract-residue-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","welcome":"Willkommen"}',
				},
			],
		});

		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "target-contract-defect",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","welcome":"Willkommen {brand}"}',
				},
			],
		});

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});

		expect(residues?.page).toEqual([
			{
				localeId: targetId,
				localeCode: "de",
				catalogPath: "de.arb",
				catalogIndex: 0,
				messageId: "welcome",
				reasons: [
					{
						code: "target_argument_not_in_source",
						placeholderNames: ["brand"],
						placeholderNameCount: 1,
						placeholderNamesComplete: true,
					},
				],
			},
		]);
	});

	test("carries a placeholder rename into the target value and metadata operations across a later baseline", async () => {
		const user = await authenticatedBackend(t, "contract-rename-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const germanBaselineFile = {
			catalogPath: "de.arb",
			content:
				'{"@@locale":"de","hello":"Hallo {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
		};
		const baselineFiles = [
			{
				catalogPath: "en.arb",
				content:
					'{"@@locale":"en","hello":"Hello {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
			},
			germanBaselineFile,
		];
		const renamedFiles = [
			{
				catalogPath: "en.arb",
				content:
					'{"@@locale":"en","hello":"Hello {person}","@hello":{"placeholders":{"person":{"type":"String"}}}}',
			},
			germanBaselineFile,
		];
		const renamedAgainSourceFile = {
			catalogPath: "en.arb",
			content:
				'{"@@locale":"en","hello":"Hello {user}","@hello":{"placeholders":{"user":{"type":"String"}}}}',
		};
		const renamedAgainFiles = [renamedAgainSourceFile, germanBaselineFile];
		const renamedMetadataFiles = [
			renamedAgainSourceFile,
			{
				catalogPath: "de.arb",
				content:
					'{"@@locale":"de","hello":"Hallo {name}","@hello":{"description":"a harmless Git edit","placeholders":{"name":{"type":"String"}}}}',
			},
		];
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: baselineFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: renamedFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename-again",
			lineage: {
				baselineCommit: "rename",
				relationship: "descendant",
				mergeBase: "rename",
			},
			files: renamedAgainFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename-noop",
			lineage: {
				baselineCommit: "rename-again",
				relationship: "descendant",
				mergeBase: "rename-again",
			},
			files: renamedAgainFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename-metadata-noop",
			lineage: {
				baselineCommit: "rename-noop",
				relationship: "descendant",
				mergeBase: "rename-noop",
			},
			files: renamedMetadataFiles,
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const key = active?.keys.find((entry) => entry.id === "hello");
		const source = key?.values.find((value) => value.isSource);
		const target = key?.values.find((value) => value.localeId === targetId);

		expect(target).toMatchObject({
			value: "Hallo {user}",
			metadataTransforms: [
				{ kind: "rename_placeholder", from: "name", to: "user" },
			],
		});
		expect(target?.sourceFingerprint).not.toBe(source?.sourceFingerprint);
	});

	test("cancels a reversible placeholder rename instead of storing an invalid self-rename", async () => {
		const user = await authenticatedBackend(
			t,
			"contract-rename-reversal-owner",
		);
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const originalSource = {
			catalogPath: "en.arb",
			content:
				'{"@@locale":"en","hello":"Hello {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
		};
		const renamedSource = {
			catalogPath: "en.arb",
			content:
				'{"@@locale":"en","hello":"Hello {person}","@hello":{"placeholders":{"person":{"type":"String"}}}}',
		};
		const targetFile = {
			catalogPath: "de.arb",
			content:
				'{"@@locale":"de","hello":"Hallo {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
		};
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [originalSource, targetFile],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "renamed",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [renamedSource, targetFile],
		});
		const restored = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "reversed",
			lineage: {
				baselineCommit: "renamed",
				relationship: "descendant",
				mergeBase: "renamed",
			},
			files: [originalSource, targetFile],
		});

		expect(restored.snapshotId).not.toBeNull();
		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "hello")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe("Hallo {name}");
		expect(target?.metadataTransforms).toBeUndefined();
	});

	test("does not mistake a source removal and unrelated addition for a placeholder rename", async () => {
		const user = await authenticatedBackend(t, "contract-rename-proof-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","message":"Hello {name}","@message":{"placeholders":{"name":{"type":"String"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","message":"Hallo {name}","@message":{"placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "replacement-contract",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","message":"{count} items","@message":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","message":"Hallo {name}","@message":{"placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});

		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "message")
			?.values.find((value) => value.localeId === targetId);
		expect(target).toMatchObject({ value: "Hallo {name}" });
		expect(target?.metadataTransforms).toBeUndefined();

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(residues?.page[0]).toMatchObject({
			localeId: targetId,
			messageId: "message",
			reasons: [
				{
					code: "removed_placeholder",
					placeholderNames: ["name"],
					placeholderNameCount: 1,
					placeholderNamesComplete: true,
				},
			],
		});
	});

	test("composes sequential Source Contract retypes into a replayable target metadata operation", async () => {
		const user = await authenticatedBackend(t, "contract-retype-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}',
				},
			],
		});

		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "retyped",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "retyped-again",
			lineage: {
				baselineCommit: "retyped",
				relationship: "descendant",
				mergeBase: "retyped",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"double"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}',
				},
			],
		});
		const replayed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "retyped-noop",
			lineage: {
				baselineCommit: "retyped-again",
				relationship: "descendant",
				mergeBase: "retyped-again",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"double"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}',
				},
			],
		});
		expect(replayed.snapshotId).not.toBeNull();

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const target = active?.keys
			.find((entry) => entry.id === "count")
			?.values.find((value) => value.localeId === targetId);

		expect(target).toMatchObject({
			value: "{count}",
			metadataTransforms: [
				{
					kind: "retype_placeholder",
					name: "count",
					from: { type: "present", value: "String" },
					to: { type: "present", value: "double" },
				},
			],
		});
	});

	test("does not replay a historical retype over a later Git placeholder type conflict", async () => {
		const user = await authenticatedBackend(
			t,
			"contract-retype-git-conflict-owner",
		);
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const sourceInt =
			'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"int"}}}}';
		const sourceString =
			'{"@@locale":"en","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}';
		const targetString =
			'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"String"}}}}';
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: sourceString },
				{ catalogPath: "de.arb", content: targetString },
			],
		});
		const retyped = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "retyped",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: sourceInt },
				{ catalogPath: "de.arb", content: targetString },
			],
		});
		const failed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "target-double",
			lineage: {
				baselineCommit: "retyped",
				relationship: "descendant",
				mergeBase: "retyped",
			},
			files: [
				{ catalogPath: "en.arb", content: sourceInt },
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","count":"{count}","@count":{"placeholders":{"count":{"type":"double"}}}}',
				},
			],
		});

		expect(failed.snapshotId).toBeNull();
		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))
				?.snapshotId,
		).toBe(retyped.snapshotId);
	});

	test("composes a placeholder rename and retype from the same Source Contract change", async () => {
		const user = await authenticatedBackend(t, "contract-rename-retype-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","value":"{name}","@value":{"placeholders":{"name":{"type":"String"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","value":"{name}","@value":{"placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename-and-retype",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","value":"{person}","@value":{"placeholders":{"person":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","value":"{name}","@value":{"placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});

		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "value")
			?.values.find((value) => value.localeId === targetId);
		expect(target).toMatchObject({
			value: "{person}",
			metadataTransforms: [
				{ kind: "rename_placeholder", from: "name", to: "person" },
				{
					kind: "retype_placeholder",
					name: "person",
					from: { type: "present", value: "String" },
					to: { type: "present", value: "int" },
				},
			],
		});
	});

	test("retains a transformed target's metadata operations through archive and byte-identical restore", async () => {
		const user = await authenticatedBackend(t, "contract-archive-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const renamedSourceFile = {
			catalogPath: "en.arb",
			content:
				'{"@@locale":"en","hello":"Hello {person}","@hello":{"placeholders":{"person":{"type":"String"}}}}',
		};
		const germanBaselineFile = {
			catalogPath: "de.arb",
			content:
				'{"@@locale":"de","hello":"Hallo {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
		};
		const baselineFiles = [
			{
				catalogPath: "en.arb",
				content:
					'{"@@locale":"en","hello":"Hello {name}","@hello":{"placeholders":{"name":{"type":"String"}}}}',
			},
			germanBaselineFile,
		];
		const renamedFiles = [renamedSourceFile, germanBaselineFile];
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: baselineFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "rename",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: renamedFiles,
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "removed",
			lineage: {
				baselineCommit: "rename",
				relationship: "descendant",
				mergeBase: "rename",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "restored",
			lineage: {
				baselineCommit: "removed",
				relationship: "descendant",
				mergeBase: "removed",
			},
			files: [
				renamedSourceFile,
				{ catalogPath: "de.arb", content: '{"@@locale":"de"}' },
			],
		});

		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "hello")
			?.values.find((value) => value.localeId === targetId);
		expect(target).toMatchObject({
			value: "Hallo {person}",
			metadataTransforms: [
				{ kind: "rename_placeholder", from: "name", to: "person" },
			],
		});
	});

	test("unwraps a target plural's argument-free other arm when the Source Contract becomes plain", async () => {
		const user = await authenticatedBackend(t, "contract-unwrap-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One} other{Many}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, one{Ein} other{Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});

		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plain",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","items":"Item"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, one{Ein} other{Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const target = active?.keys
			.find((entry) => entry.id === "items")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe("Viele");

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(residues?.page).toEqual([]);
	});

	test("keeps a lossy plural-to-plain target as Translation Residue", async () => {
		const user = await authenticatedBackend(t, "contract-lossy-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One} other{Many}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, one{Ein} other{{count} Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plain",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","items":"Item"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, one{Ein} other{{count} Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const target = active?.keys
			.find((entry) => entry.id === "items")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe(
			"{count, plural, one{Ein} other{{count} Viele}}",
		);

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(residues?.page[0]).toMatchObject({
			localeId: targetId,
			messageId: "items",
			reasons: expect.arrayContaining([
				{ code: "plural_to_plain_requires_translation" },
				{
					code: "removed_placeholder",
					placeholderNames: ["count"],
					placeholderNameCount: 1,
					placeholderNamesComplete: true,
				},
			]),
		});
	});

	test("keeps a plural other arm that depends on its count as Translation Residue", async () => {
		const user = await authenticatedBackend(t, "contract-pound-unwrap-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const targetPlural = "{count, plural, one{Ein Element} other{# Elemente}}";
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One item} other{# items}}"}',
				},
				{
					catalogPath: "de.arb",
					content: `{"@@locale":"de","items":${JSON.stringify(targetPlural)}}`,
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plain",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","items":"Item"}' },
				{
					catalogPath: "de.arb",
					content: `{"@@locale":"de","items":${JSON.stringify(targetPlural)}}`,
				},
			],
		});

		const target = (
			await user.query(api.catalogProjection.getActive, { projectId })
		)?.keys
			.find((entry) => entry.id === "items")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toBe(targetPlural);

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(residues?.page[0]).toMatchObject({
			localeId: targetId,
			messageId: "items",
			reasons: expect.arrayContaining([
				{ code: "plural_to_plain_requires_translation" },
			]),
		});
	});

	test("leaves source-added arguments and plural-arm changes as stale target work", async () => {
		const user = await authenticatedBackend(t, "contract-stale-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","welcome":"Welcome","items":"{count, plural, one{One} other{Many}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","welcome":"Willkommen","items":"{count, plural, one{Ein} other{Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "source-contract-expansion",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","welcome":"Welcome {name}","items":"{count, plural, one{One} few{A few} other{Many}}","@welcome":{"placeholders":{"name":{"type":"String"}}},"@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","welcome":"Willkommen","items":"{count, plural, one{Ein} other{Viele}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const welcome = active?.keys.find((entry) => entry.id === "welcome");
		const items = active?.keys.find((entry) => entry.id === "items");
		const welcomeSource = welcome?.values.find((value) => value.isSource);
		const welcomeTarget = welcome?.values.find(
			(value) => value.localeId === targetId,
		);
		const itemsSource = items?.values.find((value) => value.isSource);
		const itemsTarget = items?.values.find(
			(value) => value.localeId === targetId,
		);

		expect(welcomeTarget?.value).toBe("Willkommen");
		expect(itemsTarget?.value).toBe("{count, plural, one{Ein} other{Viele}}");
		expect(welcomeTarget?.sourceFingerprint).not.toBe(
			welcomeSource?.sourceFingerprint,
		);
		expect(itemsTarget?.sourceFingerprint).not.toBe(
			itemsSource?.sourceFingerprint,
		);

		const residues = await user.query(api.translationResidue.listActive, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(residues?.page).toEqual([]);
	});

	test("keeps a Git placeholder-type conflict out of the accepted Baseline", async () => {
		const user = await authenticatedBackend(t, "contract-type-conflict-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const source =
			'{"@@locale":"en","name":"{name}","@name":{"placeholders":{"name":{"type":"String"}}}}';
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: source },
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","name":"{name}","@name":{"placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});
		const failed = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "type-conflict",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: source },
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","name":"{name}","@name":{"placeholders":{"name":{"type":"int"}}}}',
				},
			],
		});

		expect(failed.snapshotId).toBeNull();
		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))
				?.snapshotId,
		).toBe(baseline.snapshotId);
	});

	test("keeps missing other arms and literal braces out of the accepted Baseline", async () => {
		const user = await authenticatedBackend(t, "contract-icu-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One} other{Many}}"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, one{Ein} other{Viele}}"}',
				},
			],
		});
		const missingOther = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "missing-other",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One} other{Many}}"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","items":"{count, plural, one{Ein}}"}',
				},
			],
		});
		const literalBrace = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "literal-brace",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","items":"A { literal"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","items":"Eintrag"}',
				},
			],
		});

		expect(missingOther.snapshotId).toBeNull();
		expect(literalBrace.snapshotId).toBeNull();
		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))
				?.snapshotId,
		).toBe(baseline.snapshotId);
	});

	test("accepts nested select and plural contracts without a bespoke transform", async () => {
		const user = await authenticatedBackend(t, "contract-nested-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","summary":"{count, plural, one{{person, select, male{He has one item} other{They have one item}}} other{{person, select, male{He has # items} other{They have # items}}}}","@summary":{"placeholders":{"count":{"type":"int"},"person":{"type":"String"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","summary":"{count, plural, one{{person, select, male{Er hat ein Element} other{Sie haben ein Element}}} other{{person, select, male{Er hat # Elemente} other{Sie haben # Elemente}}}}","@summary":{"placeholders":{"count":{"type":"int"},"person":{"type":"String"}}}}',
				},
			],
		});

		const active = await user.query(api.catalogProjection.getActive, {
			projectId,
		});
		const target = active?.keys
			.find((entry) => entry.id === "summary")
			?.values.find((value) => value.localeId === targetId);
		expect(target?.value).toContain("select");
	});
});
