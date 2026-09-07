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
import type { Doc, Id } from "./_generated/dataModel";
import {
	deriveNavigationDigest,
	navigationDigestByteLength,
} from "./catalogWorkspaceNavigation";

const ENGLISH =
	'{"@@locale":"en","greeting":"Hello {name}","@greeting":{"placeholders":{"name":{"type":"String"}}},"farewell":"Goodbye"}';
const GERMAN =
	'{"@@locale":"de","greeting":"Hallo {name}","farewell":"Tschüss"}';

let t: Backend;

beforeEach(() => {
	t = createBackend();
});

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

async function ingestCatalog(
	user: AuthenticatedBackend,
	input: {
		projectId: Id<"projects">;
		commit: string;
	},
) {
	return await user.action(api.snapshots.ingest, {
		projectId: input.projectId,
		repository: "repo",
		commit: input.commit,
		files: [
			{ catalogPath: "en.arb", content: ENGLISH },
			{ catalogPath: "de.arb", content: GERMAN },
		],
	});
}

async function readWorkspace(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	return await readWorkspaceKeyCards(user, projectId);
}

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;

function workspaceValueOrThrow(
	workspace: Workspace | undefined,
	messageId: string,
	predicate: (value: { isSource: boolean }) => boolean,
) {
	const key = workspace?.keys.find((entry) => entry.id === messageId);
	const value = key?.values.find(predicate);
	if (!value) {
		throw new Error("Expected the Catalog Workspace value.");
	}
	const withTokens = value as Workspace["keys"][number]["values"][number] & {
		gitValueFingerprint: string;
		gitValueRevision: number;
		workspaceRevision: number;
		expectedSourceFingerprint: string;
	};
	if (
		withTokens.gitValueFingerprint === undefined ||
		withTokens.gitValueRevision === undefined ||
		withTokens.workspaceRevision === undefined ||
		withTokens.expectedSourceFingerprint === undefined
	) {
		throw new Error("Expected the Catalog Workspace concurrency tokens.");
	}
	return withTokens;
}

type EvidenceDb = {
	db: Parameters<Parameters<typeof t.run>[0]>[0]["db"];
};

async function navigationEvidence(
	ctx: EvidenceDb,
	projectId: Id<"projects">,
	messageId: string,
) {
	const project = await ctx.db.get(projectId);
	const projectionId = project?.activeCatalogProjectionId;
	if (!projectionId) {
		throw new Error("Expected an active Baseline Catalog.");
	}
	const rows = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_messageId", (q) =>
			q.eq("projectionId", projectionId).eq("messageId", messageId),
		)
		.collect();
	const heads = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.collect();
	const decisions = await ctx.db
		.query("catalogWorkspaceDecisionRecords")
		.withIndex("by_value_identity", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.collect();
	const proposalHead = await ctx.db
		.query("catalogWorkspaceSourceProposalHeads")
		.withIndex("by_project_and_messageId", (q) =>
			q.eq("projectId", projectId).eq("messageId", messageId),
		)
		.unique();
	const digest = await deriveNavigationDigest({
		compactSearchCorpus: true,
		projectId,
		projectionId,
		rows,
		heads,
		decisions,
		sourceProposalHead: proposalHead,
		sourceProposalResolution: null,
	});
	return { projectionId, digest };
}

async function readNavigationRow(
	ctx: EvidenceDb,
	projectId: Id<"projects">,
	messageId: string,
) {
	const project = await ctx.db.get(projectId);
	const projectionId = project?.activeCatalogProjectionId;
	if (!projectionId) return null;
	return await ctx.db
		.query("catalogWorkspaceNavigationRows")
		.withIndex("by_project_and_projection_and_messageId", (q) =>
			q
				.eq("projectId", projectId)
				.eq("projectionId", projectionId)
				.eq("messageId", messageId),
		)
		.unique();
}

