import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { ProposalSearchScope } from "./agentProposalRetrieval";
import { activeProjectionFor } from "./catalogProjection";
import type { SearchOptions } from "./catalogSearch";

async function setup(messageCount = 4) {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "proposal-search-owner");
	const projectId = await createProject(owner);
	const sourceLocale = (await owner.query(api.locales.list, { projectId }))[0];
	if (!sourceLocale) throw new Error("Expected source Locale.");
	await owner.mutation(api.locales.bind, {
		localeId: sourceLocale._id,
		catalogPath: "en.arb",
	});
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "en.arb",
				content: JSON.stringify({
					"@@locale": "en",
					...Object.fromEntries(
						Array.from({ length: messageCount }, (_, index) => [
							`message_${String(index).padStart(3, "0")}`,
							`Build ${index}`,
						]),
					),
				}),
			},
		],
	});
	const translator = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose"],
	});
	const reviewer = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Reviewer",
		scopes: ["read", "search", "review"],
	});
	const task = await owner.mutation(api.agentTranslationProposals.createTask, {
		projectId,
		title: "Portuguese",
		target: { kind: "newLocale", localeCode: "pt" },
		scope: { kind: "completeCatalog" },
	});
	const bases = await t.query(
		internal.agentTranslationProposals.newLocaleTaskSubmissionContext,
		{
			token: translator.token,
			taskId: task.taskId,
			messageIds: Array.from(
				{ length: Math.min(messageCount, 16) },
				(_, index) => `message_${String(index).padStart(3, "0")}`,
			),
		},
	);
	const first = bases[0];
	if (!first) throw new Error("Expected task target.");
	const proposalId = first.basis.localeProposalId;
	const submitted = await t.mutation(
		internal.agentTranslationProposals.submitRevisions,
		{
			token: translator.token,
			proposalId: task.taskId,
			items: [
				{
					messageId: first.messageId,
					value: "Monte um brinquedo",
					basis: first.basis,
					clientRevisionKey: "revision-1",
					expectedCandidateRevision: 0,
				},
			],
		},
	);
	const revisionId = submitted.revisions[0]?.revisionId;
	if (!revisionId) throw new Error("Expected candidate revision.");
	async function request(
		token: string,
		scope: ProposalSearchScope,
		options: SearchOptions = {},
	) {
		return await t.fetch("/api/agent/v1/proposal-examples/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ scope, ...options }),
		});
	}
	async function page(token = translator.token, options: SearchOptions = {}) {
		const response = await request(
			token,
			{ kind: "task", taskId: task.taskId },
			options,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as FunctionReturnType<
			typeof internal.agentProposalRetrieval.search
		>;
	}
	return {
		t,
		owner,
		projectId,
		translator,
		reviewer,
		task,
		bases,
		proposalId,
		revisionId,
		request,
		page,
	};
}

