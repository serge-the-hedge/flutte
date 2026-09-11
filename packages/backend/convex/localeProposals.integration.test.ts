import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentReviewAuthorization } from "./agentReviewModel";

async function ingestSourceBaseline(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
	input: {
		commit?: string;
		content?: string;
		additionalFiles?: Array<{ catalogPath: string; content: string }>;
		lineage?: {
			baselineCommit: string;
			relationship: "ancestor" | "descendant" | "divergent";
			mergeBase: string;
		};
	} = {},
) {
	const configured = await user.query(api.localeIntroductionTargets.list, {
		projectId,
	});
	const locales = await user.query(api.locales.list, { projectId });
	if (
		configured.length === 0 &&
		!locales.some((locale) => locale.code === "pt")
	)
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "pt",
			label: "Portuguese",
			catalogPath: "intl_pt.arb",
			runtimeLocale: "pt-BR",
		});
	const [sourceLocale] = await user.query(api.locales.list, { projectId });
	if (!sourceLocale) throw new Error("Expected the source Locale.");
	await user.action(api.locales.bind, {
		localeId: sourceLocale._id,
		catalogPath: "intl_en.arb",
	});
	const result = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "github.com/brickit-app/brickit-flutter",
		commit: input.commit ?? "baseline",
		files: [
			{
				catalogPath: "intl_en.arb",
				content:
					input.content ??
					'{"@@locale":"en","welcome":"Welcome, {name}!","@welcome":{"description":"A welcome for a signed-in person.","placeholders":{"name":{"type":"String"}}}}',
			},
			...(input.additionalFiles ?? []),
		],
		...(input.lineage === undefined ? {} : { lineage: input.lineage }),
	});
	if (!result.snapshotId) throw new Error("Expected a Baseline Snapshot.");
	return result.snapshotId;
}

async function proposalToken(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	return await user.mutation(api.apiTokens.create, {
		projectId,
		name: "Portuguese proposal agent",
		scopes: ["read", "propose"],
	});
}

type AgentProposal = {
	proposalId: Id<"localeProposals">;
	sourceSnapshotId: Id<"sourceSnapshots">;
	locale: { code: string; label: string; runtimeLocale: string };
	status: "draft" | "ready";
	deliveryStatus: "draft" | "ready" | "stale";
	progress: { total: number; staged: number; remaining: number };
	diagnostics: { count: number; messages: string[] };
};

type AgentTemplate = {
	sourceSnapshotId: Id<"sourceSnapshots">;
	isDone: boolean;
	messages: Array<{
		id: string;
		sourceValue: string;
		sourceFingerprint: string;
		staged: boolean;
		metadataJson?: string;
	}>;
};

type AgentStagedValues = {
	values: Array<{
		messageId: string;
		value: string;
		sourceFingerprint: string;
		intentionalBlankReason?: string;
	}>;
};

type AgentArtifact = {
	proposalId: Id<"localeProposals">;
	sourceSnapshot: { id: string; commit: string; catalogPath: string };
	locale: { code: string; label: string; runtimeLocale: string };
	catalog: { fileName: string; content: string };
};

type AgentStageItem = {
	messageId: string;
	value: string;
	sourceFingerprint: string;
	intentionalBlankReason?: string;
};

type AgentError = {
	error: string;
	code?: string;
};

async function agentRequest(
	t: Backend,
	token: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	if (init.body !== undefined && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	return await t.fetch(path, { ...init, headers });
}

async function successfulJson<T>(response: Response): Promise<T> {
	const body = await response.text();
	expect(response.status, body).toBe(200);
	return JSON.parse(body) as T;
}

async function createPortugueseProposal(
	t: Backend,
	token: string,
): Promise<AgentProposal> {
	return await successfulJson<AgentProposal>(
		await agentRequest(t, token, "/api/agent/v1/locale-proposals/pt", {
			method: "POST",
		}),
	);
}

async function portugueseTemplate(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
): Promise<AgentTemplate> {
	return await successfulJson<AgentTemplate>(
		await agentRequest(
			t,
			token,
			`/api/agent/v1/locale-proposals/pt/template?proposalId=${encodeURIComponent(proposalId)}&limit=10`,
		),
	);
}

async function stagePortugueseValues(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
	items: AgentStageItem[],
): Promise<Response> {
	return await agentRequest(
		t,
		token,
		"/api/agent/v1/locale-proposals/pt/values",
		{
			method: "POST",
			body: JSON.stringify({ proposalId, items }),
		},
	);
}

async function portugueseStagedValues(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
): Promise<AgentStagedValues> {
	return await successfulJson<AgentStagedValues>(
		await agentRequest(
			t,
			token,
			`/api/agent/v1/locale-proposals/pt/values?proposalId=${encodeURIComponent(proposalId)}&limit=10`,
		),
	);
}

async function reviewPortugueseValues(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
	proposalId: Id<"localeProposals">,
): Promise<void> {
	let cursor: number | undefined;
	for (;;) {
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			...(cursor === undefined ? {} : { cursor }),
			limit: 16,
		});
		if (!page) throw new Error("Expected a Locale Proposal review page.");
		for (const message of page.messages) {
			if (!message.value || message.review) continue;
			await user.mutation(api.localeProposals.reviewStagedValue, {
				projectId,
				proposalId,
				messageId: message.messageId,
				decision:
					message.value.value.length === 0
						? {
								kind: "intentionalBlank",
								reason:
									message.value.intentionalBlankReason ??
									"Reviewed as intentionally blank.",
							}
						: { kind: "accept" },
			});
		}
		if (page.continueCursor === null) return;
		cursor = page.continueCursor;
	}
}

async function expectStageFailure(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
	items: AgentStageItem[],
	message: string,
	code = "VALIDATION",
): Promise<void> {
	const response = await stagePortugueseValues(t, token, proposalId, items);
	expect(response.status).toBe(400);
	const error = (await response.json()) as AgentError;
	expect(error).toMatchObject({
		error: expect.stringContaining(message),
		code,
	});
}

async function finalizePortugueseProposal(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
): Promise<Response> {
	return await agentRequest(
		t,
		token,
		"/api/agent/v1/locale-proposals/pt/finalize",
		{
			method: "POST",
			body: JSON.stringify({ proposalId }),
		},
	);
}

async function portugueseArtifact(
	t: Backend,
	token: string,
	proposalId: Id<"localeProposals">,
): Promise<AgentArtifact> {
	return await successfulJson<AgentArtifact>(
		await agentRequest(
			t,
			token,
			`/api/agent/v1/locale-proposals/pt/artifact?proposalId=${encodeURIComponent(proposalId)}`,
		),
	);
}

/** Exercise the Locale adapter after the shared review module has authenticated
 * an independent reviewer. Public authorization itself is covered by its suite. */