async function readNavigationState(ctx: EvidenceDb, projectId: Id<"projects">) {
	return await ctx.db
		.query("catalogWorkspaceNavigationStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

function stripSystemFields(row: Doc<"catalogWorkspaceNavigationRows">) {
	return {
		projectId: row.projectId,
		projectionId: row.projectionId,
		messageId: row.messageId,
		catalogIndex: row.catalogIndex,
		searchCorpus: row.searchCorpus,
		pendingSourceProposal: row.pendingSourceProposal,
		introductionReviewPending: row.introductionReviewPending ?? 0,
		source: row.source,
		targets: row.targets.map((target) => ({
			...target,
			firstReviewPending: target.firstReviewPending ?? false,
		})),
	};
}

describe("Catalog Navigation Index", () => {
	test("keeps the digest equal to a fresh derivation after a direct save", async () => {
		const user = await authenticatedBackend(t, "nav-save");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const workspace = await readWorkspace(user, projectId);
		const target = workspaceValueOrThrow(
			workspace,
			"greeting",
			(value) => !value.isSource,
		);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Hallo auch {name}" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		const { row, state, fresh, freshFarewell } = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const state = await readNavigationState(ctx, projectId);
			const { digest } = await navigationEvidence(ctx, projectId, "greeting");
			const farewell = await navigationEvidence(ctx, projectId, "farewell");
			return {
				row,
				state,
				fresh: digest,
				freshFarewell: farewell.digest,
			};
		});
		if (!row || !state) throw new Error("Expected the Navigation digest.");
		expect(stripSystemFields(row)).toEqual(fresh);
		expect(row.targets[0]).toMatchObject({
			valueState: "settled",
			touched: true,
		});
		expect(row.searchCorpus).toEqual([row.messageId]);
		// Publication staged the whole generation: both fixture keys are
		// indexed, not just the one the test touched.
		expect(state).toMatchObject({ rowCount: 2, status: "ready" });
		expect(state.byteLength).toBe(
			navigationDigestByteLength(fresh) +
				navigationDigestByteLength(freshFarewell),
		);
		expect(state.byteLength).toBeGreaterThan(0);
	}, 30_000);

	test("keeps the digest settled after an untouched confirmation", async () => {
		const user = await authenticatedBackend(t, "nav-confirm");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const workspace = await readWorkspace(user, projectId);
		const target = workspaceValueOrThrow(
			workspace,
			"greeting",
			(value) => !value.isSource,
		);
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
		const { row, fresh } = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const { digest } = await navigationEvidence(ctx, projectId, "greeting");
			return { row, fresh: digest };
		});
		if (!row) throw new Error("Expected the Navigation digest.");
		expect(stripSystemFields(row)).toEqual(fresh);
		expect(row.targets[0]).toMatchObject({
			valueState: "settled",
			touched: false,
			confirmedGitContent: true,
		});
	}, 30_000);

	test("keeps the digest blank-settled after an Intentional Blank", async () => {
		const user = await authenticatedBackend(t, "nav-blank");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const workspace = await readWorkspace(user, projectId);
		const target = workspaceValueOrThrow(
			workspace,
			"farewell",
			(value) => !value.isSource,
		);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "farewell",
			localeId: targetId,
			intent: { kind: "intentionalBlank", reason: "Not used in German" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		const { row, fresh } = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "farewell");
			const { digest } = await navigationEvidence(ctx, projectId, "farewell");
			return { row, fresh: digest };
		});
		if (!row) throw new Error("Expected the Navigation digest.");
		expect(stripSystemFields(row)).toEqual(fresh);
		expect(row.targets[0]).toMatchObject({ valueState: "settled" });
		expect(row.searchCorpus).toEqual([row.messageId]);
	}, 30_000);

	test("marks the key pending when a Source Proposal is proposed through commit", async () => {
		const user = await authenticatedBackend(t, "nav-proposal");
		const projectId = await createProject(user);
		const { sourceId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const workspace = await readWorkspace(user, projectId);
		const source = workspaceValueOrThrow(
			workspace,
			"greeting",
			(value) => value.isSource,
		);
		if (source.localeId !== sourceId) {
			throw new Error("Expected the English source value.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: sourceId,
			intent: { kind: "save", value: "Hi there {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});
		const { row, fresh } = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const { digest } = await navigationEvidence(ctx, projectId, "greeting");
			return { row, fresh: digest };
		});
		if (!row) throw new Error("Expected the Navigation digest.");
		expect(stripSystemFields(row)).toEqual(fresh);
		expect(row.pendingSourceProposal).toBe(true);
		expect(row.searchCorpus).toEqual([row.messageId]);
	}, 30_000);

	test("recomputing the same key leaves the digest byte-identical", async () => {
		const user = await authenticatedBackend(t, "nav-idempotent");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		const workspace = await readWorkspace(user, projectId);
		const target = workspaceValueOrThrow(
			workspace,
			"greeting",
			(value) => !value.isSource,
		);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "save", value: "Noch einmal {name}" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		const before = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const state = await readNavigationState(ctx, projectId);
			return { row: JSON.stringify(row), state: JSON.stringify(state) };
		});
		await user.mutation(
			internal.catalogWorkspaceNavigation.recomputeNavigationRowsMutation,
			{ projectId, messageIds: ["greeting"] },
		);
		const after = await t.run(async (ctx) => {
			const row = await readNavigationRow(ctx, projectId, "greeting");
			const state = await readNavigationState(ctx, projectId);
			return { row: JSON.stringify(row), state: JSON.stringify(state) };
		});
		expect(after).toEqual(before);
	}, 30_000);

	test("keeps a populated post-bootstrap key in First Review until a person confirms it", async () => {
		const user = await authenticatedBackend(t, "nav-introduced");
		const projectId = await createProject(user);
		const { targetId } = await bindEnglishAndGerman(user, projectId);
		await ingestCatalog(user, { projectId, commit: "baseline" });
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","greeting":"Hello {name}","@greeting":{"placeholders":{"name":{"type":"String"}}},"farewell":"Goodbye","newKey":"Draft source"}',
				},
				{
					catalogPath: "de.arb",
					content:
						'{"@@locale":"de","greeting":"Hallo {name}","farewell":"Tschüss","newKey":"Platzhalter"}',
				},
			],
		});
		const before = await t.run(async (ctx) => ({
			row: await readNavigationRow(ctx, projectId, "newKey"),
			state: await readNavigationState(ctx, projectId),
		}));
		expect(before.row).toMatchObject({
			introductionReviewPending: 1,
			targets: [{ localeId: targetId, firstReviewPending: true }],
		});
		expect(before.state?.ordinaryImportCounts).toMatchObject({
			introduced: 1,
		});

		const workspace = await readWorkspace(user, projectId);
		const target = workspaceValueOrThrow(
			workspace,
			"newKey",
			(value) => !value.isSource,
		);
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "newKey",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
		const after = await t.run(
			async (ctx) => await readNavigationRow(ctx, projectId, "newKey"),
		);
		expect(after).toMatchObject({
			introductionReviewPending: 0,
			targets: [{ localeId: targetId, firstReviewPending: false }],
		});
	}, 30_000);

	test("recompute without an active Baseline stays a no-op", async () => {
		const user = await authenticatedBackend(t, "nav-empty");
		const projectId = await createProject(user);
		await user.mutation(
			internal.catalogWorkspaceNavigation.recomputeNavigationRowsMutation,
			{ projectId, messageIds: ["greeting"] },
		);
		const counts = await t.run(async (ctx) => ({
			rowCount: (await ctx.db.query("catalogWorkspaceNavigationRows").collect())
				.length,
			stateCount: (
				await ctx.db.query("catalogWorkspaceNavigationStates").collect()
			).length,
		}));
		expect(counts.rowCount).toBe(0);
		expect(counts.stateCount).toBe(0);
	}, 30_000);
});
