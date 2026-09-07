import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	readWorkspaceTarget,
	readWorkspaceTargetEvidence,
} from "./catalogWorkspaceRead";

async function setup(introduced = false) {
	const t = createBackend();
	const user = await authenticatedBackend(t, "workspace-reference-reader");
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const sourceId = locales.find((locale) => locale.isSource)?._id;
	if (!sourceId) throw new Error("Expected source Locale.");
	const targetId = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	for (const [localeId, catalogPath] of [
		[sourceId, "en.arb"],
		[targetId, "de.arb"],
	] as const) {
		await user.action(api.locales.bind, { localeId, catalogPath });
	}
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "en.arb",
				content: introduced
					? '{"@@locale":"en"}'
					: '{"@@locale":"en","greeting":"Hello {name}"}',
			},
			{
				catalogPath: "de.arb",
				content: introduced
					? '{"@@locale":"de"}'
					: '{"@@locale":"de","greeting":"Hallo {name}"}',
			},
		],
	});
	if (introduced) {
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "introduced",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","greeting":"Hello {name}"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","greeting":"Hallo {name}"}',
				},
			],
		});
	}
	async function commit(
		localeId: Id<"locales">,
		intent:
			| { kind: "save"; value: string }
			| { kind: "confirm" }
			| { kind: "intentionalBlank"; reason: string },
	) {
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const value = workspace.keys[0]?.values.find(
			(value) => value.localeId === localeId,
		);
		if (!value?.gitValueFingerprint) throw new Error("Expected current value.");
		return await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId,
			intent,
			expectedGitValueFingerprint: value.gitValueFingerprint,
			expectedGitValueRevision: value.gitValueRevision,
			expectedWorkspaceRevision: value.workspaceRevision,
			expectedSourceFingerprint: value.expectedSourceFingerprint,
		});
	}
	async function read() {
		return await t.run(async (ctx) => {
			const current = await readWorkspaceTarget(
				ctx,
				projectId,
				"greeting",
				targetId,
			);
			return {
				...current,
				evidence: await readWorkspaceTargetEvidence(ctx, current),
			};
		});
	}
	return { t, user, projectId, sourceId, targetId, commit, read };
}

describe("Catalog Workspace reference reads", () => {
	test("shares UI freshness rules while reporting the exact source behind a target", async () => {
		const { t, user, projectId, sourceId, targetId, commit, read } =
			await setup();
		await commit(targetId, { kind: "confirm" });
		const git = await read();
		expect(git.evidence).toMatchObject({
			valueState: "settled",
			sourceMatchesCurrent: true,
			pendingSourceProposal: false,
			contract: { valid: true },
			confirmation: { actor: { kind: "user" } },
		});
		await commit(sourceId, { kind: "save", value: "Welcome {name}" });
		const pending = await read();
		expect(pending.source.value).toBe("Welcome {name}");
		expect(pending.evidence).toMatchObject({
			valueState: "settled",
			sourceMatchesCurrent: false,
			pendingSourceProposal: true,
		});
		await commit(targetId, { kind: "save", value: "Willkommen {name}" });
		const translated = await read();
		expect(translated.effectiveTarget.sourceFingerprint).toBe(
			translated.source.sourceFingerprint,
		);
		expect(translated.target.sourceFingerprint).toBe(
			git.source.sourceFingerprint,
		);
		expect(translated.effectiveTarget.valueFingerprint).toBe(
			translated.valueFingerprint,
		);
		expect(translated.evidence).toMatchObject({
			valueState: "settled",
			sourceMatchesCurrent: true,
			provenance: "workspace",
		});
		await t.run(async (ctx) => {
			if (!translated.currentHead) throw new Error("Expected saved target.");
			await ctx.db.patch(translated.currentHead._id, {
				valueFingerprint: undefined,
			});
		});
		const legacyHead = await read();
		expect(legacyHead.valueFingerprint).toBe(translated.valueFingerprint);
		expect(legacyHead.evidence.valueState).toBe("settled");
		await commit(sourceId, { kind: "save", value: "Good evening {name}" });
		const revised = await read();
		expect(revised.evidence).toMatchObject({
			valueState: "unconfirmedImport",
			sourceMatchesCurrent: false,
			confirmation: null,
		});
		const cards = await readWorkspaceKeyCards(user, projectId);
		expect(
			cards.keys[0]?.values.find((value) => !value.isSource),
		).toMatchObject({ valueState: revised.evidence.valueState });
	}, 20_000);

	test("rejects an archived target even while its projection row remains", async () => {
		const { user, targetId, read } = await setup();
		await user.mutation(api.locales.archive, { localeId: targetId });
		await expect(read()).rejects.toThrow("target Locale is not active");
	});

	test("distinguishes imported text awaiting First Review from human-confirmed evidence", async () => {
		const { targetId, read, commit } = await setup(true);
		expect((await read()).evidence).toMatchObject({
			firstReviewPending: true,
			valueState: "unconfirmedImport",
			confirmation: null,
		});
		await commit(targetId, { kind: "confirm" });
		expect((await read()).evidence).toMatchObject({
			firstReviewPending: false,
			valueState: "settled",
			confirmation: { actor: { kind: "user" } },
		});
	});

	test("keeps intentional blank evidence and detects invalid imported contracts", async () => {
		const { t, targetId, commit, read } = await setup();
		await commit(targetId, {
			kind: "intentionalBlank",
			reason: "The label is intentionally hidden in German.",
		});
		const blank = await read();
		expect(blank.evidence).toMatchObject({
			valueState: "settled",
			intentionalBlankReason: "The label is intentionally hidden in German.",
			confirmation: { kind: "intentionalBlank", actor: { kind: "user" } },
			contract: { valid: true },
		});
		// Imported catalog evidence can predate the current contract validator.
		await t.run(async (ctx) => {
			if (blank.currentHead) await ctx.db.delete(blank.currentHead._id);
			await ctx.db.patch(blank.target._id, {
				value: "Hallo {unknown}",
				valueFingerprint: undefined,
			});
		});
		expect((await read()).evidence.contract).toMatchObject({
			valid: false,
			code: "VALIDATION",
		});
	});
});
