import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib";

async function setup() {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "languages-owner");
	const projectId = await createProject(owner);
	const source = (await owner.query(api.locales.list, { projectId }))[0];
	if (!source) throw new Error("Missing Source Locale.");
	await owner.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "lib/l10n/intl_en.arb",
	});
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "lib/l10n/intl_en.arb",
				content: '{"@@locale":"en","hello":"Hello"}',
			},
		],
	});
	const { token } = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose"],
	});
	const request = (path: string, body?: unknown) =>
		t.fetch(`/api/agent/v1/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"X-Blabla-CLI-Version": "0.2.0",
				"X-Blabla-CLI-Protocol": "1",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { t, owner, projectId, request };
}

const italian = {
	localeCode: "it",
	label: "Italian",
	catalogPath: "lib/l10n/italian.arb",
	runtimeLocale: "it-IT",
};

describe("configured Locale introduction", () => {
	test("discovers explicit targets, creates arbitrary agent tasks, and pins delivery identity across configuration changes", async () => {
		const f = await setup();
		expect(await (await f.request("projects/current")).json()).toMatchObject({
			capabilities: { newLocaleTargets: [] },
		});
		const unconfigured = await f.request("translation-tasks", {
			clientTaskKey: "italian",
			target: { kind: "newLocale", localeCode: "it" },
		});
		expect(unconfigured.status).toBe(400);
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			...italian,
		});
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			localeCode: "sr",
			label: "Serbian Latin",
			catalogPath: "lib/l10n/serbian.arb",
			runtimeLocale: "sr-Latn-RS",
		});
		expect(await (await f.request("projects/current")).json()).toMatchObject({
			capabilities: { newLocaleTargets: ["it", "sr"] },
		});
		const response = await f.request("translation-tasks", {
			clientTaskKey: "italian",
			target: { kind: "newLocale", localeCode: "it" },
		});
		expect(response.status, await response.clone().text()).toBe(200);
		const task = (await response.json()) as {
			taskId: Id<"agentTranslationProposals">;
			localeCode: string;
		};
		expect(task.localeCode).toBe("it");
		const proposalId = await f.owner.query(
			api.localeProposals.currentForReview,
			{ projectId: f.projectId, localeCode: "it" },
		);
		if (!proposalId) throw new Error("Missing Italian proposal.");
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			...italian,
			label: "Changed label",
			catalogPath: "lib/l10n/new_it.arb",
			runtimeLocale: "it-CH",
		});
		await f.owner.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId,
			items: [
				{
					messageId: "hello",
					value: "Ciao",
					sourceFingerprint: await sha256Hex("Hello"),
				},
			],
		});
		await f.owner.action(api.localeProposals.finalizeForReview, {
			projectId: f.projectId,
			proposalId,
		});
		const artifact = await f.owner.action(
			api.localeProposals.artifactForReview,
			{ projectId: f.projectId, proposalId },
		);
		expect(artifact).toMatchObject({
			version: 1,
			locale: { code: "it", label: "Italian", runtimeLocale: "it-IT" },
			catalog: { fileName: "italian.arb", catalogPath: italian.catalogPath },
		});
		expect(JSON.parse(artifact.catalog.content)).toMatchObject({
			"@@locale": "it",
			hello: "Ciao",
		});
		const downloaded = await f.request(
			`locale-proposals/artifact?proposalId=${proposalId}`,
		);
		expect(downloaded.status, await downloaded.clone().text()).toBe(200);
		expect(await downloaded.json()).toEqual(artifact);
		const stored = await f.t.run((ctx) => ctx.db.get(proposalId));
		expect(stored?.catalogContentHash).toBe(
			await sha256Hex(artifact.catalog.content),
		);
		await f.owner.mutation(api.localeIntroductionTargets.remove, {
			projectId: f.projectId,
			localeCode: "it",
		});
		expect(
			await f.owner.action(api.localeProposals.artifactForReview, {
				projectId: f.projectId,
				proposalId,
			}),
		).toEqual(artifact);
		const filtered = await f.owner.query(
			api.agentTranslationProposals.listForReview,
			{
				projectId: f.projectId,
				localeCode: "sr",
				paginationOpts: { numItems: 1, cursor: null },
			},
		);
		expect(filtered.page).toEqual([]);
	});

	test("rejects unsafe setup and unauthorized writes while allowing script and region runtime mappings", async () => {
		const f = await setup();
		const outsider = await authenticatedBackend(f.t, "languages-outsider");
		await expect(
			outsider.mutation(api.localeIntroductionTargets.save, {
				projectId: f.projectId,
				...italian,
			}),
		).rejects.toThrow();
		for (const invalid of [
			{ localeCode: "sr-Latn" },
			{ catalogPath: "../it.arb" },
			{ runtimeLocale: "it_ITA" },
			{ runtimeLocale: "ja-JP" },
			{ catalogPath: "other/italian.arb" },
			{ catalogPath: "lib/l10n/italian.file.arb" },
			{ localeCode: "en" },
			{ catalogPath: "lib/l10n/intl_en.arb" },
		]) {
			await expect(
				f.owner.mutation(api.localeIntroductionTargets.save, {
					projectId: f.projectId,
					...italian,
					...invalid,
				}),
			).rejects.toThrow();
		}
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			...italian,
		});
		await expect(
			f.owner.mutation(api.localeIntroductionTargets.save, {
				projectId: f.projectId,
				...italian,
				localeCode: "ja",
				runtimeLocale: "ja-JP",
			}),
		).rejects.toThrow("catalog path");
		await f.owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId: f.projectId,
			expectedRevision: 0,
			localeCode: "it",
			text: "Use friendly forms.",
			examples: [],
		});
		await f.owner.mutation(api.localeIntroductionTargets.remove, {
			projectId: f.projectId,
			localeCode: "it",
		});
		await f.owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId: f.projectId,
			expectedRevision: 1,
			localeCode: "it",
			text: "",
			examples: [],
		});
		expect(
			(
				await f.owner.query(api.translationGuidance.list, {
					projectId: f.projectId,
				})
			).guides,
		).toEqual([]);
	});

	test("continues the same configured language after Source changes", async () => {
		const f = await setup();
		await f.owner.mutation(api.localeIntroductionTargets.save, {
			projectId: f.projectId,
			...italian,
		});
		const task = await f.owner.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId: f.projectId,
				title: "Italian",
				target: { kind: "newLocale", localeCode: "it" },
				scope: { kind: "completeCatalog" },
			},
		);
		const proposalId = await f.owner.query(
			api.localeProposals.currentForReview,
			{ projectId: f.projectId, localeCode: "it" },
		);
		if (!proposalId) throw new Error("Missing proposal.");
		await f.owner.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId,
			items: [
				{
					messageId: "hello",
					value: "Ciao",
					sourceFingerprint: await sha256Hex("Hello"),
				},
			],
		});
		await f.owner.action(api.snapshots.ingest, {
			projectId: f.projectId,
			repository: "repo",
			commit: "next",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "lib/l10n/intl_en.arb",
					content: '{"@@locale":"en","hello":"Hello","bye":"Goodbye"}',
				},
			],
		});
		const continued = await f.owner.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: task.taskId },
		);
		expect(continued).toMatchObject({
			localeCode: "it",
			carriedValueCount: 1,
			remainingValueCount: 1,
		});
		expect(continued.localeProposalId).not.toBe(proposalId);
		const values = await f.t.query(
			internal.localeProposals.valuesForFinalization,
			{ projectId: f.projectId, proposalId: continued.localeProposalId },
		);
		expect(values.values[0]).toMatchObject({
			value: "Ciao",
			updatedBy: { kind: "user" },
		});
	});
});
