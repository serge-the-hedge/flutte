import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { realizeLocaleBinding } from "./snapshots";

beforeEach(() =>
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	}),
);
afterEach(() => vi.useRealTimers());

test.each(["source", "restore"] as const)(
	"a racing %s proposal rejects staged publication after moving the legacy revision",
	async (kind) => {
		const t = createBackend({ transactionLimits: true });
		const user = await authenticatedBackend(t, `publication-race-${kind}`);
		const projectId = await createProject(user);
		const [source] = await user.query(api.locales.list, { projectId });
		if (!source) throw new Error("Missing source language");
		await user.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "en.arb",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "initial",
			files: [
				{
					catalogPath: "en.arb",
					content:
						'{"@@locale":"en","greeting":"Hello","recover":"Recover me"}',
				},
			],
		});
		const baseline = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "current",
			lineage: {
				baselineCommit: "initial",
				relationship: "descendant",
				mergeBase: "initial",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","greeting":"Hello"}',
				},
				{
					catalogPath: "fr.arb",
					content: '{"@@locale":"fr","greeting":"Bonjour"}',
				},
			],
		});
		if (!baseline.snapshotId) throw new Error("Missing baseline");
		const french = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
		});
		await t.run((ctx) =>
			ctx.db.patch(projectId, { sourceProposalHeadVersion: 41 }),
		);
		const before = await t.run((ctx) => ctx.db.get(projectId));
		const plan = await user.query(internal.locales.bindingPlan, {
			localeId: french,
			catalogPath: "fr.arb",
		});
		if (!plan.unboundFile) throw new Error("Missing unbound French evidence");
		const input = {
			projectId,
			localeId: french,
			catalogPath: "fr.arb",
			snapshotId: baseline.snapshotId,
			unboundFileId: plan.unboundFile._id,
		};
		let injected = false;
		await expect(
			user.action(async (ctx) => {
				const runMutation: ActionCtx["runMutation"] = async (
					mutation,
					args,
				) => {
					if (
						!injected &&
						getFunctionName(mutation) === "snapshots:publishBindingRealization"
					) {
						injected = true;
						if (kind === "restore") {
							await user.mutation(api.restoreProposals.request, {
								projectId,
								messageId: "recover",
							});
						} else {
							const workspace = await readWorkspaceKeyCards(user, projectId);
							const value = workspace.keys[0]?.values.find(
								(item) => item.localeId === source._id,
							);
							if (!value?.gitValueFingerprint)
								throw new Error("Missing source value");
							await user.mutation(api.catalogWorkspace.commit, {
								projectId,
								localeId: source._id,
								messageId: "greeting",
								intent: { kind: "save", value: "Hi there" },
								expectedGitValueFingerprint: value.gitValueFingerprint,
								expectedGitValueRevision: value.gitValueRevision,
								expectedWorkspaceRevision: value.workspaceRevision,
							});
						}
					}
					return ctx.runMutation(mutation, args);
				};
				await realizeLocaleBinding({ ...ctx, runMutation }, input);
			}),
		).rejects.toThrow(
			"Source Proposal set changed while catalog reconciliation was staged",
		);
		expect(injected).toBe(true);
		// The canonical proposal survives; the rejected private publication does not.
		expect(await t.run((ctx) => ctx.db.get(projectId))).toEqual(before);
		expect(
			(await user.query(api.locales.list, { projectId })).find(
				(locale) => locale._id === french,
			)?.catalogPath,
		).toBeUndefined();
		await user.action(api.locales.bind, {
			localeId: french,
			catalogPath: "fr.arb",
		});
		expect(
			(await user.query(api.locales.list, { projectId })).find(
				(locale) => locale._id === french,
			)?.catalogPath,
		).toBe("fr.arb");
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	},
);
