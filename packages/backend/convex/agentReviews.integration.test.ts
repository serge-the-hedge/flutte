import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup(introduced = false) {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "owner");
	const projectId = await createProject(owner);
	const source = (await owner.query(api.locales.list, { projectId }))[0];
	if (!source) throw new Error("Expected source Locale");
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await owner.mutation(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await owner.mutation(api.locales.bind, { localeId, catalogPath: "de.arb" });
	if (introduced)
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "bootstrap",
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","existing":"Existing"}',
				},
				{
					catalogPath: "de.arb",
					content: '{"@@locale":"de","existing":"Vorhanden"}',
				},
			],
		});
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		...(introduced
			? {
					lineage: {
						baselineCommit: "bootstrap",
						relationship: "descendant" as const,
						mergeBase: "bootstrap",
					},
				}
			: {}),
		files: [
			{
				catalogPath: "en.arb",
				content:
					'{"@@locale":"en","greeting":"Hello {name}","@greeting":{"placeholders":{"name":{"type":"String"}}}}',
			},
			{
				catalogPath: "de.arb",
				content: '{"@@locale":"de","greeting":"Hallo {name}"}',
			},
		],
	});
	const translator = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "propose"],
	});
	const reviewer = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Reviewer",
		scopes: ["read", "review"],
	});
	const task = await owner.mutation(api.agentTranslationProposals.createTask, {
		projectId,
		title: "Greeting",
		target: { kind: "existingLocale", localeId },
		scope: { kind: "selectedMessages", messageIds: ["greeting"] },
	});
	const workspace = await readWorkspaceKeyCards(owner, projectId);
	const target = workspace.keys
		.find((key) => key.id === "greeting")
		?.values.find((value) => value.localeId === localeId);
	if (
		!target?.snapshotId ||
		target.gitValueFingerprint === undefined ||
		target.gitValueRevision === undefined ||
		target.workspaceRevision === undefined ||
		target.expectedSourceFingerprint === undefined
	)
		throw new Error("Expected target basis");
	const basis = {
		kind: "catalogWorkspace" as const,
		projectionId: workspace.projectionId,
		snapshotId: target.snapshotId,
		gitValueFingerprint: target.gitValueFingerprint,
		gitValueRevision: target.gitValueRevision,
		workspaceRevision: target.workspaceRevision,
		sourceFingerprint: target.expectedSourceFingerprint,
	};
	async function submit(
		value = "Guten Tag {name}",
		expectedCandidateRevision = 0,
		intentionalBlankReason?: string,
	) {
		const result = await t.mutation(
			internal.agentTranslationProposals.submitRevisions,
			{
				token: translator.token,
				proposalId: task.taskId,
				items: [
					{
						messageId: "greeting",
						localeId,
						value,
						basis,
						clientRevisionKey: `revision-${expectedCandidateRevision}`,
						expectedCandidateRevision,
						...(intentionalBlankReason ? { intentionalBlankReason } : {}),
					},
				],
			},
		);
		const revisionId = result.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected candidate revision");
		return revisionId;
	}
	const revisionId = await submit();
	return {
		t,
		owner,
		projectId,
		localeId,
		translator,
		reviewer,
		task,
		basis,
		revisionId,
		submit,
	};
}