describe("Reviewed new-Locale example search", () => {
	test("serves bilingual human and independently reviewed examples while excluding candidates and invalid evidence", async () => {
		const f = await setup();
		expect((await f.page()).items).toEqual([]);
		const grantId = await f.owner.mutation(
			api.agentTranslationProposals.grantCandidateReview,
			{
				candidateRevisionId: f.revisionId,
				reviewerTokenId: f.reviewer.tokenId,
			},
		);
		const contextResponse = await f.t.fetch(
			`/api/agent/v1/candidate-reviews/${f.revisionId}`,
			{
				headers: { Authorization: `Bearer ${f.reviewer.token}` },
			},
		);
		expect(contextResponse.status).toBe(200);
		const { reviewToken } = (await contextResponse.json()) as {
			reviewToken: string;
		};
		const accepted = await f.t.fetch(
			`/api/agent/v1/candidate-reviews/${f.revisionId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${f.reviewer.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ reviewToken, decision: { kind: "accept" } }),
			},
		);
		expect(accepted.status).toBe(200);
		const second = f.bases[1];
		if (!second) throw new Error("Expected second source.");
		await f.owner.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId: f.proposalId,
			items: [
				{
					messageId: second.messageId,
					value: "Monte uma casa",
					sourceFingerprint: second.basis.sourceFingerprint,
				},
			],
		});
		const scope = {
			kind: "review" as const,
			candidateRevisionId: f.revisionId,
		};
		const response = await f.request(f.reviewer.token, scope, {
			q: "Monte",
			searchIn: "target",
		});
		expect(response.status).toBe(200);
		const result = (await response.json()) as FunctionReturnType<
			typeof internal.agentProposalRetrieval.search
		>;
		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({
			source: { localeCode: "en", value: "Build 0" },
			target: { localeCode: "pt", value: "Monte um brinquedo" },
			matchedFields: ["target"],
			provenance: {
				kind: "reviewedDraft",
				reviewedBy: { kind: "agent", id: f.reviewer.tokenId },
				reviewAuthorization: { candidateRevisionId: f.revisionId },
			},
		});
		expect(result.items[1]?.provenance.reviewedBy.kind).toBe("user");
		expect(
			(
				await f.page(f.translator.token, {
					q: "Build 1",
					searchIn: "source",
					match: "exact",
				})
			).items.map((item) => item.messageId),
		).toEqual(["message_001"]);
		await f.owner.mutation(
			api.agentTranslationProposals.revokeCandidateReviewGrant,
			{ grantId },
		);
		expect((await f.request(f.reviewer.token, scope)).status).toBe(403);
		// Stored authorization remains historical evidence after access revocation.
		expect((await f.page()).items).toHaveLength(2);
		await f.t.run(async (ctx) => {
			const value = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", f.proposalId).eq("messageId", "message_001"),
				)
				.unique();
			if (!value) throw new Error("Expected staged value.");
			await ctx.db.patch(value._id, { value: "Introduced {unknown}" });
		});
		expect((await f.page()).items.map((item) => item.messageId)).toEqual([
			"message_000",
		]);
	});

	test("enforces private task, cross-project, scope, and reviewer authorization boundaries", async () => {
		const f = await setup();
		const reader = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Reader",
			scopes: ["read", "search"],
		});
		const otherProjectId = await createProject(f.owner, {
			name: "Other",
			slug: "other-project",
		});
		const outsider = await f.owner.mutation(api.apiTokens.create, {
			projectId: otherProjectId,
			name: "Other project",
			scopes: ["read", "search"],
		});
		const taskScope = { kind: "task" as const, taskId: f.task.taskId };
		expect((await f.request(reader.token, taskScope)).status).toBe(200);
		expect((await f.request(outsider.token, taskScope)).status).toBe(404);
		await f.t.run((ctx) =>
			ctx.db.patch(f.task.taskId, { createdByTokenId: f.translator.tokenId }),
		);
		expect((await f.request(reader.token, taskScope)).status).toBe(404);
		expect((await f.request(f.translator.token, taskScope)).status).toBe(200);
		expect(
			(
				await f.request(f.reviewer.token, {
					kind: "review",
					candidateRevisionId: f.revisionId,
				})
			).status,
		).toBe(403);
		expect(
			(
				await f.request(f.translator.token, {
					kind: "review",
					candidateRevisionId: f.revisionId,
				})
			).status,
		).toBe(401);
		const searchOnly = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Search only",
			scopes: ["search"],
		});
		expect((await f.request(searchOnly.token, taskScope)).status).toBe(401);
	});

	test("continues past empty bounded pages and rejects changed query, draft revision, and source Snapshot", async () => {
		const f = await setup(65);
		await f.t.run(async (ctx) => {
			const projection = await activeProjectionFor(ctx, f.projectId);
			if (!projection) throw new Error("Expected active projection.");
			const sources = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection", (q) => q.eq("projectionId", projection._id))
				.collect();
			for (const source of sources)
				await ctx.db.insert("localeProposalValues", {
					projectId: f.projectId,
					proposalId: f.proposalId,
					messageId: source.messageId,
					value: source.messageId === "message_064" ? "Agulha" : "Outro",
					sourceFingerprint: source.sourceFingerprint,
					byteLength: 6,
					updatedBy: { kind: "user", id: "fixture-owner" },
					updatedAt: 1,
				});
		});
		const first = await f.page(f.translator.token, {
			q: "Agulha",
			searchIn: "target",
		});
		expect(first.items).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		if (!first.nextCursor) throw new Error("Expected continuation cursor.");
		const next = await f.page(f.translator.token, {
			q: "Agulha",
			searchIn: "target",
			cursor: first.nextCursor,
		});
		expect(next.items.map((item) => item.messageId)).toEqual(["message_064"]);
		expect(next.nextCursor).toBeNull();
		const scope = { kind: "task" as const, taskId: f.task.taskId };
		expect(
			(
				await f.request(f.translator.token, scope, {
					q: "Outro",
					searchIn: "target",
					cursor: first.nextCursor,
				})
			).status,
		).toBe(409);
		const exact = await f.page(f.translator.token, {
			q: "message_064",
			searchIn: "key",
			match: "exact",
		});
		expect(exact.items).toHaveLength(1);
		expect(exact.nextCursor).toBeNull();
		await f.t.run(async (ctx) => {
			const proposal = await ctx.db.get(f.proposalId);
			if (!proposal) throw new Error("Expected proposal.");
			await ctx.db.patch(proposal._id, { revision: proposal.revision + 1 });
		});
		expect(
			(
				await f.request(f.translator.token, scope, {
					q: "Agulha",
					searchIn: "target",
					cursor: first.nextCursor,
				})
			).status,
		).toBe(409);
		await f.owner.action(api.snapshots.ingest, {
			projectId: f.projectId,
			repository: "repo",
			commit: "new-source",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: '{"@@locale":"en","message_000":"Changed"}',
				},
			],
		});
		expect((await f.request(f.translator.token, scope)).status).toBe(409);
	});
});