async function authorizedLocaleReviewFixture(
	t: Backend,
	includeRawValue = false,
) {
	const user = await authenticatedBackend(t, "authorized-locale-owner");
	const projectId = await createProject(user);
	await ingestSourceBaseline(user, projectId, {
		content: JSON.stringify({
			"@@locale": "en",
			welcome: "Welcome",
			...(includeRawValue ? { raw: "Raw" } : {}),
		}),
	});
	const { token, tokenId: translatorTokenId } = await proposalToken(
		user,
		projectId,
	);
	const { tokenId: reviewerTokenId } = await user.mutation(
		api.apiTokens.create,
		{
			projectId,
			name: "Independent reviewer",
			scopes: ["read", "review"],
		},
	);
	const task = await user.mutation(api.agentTranslationProposals.createTask, {
		projectId,
		title: "Portuguese review",
		target: { kind: "newLocale", localeCode: "pt" },
		scope: { kind: "completeCatalog" },
	});
	await successfulJson(
		await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [{ messageId: "welcome", value: "Bem-vindo" }],
				}),
			},
		),
	);
	const revision = await t.run((ctx) =>
		ctx.db
			.query("agentTranslationCandidateRevisions")
			.withIndex("by_proposal", (q) => q.eq("proposalId", task.taskId))
			.unique(),
	);
	if (revision?.basis.kind !== "localeProposal")
		throw new Error("Expected Locale candidate");
	const proposalId = revision.basis.localeProposalId;
	const reviewAuthorization: AgentReviewAuthorization = {
		kind: "projectPolicy",
		policyRevision: 1,
		reviewerTokenId,
		candidateRevisionId: revision._id,
		authorizedByUserId: "authorized-locale-owner",
		authorizedAt: 100,
	};
	await t.mutation(internal.localeProposals.applyReviewedValue, {
		projectId,
		proposalId,
		messageId: revision.messageId,
		sourceSnapshotId: revision.basis.snapshotId,
		sourceFingerprint: revision.basis.sourceFingerprint,
		candidateValueFingerprint: revision.valueFingerprint,
		acceptedValue: revision.value,
		decision: { kind: "accept" },
		reviewer: { kind: "agent", id: reviewerTokenId },
		reviewAuthorization,
	});
	await t.run((ctx) =>
		ctx.db.patch(projectId, {
			agentReviewPolicy: {
				enabled: false,
				revision: 2,
				updatedByUserId: "authorized-locale-owner",
				updatedAt: 101,
			},
		}),
	);
	return {
		user,
		projectId,
		proposalId,
		taskId: task.taskId,
		token,
		translatorTokenId,
		reviewAuthorization,
		revision,
	};
}

