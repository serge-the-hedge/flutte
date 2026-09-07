import { expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";

test("assesses one delta key per step across twenty-four languages", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	try {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "wide-release");
		const projectId = await createProject(owner);
		const [source] = await owner.query(api.locales.list, { projectId });
		if (!source) throw new Error("Missing Source");
		const codes = [
			"de",
			"fr",
			"es",
			"it",
			"ja",
			"ko",
			"pt",
			"ru",
			"zh",
			"nl",
			"sv",
			"da",
			"no",
			"fi",
			"pl",
			"cs",
			"sk",
			"hu",
			"ro",
			"tr",
			"uk",
			"el",
			"he",
		];
		const bindings = [{ localeId: source._id, code: "en" }];
		for (const code of codes)
			bindings.push({
				localeId: await owner.mutation(api.locales.create, { projectId, code }),
				code,
			});
		for (const { localeId, code } of bindings)
			await owner.action(api.locales.bind, {
				localeId,
				catalogPath: `${code}.arb`,
			});
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "wide",
			files: bindings.map(({ code }) => ({
				catalogPath: `${code}.arb`,
				content: JSON.stringify({
					"@@locale": code,
					first: `${code} first`,
					second: `${code} second`,
					third: `${code} third`,
				}),
			})),
		});
		const overview = await owner.query(api.catalogBrowse.overview, {
			projectId,
		});
		if (overview.kind !== "ready") throw new Error("Missing catalog");
		const target = bindings.find((binding) => binding.code === "de");
		if (!target) throw new Error("Missing target");
		const cards = await owner.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: overview.projectionId,
			messageIds: ["first", "second", "third"],
			localeIds: [target.localeId],
		});
		for (const card of cards) {
			const value = card.values.find(
				(value) => value.localeId === target.localeId,
			);
			if (!value?.gitValueFingerprint) throw new Error("Missing target basis");
			await owner.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: card.id,
				localeId: target.localeId,
				intent: { kind: "save", value: `Edited ${card.id}` },
				expectedGitValueFingerprint: value.gitValueFingerprint,
				expectedGitValueRevision: value.gitValueRevision,
				expectedWorkspaceRevision: value.workspaceRevision,
				expectedSourceFingerprint: value.expectedSourceFingerprint,
			});
		}
		const record = await owner.mutation(api.releaseRecords.prepare, {
			projectId,
		});
		for (let count = 1; count <= 3; count++) {
			const step = await t.mutation(internal.releaseRecords.processStep, {
				recordId: record.recordId,
			});
			expect(step).toMatchObject({
				status: "preparing",
				deltaKeyCount: count,
				scopeValueCount: count * codes.length,
			});
		}
		const completed = await t.mutation(internal.releaseRecords.processStep, {
			recordId: record.recordId,
		});
		expect(completed).toMatchObject({
			status: "ready",
			deltaKeyCount: 3,
			scopeValueCount: 69,
		});
	} finally {
		vi.useRealTimers();
	}
});