async function request(
	t: Backend,
	token: string,
	revisionId: Id<"agentTranslationCandidateRevisions">,
	body?: unknown,
) {
	return await t.fetch(`/api/agent/v1/candidate-reviews/${revisionId}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function context(
	fixture: Awaited<ReturnType<typeof setup>>,
	revisionId = fixture.revisionId,
) {
	const response = await request(fixture.t, fixture.reviewer.token, revisionId);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		reviewToken: string;
		candidate: { value: string };
		basisIsCurrent: boolean;
	};
}

describe("independent agent review", () => {
	test("binds general voice and authorized agent Dictionary changes into review context", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const initial = await context(f);
		await f.owner.mutation(api.translationGuidance.saveProjectVoiceGuide, {
			projectId: f.projectId,
			expectedRevision: 0,
			text: "Be warm and concise in every language.",
			examples: [],
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: initial.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		const withVoice = await context(f);
		expect(
			await (await request(f.t, f.reviewer.token, f.revisionId)).json(),
		).toMatchObject({
			guidance: {
				projectGuide: { text: "Be warm and concise in every language." },
			},
		});
		const dictionary = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Dictionary author",
			scopes: ["read", "dictionary-write"],
		});
		const saved = await f.t.fetch("/api/agent/v1/dictionary/terms", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${dictionary.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				expectedRevision: 1,
				terms: [
					{
						kind: "translated",
						sourceTerm: "Hello",
						definition: "Use the established greeting.",
						renderings: [{ localeCode: "de", value: "Guten Tag" }],
					},
				],
			}),
		});
		expect(saved.status).toBe(200);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: withVoice.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		expect(
			await (await request(f.t, f.reviewer.token, f.revisionId)).json(),
		).toMatchObject({
			guidance: {
				terms: [{ authoredBy: { kind: "agent", id: dictionary.tokenId } }],
			},
		});
	});

	test("binds a review to human guidance and retains superseded guidance citations", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const before = await context(f);
		const term = await f.owner.mutation(api.translationGuidance.saveTerm, {
			projectId: f.projectId,
			expectedRevision: 0,
			term: {
				kind: "translated",
				sourceTerm: "Hello",
				definition: "Friendly greeting",
				renderings: [{ localeCode: "de", value: "Guten Tag" }],
			},
		});
		const stale = await request(f.t, f.reviewer.token, f.revisionId, {
			reviewToken: before.reviewToken,
			decision: { kind: "accept" },
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "STALE_BASIS" });
		const refreshed = await request(f.t, f.reviewer.token, f.revisionId);
		expect(await refreshed.json()).toMatchObject({
			guidance: {
				revision: 1,
				terms: [
					{
						revisionId: term.revisionId,
						matchedTextIndexes: [0],
						term: { sourceTerm: "Hello" },
					},
				],
			},
		});
		await f.owner.mutation(api.translationGuidance.removeTerm, {
			projectId: f.projectId,
			expectedRevision: 1,
			sourceTerm: "Hello",
		});
		const historical = await f.t.fetch(
			`/api/agent/v1/guidance/revisions/${term.revisionId}`,
			{ headers: { Authorization: `Bearer ${f.reviewer.token}` } },
		);
		expect(historical.status).toBe(200);
		expect(await historical.json()).toMatchObject({
			revision: 1,
			content: { kind: "term", term: { sourceTerm: "Hello" } },
		});
	});

	test("does not present a revoked reviewer delegation as usable", async () => {
		const f = await setup();
		const grantId = await f.owner.mutation(
			api.agentTranslationProposals.grantCandidateReview,
			{
				candidateRevisionId: f.revisionId,
				reviewerTokenId: f.reviewer.tokenId,
			},
		);
		const readAuthorization = () =>
			f.owner.query(
				api.agentTranslationProposals.candidateReviewAuthorization,
				{ candidateRevisionId: f.revisionId },
			);
		expect((await readAuthorization()).grants).toHaveLength(1);
		await f.owner.mutation(api.apiTokens.revoke, {
			tokenId: f.reviewer.tokenId,
		});
		expect(await readAuthorization()).toMatchObject({
			policy: { enabled: false },
			grants: [],
			reviewers: [],
		});
		expect(await f.t.run((ctx) => ctx.db.get(grantId))).not.toBeNull();
	});

	test("authorized exact acceptance completes First Review for a later introduction", async () => {
		const f = await setup(true);
		async function navigation() {
			return await f.t.run((ctx) =>
				ctx.db
					.query("catalogWorkspaceNavigationRows")
					.withIndex("by_project_and_projection_and_messageId", (q) =>
						q
							.eq("projectId", f.projectId)
							.eq("projectionId", f.basis.projectionId)
							.eq("messageId", "greeting"),
					)
					.unique(),
			);
		}
		expect(await navigation()).toMatchObject({ introductionReviewPending: 1 });
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(200);
		expect(await navigation()).toMatchObject({ introductionReviewPending: 0 });
		const after = await request(f.t, f.reviewer.token, f.revisionId);
		expect(await after.json()).toMatchObject({
			alreadyReviewed: true,
			latestReview: {
				decision: { kind: "accept" },
				reviewer: { kind: "agent", id: f.reviewer.tokenId },
			},
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "reject" },
				})
			).status,
		).toBe(409);
		expect(
			await f.t.run((ctx) =>
				ctx.db.query("agentTranslationCandidateReviews").collect(),
			),
		).toHaveLength(1);
	});

	test("owner policy and editor delegation enforce project roles and token scope", async () => {
		const f = await setup();
		const editor = await authenticatedBackend(f.t, "editor");
		const viewer = await authenticatedBackend(f.t, "viewer");
		await f.owner.mutation(api.projects.addMember, {
			projectId: f.projectId,
			userId: "editor",
			role: "editor",
		});
		await f.owner.mutation(api.projects.addMember, {
			projectId: f.projectId,
			userId: "viewer",
			role: "viewer",
		});
		for (const member of [editor, viewer])
			await expect(
				member.mutation(api.projects.setAgentReviewPolicy, {
					projectId: f.projectId,
					enabled: true,
				}),
			).rejects.toThrow("Insufficient");
		await expect(
			viewer.mutation(api.agentTranslationProposals.grantCandidateReview, {
				candidateRevisionId: f.revisionId,
				reviewerTokenId: f.reviewer.tokenId,
			}),
		).rejects.toThrow("Insufficient");
		const otherProject = await createProject(f.owner, {
			name: "Other",
			slug: "other",
		});
		const otherToken = await f.owner.mutation(api.apiTokens.create, {
			projectId: otherProject,
			name: "Other project reviewer",
			scopes: ["review"],
		});
		await expect(
			editor.mutation(api.agentTranslationProposals.grantCandidateReview, {
				candidateRevisionId: f.revisionId,
				reviewerTokenId: otherToken.tokenId,
			}),
		).rejects.toThrow("separate");
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: otherProject,
			enabled: true,
		});
		expect((await request(f.t, otherToken.token, f.revisionId)).status).toBe(
			403,
		);
		await editor.mutation(api.agentTranslationProposals.grantCandidateReview, {
			candidateRevisionId: f.revisionId,
			reviewerTokenId: f.reviewer.tokenId,
		});
		await context(f);
		await f.owner.mutation(api.projects.archive, { projectId: f.projectId });
		expect((await request(f.t, f.reviewer.token, f.revisionId)).status).toBe(
			404,
		);
	});

	test("revoking and regranting permission invalidates an earlier read token", async () => {
		const f = await setup();
		const grantId = await f.owner.mutation(
			api.agentTranslationProposals.grantCandidateReview,
			{
				candidateRevisionId: f.revisionId,
				reviewerTokenId: f.reviewer.tokenId,
			},
		);
		const read = await context(f);
		await f.owner.mutation(
			api.agentTranslationProposals.revokeCandidateReviewGrant,
			{ grantId },
		);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(403);
		await f.owner.mutation(api.agentTranslationProposals.grantCandidateReview, {
			candidateRevisionId: f.revisionId,
			reviewerTokenId: f.reviewer.tokenId,
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
	});

	test("a fresh review read cannot rebase a candidate over an already changed target", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		await f.owner.mutation(api.catalogWorkspace.commit, {
			projectId: f.projectId,
			messageId: "greeting",
			localeId: f.localeId,
			intent: { kind: "save", value: "Willkommen {name}" },
			expectedGitValueFingerprint: f.basis.gitValueFingerprint,
			expectedGitValueRevision: f.basis.gitValueRevision,
			expectedWorkspaceRevision: f.basis.workspaceRevision,
			expectedSourceFingerprint: f.basis.sourceFingerprint,
		});
		const read = await context(f);
		expect(read.basisIsCurrent).toBe(false);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.t.run((ctx) =>
					ctx.db.query("catalogWorkspaceValueHeads").first(),
				)
			)?.value,
		).toBe("Willkommen {name}");
	});

	test("a fresh review read cannot accept a candidate against changed Source", async () => {
		const f = await setup();
		const workspace = await readWorkspaceKeyCards(f.owner, f.projectId);
		const source = workspace.keys
			.find((key) => key.id === "greeting")
			?.values.find((value) => value.isSource);
		if (
			!source ||
			source.gitValueFingerprint === undefined ||
			source.gitValueRevision === undefined ||
			source.workspaceRevision === undefined
		)
			throw new Error("Expected source basis");
		await f.owner.mutation(api.catalogWorkspace.commit, {
			projectId: f.projectId,
			messageId: "greeting",
			localeId: source.localeId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		expect(read.basisIsCurrent).toBe(false);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		expect(
			await f.t.run((ctx) =>
				ctx.db.query("agentTranslationCandidateReviews").collect(),
			),
		).toEqual([]);
	});

	test("new-Locale HTTP review protects unseen staged edits then applies exact reviewed bytes", async () => {
		const f = await setup();
		const task = await f.owner.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId: f.projectId,
				title: "Portuguese",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const [target] = await f.t.query(
			internal.agentTranslationProposals.newLocaleTaskSubmissionContext,
			{
				token: f.translator.token,
				taskId: task.taskId,
				messageIds: ["greeting"],
			},
		);
		if (!target) throw new Error("Expected new-Locale basis");
		const submitted = await f.t.mutation(
			internal.agentTranslationProposals.submitRevisions,
			{
				token: f.translator.token,
				proposalId: task.taskId,
				items: [
					{
						messageId: "greeting",
						value: "Olá {name}",
						basis: target.basis,
						clientRevisionKey: "pt-1",
						expectedCandidateRevision: 0,
					},
				],
			},
		);
		const revisionId = submitted.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected new-Locale candidate");
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f, revisionId);
		await f.owner.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId: target.basis.localeProposalId,
			items: [
				{
					messageId: "greeting",
					value: "Bom dia {name}",
					sourceFingerprint: target.basis.sourceFingerprint,
				},
			],
		});
		expect(
			(
				await request(f.t, f.reviewer.token, revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		const fresh = await context(f, revisionId);
		expect(
			(
				await request(f.t, f.reviewer.token, revisionId, {
					reviewToken: fresh.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(200);
		const value = await f.t.run((ctx) =>
			ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q
						.eq("proposalId", target.basis.localeProposalId)
						.eq("messageId", "greeting"),
				)
				.unique(),
		);
		expect(value).toMatchObject({
			value: "Olá {name}",
			updatedBy: { kind: "agent", id: f.reviewer.tokenId },
			reviewAuthorization: { candidateRevisionId: revisionId },
		});
		await f.owner.action(api.agentTranslationProposals.finalizeTask, {
			taskId: task.taskId,
		});
		const receipt = await request(f.t, f.reviewer.token, revisionId);
		expect(receipt.status).toBe(200);
		expect(await receipt.json()).toMatchObject({
			kind: "recordedReview",
			candidateRevisionId: revisionId,
			latestReview: { decision: { kind: "accept" } },
		});
	});
	test("defaults off; exact human delegation applies with durable reviewer provenance", async () => {
		const f = await setup();
		expect((await request(f.t, f.reviewer.token, f.revisionId)).status).toBe(
			403,
		);
		const grantId = await f.owner.mutation(
			api.agentTranslationProposals.grantCandidateReview,
			{
				candidateRevisionId: f.revisionId,
				reviewerTokenId: f.reviewer.tokenId,
			},
		);
		const read = await context(f);
		expect(read.candidate.value).toBe("Guten Tag {name}");
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(200);
		const [review, head, decisions] = await f.t.run(async (ctx) =>
			Promise.all([
				ctx.db.query("agentTranslationCandidateReviews").first(),
				ctx.db.query("catalogWorkspaceValueHeads").first(),
				ctx.db.query("catalogWorkspaceDecisionRecords").collect(),
			]),
		);
		const authority = {
			kind: "candidateGrant",
			grantId,
			reviewerTokenId: f.reviewer.tokenId,
			candidateRevisionId: f.revisionId,
			authorizedByUserId: "owner",
		};
		expect(review).toMatchObject({
			reviewer: { kind: "agent", id: f.reviewer.tokenId },
			reviewAuthorization: authority,
		});
		expect(head).toMatchObject({
			value: "Guten Tag {name}",
			updatedBy: { kind: "agent", id: f.reviewer.tokenId },
			reviewAuthorization: authority,
		});
		expect(decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "translatorConfirmation",
					reviewAuthorization: expect.objectContaining(authority),
				}),
			]),
		);
		await f.owner.mutation(
			api.agentTranslationProposals.revokeCandidateReviewGrant,
			{ grantId },
		);
		expect((await request(f.t, f.reviewer.token, f.revisionId)).status).toBe(
			403,
		);
		if (!review) throw new Error("Expected recorded review");
		expect(await f.t.run((ctx) => ctx.db.get(review._id))).toEqual(review);
	});

	test("project policy permits rejection without changing the current value", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "reject", reason: "Too formal" },
				})
			).status,
		).toBe(200);
		const result = await f.t.run(async (ctx) => ({
			review: await ctx.db.query("agentTranslationCandidateReviews").first(),
			heads: await ctx.db.query("catalogWorkspaceValueHeads").collect(),
		}));
		expect(result.heads).toEqual([]);
		expect(result.review).toMatchObject({
			decision: { kind: "reject", reason: "Too formal" },
			reviewAuthorization: { kind: "projectPolicy", policyRevision: 1 },
		});
	});

	test("rejects mixed credentials, translator self-review, and reviewer writes", async () => {
		const f = await setup();
		for (const scope of ["propose", "snapshot-submission", "export"] as const) {
			await expect(
				f.owner.mutation(api.apiTokens.create, {
					projectId: f.projectId,
					name: "mixed",
					scopes: ["review", scope],
				}),
			).rejects.toThrow("reviewer token");
		}
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		await f.t.run((ctx) =>
			ctx.db.patch(f.translator.tokenId, { scopes: ["review"] }),
		);
		expect((await request(f.t, f.translator.token, f.revisionId)).status).toBe(
			403,
		);
		// A translator-owned task remains separate even if a human supplies a revision.
		await f.t.run(async (ctx) => {
			await ctx.db.patch(f.task.taskId, {
				createdByTokenId: f.translator.tokenId,
			});
			await ctx.db.patch(f.revisionId, {
				createdBy: { kind: "user", id: "owner" },
			});
		});
		expect((await request(f.t, f.translator.token, f.revisionId)).status).toBe(
			403,
		);
		await expect(
			f.t.mutation(internal.agentTranslationProposals.create, {
				token: f.reviewer.token,
				clientProposalKey: "not-a-translator",
				target: { kind: "catalogWorkspace" },
			}),
		).rejects.toThrow("insufficient");
		await f.t.run((ctx) =>
			ctx.db.patch(f.reviewer.tokenId, {
				scopes: ["read", "review", "propose"],
			}),
		);
		expect((await request(f.t, f.reviewer.token, f.revisionId)).status).toBe(
			401,
		);
	});

	test("limits grants to one named reviewer and the latest exact revision", async () => {
		const f = await setup();
		const other = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Other reviewer",
			scopes: ["review"],
		});
		await f.owner.mutation(api.agentTranslationProposals.grantCandidateReview, {
			candidateRevisionId: f.revisionId,
			reviewerTokenId: f.reviewer.tokenId,
		});
		expect((await request(f.t, other.token, f.revisionId)).status).toBe(403);
		const read = await context(f);
		const next = await f.submit("Willkommen {name}", 1);
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		expect((await request(f.t, f.reviewer.token, next)).status).toBe(403);
	});

	test("rechecks revocation and policy generations in the review transaction", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: false,
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(403);
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		const fresh = await context(f);
		await f.owner.mutation(api.apiTokens.revoke, {
			tokenId: f.reviewer.tokenId,
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: fresh.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(401);
	});

	test("does not overwrite a human edit made after reviewer context was read", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		await f.owner.mutation(api.agentTranslationProposals.saveTaskValue, {
			taskId: f.task.taskId,
			candidateToken: f.revisionId,
			messageId: "greeting",
			value: "Willkommen {name}",
		});
		expect(
			(
				await request(f.t, f.reviewer.token, f.revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.t.run((ctx) =>
					ctx.db.query("catalogWorkspaceValueHeads").first(),
				)
			)?.value,
		).toBe("Willkommen {name}");
	});

	test("reviewers cannot edit candidate bytes or rebase the Source", async () => {
		const f = await setup();
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f);
		for (const decision of [
			{ kind: "accept", value: "changed" },
			{ kind: "acceptWithEdits", value: "changed" },
			{ kind: "keepForCurrentSource" },
		]) {
			expect(
				(
					await request(f.t, f.reviewer.token, f.revisionId, {
						reviewToken: read.reviewToken,
						decision,
					})
				).status,
			).toBe(400);
		}
		expect(
			await f.t.run((ctx) =>
				ctx.db.query("agentTranslationCandidateReviews").collect(),
			),
		).toEqual([]);
	});

	test("exact acceptance preserves an authored Intentional Blank reason", async () => {
		const f = await setup();
		const revisionId = await f.submit("", 1, "No greeting on this screen");
		await f.owner.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const read = await context(f, revisionId);
		expect(
			(
				await request(f.t, f.reviewer.token, revisionId, {
					reviewToken: read.reviewToken,
					decision: { kind: "accept" },
				})
			).status,
		).toBe(200);
		expect(
			await f.t.run((ctx) =>
				ctx.db.query("catalogWorkspaceDecisionRecords").collect(),
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "intentionalBlank",
					reason: "No greeting on this screen",
					reviewAuthorization: expect.objectContaining({
						reviewerTokenId: f.reviewer.tokenId,
					}),
				}),
			]),
		);
	});
});
