import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import {
	readWorkspaceTarget,
	readWorkspaceTargetEvidence,
} from "./catalogWorkspaceRead";

async function setup() {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "evidence-owner");
	const projectId = await createProject(owner);
	const source = (await owner.query(api.locales.list, { projectId }))[0];
	if (!source) throw new Error("Expected Source Locale.");
	const targetId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await owner.mutation(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await owner.mutation(api.locales.bind, {
		localeId: targetId,
		catalogPath: "de.arb",
	});
	async function ingest(
		commit: string,
		baselineCommit?: string,
		german = "Hallo",
		english = "Hello",
	) {
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(baselineCommit
				? {
						lineage: {
							baselineCommit,
							relationship: "descendant" as const,
							mergeBase: baselineCommit,
						},
					}
				: {}),
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({
						"@@locale": "en",
						existing: "Existing",
						...(baselineCommit ? { greeting: english } : {}),
					}),
				},
				{
					catalogPath: "de.arb",
					content: JSON.stringify({
						"@@locale": "de",
						existing: "Vorhanden",
						...(baselineCommit ? { greeting: german } : {}),
					}),
				},
			],
		});
	}
	await ingest("bootstrap");
	await ingest("introduced", "bootstrap");
	async function confirm() {
		const workspace = await readWorkspaceKeyCards(owner, projectId);
		const target = workspace.keys
			.find((key) => key.id === "greeting")
			?.values.find((value) => value.localeId === targetId);
		if (!target?.gitValueFingerprint) throw new Error("Expected Target basis.");
		await owner.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: targetId,
			intent: { kind: "confirm" },
			expectedGitValueFingerprint: target.gitValueFingerprint,
			expectedGitValueRevision: target.gitValueRevision,
			expectedWorkspaceRevision: target.workspaceRevision,
			expectedSourceFingerprint: target.expectedSourceFingerprint,
		});
	}
	async function evidence() {
		return await t.run(async (ctx) =>
			readWorkspaceTargetEvidence(
				ctx,
				await readWorkspaceTarget(ctx, projectId, "greeting", targetId),
			),
		);
	}
	return { t, owner, projectId, targetId, ingest, confirm, evidence };
}

describe("Indexed Workspace reference evidence", () => {
	test("reads a constant number of relevant decisions despite substantial history", async () => {
		const f = await setup();
		await f.confirm();
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 1000; index++)
				await ctx.db.insert("catalogWorkspaceDecisionRecords", {
					projectId: f.projectId,
					messageId: "greeting",
					localeId: f.targetId,
					sourceFingerprint: `historical-source-${index}`,
					valueFingerprint: `historical-value-${index}`,
					kind: "translatorConfirmation",
					recordedBy: { kind: "user", id: "historical-user" },
					recordedAt: 0,
				});
		});
		const { result, decisionRowsRead } = await f.t.run(async (ctx) => {
			let decisionRowsRead = 0;
			function track<T extends object>(builder: T): T {
				return new Proxy(builder, {
					get(target, property) {
						const method: unknown = Reflect.get(target, property);
						if (typeof method !== "function") return method;
						return (...args: unknown[]) => {
							const result: unknown = Reflect.apply(method, target, args);
							if (property === "take")
								return Promise.resolve(result).then((rows) => {
									if (Array.isArray(rows)) decisionRowsRead += rows.length;
									return rows;
								});
							return result !== null && typeof result === "object"
								? track(result)
								: result;
						};
					},
				});
			}
			const db = new Proxy(ctx.db, {
				get(target, property) {
					if (property === "query")
						return (table: Parameters<typeof ctx.db.query>[0]) => {
							const query = target.query(table);
							return table === "catalogWorkspaceDecisionRecords"
								? track(query)
								: query;
						};
					return Reflect.get(target, property);
				},
			});
			const current = await readWorkspaceTarget(
				ctx,
				f.projectId,
				"greeting",
				f.targetId,
			);
			return {
				result: await readWorkspaceTargetEvidence({ ...ctx, db }, current),
				decisionRowsRead,
			};
		});
		expect(decisionRowsRead).toBeLessThanOrEqual(3);
		expect(result).toMatchObject({
			valueState: "settled",
			firstReviewPending: false,
			confirmation: {
				kind: "translatorConfirmation",
				decisionId: expect.any(String),
			},
			reference: {
				messageId: "greeting",
				localeId: f.targetId,
				snapshotId: expect.any(String),
				valueFingerprint: expect.any(String),
			},
		});
	});

	test("retains completed First Review across changed values and matches cosmetic stale classification", async () => {
		const f = await setup();
		expect(await f.evidence()).toMatchObject({
			firstReviewPending: true,
			confirmation: null,
		});
		await f.confirm();
		await f.ingest("cosmetic-source", "introduced", "Hallo", "Hello!");
		expect(await f.evidence()).toMatchObject({
			firstReviewPending: false,
			valueState: "stale",
			sourceChangeKind: "cosmetic",
			confirmation: null,
		});
		await f.ingest("changed-target", "cosmetic-source", "Guten Tag", "Hello!");
		expect(await f.evidence()).toMatchObject({
			firstReviewPending: false,
			valueState: "unconfirmedImport",
			confirmation: null,
		});
		await f.t.run(async (ctx) => {
			const state = await ctx.db
				.query("catalogWorkspaceNavigationStates")
				.withIndex("by_project", (q) => q.eq("projectId", f.projectId))
				.unique();
			if (!state) throw new Error("Expected Navigation state.");
			await ctx.db.patch(state._id, { status: "staging" });
		});
		await expect(f.evidence()).rejects.toThrow("Navigation Index backfill");
	});
});
