import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function bindEnglishAndGerman(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the English Locale.");
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

async function readSource(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const workspace = await readWorkspaceKeyCards(user, projectId);
	const source = workspace.keys[0]?.values.find((value) => value.isSource);
	if (
		!source ||
		source.localeId === undefined ||
		source.gitValueFingerprint === undefined ||
		source.gitValueRevision === undefined ||
		source.expectedSourceFingerprint === undefined
	) {
		throw new Error("Expected the English Catalog Workspace value.");
	}
	return {
		...source,
		localeId: source.localeId,
		gitValueFingerprint: source.gitValueFingerprint,
		gitValueRevision: source.gitValueRevision,
		expectedSourceFingerprint: source.expectedSourceFingerprint,
	};
}

async function readTarget(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const workspace = await readWorkspaceKeyCards(user, projectId);
	const target = workspace.keys[0]?.values.find((value) => !value.isSource);
	if (
		!target ||
		target.gitValueFingerprint === undefined ||
		target.gitValueRevision === undefined ||
		target.expectedSourceFingerprint === undefined
	) {
		throw new Error("Expected the German Catalog Workspace value.");
	}
	return {
		...target,
		gitValueFingerprint: target.gitValueFingerprint,
		gitValueRevision: target.gitValueRevision,
		expectedSourceFingerprint: target.expectedSourceFingerprint,
	};
}

async function ingestCatalog(
	user: AuthenticatedBackend,
	input: {
		projectId: Id<"projects">;
		commit: string;
		english?: string;
		german?: string;
		baselineCommit?: string;
	},
) {
	return await user.action(api.snapshots.ingest, {
		projectId: input.projectId,
		repository: "repo",
		commit: input.commit,
		...(input.baselineCommit === undefined
			? {}
			: {
					lineage: {
						baselineCommit: input.baselineCommit,
						relationship: "descendant" as const,
						mergeBase: input.baselineCommit,
					},
				}),
		files: [
			{
				catalogPath: "en.arb",
				content:
					input.english ??
					'{"@@locale":"en","greeting":"Hello {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			},
			{
				catalogPath: "de.arb",
				content: input.german ?? '{"@@locale":"de","greeting":"Hallo {name}"}',
			},
		],
	});
}

describe("Catalog Workspace", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("holds an English Source Proposal beside Git and carries same-pass target work when Git lands it", async () => {
		const user = await authenticatedBackend(t, "workspace-source-proposal");
		const projectId = await createProject(user);
		const { sourceId, targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const source = await readSource(user, projectId);
		const sourceReceipt = await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});
		expect(sourceReceipt).toMatchObject({
			workspaceRevision: 1,
			sourceFingerprint: expect.any(String),
		});

		const proposed = await readSource(user, projectId);
		expect(proposed).toMatchObject({
			value: "Welcome {name}",
			sourceProposalStatus: "pending",
			workspaceRevision: 1,
		});
		expect(
			(
				await user.query(api.catalogProjection.getActive, { projectId })
			)?.keys[0]?.values.find((value) => value.isSource)?.value,
		).toBe("Hello {name}");
		const target = await readTarget(user, projectId);
		const targetReceipt = await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Willkommen {name}" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		expect(targetReceipt.sourceFingerprint).toBe(proposed.sourceFingerprint);
		expect(await readTarget(user, projectId)).toMatchObject({
			sourceFingerprint: proposed.sourceFingerprint,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "proposal-landed",
			baselineCommit: "baseline",
			english:
				'{"@@locale":"en","greeting":"Welcome {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			german: '{"@@locale":"de","greeting":"Willkommen {name}"}',
		});

		expect(await readSource(user, projectId)).toMatchObject({
			value: "Welcome {name}",
			sourceProposalStatus: "landed",
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Willkommen {name}",
			valueState: "settled",
		});
	}, 20_000);

	test("keeps an independently settled target settled while a Source Proposal is pending", async () => {
		const user = await authenticatedBackend(
			t,
			"workspace-source-proposal-nonblocking",
		);
		const projectId = await createProject(user);
		const { sourceId, targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const target = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "settled",
		});

		const source = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});

		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "settled",
		});
	}, 20_000);

	test("makes target work against a revised Source Proposal current only for the latest wording", async () => {
		const user = await authenticatedBackend(
			t,
			"workspace-source-proposal-revision",
		);
		const projectId = await createProject(user);
		const { sourceId, targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const initialSource = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: initialSource.gitValueFingerprint,
			expectedGitValueRevision: initialSource.gitValueRevision,
			expectedWorkspaceRevision: initialSource.workspaceRevision,
		});
		const target = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Willkommen {name}" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "settled",
		});

		const firstProposal = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Good evening {name}" },
			expectedGitValueFingerprint: firstProposal.gitValueFingerprint,
			expectedGitValueRevision: firstProposal.gitValueRevision,
			expectedWorkspaceRevision: firstProposal.workspaceRevision,
		});

		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "unconfirmedImport",
		});
	}, 20_000);

	test("rejects a target draft when a newer Source Proposal changes its English basis", async () => {
		const user = await authenticatedBackend(
			t,
			"workspace-source-proposal-stale-target",
		);
		const projectId = await createProject(user);
		const { sourceId, targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const initialSource = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: initialSource.gitValueFingerprint,
			expectedGitValueRevision: initialSource.gitValueRevision,
			expectedWorkspaceRevision: initialSource.workspaceRevision,
		});
		const staleTargetDraft = await readTarget(user, projectId);
		const firstProposal = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Good evening {name}" },
			expectedGitValueFingerprint: firstProposal.gitValueFingerprint,
			expectedGitValueRevision: firstProposal.gitValueRevision,
			expectedWorkspaceRevision: firstProposal.workspaceRevision,
		});

		await expect(
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: targetId,
				intent: { kind: "save", value: "Willkommen {name}" },
				expectedGitValueFingerprint: staleTargetDraft.gitValueFingerprint,
				expectedGitValueRevision: staleTargetDraft.gitValueRevision,
				expectedWorkspaceRevision: staleTargetDraft.workspaceRevision,
				expectedSourceFingerprint: staleTargetDraft.expectedSourceFingerprint,
			}),
		).rejects.toThrow("source value changed");
	}, 20_000);

	test("rejects a stale English draft after another Source Proposal is saved", async () => {
		const user = await authenticatedBackend(
			t,
			"workspace-source-proposal-stale-source",
		);
		const projectId = await createProject(user);
		const { sourceId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const staleSourceDraft = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: staleSourceDraft.gitValueFingerprint,
			expectedGitValueRevision: staleSourceDraft.gitValueRevision,
			expectedWorkspaceRevision: staleSourceDraft.workspaceRevision,
		});

		await expect(
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: sourceId,
				intent: { kind: "save", value: "Good evening {name}" },
				expectedGitValueFingerprint: staleSourceDraft.gitValueFingerprint,
				expectedGitValueRevision: staleSourceDraft.gitValueRevision,
				expectedWorkspaceRevision: staleSourceDraft.workspaceRevision,
			}),
		).rejects.toThrow("Source Proposal changed");
	}, 20_000);

	test("keeps a Source Proposal pending when an accepted Baseline leaves Git English unchanged", async () => {
		const user = await authenticatedBackend(
			t,
			"workspace-source-proposal-unchanged",
		);
		const projectId = await createProject(user);
		const { sourceId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const source = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "target-only-update",
			baselineCommit: "baseline",
			german: '{"@@locale":"de","greeting":"Guten Tag {name}"}',
		});

		expect(await readSource(user, projectId)).toMatchObject({
			value: "Welcome {name}",
			sourceProposalStatus: "pending",
		});
	}, 20_000);

	test("refuses a Source Proposal that alters the Source Contract placeholder or ICU shape", async () => {
		const user = await authenticatedBackend(t, "workspace-source-contract");
		const projectId = await createProject(user);
		const { sourceId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const source = await readSource(user, projectId);

		await expect(
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: sourceId,
				intent: {
					kind: "save",
					value: "Welcome {name, plural, one {One person} other {Many people}}",
				},
				expectedGitValueFingerprint: source.gitValueFingerprint,
				expectedGitValueRevision: source.gitValueRevision,
				expectedWorkspaceRevision: source.workspaceRevision,
			}),
		).rejects.toThrow("cannot alter Source Contract placeholders or ICU shape");
		expect(await readSource(user, projectId)).toMatchObject({
			value: "Hello {name}",
			workspaceRevision: 0,
		});
	}, 20_000);

	test("reports a divergent Git source value as a superseded Source Proposal without rewriting Git", async () => {
		const user = await authenticatedBackend(t, "workspace-source-superseded");
		const projectId = await createProject(user);
		const { sourceId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const source = await readSource(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "proposal-superseded",
			baselineCommit: "baseline",
			english:
				'{"@@locale":"en","greeting":"Greetings {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
		});

		expect(await readSource(user, projectId)).toMatchObject({
			value: "Greetings {name}",
			sourceProposalStatus: "superseded",
			workspaceRevision: 0,
		});
		expect(
			(
				await user.query(api.catalogProjection.getActive, { projectId })
			)?.keys[0]?.values.find((value) => value.isSource)?.value,
		).toBe("Greetings {name}");
	}, 20_000);

	test("persists a contract-valid target value beside the immutable Baseline Catalog", async () => {
		const user = await authenticatedBackend(t, "workspace-editor");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const before = await readTarget(user, projectId);
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.canEdit).toBe(true);
		expect(before).toMatchObject({
			localeId: targetId,
			value: "Hallo {name}",
			workspaceRevision: 0,
		});

		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Guten Tag {name}" },
			expectedGitValueFingerprint: before.gitValueFingerprint,
			expectedGitValueRevision: before.gitValueRevision,
			expectedWorkspaceRevision: before.workspaceRevision,
			expectedSourceFingerprint: before.expectedSourceFingerprint,
		});

		expect(await readTarget(user, projectId)).toMatchObject({
			localeId: targetId,
			value: "Guten Tag {name}",
			workspaceRevision: 1,
			valueState: "settled",
		});
		expect(
			(
				await user.query(api.catalogProjection.getActive, { projectId })
			)?.keys[0]?.values.find((value) => !value.isSource)?.value,
		).toBe("Hallo {name}");
	}, 20_000);

	test("keeps a target head across an unchanged Git value and lets a conflicting Git value win", async () => {
		const user = await authenticatedBackend(t, "workspace-git-wins");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const before = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Guten Tag {name}" },
			expectedGitValueFingerprint: before.gitValueFingerprint,
			expectedGitValueRevision: before.gitValueRevision,
			expectedWorkspaceRevision: before.workspaceRevision,
			expectedSourceFingerprint: before.expectedSourceFingerprint,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "unchanged-target",
			baselineCommit: "baseline",
		});
		expect((await readTarget(user, projectId)).value).toBe("Guten Tag {name}");

		await ingestCatalog(user, {
			projectId,
			commit: "changed-target",
			baselineCommit: "unchanged-target",
			german: '{"@@locale":"de","greeting":"Git geändert {name}"}',
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Git geändert {name}",
			workspaceRevision: 0,
		});
		await ingestCatalog(user, {
			projectId,
			commit: "reverted-target",
			baselineCommit: "changed-target",
		});
		const reverted = await readTarget(user, projectId);
		expect(reverted).toMatchObject({
			value: "Hallo {name}",
			gitValueRevision: 2,
			workspaceRevision: 0,
		});
		await expect(
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: targetId,
				intent: { kind: "save", value: "Stale edit {name}" },
				expectedGitValueFingerprint: before.gitValueFingerprint,
				expectedGitValueRevision: before.gitValueRevision,
				expectedWorkspaceRevision: before.workspaceRevision,
				expectedSourceFingerprint: before.expectedSourceFingerprint,
			}),
		).rejects.toThrow("Git value changed");
	}, 20_000);

	test("keeps a pre-fingerprint Baseline Catalog editable", async () => {
		const user = await authenticatedBackend(t, "workspace-legacy-fingerprint");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			const projectionId = project?.activeCatalogProjectionId;
			if (!projectionId) {
				throw new Error("Expected an active Baseline Catalog.");
			}
			const target = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_localeId", (q) =>
					q
						.eq("projectionId", projectionId)
						.eq("messageId", "greeting")
						.eq("localeId", targetId),
				)
				.unique();
			if (!target || target.isSource) {
				throw new Error("Expected the active German Catalog value.");
			}
			await ctx.db.patch(target._id, { valueFingerprint: undefined });
		});

		const before = await readTarget(user, projectId);
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.canEdit).toBe(true);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Guten Tag {name}" },
			expectedGitValueFingerprint: before.gitValueFingerprint,
			expectedGitValueRevision: before.gitValueRevision,
			expectedWorkspaceRevision: before.workspaceRevision,
			expectedSourceFingerprint: before.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Guten Tag {name}",
			valueState: "settled",
		});
	}, 20_000);

	test("refuses malformed ICU and target-only arguments before writing a target head", async () => {
		const user = await authenticatedBackend(t, "workspace-contract");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const before = await readTarget(user, projectId);
		const commit = (value: string) =>
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: targetId,
				intent: { kind: "save", value },
				expectedGitValueFingerprint: before.gitValueFingerprint,
				expectedGitValueRevision: before.gitValueRevision,
				expectedWorkspaceRevision: before.workspaceRevision,
				expectedSourceFingerprint: before.expectedSourceFingerprint,
			});

		await expect(commit("{name")).rejects.toThrow("Contract Validity failed");
		await expect(commit("Hallo {unknown}")).rejects.toThrow(
			"introduces argument",
		);
		await expect(commit("{name, plural, one {One person}}")).rejects.toThrow(
			"has no other arm",
		);
		expect((await readTarget(user, projectId)).workspaceRevision).toBe(0);
	}, 20_000);

	test("accepts a valid structured plural target through the Catalog Workspace seam", async () => {
		const user = await authenticatedBackend(t, "workspace-structured-plural");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, {
			projectId,
			commit: "plural-baseline",
			english:
				'{"@@locale":"en","greeting":"{count, plural, one{One item} other{{count} items}}","@greeting":{"placeholders":{"count":{"type":"int"}}}}',
			german:
				'{"@@locale":"de","greeting":"{count, plural, one{Ein Element} other{{count} Elemente}}"}',
		});
		const before = await readTarget(user, projectId);

		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: {
				kind: "save",
				value:
					"{count, plural, zero{Keine Elemente} one{Ein Element} other{{count} Elemente}}",
			},
			expectedGitValueFingerprint: before.gitValueFingerprint,
			expectedGitValueRevision: before.gitValueRevision,
			expectedWorkspaceRevision: before.workspaceRevision,
			expectedSourceFingerprint: before.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value:
				"{count, plural, zero{Keine Elemente} one{Ein Element} other{{count} Elemente}}",
			valueState: "settled",
		});
	}, 20_000);

	test("keeps an ordinary empty target Waiting until an Intentional Blank records its reason", async () => {
		const user = await authenticatedBackend(t, "workspace-blank");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, {
			projectId,
			commit: "baseline",
			german: '{"@@locale":"de","greeting":""}',
		});

		const waiting = await readTarget(user, projectId);
		expect(waiting).toMatchObject({
			value: "",
			valueState: "waiting",
		});
		await expect(
			user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: targetId,
				intent: { kind: "save", value: "" },
				expectedGitValueFingerprint: waiting.gitValueFingerprint,
				expectedGitValueRevision: waiting.gitValueRevision,
				expectedWorkspaceRevision: waiting.workspaceRevision,
				expectedSourceFingerprint: waiting.expectedSourceFingerprint,
			}),
		).rejects.toThrow("Intentional Blank");

		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "intentionalBlank", reason: "No German label here" },
			expectedGitValueFingerprint: waiting.gitValueFingerprint,
			expectedGitValueRevision: waiting.gitValueRevision,
			expectedWorkspaceRevision: waiting.workspaceRevision,
			expectedSourceFingerprint: waiting.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "",
			valueState: "settled",
			intentionalBlankReason: "No German label here",
		});

		await ingestCatalog(user, {
			projectId,
			commit: "source-changed",
			baselineCommit: "baseline",
			english:
				'{"@@locale":"en","greeting":"Welcome {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			german: '{"@@locale":"de","greeting":""}',
		});
		const afterSourceChange = await readTarget(user, projectId);
		expect(afterSourceChange).toMatchObject({
			value: "",
			valueState: "waiting",
		});
		expect(afterSourceChange).not.toHaveProperty("intentionalBlankReason");
	}, 20_000);

	test("derives Unconfirmed Import until a human confirms the exact content and source wording", async () => {
		const user = await authenticatedBackend(t, "workspace-confirmation");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const imported = await readTarget(user, projectId);
		expect(imported).toMatchObject({ valueState: "unconfirmedImport" });
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.valueStateCounts).toMatchObject({
			waiting: 0,
			unconfirmedImport: 1,
			stale: 0,
			settled: 0,
		});
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: imported.gitValueFingerprint,
			expectedGitValueRevision: imported.gitValueRevision,
			expectedWorkspaceRevision: imported.workspaceRevision,
			expectedSourceFingerprint: imported.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Hallo {name}",
			valueState: "settled",
		});
		const confirmed = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Guten Tag {name}" },
			expectedGitValueFingerprint: confirmed.gitValueFingerprint,
			expectedGitValueRevision: confirmed.gitValueRevision,
			expectedWorkspaceRevision: confirmed.workspaceRevision,
			expectedSourceFingerprint: confirmed.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Guten Tag {name}",
			valueState: "settled",
		});

		await ingestCatalog(user, {
			projectId,
			commit: "git-target-changed",
			baselineCommit: "baseline",
			german: '{"@@locale":"de","greeting":"Git geändert {name}"}',
		});
		const gitChanged = await readTarget(user, projectId);
		expect(gitChanged).toMatchObject({
			value: "Git geändert {name}",
			valueState: "unconfirmedImport",
		});

		await ingestCatalog(user, {
			projectId,
			commit: "git-target-reverted",
			baselineCommit: "git-target-changed",
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Hallo {name}",
			valueState: "settled",
		});

		await ingestCatalog(user, {
			projectId,
			commit: "source-changed",
			baselineCommit: "git-target-reverted",
			english:
				'{"@@locale":"en","greeting":"Welcome {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			german: '{"@@locale":"de","greeting":"Git geändert {name}"}',
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "unconfirmedImport",
		});
	}, 20_000);

	test("derives a semantic stale state when the confirmed Source Contract changes", async () => {
		const user = await authenticatedBackend(t, "workspace-stale-source");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });

		const imported = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: imported.gitValueFingerprint,
			expectedGitValueRevision: imported.gitValueRevision,
			expectedWorkspaceRevision: imported.workspaceRevision,
			expectedSourceFingerprint: imported.expectedSourceFingerprint,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "source-contract-changed",
			baselineCommit: "baseline",
			english:
				'{"@@locale":"en","greeting":"Welcome {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			german: '{"@@locale":"de","greeting":"Hallo {name}"}',
		});

		const stale = await readTarget(user, projectId);
		expect(stale).toMatchObject({
			value: "Hallo {name}",
			valueState: "stale",
			sourceChangeKind: "semantic",
		});
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.valueStateCounts).toMatchObject({
			waiting: 0,
			unconfirmedImport: 0,
			stale: 1,
			settled: 0,
		});

		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: stale.gitValueFingerprint,
			expectedGitValueRevision: stale.gitValueRevision,
			expectedWorkspaceRevision: stale.workspaceRevision,
			expectedSourceFingerprint: stale.expectedSourceFingerprint,
		});
		expect(await readTarget(user, projectId)).toMatchObject({
			valueState: "settled",
		});
	}, 20_000);

	test("derives a cosmetic stale state for whitespace and punctuation-only Source changes", async () => {
		const user = await authenticatedBackend(t, "workspace-stale-cosmetic");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, {
			projectId,
			commit: "baseline",
			english: '{"@@locale":"en","greeting":"Hello"}',
			german: '{"@@locale":"de","greeting":"Hallo"}',
		});

		const imported = await readTarget(user, projectId);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: imported.gitValueFingerprint,
			expectedGitValueRevision: imported.gitValueRevision,
			expectedWorkspaceRevision: imported.workspaceRevision,
			expectedSourceFingerprint: imported.expectedSourceFingerprint,
		});

		await ingestCatalog(user, {
			projectId,
			commit: "source-punctuation-changed",
			baselineCommit: "baseline",
			english: '{"@@locale":"en","greeting":"Hello!"}',
			german: '{"@@locale":"de","greeting":"Hallo"}',
		});

		expect(await readTarget(user, projectId)).toMatchObject({
			value: "Hallo",
			valueState: "stale",
			sourceChangeKind: "cosmetic",
		});
	}, 20_000);

	test("lets a viewer read the Catalog Workspace but not save a target value", async () => {
		const owner = await authenticatedBackend(t, "workspace-owner");
		const projectId = await createProject(owner);
		const { sourceId, targetId } = await bindEnglishAndGerman(owner, projectId);
		await ingestCatalog(owner, { projectId, commit: "baseline" });
		const viewer = await authenticatedBackend(t, "workspace-viewer");
		await owner.mutation(api.projects.addMember, {
			projectId,
			userId: "workspace-viewer",
			role: "viewer",
		});
		const [source, target] = await Promise.all([
			readSource(viewer, projectId),
			readTarget(viewer, projectId),
		]);
		const viewerNavigation = await viewer.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (viewerNavigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(viewerNavigation.canEdit).toBe(false);
		await expect(
			viewer.mutation(api.ordinaryImportRuns.startOrdinaryImportRun, {
				projectId,
				expectedProjectionId: viewerNavigation.projectionId,
				policy: "ordinary-v1" as const,
			}),
		).rejects.toThrow("Insufficient project permissions");
		await expect(
			viewer.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: targetId,
				intent: { kind: "save", value: "Guten Tag {name}" },
				expectedGitValueFingerprint: target.gitValueFingerprint,
				expectedGitValueRevision: target.gitValueRevision,
				expectedWorkspaceRevision: target.workspaceRevision,
				expectedSourceFingerprint: target.expectedSourceFingerprint,
			}),
		).rejects.toThrow("Insufficient project permissions");
		await expect(
			viewer.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: sourceId,
				intent: { kind: "save", value: "Welcome {name}" },
				expectedGitValueFingerprint: source.gitValueFingerprint,
				expectedGitValueRevision: source.gitValueRevision,
				expectedWorkspaceRevision: source.workspaceRevision,
			}),
		).rejects.toThrow("Insufficient project permissions");
	}, 20_000);

	test("runs server-owned ordinary confirmation to completion and is idempotent", async () => {
		const user = await authenticatedBackend(t, "workspace-run-confirm");
		const projectId = await createProject(user);
		await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, {
			projectId,
			commit: "baseline",
			english:
				'{"@@locale":"en","unique":"Hello","same":"Same","repeatOne":"One","repeatTwo":"Two","empty":"Empty"}',
			german:
				'{"@@locale":"de","unique":"Hallo","same":"Same","repeatOne":"OK","repeatTwo":"OK","empty":""}',
		});

		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.ordinaryImports).toMatchObject({
			policy: "ordinary-v1",
			run: null,
			eligible: 3,
			empty: 1,
			sourceIdentical: 1,
			repeated: 0,
		});

		const started = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			},
		);
		expect(started).toMatchObject({ status: "running", confirmed: 0 });

		// Drive the durable run cursor directly; each step is one bounded
		// transaction that advances the same cursor a scheduler-driven worker
		// would advance.
		let run = started;
		for (let step = 0; step < 10 && run.status === "running"; step++) {
			const result = await t.mutation(
				internal.ordinaryImportRuns.runOrdinaryImportStep,
				{ runId: run.runId },
			);
			if (result) run = result;
		}
		expect(run.status).toBe("done");
		expect(run.confirmed).toBe(3);
		expect(run.skipped).toBe(2);

		// The confirmed key leaves the ordinary-import summary at once and the
		// Navigation Index carries the settled state through the projector.
		const after = await user.query(api.catalogWorkspaceNavigation.navigation, {
			projectId,
		});
		if (after.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(after.ordinaryImports).toMatchObject({
			run: { status: "done", confirmed: 3 },
			alreadyConfirmed: 3,
			eligible: 0,
		});
		const uniqueDigest = after.keys.find(
			(digest) => digest.messageId === "unique",
		);
		if (!uniqueDigest) throw new Error("Expected the unique key digest.");
		expect(uniqueDigest.targets[0]).toMatchObject({
			valueState: "settled",
			confirmedGitContent: true,
		});

		// Provenance: the recorded decision is attributed to the user who
		// started the run, not to the server-run machinery.
		const provenance = await t.run(async (ctx) => {
			return await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.withIndex("by_project", (q) => q.eq("projectId", projectId))
				.collect();
		});
		expect(provenance).toHaveLength(3);
		expect(provenance[0]).toMatchObject({
			recordedBy: { kind: "user", id: "workspace-run-confirm" },
		});

		// A second start over the same Baseline is idempotent in outcome: the
		// confirmed value is never re-confirmed, and the content categories
		// stay skipped.
		const restarted = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			},
		);
		expect(restarted.status).toBe("running");
		let secondRun = restarted;
		for (let step = 0; step < 10 && secondRun.status === "running"; step++) {
			const result = await t.mutation(
				internal.ordinaryImportRuns.runOrdinaryImportStep,
				{ runId: secondRun.runId },
			);
			if (result) secondRun = result;
		}
		expect(secondRun).toMatchObject({ status: "done", confirmed: 0 });
	}, 20_000);

	test("persists a diagnostic when an ordinary confirmation step fails", async () => {
		const user = await authenticatedBackend(t, "workspace-run-failure");
		const projectId = await createProject(user);
		await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		const started = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			},
		);
		await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			const projectionId = project?.activeCatalogProjectionId;
			if (!projectionId) {
				throw new Error("Expected the active Catalog Projection.");
			}
			const rows = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId", (q) =>
					q.eq("projectionId", projectionId).eq("messageId", "greeting"),
				)
				.collect();
			const target = rows.find((row) => !row.isSource);
			if (!target) throw new Error("Expected the greeting target row.");
			await ctx.db.delete(target._id);
		});

		const failed = await t.mutation(
			internal.ordinaryImportRuns.runOrdinaryImportStep,
			{ runId: started.runId },
		);
		expect(failed).toMatchObject({
			status: "failed",
			failure: { code: "INTEGRITY" },
		});
		const stored = await t.run(async (ctx) => ctx.db.get(started.runId));
		expect(stored).toMatchObject({
			status: "failed",
			stepPending: false,
			failure: { code: "INTEGRITY" },
		});
	}, 20_000);

	test("a changed Baseline supersedes the running confirmation run", async () => {
		const user = await authenticatedBackend(t, "workspace-run-superseded");
		const projectId = await createProject(user);
		await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}

		const started = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			},
		);

		// A new Baseline publishes while the run is still walking. The
		// scheduled steps race the ingest in this harness, so the run is
		// deterministically re-armed against the OLD projection afterwards:
		// a running run bound to a projection that is no longer active must
		// be marked superseded by the next step.
		await ingestCatalog(user, {
			projectId,
			commit: "next",
			baselineCommit: "baseline",
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(started.runId, {
				status: "running",
				cursor: 0,
				stepPending: true,
			});
		});

		const result = await t.mutation(
			internal.ordinaryImportRuns.runOrdinaryImportStep,
			{ runId: started.runId },
		);
		expect(result).toMatchObject({ status: "superseded" });

		// Starting a fresh run against the stale projection fails outright.
		await expect(
			user.mutation(api.ordinaryImportRuns.startOrdinaryImportRun, {
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			}),
		).rejects.toThrow("changed before the confirmation run started");
	}, 20_000);

	test("skips a concurrently edited value and records the starting user as provenance", async () => {
		const user = await authenticatedBackend(t, "workspace-run-concurrent");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}

		// An editor saves the German value while the catalog is still fully
		// ordinary: the run must skip it as modified instead of confirming
		// over the edit.
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const target = workspace.keys[0]?.values.find((value) => !value.isSource);
		if (!target || target.gitValueFingerprint === undefined) {
			throw new Error("Expected the German Catalog Workspace value.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Hallo {name}" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});

		const started = await user.mutation(
			api.ordinaryImportRuns.startOrdinaryImportRun,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				policy: "ordinary-v1" as const,
			},
		);
		let run = started;
		for (let step = 0; step < 10 && run.status === "running"; step++) {
			const result = await t.mutation(
				internal.ordinaryImportRuns.runOrdinaryImportStep,
				{ runId: run.runId },
			);
			if (result) run = result;
		}
		expect(run).toMatchObject({ status: "done", confirmed: 0 });

		// The touched value is filtered out before the run even counts it, and
		// nothing was confirmed over the edit: the only decision is the
		// translator's own save.
		const decisions = await t.run(async (ctx) => {
			return await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.withIndex("by_project", (q) => q.eq("projectId", projectId))
				.collect();
		});
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			kind: "translatorConfirmation",
			messageId: "greeting",
		});
	}, 20_000);

	test("pages ordinary candidates for the agent without confirmation authority", async () => {
		const user = await authenticatedBackend(t, "workspace-agent-paging");
		const projectId = await createProject(user);
		await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, {
			projectId,
			commit: "baseline",
			english:
				'{"@@locale":"en","greeting":"Hello {name}","farewell":"Goodbye"}',
			german:
				'{"@@locale":"de","greeting":"Hallo {name}","farewell":"Tschüss"}',
		});

		const firstPage = await t.query(
			internal.ordinaryImportRuns.pageOrdinaryImportCandidates,
			{ projectId, cursor: 0, limit: 1 },
		);
		expect(firstPage).toMatchObject({
			policy: "ordinary-v1",
		});
		if (!firstPage) throw new Error("Expected a candidate page.");
		expect(firstPage.candidates).toHaveLength(1);
		expect(firstPage.candidates[0]).toMatchObject({
			sourceFingerprint: expect.any(String),
			valueFingerprint: expect.any(String),
		});
		const nextCursor = firstPage.nextCursor;
		if (typeof nextCursor !== "string") {
			throw new Error("Expected the first page to return an opaque cursor.");
		}

		const secondPage = await t.query(
			internal.ordinaryImportRuns.pageOrdinaryImportCandidates,
			{ projectId, cursor: nextCursor, limit: 1 },
		);
		if (!secondPage) throw new Error("Expected a second candidate page.");
		expect(secondPage.candidates).toHaveLength(1);
		expect(secondPage.candidates[0]?.messageId).not.toBe(
			firstPage.candidates[0]?.messageId,
		);
		expect(secondPage.nextCursor).toBeNull();

		// Paging is a read: it records nothing.
		const decisions = await t.run(async (ctx) => {
			return await ctx.db
				.query("catalogWorkspaceDecisionRecords")
				.withIndex("by_project", (q) => q.eq("projectId", projectId))
				.collect();
		});
		expect(decisions).toEqual([]);
	}, 20_000);
});