describe("Portuguese Locale Proposals through the Agent API", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("the Portuguese alias needs configured setup and preserves explicitly configured regional identity", async () => {
		const user = await authenticatedBackend(t, "explicit-locale-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		await user.mutation(api.localeIntroductionTargets.remove, {
			projectId,
			localeCode: "pt",
		});
		const { token } = await proposalToken(user, projectId);
		const missing = await agentRequest(
			t,
			token,
			"/api/agent/v1/locale-proposals/pt",
			{ method: "POST" },
		);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({
			code: "NOT_FOUND",
			error: expect.stringContaining("not configured"),
		});
		expect(
			await t.run((ctx) => ctx.db.query("localeProposals").collect()),
		).toEqual([]);
		await user.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode: "pt",
			label: "Portuguese (Portugal)",
			catalogPath: "intl_pt.arb",
			runtimeLocale: "pt-PT",
		});
		const proposal = await successfulJson<AgentProposal>(
			await agentRequest(t, token, "/api/agent/v1/locale-proposals", {
				method: "POST",
				body: JSON.stringify({ localeCode: "pt" }),
			}),
		);
		expect(proposal.locale).toEqual({
			code: "pt",
			label: "Portuguese (Portugal)",
			runtimeLocale: "pt-PT",
		});
		await user.mutation(api.localeIntroductionTargets.remove, {
			projectId,
			localeCode: "pt",
		});
		const resumed = await createPortugueseProposal(t, token);
		expect(resumed.proposalId).toBe(proposal.proposalId);
		expect(resumed.locale).toEqual(proposal.locale);
	});

	test("authorized independent review retains provenance and can finalize after policy is disabled", async () => {
		const { user, projectId, proposalId, taskId, reviewAuthorization } =
			await authorizedLocaleReviewFixture(t);
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId,
			focus: "all",
			limit: 16,
		});
		expect(page?.pendingReview).toEqual({ count: 0, hasMore: false });
		expect(page?.messages[0]).toMatchObject({
			value: {
				value: "Bem-vindo",
				updatedBy: { kind: "agent", id: reviewAuthorization.reviewerTokenId },
				reviewAuthorization,
			},
		});
		const storedReview = await t.run((ctx) =>
			ctx.db
				.query("localeProposalValueReviews")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.unique(),
		);
		expect(storedReview?.reviewAuthorization).toEqual(reviewAuthorization);
		await expect(
			user.action(api.localeProposals.finalizeForReview, {
				projectId,
				proposalId,
			}),
		).resolves.toMatchObject({ status: "ready" });
	});

	test("continuation carries approved agent evidence, skips raw submissions, and keeps its reviewed queue state", async () => {
		const { user, projectId, proposalId, token, reviewAuthorization } =
			await authorizedLocaleReviewFixture(t, true);
		const template = await portugueseTemplate(t, token, proposalId);
		const raw = template.messages.find((message) => message.id === "raw");
		if (!raw) throw new Error("Expected raw source");
		await successfulJson(
			await stagePortugueseValues(t, token, proposalId, [
				{
					messageId: "raw",
					value: "Sem revisão",
					sourceFingerprint: raw.sourceFingerprint,
				},
			]),
		);
		await ingestSourceBaseline(user, projectId, {
			commit: "next",
			content: JSON.stringify({
				"@@locale": "en",
				welcome: "Welcome",
				raw: "Raw",
			}),
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});
		const carried = await user.action(
			api.localeProposals.carryForwardForReview,
			{ projectId, proposalId },
		);
		expect(carried).toMatchObject({
			carriedValueCount: 1,
			remainingValueCount: 1,
		});
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId: carried.localeProposalId,
			focus: "all",
			limit: 16,
		});
		expect(page?.pendingReview).toEqual({ count: 0, hasMore: false });
		expect(
			page?.messages.find((message) => message.messageId === "welcome"),
		).toMatchObject({
			facts: { state: "reviewed" },
			value: { value: "Bem-vindo", reviewAuthorization },
		});
		expect(
			page?.messages.find((message) => message.messageId === "raw"),
		).toMatchObject({ value: null });
	});

	test("raw retries preserve reviewed exact content, while replacements require review again", async () => {
		const {
			user,
			projectId,
			proposalId,
			token,
			taskId,
			revision,
			reviewAuthorization,
		} = await authorizedLocaleReviewFixture(t);
		const stage = (value: string) =>
			stagePortugueseValues(t, token, proposalId, [
				{
					messageId: "welcome",
					value,
					sourceFingerprint: revision.basis.sourceFingerprint,
				},
			]);
		await successfulJson(await stage(revision.value));
		const read = () =>
			t.run((ctx) =>
				ctx.db
					.query("localeProposalValues")
					.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
					.unique(),
			);
		expect((await read())?.reviewAuthorization).toEqual(reviewAuthorization);
		await successfulJson(await stage("Outra tradução"));
		expect((await read())?.reviewAuthorization).toBeUndefined();
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId,
			focus: "awaiting",
			limit: 16,
		});
		expect(page?.pendingReview).toEqual({ count: 1, hasMore: false });
		await expect(
			user.action(api.localeProposals.finalizeForReview, {
				projectId,
				proposalId,
			}),
		).rejects.toThrow("needs human or authorized independent-agent review");
	});

	test("a new reviewed revision reapplies recurring bytes instead of reusing an unrelated prior application", async () => {
		const {
			user,
			projectId,
			proposalId,
			token,
			revision,
			reviewAuthorization,
		} = await authorizedLocaleReviewFixture(t);
		await successfulJson(
			await stagePortugueseValues(t, token, proposalId, [
				{
					messageId: "welcome",
					value: "Different staged text",
					sourceFingerprint: revision.basis.sourceFingerprint,
				},
			]),
		);
		const submitted = await t.mutation(
			internal.agentTranslationProposals.submitRevisions,
			{
				token,
				proposalId: revision.proposalId,
				items: [
					{
						messageId: "welcome",
						value: revision.value,
						basis: revision.basis,
						clientRevisionKey: "recurring-bytes",
						expectedCandidateRevision: revision.revision,
					},
				],
			},
		);
		const nextId = submitted.revisions[0]?.revisionId;
		if (!nextId || revision.basis.kind !== "localeProposal")
			throw new Error("Expected recurring candidate");
		const nextAuthorization = {
			...reviewAuthorization,
			candidateRevisionId: nextId,
		};
		await t.mutation(internal.localeProposals.applyReviewedValue, {
			projectId,
			proposalId,
			messageId: "welcome",
			sourceSnapshotId: revision.basis.snapshotId,
			sourceFingerprint: revision.basis.sourceFingerprint,
			candidateValueFingerprint: revision.valueFingerprint,
			acceptedValue: revision.value,
			decision: { kind: "accept" },
			reviewer: { kind: "agent", id: reviewAuthorization.reviewerTokenId },
			reviewAuthorization: nextAuthorization,
		});
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			limit: 16,
		});
		expect(page?.messages[0]).toMatchObject({
			value: { value: revision.value, reviewAuthorization: nextAuthorization },
			review: { reviewAuthorization: nextAuthorization },
		});
		const reviews = await t.run((ctx) =>
			ctx.db
				.query("localeProposalValueReviews")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.collect(),
		);
		expect(reviews).toHaveLength(2);
		expect(reviews[0]?.reviewAuthorization).toEqual(reviewAuthorization);
	});

	test("resumes one current Portuguese proposal without creating a Locale", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		const snapshotId = await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);

		const first = await createPortugueseProposal(t, token);
		const resumed = await createPortugueseProposal(t, token);

		expect(resumed).toMatchObject({
			proposalId: first.proposalId,
			sourceSnapshotId: snapshotId,
			progress: { total: 1, staged: 0, remaining: 1 },
		});
		expect(
			(await user.query(api.locales.list, { projectId })).map(
				(locale) => locale.code,
			),
		).toEqual(["en"]);
	}, 60_000);

	test("runs a complete new Locale through the generic Translation Task API", async () => {
		const user = await authenticatedBackend(t, "new-locale-task-owner");
		const projectId = await createProject(user);
		const sourceMessages = Object.fromEntries(
			Array.from({ length: 35 }, (_, index) => [
				`message_${String(index).padStart(2, "0")}`,
				`Source value ${index}`,
			]),
		);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({ "@@locale": "en", ...sourceMessages }),
		});
		const { token } = await proposalToken(user, projectId);
		const create = () =>
			agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-complete-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			});
		const created = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
			localeCode: string;
			targetCount: number;
		}>(await create());
		const retried = await successfulJson<{ taskId: string }>(await create());
		expect(created).toMatchObject({ localeCode: "pt", targetCount: 35 });
		expect(retried.taskId).toBe(created.taskId);

		type NewLocaleTaskTarget = {
			messageId: string;
			sourceValue: string;
			targetValue: string;
			staged: boolean;
			candidate: null | {
				revisionId: string;
				revision: number;
				value: string;
			};
		};
		type NewLocaleTaskPage = {
			task: {
				taskId: string;
				localeCode: string;
				targetCount: number;
			};
			targets: NewLocaleTaskTarget[];
			nextCursor: number | null;
		};
		const targets: NewLocaleTaskTarget[] = [];
		let cursor: number | null = 0;
		do {
			const page: NewLocaleTaskPage = await successfulJson<NewLocaleTaskPage>(
				await agentRequest(
					t,
					token,
					`/api/agent/v1/translation-tasks/${created.taskId}?cursor=${cursor}&limit=10`,
				),
			);
			expect(page.task).toMatchObject({
				taskId: created.taskId,
				localeCode: "pt",
				targetCount: 35,
			});
			targets.push(...page.targets);
			cursor = page.nextCursor;
		} while (cursor !== null);
		expect(targets).toHaveLength(35);
		expect(targets.map((target) => target.messageId)).toEqual(
			Object.keys(sourceMessages),
		);

		const firstTarget = targets[0];
		if (!firstTarget) throw new Error("Expected a new-Locale task target.");
		const submit = (value: string) =>
			agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${created.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId: firstTarget.messageId, value }],
					}),
				},
			);
		await expect(
			successfulJson(await submit("Valor inicial")),
		).resolves.toMatchObject({
			candidates: [
				{ messageId: firstTarget.messageId, status: "awaitingReview" },
			],
			revisions: [{ revision: 1 }],
		});
		await expect(
			successfulJson(await submit("Valor corrigido")),
		).resolves.toMatchObject({ revisions: [{ revision: 2 }] });

		const firstPage = await successfulJson<{
			targets: NewLocaleTaskTarget[];
		}>(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${created.taskId}?limit=10`,
			),
		);
		expect(firstPage.targets[0]).toMatchObject({
			messageId: firstTarget.messageId,
			targetValue: "",
			staged: false,
			candidate: { revision: 2, value: "Valor corrigido" },
		});
		const taskList = await user.query(
			api.agentTranslationProposals.listForReview,
			{
				projectId,
				paginationOpts: { numItems: 50, cursor: null },
			},
		);
		expect(taskList.page[0]).toMatchObject({
			_id: created.taskId,
			status: "open",
			candidateCount: 1,
			localeProposalTaskScope: { localeCode: "pt", targetCount: 35 },
		});

		const localeProposal = await createPortugueseProposal(t, token);
		const reviewPage = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposal.proposalId,
			taskId: created.taskId,
			limit: 16,
		});
		expect(reviewPage?.messages[0]).toMatchObject({
			messageId: firstTarget.messageId,
			value: null,
			candidate: { revision: 2, value: "Valor corrigido", review: null },
		});
	}, 60_000);

	test("keeps a near-envelope source and candidate page readable", async () => {
		const user = await authenticatedBackend(t, "large-new-locale-task");
		const projectId = await createProject(user);
		const sourceValue = "S".repeat(200 * 1024);
		const description = "D".repeat(200 * 1024);
		const candidateValue = "T".repeat(200 * 1024);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				large: sourceValue,
				"@large": { description },
			}),
		});
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "large-portuguese-v1",
					target: { kind: "newLocale", localeCode: "pt" },
					scope: { kind: "completeCatalog" },
				}),
			}),
		);
		await successfulJson(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId: "large", value: candidateValue }],
					}),
				},
			),
		);
		const page = await successfulJson<{
			targets: Array<{
				messageId: string;
				candidate: { value: string } | null;
			}>;
		}>(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}`,
			),
		);
		expect(page.targets).toHaveLength(1);
		expect(page.targets[0]).toMatchObject({
			messageId: "large",
			candidate: { value: candidateValue },
		});
	}, 60_000);

	test("reviews and finalizes a new Locale through task-only human commands", async () => {
		const user = await authenticatedBackend(t, "new-locale-task-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-reviewed-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		const page = await successfulJson<{
			targets: Array<{ messageId: string }>;
		}>(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}`,
			),
		);
		const message = page.targets[0];
		if (!message) throw new Error("Expected the new-Locale task message.");
		await successfulJson(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [
							{ messageId: message.messageId, value: "Boas-vindas, {name}!" },
						],
					}),
				},
			),
		);
		const taskReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const localeProposalId =
			taskReview?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!localeProposalId) {
			throw new Error("Expected the task Locale Proposal.");
		}
		const localeReview = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			limit: 16,
		});
		const reviewToken = localeReview?.messages[0]?.candidate?.revisionId;
		if (!reviewToken) throw new Error("Expected the candidate revision token.");
		await expect(
			user.mutation(api.agentTranslationProposals.reviewTaskValue, {
				taskId: task.taskId,
				messageId: message.messageId,
				candidateToken: reviewToken,
				decision: { kind: "accept" },
			}),
		).resolves.toMatchObject({ decision: { kind: "accept" } });
		await expect(
			user.mutation(api.agentTranslationProposals.reviewTaskValue, {
				taskId: task.taskId,
				messageId: message.messageId,
				candidateToken: reviewToken,
				decision: { kind: "reject" },
			}),
		).resolves.toMatchObject({ decision: { kind: "accept" } });
		await expect(
			user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: task.taskId,
			}),
		).resolves.toMatchObject({
			kind: "newLocale",
			taskId: task.taskId,
			localeProposalId: expect.any(String),
			deliveryStatus: "ready",
		});
		expect(
			(
				await user.query(api.agentTranslationProposals.getForReview, {
					proposalId: task.taskId,
				})
			)?.proposal.status,
		).toBe("accepted");
		const retry = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-reviewed-v1",
					target: { kind: "newLocale", localeCode: "pt" },
					scope: { kind: "completeCatalog" },
				}),
			},
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ taskId: task.taskId });
		const unusable = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-after-finalization",
					target: { kind: "newLocale", localeCode: "pt" },
					scope: { kind: "completeCatalog" },
				}),
			},
		);
		expect(unusable.status).toBe(400);
		expect(await unusable.json()).toMatchObject({ code: "BAD_STATE" });
		await expect(
			user.mutation(api.agentTranslationProposals.createTask, {
				projectId,
				title: "Another Portuguese task",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			}),
		).rejects.toThrow("already finalized");
	}, 60_000);

	test("keeps earlier agent-staged values in a new-Locale task review queue", async () => {
		const user = await authenticatedBackend(t, "mixed-locale-task-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-mixed-review-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		const taskReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const localeProposalId =
			taskReview?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!localeProposalId) throw new Error("Expected a Locale Proposal task.");
		const initialReview = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			limit: 16,
		});
		const source = initialReview?.messages[0];
		if (!source) throw new Error("Expected the source message.");

		await successfulJson(
			await stagePortugueseValues(t, token, localeProposalId, [
				{
					messageId: source.messageId,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: source.sourceFingerprint,
				},
			]),
		);

		const awaitingReview = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "awaiting",
			limit: 16,
		});
		expect(awaitingReview?.proposal.progress.remaining).toBe(0);
		expect(awaitingReview?.pendingReview).toEqual({
			count: 1,
			hasMore: false,
		});
		expect(awaitingReview?.messages).toMatchObject([
			{
				messageId: source.messageId,
				facts: { state: "awaiting" },
				candidate: null,
				value: {
					value: "Boas-vindas, {name}!",
					updatedBy: { kind: "agent" },
				},
			},
		]);

		const valueToken = awaitingReview?.messages[0]?.value?.reviewToken;
		if (!valueToken) throw new Error("Expected the staged value review token.");
		await user.mutation(api.localeProposals.reviewStagedValue, {
			projectId,
			proposalId: localeProposalId,
			messageId: source.messageId,
			expectedValueFingerprint: valueToken,
			decision: { kind: "accept" },
		});
		await expect(
			user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: task.taskId,
			}),
		).resolves.toMatchObject({ deliveryStatus: "ready" });
	}, 60_000);

	test("paginates earlier agent-staged values without exposing storage windows", async () => {
		const user = await authenticatedBackend(t, "paged-mixed-locale-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				first: "First",
				second: "Second",
				third: "Third",
			}),
		});
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-paged-mixed-review-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		const taskReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const localeProposalId =
			taskReview?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!localeProposalId) throw new Error("Expected a Locale Proposal task.");
		const sourcePage = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			limit: 3,
		});
		if (!sourcePage) throw new Error("Expected the source page.");
		await successfulJson(
			await stagePortugueseValues(
				t,
				token,
				localeProposalId,
				sourcePage.messages.map((message) => ({
					messageId: message.messageId,
					value: `pt:${message.sourceValue}`,
					sourceFingerprint: message.sourceFingerprint,
				})),
			),
		);

		const first = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "awaiting",
			limit: 2,
		});
		expect(first?.messages).toHaveLength(2);
		expect(first?.pendingQueueContinueCursor).toEqual(expect.any(String));
		expect(first?.isDone).toBe(false);
		const pendingCursor = first?.pendingQueueContinueCursor;
		if (!pendingCursor) throw new Error("Expected the pending queue cursor.");
		const second = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "awaiting",
			limit: 2,
			pendingCursor,
		});
		expect(second?.messages).toHaveLength(1);
		expect(second?.messages[0]?.messageId).not.toBe(
			first?.messages[0]?.messageId,
		);
		expect(second?.pendingQueueContinueCursor).toBeNull();
	}, 60_000);

	test("keeps a rejected agent value actionable until a human replaces it", async () => {
		const user = await authenticatedBackend(
			t,
			"rejected-mixed-locale-reviewer",
		);
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-rejected-mixed-review-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		const taskReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const localeProposalId =
			taskReview?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!localeProposalId) throw new Error("Expected a Locale Proposal task.");
		const initial = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			limit: 1,
		});
		const source = initial?.messages[0];
		if (!source) throw new Error("Expected the source message.");
		await successfulJson(
			await stagePortugueseValues(t, token, localeProposalId, [
				{
					messageId: source.messageId,
					value: "Rejeitar, {name}!",
					sourceFingerprint: source.sourceFingerprint,
				},
			]),
		);
		const awaiting = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "awaiting",
			limit: 1,
		});
		const valueToken = awaiting?.messages[0]?.value?.reviewToken;
		if (!valueToken) throw new Error("Expected the staged value token.");
		await user.mutation(api.localeProposals.reviewStagedValue, {
			projectId,
			proposalId: localeProposalId,
			messageId: source.messageId,
			expectedValueFingerprint: valueToken,
			decision: { kind: "reject" },
		});

		const rejected = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "awaiting",
			limit: 1,
		});
		expect(rejected?.messages[0]).toMatchObject({
			messageId: source.messageId,
			facts: { state: "needsEdit" },
		});
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId: localeProposalId,
			items: [
				{
					messageId: source.messageId,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: source.sourceFingerprint,
				},
			],
		});
		await expect(
			user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: task.taskId,
			}),
		).resolves.toMatchObject({ deliveryStatus: "ready" });
	}, 60_000);

	test("batch accepts exact new-Locale revisions atomically", async () => {
		const user = await authenticatedBackend(t, "new-locale-batch-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				first: "First",
				second: "Second",
			}),
		});
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-batch-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		await successfulJson(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [
							{ messageId: "first", value: "Primeiro" },
							{ messageId: "second", value: "Segundo" },
						],
					}),
				},
			),
		);
		const taskDetail = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const localeProposalId =
			taskDetail?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!localeProposalId) throw new Error("Expected a Locale Proposal task.");
		const firstReviewPage = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			limit: 16,
		});
		const staleRevisionIds =
			firstReviewPage?.messages.flatMap((message) =>
				message.candidate ? [message.candidate.revisionId] : [],
			) ?? [];
		expect(staleRevisionIds).toHaveLength(2);

		await successfulJson(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId: "first", value: "Primeira" }],
					}),
				},
			),
		);
		await expect(
			user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: task.taskId,
				candidateRevisionIds: staleRevisionIds,
			}),
		).rejects.toThrow("Only current candidate revisions");
		expect(
			(
				await user.query(api.localeProposals.getForReview, {
					proposalId: localeProposalId,
					limit: 16,
				})
			)?.proposal.progress.staged,
		).toBe(0);

		const currentReviewPage = await user.query(
			api.localeProposals.getForReview,
			{
				proposalId: localeProposalId,
				taskId: task.taskId,
				limit: 16,
			},
		);
		const currentRevisionIds =
			currentReviewPage?.messages.flatMap((message) =>
				message.candidate ? [message.candidate.revisionId] : [],
			) ?? [];
		await expect(
			user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: task.taskId,
				candidateRevisionIds: currentRevisionIds,
			}),
		).resolves.toEqual({ accepted: 2, status: "open" });
		const firstCandidate = currentReviewPage?.messages.find(
			(message) => message.messageId === "first",
		)?.candidate;
		if (!firstCandidate)
			throw new Error("Expected the first current candidate.");
		await expect(
			user.mutation(api.agentTranslationProposals.saveTaskValue, {
				taskId: task.taskId,
				messageId: "first",
				candidateToken: firstCandidate.revisionId,
				value: "Primeiro revisto",
			}),
		).resolves.toMatchObject({
			decision: { kind: "acceptWithEdits", value: "Primeiro revisto" },
		});
		const revisedPage = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposalId,
			taskId: task.taskId,
			focus: "reviewed",
			limit: 16,
		});
		expect(
			revisedPage?.messages.find((message) => message.messageId === "first"),
		).toMatchObject({
			value: { value: "Primeiro revisto", updatedBy: { kind: "user" } },
			candidate: {
				review: {
					finalValue: "Primeiro revisto",
					reviewBasisIsCurrent: true,
				},
			},
		});
	}, 60_000);

	test("keeps an agent-proposed Intentional Blank inert until human review", async () => {
		const user = await authenticatedBackend(t, "new-locale-intentional-blank");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				optionalLabel: "Optional label",
			}),
		});
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-blank-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		const submitted = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [
						{
							messageId: "optionalLabel",
							candidate: {
								kind: "intentionalBlank",
								reason: "This label is not shown in Portuguese.",
							},
						},
					],
				}),
			},
		);
		expect(submitted.status).toBe(200);

		const taskDetail = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const proposalId =
			taskDetail?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!proposalId) throw new Error("Expected a Locale Proposal task.");
		const beforeReview = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "attention",
			limit: 16,
		});
		const candidate = beforeReview?.messages[0]?.candidate;
		expect(candidate).toMatchObject({
			value: "",
			intentionalBlankReason: "This label is not shown in Portuguese.",
			review: null,
		});
		expect(beforeReview?.proposal.progress.staged).toBe(0);
		if (!candidate) throw new Error("Expected an Intentional Blank candidate.");
		await expect(
			user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: task.taskId,
				candidateRevisionIds: [candidate.revisionId],
			}),
		).rejects.toThrow("must be reviewed individually");

		await user.mutation(api.agentTranslationProposals.reviewTaskValue, {
			taskId: task.taskId,
			messageId: "optionalLabel",
			candidateToken: candidate.revisionId,
			decision: {
				kind: "intentionalBlank",
				reason: "This label is not shown in Portuguese.",
			},
		});
		const afterReview = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "reviewed",
			limit: 16,
		});
		expect(afterReview?.messages[0]).toMatchObject({
			value: {
				value: "",
				intentionalBlankReason: "This label is not shown in Portuguese.",
				updatedBy: { kind: "user" },
			},
			candidate: { review: { decision: { kind: "intentionalBlank" } } },
		});
	}, 60_000);

	test("pages and separates routine new-Locale review from attention work", async () => {
		const user = await authenticatedBackend(t, "new-locale-focused-review");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				routine: "Translate me",
				same: "Keep",
				greeting: "Hello {name}",
				missing: "Still missing",
			}),
		});
		const { token } = await proposalToken(user, projectId);
		const task = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-focused-review-v1",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		await successfulJson(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [
							{ messageId: "routine", value: "Traduza-me" },
							{ messageId: "same", value: "Keep" },
							{ messageId: "greeting", value: "Olá {name}" },
						],
					}),
				},
			),
		);
		const taskDetail = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const proposalId =
			taskDetail?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!proposalId) throw new Error("Expected a Locale Proposal task.");

		const routine = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "routine",
			limit: 16,
		});
		expect(routine?.messages.map((message) => message.messageId)).toEqual([
			"routine",
		]);
		expect(routine?.messages[0]?.facts).toMatchObject({
			state: "awaiting",
			sourceIdentical: false,
			icu: false,
		});

		const attention = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "attention",
			limit: 16,
		});
		expect(attention?.messages.map((message) => message.messageId)).toEqual([
			"same",
			"greeting",
		]);
		expect(attention?.messages[0]?.facts.sourceIdentical).toBe(true);
		expect(attention?.messages[1]?.facts.icu).toBe(true);

		const searched = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "attention",
			search: "greeting",
			limit: 16,
		});
		expect(searched?.messages.map((message) => message.messageId)).toEqual([
			"greeting",
		]);

		const missing = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "missing",
			limit: 16,
		});
		expect(missing?.messages.map((message) => message.messageId)).toEqual([
			"missing",
		]);

		const firstPage = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "all",
			limit: 2,
		});
		expect(firstPage?.messages.map((message) => message.messageId)).toEqual([
			"routine",
			"same",
		]);
		expect(firstPage?.continueCursor).toBe(2);
		const secondPage = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			focus: "all",
			cursor: firstPage?.continueCursor ?? undefined,
			limit: 2,
		});
		expect(secondPage?.messages.map((message) => message.messageId)).toEqual([
			"greeting",
			"missing",
		]);
		expect(secondPage?.continueCursor).toBeNull();
	}, 60_000);

	test("starts one resumable human new-Locale task", async () => {
		const user = await authenticatedBackend(t, "new-locale-human-starter");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const first = await user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId,
				title: "pt · complete catalog",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const resumed = await user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId,
				title: "Another title must still resume",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		expect(resumed).toEqual(first);
		expect(first).toMatchObject({ localeCode: "pt", targetCount: 1 });
		const tasks = await user.query(
			api.agentTranslationProposals.listForReview,
			{
				projectId,
				paginationOpts: { numItems: 10, cursor: null },
			},
		);
		expect(tasks.page).toHaveLength(1);
		expect(tasks.page[0]?._id).toBe(first.taskId);

		const { token } = await proposalToken(user, projectId);
		const listed = await successfulJson<{
			tasks: Array<{
				taskId: Id<"agentTranslationProposals">;
				ownership: "project" | "token";
			}>;
		}>(
			await agentRequest(
				t,
				token,
				"/api/agent/v1/translation-tasks?status=open",
			),
		);
		expect(listed.tasks).toEqual([
			expect.objectContaining({
				taskId: first.taskId,
				ownership: "project",
			}),
		]);

		const agentResume = await successfulJson<{
			taskId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "agent-used-a-different-title",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			}),
		);
		expect(agentResume.taskId).toBe(first.taskId);
	});

	test("does not count ordinary proposal history as task history", async () => {
		const user = await authenticatedBackend(t, "new-locale-task-history");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token, tokenId } = await proposalToken(user, projectId);
		await t.run(async (ctx) => {
			for (let index = 0; index < 129; index += 1) {
				await ctx.db.insert("agentTranslationProposals", {
					projectId,
					createdByTokenId: tokenId,
					createdBy: { kind: "agent", id: tokenId },
					clientProposalKey: `ordinary-${index}`,
					target: { kind: "catalogWorkspace" },
					status: "open",
					candidateCount: 0,
					revisionCount: 0,
					retainedByteLength: 0,
					createdAt: index,
					updatedAt: index,
				});
			}
		});

		const created = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "portuguese-after-ordinary-history",
					target: { kind: "newLocale", localeCode: "pt" },
				}),
			},
		);
		expect(created.status).toBe(200);
		const listed = await successfulJson<{ tasks: Array<{ kind: string }> }>(
			await agentRequest(t, token, "/api/agent/v1/translation-tasks"),
		);
		expect(listed.tasks).toEqual([
			expect.objectContaining({ kind: "newLocale" }),
		]);
	}, 60_000);

	test("rejects an unconfigured new Locale before creating a proposal", async () => {
		const user = await authenticatedBackend(t, "unsupported-new-locale-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const response = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "unsupported-new-locale",
					target: { kind: "newLocale", localeCode: "it" },
				}),
			},
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
		expect(
			await user.query(api.localeProposals.currentForReview, { projectId }),
		).toBeNull();
	});

	test("requires both agent scopes", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const readOnly = await user.mutation(api.apiTokens.create, {
			projectId,
			name: "Read-only agent",
			scopes: ["read"],
		});
		const unauthorized = await agentRequest(
			t,
			readOnly.token,
			"/api/agent/v1/locale-proposals/pt",
			{ method: "POST" },
		);
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({
			error: expect.stringContaining("Invalid or insufficient API token."),
		});
	});

	test("publishes a project CLI floor and refuses only an incompatible protocol", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const proposal = await createPortugueseProposal(t, token);
		await user.mutation(api.projects.update, {
			projectId,
			name: "Primary project",
			minimumCliVersion: "0.2.0",
			minimumCliProtocol: 2,
		});

		const incompatible = await agentRequest(
			t,
			token,
			`/api/agent/v1/locale-proposals/pt?proposalId=${encodeURIComponent(proposal.proposalId)}`,
			{
				headers: {
					"X-Blabla-CLI-Version": "0.1.0",
					"X-Blabla-CLI-Protocol": "1",
				},
			},
		);
		expect(incompatible.status).toBe(426);
		expect(await incompatible.json()).toMatchObject({
			code: "CLI_UPGRADE_REQUIRED",
		});

		const compatible = await agentRequest(
			t,
			token,
			`/api/agent/v1/locale-proposals/pt?proposalId=${encodeURIComponent(proposal.proposalId)}`,
			{
				headers: {
					"X-Blabla-CLI-Version": "0.1.0",
					"X-Blabla-CLI-Protocol": "2",
				},
			},
		);
		expect(compatible.status).toBe(200);
		expect(compatible.headers.get("X-Blabla-Minimum-CLI-Version")).toBe(
			"0.2.0",
		);
		expect(compatible.headers.get("X-Blabla-Minimum-CLI-Protocol")).toBe("2");
	});

	test("persists validation diagnostics and refuses invalid proposal values", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);

		const { token } = await proposalToken(user, projectId);
		const proposal = await createPortugueseProposal(t, token);
		const template = await portugueseTemplate(t, token, proposal.proposalId);
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");
		const { token: validationToken } = await proposalToken(user, projectId);

		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: "unknown",
					value: "Olá",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"not in the pinned Source Snapshot",
		);
		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: message.id,
					value: "Olá, {name}!",
					sourceFingerprint: message.sourceFingerprint,
				},
				{
					messageId: message.id,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"repeats or omits a message identity",
		);
		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: message.id,
					value: "",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"Intentional Blank",
		);
		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: message.id,
					value: "Olá, {name",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"Contract Validity failed",
		);
		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: message.id,
					value: "Olá, {name}!",
					sourceFingerprint: `${message.sourceFingerprint}stale`,
				},
			],
			"outdated Source Contract",
		);
		await expectStageFailure(
			t,
			validationToken,
			proposal.proposalId,
			[
				{
					messageId: message.id,
					value: "Olá, {unknown}!",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"Contract Validity failed",
		);
		const incomplete = await finalizePortugueseProposal(
			t,
			validationToken,
			proposal.proposalId,
		);
		expect(incomplete.status).toBe(400);
		expect(await incomplete.json()).toMatchObject({
			error: expect.stringContaining("Missing Locale value"),
			code: "VALIDATION",
			diagnosticCount: 1,
			diagnostics: [expect.stringContaining("Missing Locale value")],
		});
		const reviewed = await successfulJson<AgentProposal>(
			await agentRequest(
				t,
				validationToken,
				`/api/agent/v1/locale-proposals/pt?proposalId=${encodeURIComponent(proposal.proposalId)}`,
			),
		);
		expect(reviewed.diagnostics).toEqual({
			count: 1,
			messages: [expect.stringContaining("Missing Locale value")],
		});
		const { token: artifactToken } = await proposalToken(user, projectId);
		const unavailableArtifact = await agentRequest(
			t,
			artifactToken,
			`/api/agent/v1/locale-proposals/pt/artifact?proposalId=${encodeURIComponent(proposal.proposalId)}`,
		);
		expect(unavailableArtifact.status).toBe(400);
		expect(await unavailableArtifact.json()).toMatchObject({
			error: expect.stringContaining("has no finalized delivery artifact"),
		});
	});

	test("keeps a resumed proposal pinned despite later source setup changes", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		const frenchLocaleId = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
			label: "French",
		});
		await user.action(api.locales.bind, {
			localeId: frenchLocaleId,
			catalogPath: "intl_fr.arb",
		});
		await ingestSourceBaseline(user, projectId, {
			additionalFiles: [
				{
					catalogPath: "intl_fr.arb",
					content:
						'{"@@locale":"fr","welcome":"Bonjour, {name}!","@welcome":{"description":"Une salutation.","placeholders":{"name":{"type":"String"}}}}',
				},
			],
		});
		const { token } = await proposalToken(user, projectId);

		// This simulates a source-locale migration after the Baseline was ingested.
		// The Agent API must use the snapshot-time source role, then retain that
		// chosen Catalog Document as immutable proposal evidence.
		await t.run(async (ctx) => {
			await ctx.db.patch(projectId, { sourceLocaleId: frenchLocaleId });
		});
		const proposal = await createPortugueseProposal(t, token);

		const template = await portugueseTemplate(t, token, proposal.proposalId);
		expect(template.messages).toMatchObject([
			{ id: "welcome", sourceValue: "Welcome, {name}!" },
		]);
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");
		await successfulJson<AgentProposal>(
			await stagePortugueseValues(t, token, proposal.proposalId, [
				{
					messageId: message.id,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: message.sourceFingerprint,
				},
			]),
		);
		await reviewPortugueseValues(user, projectId, proposal.proposalId);
		await successfulJson<AgentProposal>(
			await finalizePortugueseProposal(t, token, proposal.proposalId),
		);
		await expect(
			portugueseArtifact(t, token, proposal.proposalId),
		).resolves.toMatchObject({
			sourceSnapshot: { catalogPath: "intl_en.arb" },
		});
	});

	test("keeps Portuguese proposals inside the agent token's project", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const firstProjectId = await createProject(user, { slug: "first-project" });
		const secondProjectId = await createProject(user, {
			slug: "second-project",
		});
		await ingestSourceBaseline(user, firstProjectId);
		await ingestSourceBaseline(user, secondProjectId);
		const { token: firstToken } = await proposalToken(user, firstProjectId);
		const { token: secondToken } = await proposalToken(user, secondProjectId);
		const secondProposal = await createPortugueseProposal(t, secondToken);

		const response = await agentRequest(
			t,
			firstToken,
			`/api/agent/v1/locale-proposals/pt?proposalId=${encodeURIComponent(secondProposal.proposalId)}`,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("Locale Proposal not found"),
			code: "NOT_FOUND",
		});
	});

	test("pins a proposal to its Baseline Snapshot and starts fresh after Git advances", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		const baselineSnapshotId = await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const oldProposal = await createPortugueseProposal(t, token);
		const template = await portugueseTemplate(t, token, oldProposal.proposalId);
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");

		const nextSnapshotId = await ingestSourceBaseline(user, projectId, {
			commit: "next",
			content:
				'{"@@locale":"en","welcome":"Welcome back, {name}!","@welcome":{"description":"A welcome for a signed-in person.","placeholders":{"name":{"type":"String"}}}}',
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});

		await expectStageFailure(
			t,
			token,
			oldProposal.proposalId,
			[
				{
					messageId: message.id,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
			"no longer the Baseline Snapshot",
			"STALE_SOURCE",
		);
		expect(
			await successfulJson<AgentProposal>(
				await agentRequest(
					t,
					token,
					`/api/agent/v1/locale-proposals/pt?proposalId=${encodeURIComponent(oldProposal.proposalId)}`,
				),
			),
		).toMatchObject({
			sourceSnapshotId: baselineSnapshotId,
			deliveryStatus: "stale",
		});

		const currentProposal = await createPortugueseProposal(t, token);
		expect(currentProposal).toMatchObject({
			sourceSnapshotId: nextSnapshotId,
			progress: { total: 1, staged: 0, remaining: 1 },
		});
		expect(currentProposal.proposalId).not.toBe(oldProposal.proposalId);
	});

	test("carries compatible reviewed values onto the current Source and leaves only residue", async () => {
		const user = await authenticatedBackend(
			t,
			"locale-proposal-continuation-owner",
		);
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				unchanged: "Unchanged",
				changed: "Before",
			}),
		});
		const oldTask = await user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId,
				title: "Portuguese first pass",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const oldTaskDetail = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: oldTask.taskId },
		);
		const oldProposalId =
			oldTaskDetail?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!oldProposalId) throw new Error("Expected the old Locale Proposal.");
		const oldPage = await user.query(api.localeProposals.getForReview, {
			proposalId: oldProposalId,
			taskId: oldTask.taskId,
			limit: 16,
		});
		if (!oldPage) throw new Error("Expected the old review page.");
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId: oldProposalId,
			items: oldPage.messages.map((message) => ({
				messageId: message.messageId,
				value: message.messageId === "unchanged" ? "Sem mudancas" : "Antes",
				sourceFingerprint: message.sourceFingerprint,
			})),
		});
		await user.action(api.agentTranslationProposals.finalizeTask, {
			taskId: oldTask.taskId,
		});

		await ingestSourceBaseline(user, projectId, {
			commit: "next",
			content: JSON.stringify({
				"@@locale": "en",
				unchanged: "Unchanged",
				changed: "After",
				added: "Added",
			}),
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});

		await expect(
			user.query(api.localeProposals.getForReview, {
				proposalId: oldProposalId,
				taskId: oldTask.taskId,
				limit: 16,
			}),
		).resolves.toMatchObject({
			isCurrentBaseline: false,
			messages: [
				{ messageId: "unchanged", value: { value: "Sem mudancas" } },
				{ messageId: "changed", value: { value: "Antes" } },
			],
		});

		const continued = await user.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: oldTask.taskId },
		);
		expect(continued).toMatchObject({
			carriedValueCount: 1,
			remainingValueCount: 2,
			totalValueCount: 3,
		});
		expect(continued.taskId).not.toBe(oldTask.taskId);

		const currentPage = await user.query(api.localeProposals.getForReview, {
			proposalId: continued.localeProposalId,
			taskId: continued.taskId,
			focus: "all",
			limit: 16,
		});
		expect(currentPage?.messages).toMatchObject([
			{ messageId: "unchanged", value: { value: "Sem mudancas" } },
			{ messageId: "changed", value: null },
			{ messageId: "added", value: null },
		]);
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId: continued.localeProposalId,
			items:
				currentPage?.messages
					.filter((message) => message.value === null)
					.map((message) => ({
						messageId: message.messageId,
						value: message.messageId === "changed" ? "Depois" : "Adicionado",
						sourceFingerprint: message.sourceFingerprint,
					})) ?? [],
		});
		await expect(
			user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: continued.taskId,
			}),
		).resolves.toMatchObject({ deliveryStatus: "ready" });
		expect(
			await user.action(api.localeProposals.artifactForReview, {
				projectId,
				proposalId: oldProposalId,
			}),
		).toMatchObject({ proposalId: oldProposalId });
	}, 60_000);

	test("leaves metadata-only Source Contract changes as translation residue", async () => {
		const user = await authenticatedBackend(
			t,
			"locale-proposal-contract-continuation-owner",
		);
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId, {
			content: JSON.stringify({
				"@@locale": "en",
				count: "{count} items",
				"@count": { placeholders: { count: { type: "int" } } },
			}),
		});
		const task = await user.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Portuguese contract pass",
			target: { kind: "newLocale", localeCode: "pt" },
			scope: { kind: "completeCatalog" },
		});
		const taskDetail = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const proposalId =
			taskDetail?.proposal.localeProposalTaskScope?.localeProposalId;
		if (!proposalId) throw new Error("Expected a Locale Proposal.");
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			limit: 16,
		});
		const [message] = page?.messages ?? [];
		if (!message) throw new Error("Expected the source message.");
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId,
			items: [
				{
					messageId: message.messageId,
					value: "{count} itens",
					sourceFingerprint: message.sourceFingerprint,
				},
			],
		});

		await ingestSourceBaseline(user, projectId, {
			commit: "next-contract",
			content: JSON.stringify({
				"@@locale": "en",
				count: "{count} items",
				"@count": { placeholders: { count: { type: "String" } } },
			}),
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
		});

		await expect(
			user.action(api.agentTranslationProposals.continueNewLocaleTask, {
				taskId: task.taskId,
			}),
		).resolves.toMatchObject({
			carriedValueCount: 0,
			incompatibleValueCount: 1,
			remainingValueCount: 1,
			totalValueCount: 1,
		});
	}, 60_000);

	test("accepts an exact Intentional Blank with its reason", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const proposal = await createPortugueseProposal(t, token);
		const template = await portugueseTemplate(t, token, proposal.proposalId);
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");

		await successfulJson<AgentProposal>(
			await stagePortugueseValues(t, token, proposal.proposalId, [
				{
					messageId: message.id,
					value: "",
					sourceFingerprint: message.sourceFingerprint,
					intentionalBlankReason:
						"This message is intentionally hidden in Portuguese.",
				},
			]),
		);
		await expect(
			portugueseStagedValues(t, token, proposal.proposalId),
		).resolves.toMatchObject({
			values: [
				{
					messageId: "welcome",
					value: "",
					sourceFingerprint: message.sourceFingerprint,
					intentionalBlankReason:
						"This message is intentionally hidden in Portuguese.",
				},
			],
		});
		await reviewPortugueseValues(user, projectId, proposal.proposalId);
		await expect(
			successfulJson<AgentProposal>(
				await finalizePortugueseProposal(t, token, proposal.proposalId),
			),
		).resolves.toMatchObject({ status: "ready" });
		await expect(
			portugueseArtifact(t, token, proposal.proposalId),
		).resolves.toMatchObject({
			catalog: { content: expect.stringContaining('"welcome": ""') },
		});
	});

	test("creates a source-pinned Portuguese delivery artifact", async () => {
		const user = await authenticatedBackend(t, "locale-proposal-owner");
		const projectId = await createProject(user);
		const snapshotId = await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);

		const proposal = await createPortugueseProposal(t, token);
		expect(proposal).toMatchObject({
			sourceSnapshotId: snapshotId,
			locale: {
				code: "pt",
				label: "Portuguese",
				runtimeLocale: "pt-BR",
			},
			status: "draft",
			progress: { total: 1, staged: 0, remaining: 1 },
		});

		const template = await portugueseTemplate(t, token, proposal.proposalId);
		expect(template).toMatchObject({
			sourceSnapshotId: snapshotId,
			isDone: true,
			messages: [
				{
					id: "welcome",
					sourceValue: "Welcome, {name}!",
					staged: false,
					metadataJson:
						'{"description":"A welcome for a signed-in person.","placeholders":{"name":{"type":"String"}}}',
				},
			],
		});
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");

		const staged = await successfulJson<AgentProposal>(
			await stagePortugueseValues(t, token, proposal.proposalId, [
				{
					messageId: message.id,
					value: "Boas-vindas, {name}!",
					sourceFingerprint: message.sourceFingerprint,
				},
			]),
		);
		expect(staged.progress).toEqual({ total: 1, staged: 1, remaining: 0 });
		const resumedTemplate = await portugueseTemplate(
			t,
			token,
			proposal.proposalId,
		);
		expect(resumedTemplate.messages).toMatchObject([
			{ id: "welcome", staged: true },
		]);
		await reviewPortugueseValues(user, projectId, proposal.proposalId);

		const finalized = await successfulJson<AgentProposal>(
			await finalizePortugueseProposal(t, token, proposal.proposalId),
		);
		expect(finalized).toMatchObject({
			status: "ready",
			proposalId: proposal.proposalId,
		});

		const artifact = await portugueseArtifact(t, token, proposal.proposalId);
		expect(artifact).toMatchObject({
			proposalId: proposal.proposalId,
			sourceSnapshot: {
				id: snapshotId,
				commit: "baseline",
				integrationBranch: "develop",
			},
			locale: {
				code: "pt",
				label: "Portuguese",
				runtimeLocale: "pt-BR",
			},
			catalog: {
				fileName: "intl_pt.arb",
				content:
					'{\n  "@@locale": "pt",\n  "welcome": "Boas-vindas, {name}!",\n  "@welcome": {\n    "description": "A welcome for a signed-in person.",\n    "placeholders": {\n      "name": {\n        "type": "String"\n      }\n    }\n  }\n}',
			},
		});
	});

	test("routes a locale candidate through the generic agent review seam", async () => {
		const user = await authenticatedBackend(t, "generic-locale-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { token } = await proposalToken(user, projectId);
		const localeProposal = await createPortugueseProposal(t, token);
		const template = await portugueseTemplate(
			t,
			token,
			localeProposal.proposalId,
		);
		const [message] = template.messages;
		if (!message) throw new Error("Expected the welcome template message.");

		const created = await successfulJson<{
			proposalId: Id<"agentTranslationProposals">;
		}>(
			await agentRequest(t, token, "/api/agent/v1/translation-proposals", {
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "pt-welcome-v1",
					target: {
						kind: "localeProposal",
						localeProposalId: localeProposal.proposalId,
					},
				}),
			}),
		);
		const revision = await successfulJson<{
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		}>(
			await agentRequest(
				t,
				token,
				`/api/agent/v1/translation-proposals/${created.proposalId}/candidate-revisions`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [
							{
								messageId: message.id,
								value: "Boas-vindas, {name}!",
								clientRevisionKey: "pt-welcome-v1-r1",
								expectedCandidateRevision: 0,
								basis: {
									kind: "localeProposal",
									localeProposalId: localeProposal.proposalId,
									snapshotId: template.sourceSnapshotId,
									sourceFingerprint: message.sourceFingerprint,
								},
							},
						],
					}),
				},
			),
		);
		const revisionId = revision.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected a locale candidate revision.");

		const review = await user.mutation(
			api.agentTranslationProposals.reviewCandidate,
			{
				candidateRevisionId: revisionId,
				decision: { kind: "accept" },
			},
		);
		expect(review.decision).toEqual({ kind: "accept" });

		const reviewPage = await user.query(api.localeProposals.getForReview, {
			proposalId: localeProposal.proposalId,
			limit: 16,
		});
		const reviewed = reviewPage?.messages.find(
			(entry) => entry.messageId === message.id,
		);
		expect(reviewed).toMatchObject({
			value: {
				value: "Boas-vindas, {name}!",
				updatedBy: { kind: "user" },
			},
			review: { decision: { kind: "accept" } },
		});

		await expect(
			user.action(api.localeProposals.finalizeForReview, {
				projectId,
				proposalId: localeProposal.proposalId,
			}),
		).resolves.toMatchObject({ status: "ready" });
	});

	test("lets an editor prepare and approve an Intentional Blank", async () => {
		const user = await authenticatedBackend(t, "manual-locale-reviewer");
		const projectId = await createProject(user);
		await ingestSourceBaseline(user, projectId);
		const { proposalId } = await user.mutation(
			api.localeProposals.ensureForReview,
			{ projectId, localeCode: "pt" },
		);
		const page = await user.query(api.localeProposals.getForReview, {
			proposalId,
			limit: 16,
		});
		const [message] = page?.messages ?? [];
		if (!message) throw new Error("Expected the source message.");

		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId,
			items: [
				{
					messageId: message.messageId,
					value: "",
					sourceFingerprint: message.sourceFingerprint,
					intentionalBlankReason: "Not shown in the Portuguese experience.",
				},
			],
		});
		await user.mutation(api.localeProposals.reviewStagedValue, {
			projectId,
			proposalId,
			messageId: message.messageId,
			decision: {
				kind: "intentionalBlank",
				reason: "Not shown in the Portuguese experience.",
			},
		});

		await expect(
			user.action(api.localeProposals.finalizeForReview, {
				projectId,
				proposalId,
			}),
		).resolves.toMatchObject({ status: "ready" });
	});
});

test("new-locale templates expose limits and staging rejects oversized Unicode text clearly", async () => {
	const t = createBackend();
	const user = await authenticatedBackend(t, "limit-editor");
	const projectId = await createProject(user);
	await ingestSourceBaseline(user, projectId, {
		content: JSON.stringify({ "@@locale": "en", title: "Title" }),
	});
	await user.mutation(api.messageConstraints.setCharacterLimit, {
		projectId,
		messageId: "title",
		characterLimit: 3,
		expectedCharacterLimit: null,
	});
	const { token } = await proposalToken(user, projectId);
	const { proposalId } = await createPortugueseProposal(t, token);
	const template = await portugueseTemplate(t, token, proposalId);
	expect(template.messages[0]).toMatchObject({
		id: "title",
		characterLimit: 3,
	});
	const sourceFingerprint = template.messages[0]?.sourceFingerprint;
	if (!sourceFingerprint) throw new Error("Missing source fingerprint");
	const rejected = await stagePortugueseValues(t, token, proposalId, [
		{ messageId: "title", value: "😀abc", sourceFingerprint },
	]);
	expect(rejected.status).toBe(400);
	expect(await rejected.json()).toMatchObject({
		code: "CHARACTER_LIMIT_EXCEEDED",
		messageId: "title",
		characterLimit: 3,
		characterCount: 4,
		overBy: 1,
	});
	await successfulJson(
		await stagePortugueseValues(t, token, proposalId, [
			{ messageId: "title", value: "😀ab", sourceFingerprint },
		]),
	);
});
