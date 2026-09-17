import { expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";

test("source proposal edits invalidate search bookmarks", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	try {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "search-review");
		const projectId = await createProject(owner);
		// A deployed project can already have a strict proposal revision. Its
		// first write must preserve that basis while leaving project readers alone.
		await t.run((ctx) =>
			ctx.db.patch(projectId, { sourceProposalHeadVersion: 41 }),
		);
		const [en] = await owner.query(api.locales.list, { projectId });
		if (!en) throw Error("No source");
		await owner.action(api.locales.bind, {
			localeId: en._id,
			catalogPath: "en.arb",
		});
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "initial",
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({ "@@locale": "en", key: "Original" }),
				},
			],
		});
		const projectBeforeEdits = await t.run((ctx) => ctx.db.get(projectId));
		let expectedProposalRevision = 41;
		for (const value of ["First proposal", "Second proposal"]) {
			const workspace = await readWorkspaceKeyCards(owner, projectId);
			const source = workspace.keys[0]?.values[0];
			if (!source?.gitValueFingerprint) throw Error("No value");
			const before = await owner.query(api.catalogBrowse.overview, {
				projectId,
			});
			if (before.kind !== "ready") throw Error("No browse");
			await owner.mutation(api.catalogWorkspace.commit, {
				projectId,
				localeId: en._id,
				messageId: "key",
				intent: { kind: "save", value },
				expectedGitValueFingerprint: source.gitValueFingerprint,
				expectedGitValueRevision: source.gitValueRevision,
				expectedWorkspaceRevision: source.workspaceRevision,
			});
			expect(await t.run((ctx) => ctx.db.get(projectId))).toEqual(
				projectBeforeEdits,
			);
			const proposalState = await t.run((ctx) =>
				ctx.db
					.query("catalogWorkspaceSourceProposalStates")
					.withIndex("by_project", (q) => q.eq("projectId", projectId))
					.unique(),
			);
			expect(proposalState?.proposalSetRevision).toBe(
				++expectedProposalRevision,
			);
			const after = await owner.query(api.catalogBrowse.overview, {
				projectId,
			});
			if (after.kind !== "ready") throw Error("No browse");

			const matches = await owner.query(api.catalogBrowse.page, {
				projectId,
				projectionId: after.projectionId,
				q: value,
				localeIds: [],
			});
			expect(matches.keys.map((key) => key.messageId)).toEqual(["key"]);
			const previous = await owner.query(api.catalogBrowse.page, {
				projectId,
				projectionId: after.projectionId,
				q: value === "First proposal" ? "Original" : "First proposal",
				localeIds: [],
			});
			expect(previous.keys).toEqual([]);
			expect(after.revision).toBeGreaterThan(before.revision);
		}
	} finally {
		vi.useRealTimers();
	}
});
