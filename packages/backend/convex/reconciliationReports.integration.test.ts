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
	return { targetId };
}

describe("Reconciliation Reports", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("publishes one durable key-level Changed in Git report with its accepted Baseline transition", async () => {
		const user = await authenticatedBackend(t, "report-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
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
		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "target-edited-in-git",
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
					content: '{"@@locale":"de","welcome":"Guten Tag"}',
				},
			],
		});

		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))
				?.snapshotId,
		).toBe(next.snapshotId);
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(reports?.page).toHaveLength(1);
		const [report] = reports?.page ?? [];
		if (!report) throw new Error("Expected a Reconciliation Report.");
		expect(report).toMatchObject({
			snapshotId: next.snapshotId,
			previousSnapshotId: baseline.snapshotId,
		});

		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows).toMatchObject([
			{
				group: "changed_in_git",
				messageId: "welcome",
				locales: [
					{
						localeId: targetId,
						localeCode: "de",
						facts: [{ kind: "git_value_changed" }],
					},
				],
			},
		]);
		const fact = detail?.rows[0]?.locales[0]?.facts[0];
		if (!fact) throw new Error("Expected a report fact.");
		await user.mutation(api.reconciliationReports.dispose, {
			factId: fact._id,
		});
		const dispositioned = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(
			dispositioned?.rows[0]?.locales[0]?.facts[0]?.disposition,
		).toMatchObject({
			actor: { kind: "user", id: "report-owner" },
		});
		expect(
			dispositioned?.rows[0]?.locales[0]?.facts[0]?.disposition?.at,
		).toEqual(expect.any(Number));

		const viewer = await authenticatedBackend(t, "report-viewer");
		await user.mutation(api.projects.addMember, {
			projectId,
			userId: "report-viewer",
			role: "viewer",
		});
		expect(
			(
				await viewer.query(api.reconciliationReports.get, {
					reportId: report._id,
					paginationOpts: { numItems: 10, cursor: null },
				})
			)?.rows,
		).toHaveLength(1);
	});

	test("groups automatic and unresolved consequences in the locked order while handing current work to Strings", async () => {
		const user = await authenticatedBackend(t, "report-groups-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","broken":"{count} things","git":"Git","archived":"Archive","review":"Old","@broken":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","broken":"{count} Dinge","git":"Git","archived":"Archiv","review":"Alt","@broken":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "consequences",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","broken":"Things","git":"Git","review":"New","new":"New"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","broken":"{count} Dinge","git":"Geändert","review":"Alt","new":"Neu"}',
				},
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const [report] = reports.page;
		if (!report) throw new Error("Expected a Reconciliation Report.");
		expect(report.snapshotId).toBe(next.snapshotId);
		expect(report.previousSnapshotId).toBe(baseline.snapshotId);

		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows.map((row) => row.group)).toEqual([
			"broken_by_source_change",
			"changed_in_git",
			"archived_by_sync",
			"to_review",
			"to_translate",
		]);
		expect(detail?.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					group: "broken_by_source_change",
					messageId: "broken",
					locales: expect.arrayContaining([
						expect.objectContaining({
							localeId: targetId,
							facts: expect.arrayContaining([
								expect.objectContaining({
									kind: "source_change_broke_target",
									reasonCodes: ["removed_placeholder"],
								}),
							]),
						}),
					]),
				}),
				expect.objectContaining({
					group: "archived_by_sync",
					messageId: "archived",
					locales: expect.arrayContaining([
						expect.objectContaining({
							facts: expect.arrayContaining([
								expect.objectContaining({ kind: "key_archived" }),
							]),
						}),
					]),
				}),
				expect.objectContaining({
					group: "to_review",
					messageId: "review",
				}),
				expect.objectContaining({
					group: "to_translate",
					messageId: "new",
					locales: [
						expect.objectContaining({
							localeId: targetId,
							facts: [expect.objectContaining({ kind: "new_target_value" })],
						}),
					],
				}),
			]),
		);

		const handoff = await user.query(api.reconciliationReports.getWorkHandoff, {
			reportId: report._id,
		});
		expect(handoff?.keys.map((key) => key.messageId)).toEqual([
			"broken",
			"git",
			"review",
			"new",
		]);
	});

	test("keeps routine no-op Baseline transitions quiet", async () => {
		const user = await authenticatedBackend(t, "report-quiet-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
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
			commit: "no-op",
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
					content: '{"@@locale":"de","welcome":"Willkommen"}',
				},
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(reports.page).toEqual([]);
	});

	test("records an automatic Contract Transform after it has changed the accepted catalog", async () => {
		const user = await authenticatedBackend(t, "report-transform-owner");
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
		const transformed = await user.action(api.snapshots.ingest, {
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
		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))?.keys
				.find((key) => key.id === "items")
				?.values.find((value) => value.localeId === targetId)?.value,
		).toBe("{count, plural, other{Ein Element}}");

		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const report = reports.page.find(
			(candidate) => candidate.snapshotId === transformed.snapshotId,
		);
		if (!report) throw new Error("Expected a Contract Transform report.");
		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows.map((row) => row.group)).toEqual(["to_review"]);
		expect(detail?.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					group: "to_review",
					messageId: "items",
					locales: expect.arrayContaining([
						expect.objectContaining({
							localeId: targetId,
							facts: expect.arrayContaining([
								expect.objectContaining({
									kind: "automatic_contract_transform",
									transformCode: "wrapped_plural",
								}),
							]),
						}),
					]),
				}),
			]),
		);
	});

	test("keeps one key row when a target has both a source break and a Git edit", async () => {
		const user = await authenticatedBackend(t, "report-mixed-key-owner");
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
						'{"@@locale":"en","items":"{count} items","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count} Dinge","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		const next = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "mixed",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","items":"Items"}' },
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count} Neue Dinge","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const report = reports.page.find(
			(candidate) => candidate.snapshotId === next.snapshotId,
		);
		if (!report) throw new Error("Expected a mixed consequence report.");
		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows).toHaveLength(1);
		expect(detail?.rows[0]).toMatchObject({
			group: "broken_by_source_change",
			messageId: "items",
			locales: [
				{
					localeId: targetId,
					facts: expect.arrayContaining([
						expect.objectContaining({ kind: "source_change_broke_target" }),
						expect.objectContaining({ kind: "git_value_changed" }),
					]),
				},
			],
		});
	});

	test("records each new source edit even when its target was already stale", async () => {
		const user = await authenticatedBackend(t, "report-repeated-source-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","welcome":"Old"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","welcome":"Alt"}' },
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "new",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","welcome":"New"}' },
				{ catalogPath: "de.arb", content: '{"@@locale":"de","welcome":"Alt"}' },
			],
		});
		const newer = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "newer",
			lineage: {
				baselineCommit: "new",
				relationship: "descendant",
				mergeBase: "new",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Newer"}',
				},
				{ catalogPath: "de.arb", content: '{"@@locale":"de","welcome":"Alt"}' },
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const report = reports.page.find(
			(candidate) => candidate.snapshotId === newer.snapshotId,
		);
		if (!report) throw new Error("Expected the later source-change report.");
		expect(
			(
				await user.query(api.reconciliationReports.get, {
					reportId: report._id,
					paginationOpts: { numItems: 10, cursor: null },
				})
			)?.rows,
		).toMatchObject([{ group: "to_review", messageId: "welcome" }]);
	});

	test("groups a non-lossless plural-to-plain change as broken by its source", async () => {
		const user = await authenticatedBackend(t, "report-plural-break-owner");
		const projectId = await createProject(user);
		const { targetId } = await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plural",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","items":"{count, plural, one{One item} other{{count} items}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, other{{count} Dinge}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		const plain = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "plain",
			lineage: {
				baselineCommit: "plural",
				relationship: "descendant",
				mergeBase: "plural",
			},
			files: [
				{ catalogPath: "en.arb", content: '{"@@locale":"en","items":"Items"}' },
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","items":"{count, plural, other{{count} Dinge}}","@items":{"placeholders":{"count":{"type":"int"}}}}',
				},
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const report = reports.page.find(
			(candidate) => candidate.snapshotId === plain.snapshotId,
		);
		if (!report) throw new Error("Expected the plural-to-plain report.");
		expect(
			(
				await user.query(api.reconciliationReports.get, {
					reportId: report._id,
					paginationOpts: { numItems: 10, cursor: null },
				})
			)?.rows,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					group: "broken_by_source_change",
					messageId: "items",
					locales: expect.arrayContaining([
						expect.objectContaining({
							localeId: targetId,
							facts: expect.arrayContaining([
								expect.objectContaining({
									kind: "source_change_broke_target",
									reasonCodes: expect.arrayContaining([
										"plural_to_plain_requires_translation",
									]),
								}),
							]),
						}),
					]),
				}),
			]),
		);
	});

	test("links older unresolved work through the frozen handoff without copying it into a new report", async () => {
		const user = await authenticatedBackend(t, "report-handoff-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","review":"Old","git":"Git"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","review":"Alt","git":"Git"}',
				},
			],
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "review-became-stale",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","review":"New","git":"Git"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","review":"Alt","git":"Git"}',
				},
			],
		});
		const latest = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "different-git-change",
			lineage: {
				baselineCommit: "review-became-stale",
				relationship: "descendant",
				mergeBase: "review-became-stale",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","review":"New","git":"Git"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","review":"Alt","git":"Geändert"}',
				},
			],
		});
		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const report = reports.page.find(
			(candidate) => candidate.snapshotId === latest.snapshotId,
		);
		if (!report) throw new Error("Expected the latest Reconciliation Report.");
		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows).toMatchObject([
			{ group: "changed_in_git", messageId: "git" },
		]);
		expect(detail?.rows.map((row) => row.messageId)).not.toContain("review");
		expect(
			(
				await user.query(api.reconciliationReports.getWorkHandoff, {
					reportId: report._id,
				})
			)?.keys.map((key) => key.messageId),
		).toEqual(["review", "git"]);
	});

	test("keeps an unbound Locale file as immutable setup evidence without blocking the Baseline", async () => {
		const user = await authenticatedBackend(t, "report-unbound-owner");
		const projectId = await createProject(user);
		await bindTwoLocales(user, projectId);
		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "with-unbound-locale",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","welcome":"Willkommen"}',
				},
				{ catalogPath: "pt.arb", content: '{"@@locale":"pt","welcome":"Olá"}' },
			],
		});

		expect(
			(await user.query(api.catalogProjection.getActive, { projectId }))
				?.snapshotId,
		).toBe(result.snapshotId);
		const snapshot = result.snapshotId
			? await user.query(api.snapshots.get, { snapshotId: result.snapshotId })
			: null;
		expect(snapshot?.unboundLocaleFiles).toMatchObject([
			{
				catalogPath: "pt.arb",
				declaredLocaleCode: "pt",
				messageCount: 1,
			},
		]);

		const reports = await user.query(api.reconciliationReports.list, {
			projectId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		const [report] = reports.page;
		if (!report) throw new Error("Expected a Locale Setup report.");
		const detail = await user.query(api.reconciliationReports.get, {
			reportId: report._id,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(detail?.rows).toMatchObject([
			{
				group: "locale_setup",
				catalogPath: "pt.arb",
				locales: [
					{
						facts: [
							{
								kind: "unbound_locale_file",
								declaredLocaleCode: "pt",
								messageCount: 1,
							},
						],
					},
				],
			},
		]);
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "same-unbound-locale",
			lineage: {
				baselineCommit: "with-unbound-locale",
				relationship: "descendant",
				mergeBase: "with-unbound-locale",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","welcome":"Welcome"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","welcome":"Willkommen"}',
				},
				{ catalogPath: "pt.arb", content: '{"@@locale":"pt","welcome":"Olá"}' },
			],
		});
		expect(
			(
				await user.query(api.reconciliationReports.list, {
					projectId,
					paginationOpts: { numItems: 10, cursor: null },
				})
			).page,
		).toHaveLength(1);
	});
});
