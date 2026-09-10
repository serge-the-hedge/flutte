import { beforeEach, describe, expect, test } from "vitest";

import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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

async function setupProject(user: AuthenticatedBackend) {
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the source Locale.");
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
	const ingested = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
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
	if (!ingested.snapshotId) throw new Error("Expected a baseline snapshot.");
	const token = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "translation agent",
		scopes: ["read", "search", "propose"],
	});
	return { projectId, targetId, token: token.token };
}

async function setupWorkQueueProject(user: AuthenticatedBackend) {
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the source Locale.");
	const de = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	const fr = await user.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	for (const [localeId, catalogPath] of [
		[source._id, "en.arb"],
		[de, "de.arb"],
		[fr, "fr.arb"],
	] as const) {
		await user.action(api.locales.bind, { localeId, catalogPath });
	}
	const ingested = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "work-queue-baseline",
		files: [
			{
				catalogPath: "en.arb",
				content: JSON.stringify({
					"@@locale": "en",
					missing: "Needs translation",
					emptySource: "",
					echo: "Brickit",
					repeated: "Continue",
					unrelatedOne: "First shared label",
					unrelatedTwo: "Second shared label",
				}),
			},
			{
				catalogPath: "de.arb",
				content: JSON.stringify({
					"@@locale": "de",
					echo: "Brickit",
					repeated: "Weiter",
					unrelatedOne: "Gemeinsam",
					unrelatedTwo: "Gemeinsam",
				}),
			},
			{
				catalogPath: "fr.arb",
				content: JSON.stringify({
					"@@locale": "fr",
					missing: "À traduire",
					echo: "Briques",
					repeated: "Weiter",
					unrelatedOne: "Premier",
					unrelatedTwo: "Deuxième",
				}),
			},
		],
	});
	if (!ingested.snapshotId) throw new Error("Expected a baseline snapshot.");
	const token = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "work queue agent",
		scopes: ["read", "search", "propose"],
	});
	return { projectId, de, token: token.token };
}

async function setupSparseWorkQueueProject(user: AuthenticatedBackend) {
	const projectId = await createProject(user);
	const locales = await user.query(api.locales.list, { projectId });
	const source = locales.find((locale) => locale.code === "en");
	if (!source) throw new Error("Expected the source Locale.");
	const de = await user.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await user.action(api.locales.bind, {
		localeId: de,
		catalogPath: "de.arb",
	});

	const sourceCatalog: Record<string, string> = { "@@locale": "en" };
	const targetCatalog: Record<string, string> = { "@@locale": "de" };
	for (let index = 0; index < 70; index += 1) {
		const messageId = `item_${index.toString().padStart(3, "0")}`;
		sourceCatalog[messageId] = `Source ${index}`;
		targetCatalog[messageId] = `Deutsch ${index}`;
	}
	sourceCatalog.z_missing = "Last missing value";

	const ingested = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "sparse-work-queue-baseline",
		files: [
			{ catalogPath: "en.arb", content: JSON.stringify(sourceCatalog) },
			{ catalogPath: "de.arb", content: JSON.stringify(targetCatalog) },
		],
	});
	if (!ingested.snapshotId) throw new Error("Expected a baseline snapshot.");
	const token = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "sparse work queue agent",
		scopes: ["read", "search", "propose"],
	});
	return token.token;
}

async function targetBasis(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
) {
	const workspace = await readWorkspaceKeyCards(user, projectId);
	const key = workspace.keys.find((entry) => entry.id === "greeting");
	const target = key?.values.find((value) => !value.isSource);
	if (
		!target?.snapshotId ||
		target.gitValueFingerprint === undefined ||
		target.gitValueRevision === undefined ||
		target.workspaceRevision === undefined ||
		target.expectedSourceFingerprint === undefined
	) {
		throw new Error("Expected a complete Catalog Workspace target basis.");
	}
	return {
		projectionId: workspace.projectionId,
		snapshotId: target.snapshotId,
		gitValueFingerprint: target.gitValueFingerprint,
		gitValueRevision: target.gitValueRevision,
		workspaceRevision: target.workspaceRevision,
		sourceFingerprint: target.expectedSourceFingerprint,
		localeId: target.localeId,
	};
}

describe("Agent Translation Proposals", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	test("discovers current workspace facts through the agent transport", async () => {
		const user = await authenticatedBackend(t, "agent-translation-discovery");
		const { token } = await setupProject(user);

		const search = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/search?q=greeting&localeCode=de",
		);
		expect(search.status).toBe(200);
		const searchBody = (await search.json()) as {
			results: Array<{ messageId: string; target: { value: string } }>;
		};
		expect(searchBody.results).toEqual([
			expect.objectContaining({
				messageId: "greeting",
				target: expect.objectContaining({ value: "Hallo {name}" }),
			}),
		]);

		const context = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/context",
			{
				method: "POST",
				body: JSON.stringify({ keys: ["greeting"], locales: ["de"] }),
			},
		);
		expect(context.status).toBe(200);
		const contextBody = (await context.json()) as {
			rows: Array<{
				basis: {
					projectionId: string;
					snapshotId: string;
					gitValueFingerprint: string;
				};
			}>;
		};
		expect(contextBody.rows).toHaveLength(1);
		expect(contextBody.rows[0]?.basis).toMatchObject({
			projectionId: expect.any(String),
			snapshotId: expect.any(String),
			gitValueFingerprint: expect.any(String),
		});

		const confirmationPlan = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/ordinary-confirmations?limit=10",
		);
		expect(confirmationPlan.status).toBe(200);
		expect(await confirmationPlan.json()).toMatchObject({
			policy: "ordinary-v1",
			candidates: [expect.objectContaining({ messageId: "greeting" })],
			nextCursor: null,
		});
	});

	test("pages the complete translation work queue without cross-key repetition noise", async () => {
		const user = await authenticatedBackend(t, "agent-translation-work-queue");
		const { token } = await setupWorkQueueProject(user);
		const items: Array<{
			messageId: string;
			localeCode: string;
			reasons: string[];
			sourceValue: string;
			targetValue: string;
		}> = [];
		let cursor = "";
		do {
			const response = await agentRequest(
				t,
				token,
				`/api/agent/v1/workspace/work?limit=2&cursor=${encodeURIComponent(cursor)}`,
			);
			expect(response.status).toBe(200);
			const page = (await response.json()) as {
				items: typeof items;
				nextCursor: string | null;
			};
			items.push(...page.items);
			cursor = page.nextCursor ?? "";
		} while (cursor);

		expect(items).toEqual([
			expect.objectContaining({
				messageId: "missing",
				localeCode: "de",
				reasons: ["missing"],
				sourceValue: "Needs translation",
				targetValue: "",
			}),
			expect.objectContaining({
				messageId: "echo",
				localeCode: "de",
				reasons: ["sourceIdentical"],
			}),
			expect.objectContaining({
				messageId: "repeated",
				localeCode: "de",
				reasons: ["sameKeyRepeat"],
			}),
			expect.objectContaining({
				messageId: "repeated",
				localeCode: "fr",
				reasons: ["sameKeyRepeat"],
			}),
		]);
		expect(items.some((item) => item.messageId.startsWith("unrelated"))).toBe(
			false,
		);
		expect(items.some((item) => item.messageId === "emptySource")).toBe(false);

		const missingGerman = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/work?localeCode=de&reason=missing&limit=16",
		);
		expect(missingGerman.status).toBe(200);
		expect(await missingGerman.json()).toMatchObject({
			items: [
				expect.objectContaining({
					messageId: "missing",
					localeCode: "de",
				}),
			],
			nextCursor: null,
		});

		const staleCursor = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/work?cursor=v1.stale-projection.0.0",
		);
		expect(staleCursor.status).toBe(409);
		expect(await staleCursor.json()).toMatchObject({ code: "STALE_BASIS" });
	});

	test("keeps paging across an empty scan window to sparse work", async () => {
		const user = await authenticatedBackend(t, "sparse-translation-work-queue");
		const token = await setupSparseWorkQueueProject(user);
		const firstResponse = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/work?localeCode=de&reason=missing",
		);
		expect(firstResponse.status).toBe(200);
		const firstPage = (await firstResponse.json()) as {
			items: Array<{ messageId: string }>;
			nextCursor: string | null;
		};
		expect(firstPage.items).toEqual([]);
		expect(firstPage.nextCursor).toEqual(expect.any(String));

		const secondResponse = await agentRequest(
			t,
			token,
			`/api/agent/v1/workspace/work?localeCode=de&reason=missing&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
		);
		expect(secondResponse.status).toBe(200);
		expect(await secondResponse.json()).toMatchObject({
			items: [
				expect.objectContaining({
					messageId: "z_missing",
					reasons: ["missing"],
				}),
			],
			nextCursor: null,
		});
	});

	test("does not call old Git content Source-identical while a Source Proposal is pending", async () => {
		const user = await authenticatedBackend(t, "pending-source-work-queue");
		const { projectId, token } = await setupWorkQueueProject(user);
		const workspace = await readWorkspaceKeyCards(user, projectId);
		const source = workspace.keys
			.find((key) => key.id === "echo")
			?.values.find((value) => value.isSource);
		if (
			!source ||
			source.gitValueFingerprint === undefined ||
			source.gitValueRevision === undefined ||
			source.workspaceRevision === undefined
		) {
			throw new Error("Expected the Source concurrency basis.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "echo",
			localeId: source.localeId,
			intent: { kind: "save", value: "Brickit app" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});

		const response = await agentRequest(
			t,
			token,
			"/api/agent/v1/workspace/work?localeCode=de&reason=sourceIdentical",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [],
			nextCursor: null,
		});
	});

	test("rejects over-limit agent submissions with actionable counts and rechecks acceptance", async () => {
		const user = await authenticatedBackend(t, "agent-character-limits");
		const { projectId, token } = await setupProject(user);
		const basis = await targetBasis(user, projectId);
		await user.mutation(api.messageConstraints.setCharacterLimit, {
			projectId,
			messageId: "greeting",
			characterLimit: 8,
			expectedCharacterLimit: null,
		});
		const created = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-proposals",
			{
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "limited",
					target: { kind: "catalogWorkspace" },
				}),
			},
		);
		expect(created.status).toBe(200);
		const { proposalId } = (await created.json()) as {
			proposalId: Id<"agentTranslationProposals">;
		};
		const submit = (value: string, clientRevisionKey: string) =>
			agentRequest(
				t,
				token,
				`/api/agent/v1/translation-proposals/${proposalId}/candidate-revisions`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [
							{
								messageId: "greeting",
								localeId: basis.localeId,
								value,
								clientRevisionKey,
								expectedCandidateRevision: 0,
								basis,
							},
						],
					}),
				},
			);
		const rejected = await submit("😀😀 {name}", "too-long");
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({
			code: "CHARACTER_LIMIT_EXCEEDED",
			messageId: "greeting",
			characterLimit: 8,
			characterCount: 9,
			overBy: 1,
			error: expect.stringMatching(/remove|shorten/i),
		});
		const accepted = await submit("😀 {name}", "fits");
		expect(accepted.status).toBe(200);
		const { revisions } = (await accepted.json()) as {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		};
		const revisionId = revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected a valid candidate.");
		expect(
			await user.query(api.agentTranslationProposals.contextForReview, {
				revisionId,
			}),
		).toMatchObject({ characterLimit: 8 });
		await user.mutation(api.messageConstraints.setCharacterLimit, {
			projectId,
			messageId: "greeting",
			characterLimit: 7,
			expectedCharacterLimit: 8,
		});
		await expect(
			user.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: revisionId,
				decision: { kind: "accept" },
			}),
		).rejects.toThrow(/character/i);
		// A retry returns the already-saved immutable candidate; it does not apply it.
		expect((await submit("😀 {name}", "fits")).status).toBe(200);
		await user.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: revisionId,
			decision: { kind: "acceptWithEdits", value: "😀{name}" },
		});
	});

	test("creates, resumes, and human-accepts a Catalog Workspace candidate", async () => {
		const user = await authenticatedBackend(t, "agent-translation-reviewer");
		const { projectId, token } = await setupProject(user);
		const basis = await targetBasis(user, projectId);

		const createResponse = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-proposals",
			{
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "greeting-de-v1",
					target: { kind: "catalogWorkspace" },
				}),
			},
		);
		expect(createResponse.status).toBe(200);
		const proposal = (await createResponse.json()) as {
			proposalId: Id<"agentTranslationProposals">;
		};

		const resumedResponse = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-proposals",
			{
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "greeting-de-v1",
					target: { kind: "catalogWorkspace" },
				}),
			},
		);
		expect(resumedResponse.status).toBe(200);
		expect((await resumedResponse.json()).proposalId).toBe(proposal.proposalId);

		const revisionResponse = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-proposals/${proposal.proposalId}/candidate-revisions`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [
						{
							messageId: "greeting",
							localeId: basis.localeId,
							value: "Guten Tag {name}",
							clientRevisionKey: "greeting-de-v1-r1",
							expectedCandidateRevision: 0,
							basis,
						},
					],
				}),
			},
		);
		expect(revisionResponse.status).toBe(200);
		const revision = (await revisionResponse.json()) as {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		};
		const revisionId = revision.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected a candidate revision.");
		const reviewContext = await user.query(
			api.agentTranslationProposals.contextForReview,
			{ revisionId },
		);
		expect(reviewContext).toMatchObject({
			available: true,
			localeCode: "de",
			basisIsCurrent: true,
			source: {
				value: "Hello {name}",
				argumentNames: ["name"],
			},
			target: { value: "Hallo {name}", catalogPath: "de.arb" },
		});

		const historyBeforeAcceptance = await user.query(
			api.translationHistory.list,
			{
				projectId,
				messageId: "greeting",
				localeId: basis.localeId,
			},
		);
		expect(historyBeforeAcceptance.events.map((event) => event.value)).toEqual([
			"Hallo {name}",
		]);

		const review = await user.mutation(
			api.agentTranslationProposals.reviewCandidate,
			{
				candidateRevisionId: revisionId,
				decision: { kind: "acceptWithEdits", value: "Willkommen {name}" },
			},
		);
		expect(review.workspaceRevision).toBe(1);
		expect(
			(
				await user.query(api.translationHistory.list, {
					projectId,
					messageId: "greeting",
					localeId: basis.localeId,
				})
			).events[0],
		).toMatchObject({ kind: "accepted", value: "Willkommen {name}" });

		const workspace = await readWorkspaceKeyCards(user, projectId);
		const value = workspace.keys
			.find((entry) => entry.id === "greeting")
			?.values.find((entry) => entry.localeId === basis.localeId);
		expect(value).toMatchObject({
			value: "Willkommen {name}",
			valueState: "settled",
		});
		// The Navigation Index advanced atomically with the accepted proposal.
		const navRow = await t.run(async (ctx) => {
			const project = await ctx.db.get(projectId);
			const projectionId = project?.activeCatalogProjectionId;
			if (!projectionId) {
				throw new Error("Expected an active Baseline Catalog.");
			}
			return await ctx.db
				.query("catalogWorkspaceNavigationRows")
				.withIndex("by_project_and_projection_and_messageId", (q) =>
					q
						.eq("projectId", projectId)
						.eq("projectionId", projectionId)
						.eq("messageId", "greeting"),
				)
				.unique();
		});
		if (!navRow) throw new Error("Expected the Navigation digest.");
		expect(navRow.searchCorpus).toEqual(["greeting"]);
		expect(navRow.targets[0]).toMatchObject({
			valueState: "settled",
			touched: true,
		});
		const reviewedProposal = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: proposal.proposalId },
		);
		expect(reviewedProposal?.proposal.status).toBe("accepted");
	});

	test("rolls back an exact-acceptance batch when one task candidate is stale", async () => {
		const user = await authenticatedBackend(t, "atomic-task-batch-review");
		const { projectId, de, token } = await setupWorkQueueProject(user);
		const task = await user.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "German repair batch",
			target: { kind: "existingLocale", localeId: de },
			scope: {
				kind: "selectedMessages",
				messageIds: ["missing", "echo"],
			},
		});
		const submission = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [
						{ messageId: "missing", value: "Übersetzung benötigt" },
						{ messageId: "echo", value: "Brickit App" },
					],
				}),
			},
		);
		expect(submission.status).toBe(200);
		const revisions = (await submission.json()) as {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		};
		const revisionIds = revisions.revisions.map(
			(revision) => revision.revisionId,
		);
		expect(revisionIds).toHaveLength(2);

		const before = await readWorkspaceKeyCards(user, projectId);
		const echo = before.keys
			.find((key) => key.id === "echo")
			?.values.find((value) => value.localeId === de);
		if (
			!echo ||
			echo.gitValueFingerprint === undefined ||
			echo.gitValueRevision === undefined ||
			echo.workspaceRevision === undefined ||
			echo.expectedSourceFingerprint === undefined
		) {
			throw new Error("Expected the German echo basis.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "echo",
			localeId: de,
			intent: { kind: "save", value: "Brickit Anwendung" },
			expectedGitValueFingerprint: echo.gitValueFingerprint,
			expectedGitValueRevision: echo.gitValueRevision,
			expectedWorkspaceRevision: echo.workspaceRevision,
			expectedSourceFingerprint: echo.expectedSourceFingerprint,
		});

		await expect(
			user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: task.taskId,
				candidateRevisionIds: revisionIds,
			}),
		).rejects.toThrow(/basis|revision/i);
		const after = await readWorkspaceKeyCards(user, projectId);
		expect(
			after.keys
				.find((key) => key.id === "missing")
				?.values.find((value) => value.localeId === de),
		).toMatchObject({ value: "", valueState: "waiting" });
	});

	test("lets a human freeze an existing-Locale task and an agent fill it without basis plumbing", async () => {
		const user = await authenticatedBackend(t, "human-translation-task");
		const { projectId, targetId, token } = await setupProject(user);
		const created = await user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId,
				title: "Polish German greeting",
				target: { kind: "existingLocale", localeId: targetId },
				scope: { kind: "selectedMessages", messageIds: ["greeting"] },
			},
		);
		expect(created).toMatchObject({
			title: "Polish German greeting",
			localeCode: "de",
			targetCount: 1,
		});

		const taskResponse = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${created.taskId}`,
		);
		expect(taskResponse.status).toBe(200);
		expect(await taskResponse.json()).toMatchObject({
			task: {
				taskId: created.taskId,
				localeCode: "de",
				targetCount: 1,
				candidateCount: 0,
			},
			targets: [
				expect.objectContaining({
					messageId: "greeting",
					sourceValue: "Hello {name}",
					targetValue: "Hallo {name}",
				}),
			],
			nextCursor: null,
		});

		const submit = (value = "Guten Tag {name}") =>
			agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${created.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId: "greeting", value }],
					}),
				},
			);
		const submitted = await submit();
		expect(submitted.status).toBe(200);
		const submittedBody = (await submitted.json()) as {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		};
		const revisionId = submittedBody.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected a task candidate revision.");
		const retry = await submit();
		expect(retry.status).toBe(200);
		expect((await retry.json()).revisions[0]?.revisionId).toBe(revisionId);
		const correction = await submit("Willkommen {name}");
		expect(correction.status).toBe(200);
		const correctionId = (await correction.json()).revisions[0]?.revisionId;
		const restored = await submit();
		expect(restored.status).toBe(200);
		const restoredId = (await restored.json()).revisions[0]?.revisionId;
		if (!restoredId)
			throw new Error("Expected the restored candidate revision.");
		expect(restoredId).not.toBe(revisionId);
		expect(restoredId).not.toBe(correctionId);
		const restoredRetry = await submit();
		expect((await restoredRetry.json()).revisions[0]?.revisionId).toBe(
			restoredId,
		);

		const beforeReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: created.taskId },
		);
		expect(beforeReview).toMatchObject({
			proposal: { status: "open", taskScope: { targetCount: 1 } },
			taskTargets: [expect.objectContaining({ messageId: "greeting" })],
			candidates: [
				expect.objectContaining({
					revision: expect.objectContaining({ value: "Guten Tag {name}" }),
				}),
			],
		});
		expect(
			await user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: created.taskId,
				candidateRevisionIds: [restoredId],
			}),
		).toEqual({ accepted: 1, status: "accepted" });
		expect(
			await user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: created.taskId,
				candidateRevisionIds: [restoredId],
			}),
		).toEqual({ accepted: 0, status: "accepted" });
		const reviewed = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: created.taskId },
		);
		expect(reviewed?.proposal.status).toBe("accepted");
	});

	test("keeps a frozen task scope live across a Source Proposal", async () => {
		const user = await authenticatedBackend(t, "live-translation-task-basis");
		const { projectId, targetId, token } = await setupProject(user);
		const task = await user.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Keep German greeting current",
			target: { kind: "existingLocale", localeId: targetId },
			scope: { kind: "selectedMessages", messageIds: ["greeting"] },
		});
		const submit = () =>
			agentRequest(
				t,
				token,
				`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId: "greeting", value: "Guten Tag {name}" }],
					}),
				},
			);

		const firstSubmission = await submit();
		expect(firstSubmission.status).toBe(200);
		const firstRevisionId = (
			(await firstSubmission.json()) as {
				revisions: Array<{
					revisionId: Id<"agentTranslationCandidateRevisions">;
				}>;
			}
		).revisions[0]?.revisionId;
		if (!firstRevisionId) throw new Error("Expected the first task revision.");

		const workspace = await readWorkspaceKeyCards(user, projectId);
		const source = workspace.keys
			.find((key) => key.id === "greeting")
			?.values.find((value) => value.isSource);
		if (
			!source ||
			source.gitValueFingerprint === undefined ||
			source.gitValueRevision === undefined ||
			source.workspaceRevision === undefined
		) {
			throw new Error("Expected the Source concurrency basis.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: source.localeId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});

		const refreshedTask = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}`,
		);
		expect(refreshedTask.status).toBe(200);
		expect(await refreshedTask.json()).toMatchObject({
			targets: [
				expect.objectContaining({
					messageId: "greeting",
					sourceValue: "Welcome {name}",
				}),
			],
		});

		const refreshedSubmission = await submit();
		expect(refreshedSubmission.status).toBe(200);
		const refreshedRevisionId = (
			(await refreshedSubmission.json()) as {
				revisions: Array<{
					revisionId: Id<"agentTranslationCandidateRevisions">;
				}>;
			}
		).revisions[0]?.revisionId;
		if (!refreshedRevisionId) {
			throw new Error("Expected the refreshed task revision.");
		}
		expect(refreshedRevisionId).not.toBe(firstRevisionId);
		expect(
			await user.query(api.agentTranslationProposals.contextForReview, {
				revisionId: refreshedRevisionId,
			}),
		).toMatchObject({
			available: true,
			basisIsCurrent: true,
			source: { value: "Welcome {name}" },
		});
		expect(
			await user.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
				proposalId: task.taskId,
				candidateRevisionIds: [refreshedRevisionId],
			}),
		).toEqual({ accepted: 1, status: "accepted" });
	});

	test("lets a human keep a stale candidate for the current Source Contract", async () => {
		const user = await authenticatedBackend(t, "keep-stale-translation-task");
		const { projectId, targetId, token } = await setupProject(user);
		const task = await user.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Review German greeting",
			target: { kind: "existingLocale", localeId: targetId },
			scope: { kind: "selectedMessages", messageIds: ["greeting"] },
		});
		const submission = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [{ messageId: "greeting", value: "Guten Tag {name}" }],
				}),
			},
		);
		const revisionId = (
			(await submission.json()) as {
				revisions: Array<{
					revisionId: Id<"agentTranslationCandidateRevisions">;
				}>;
			}
		).revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected a task candidate revision.");

		const workspace = await readWorkspaceKeyCards(user, projectId);
		const source = workspace.keys
			.find((key) => key.id === "greeting")
			?.values.find((value) => value.isSource);
		if (
			!source ||
			source.gitValueFingerprint === undefined ||
			source.gitValueRevision === undefined ||
			source.workspaceRevision === undefined
		) {
			throw new Error("Expected the Source concurrency basis.");
		}
		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: source.localeId,
			intent: { kind: "save", value: "Welcome {name}" },
			expectedGitValueFingerprint: source.gitValueFingerprint,
			expectedGitValueRevision: source.gitValueRevision,
			expectedWorkspaceRevision: source.workspaceRevision,
		});
		expect(
			await user.query(api.agentTranslationProposals.contextForReview, {
				revisionId,
			}),
		).toMatchObject({
			available: true,
			basisIsCurrent: false,
			source: { value: "Welcome {name}" },
		});

		await expect(
			user.mutation(api.agentTranslationProposals.saveTaskValue, {
				taskId: task.taskId,
				messageId: "greeting",
				candidateToken: revisionId,
				value: "Guten Tag {name}",
			}),
		).resolves.toMatchObject({
			decision: { kind: "keepForCurrentSource" },
		});
		await expect(
			user.mutation(api.agentTranslationProposals.saveTaskValue, {
				taskId: task.taskId,
				messageId: "greeting",
				candidateToken: revisionId,
				value: "Willkommen {name}",
			}),
		).resolves.toMatchObject({
			decision: {
				kind: "acceptWithEdits",
				value: "Willkommen {name}",
			},
		});
		const after = await readWorkspaceKeyCards(user, projectId);
		expect(
			after.keys
				.find((key) => key.id === "greeting")
				?.values.find((value) => value.localeId === targetId),
		).toMatchObject({ value: "Willkommen {name}", valueState: "settled" });
		const evidence = await t.run(async (ctx) => {
			return await ctx.db
				.query("agentTranslationCandidateReviews")
				.withIndex("by_revision", (q) => q.eq("revisionId", revisionId))
				.order("desc")
				.collect();
		});
		expect(evidence).toHaveLength(2);
		expect(evidence[0]).toMatchObject({
			decision: {
				kind: "acceptWithEdits",
				value: "Willkommen {name}",
			},
		});
		expect(evidence[1]).toMatchObject({
			decision: { kind: "keepForCurrentSource" },
			appliedBasis: { kind: "catalogWorkspace" },
		});
		expect(evidence[1]?.appliedBasis).not.toEqual(
			(await t.run((ctx) => ctx.db.get(revisionId)))?.basis,
		);
	});

	test("creates the same existing-Locale task through explicit and legacy targets", async () => {
		const user = await authenticatedBackend(t, "agent-owned-translation-task");
		const { token } = await setupWorkQueueProject(user);
		const create = (body: Record<string, unknown>) =>
			agentRequest(t, token, "/api/agent/v1/translation-tasks", {
				method: "POST",
				body: JSON.stringify(body),
			});
		const explicit = await create({
			clientTaskKey: "german-missing-v1",
			target: { kind: "existingLocale", localeCode: "de" },
			messageIds: ["missing"],
		});
		expect(explicit.status).toBe(200);
		const task = (await explicit.json()) as {
			taskId: Id<"agentTranslationProposals">;
			localeCode: string;
			targetCount: number;
		};
		expect(task).toMatchObject({ localeCode: "de", targetCount: 1 });

		const legacyRetry = await create({
			clientTaskKey: "german-missing-v1",
			localeCode: "de",
			messageIds: ["missing"],
		});
		expect(legacyRetry.status).toBe(200);
		expect(await legacyRetry.json()).toMatchObject({ taskId: task.taskId });

		const submission = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [{ messageId: "missing", value: "Übersetzung benötigt" }],
				}),
			},
		);
		expect(submission.status).toBe(200);
		const firstReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const firstRevision = firstReview?.candidates[0]?.revision;
		if (!firstRevision) throw new Error("Expected the submitted candidate.");
		const correction = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [{ messageId: "missing", value: "Übersetzung vorhanden" }],
				}),
			},
		);
		expect(correction.status).toBe(200);
		await expect(
			user.mutation(api.agentTranslationProposals.reviewTaskValue, {
				taskId: task.taskId,
				messageId: "missing",
				candidateToken: firstRevision._id,
				decision: { kind: "accept" },
			}),
		).rejects.toThrow("changed; refresh");
		const currentReview = await user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId },
		);
		const currentRevision = currentReview?.candidates[0]?.revision;
		if (!currentRevision) throw new Error("Expected the corrected candidate.");
		await expect(
			user.mutation(api.agentTranslationProposals.reviewTaskValue, {
				taskId: task.taskId,
				messageId: "missing",
				candidateToken: currentRevision._id,
				decision: { kind: "accept" },
			}),
		).resolves.toMatchObject({
			taskId: task.taskId,
			messageId: "missing",
			decision: { kind: "accept" },
		});
		await expect(
			user.mutation(api.agentTranslationProposals.reviewTaskValue, {
				taskId: task.taskId,
				messageId: "missing",
				candidateToken: currentRevision._id,
				decision: { kind: "reject" },
			}),
		).resolves.toMatchObject({ decision: { kind: "accept" } });
		await expect(
			user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: task.taskId,
			}),
		).resolves.toMatchObject({
			kind: "existingLocale",
			taskId: task.taskId,
			releaseRecordId: expect.any(String),
			releaseStatus: "preparing",
		});
	});

	test("rejects an agent blank and rejects stale basis evidence", async () => {
		const user = await authenticatedBackend(t, "agent-translation-safety");
		const { projectId, token } = await setupProject(user);
		const basis = await targetBasis(user, projectId);
		const createResponse = await agentRequest(
			t,
			token,
			"/api/agent/v1/translation-proposals",
			{
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "safety",
					target: { kind: "catalogWorkspace" },
				}),
			},
		);
		const proposal = (await createResponse.json()) as {
			proposalId: Id<"agentTranslationProposals">;
		};
		const blank = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-proposals/${proposal.proposalId}/candidate-revisions`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [
						{
							messageId: "greeting",
							localeId: basis.localeId,
							value: "",
							clientRevisionKey: "blank",
							expectedCandidateRevision: 0,
							basis,
						},
					],
				}),
			},
		);
		expect(blank.status).toBe(400);
		expect(await blank.json()).toMatchObject({
			code: "VALIDATION",
		});

		await user.mutation(api.catalogWorkspace.commit, {
			projectId,
			messageId: "greeting",
			localeId: basis.localeId,
			intent: { kind: "save", value: "Hallo zusammen {name}" },
			expectedGitValueFingerprint: basis.gitValueFingerprint,
			expectedGitValueRevision: basis.gitValueRevision,
			expectedWorkspaceRevision: basis.workspaceRevision,
			expectedSourceFingerprint: basis.sourceFingerprint,
		});
		const stale = await agentRequest(
			t,
			token,
			`/api/agent/v1/translation-proposals/${proposal.proposalId}/candidate-revisions`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [
						{
							messageId: "greeting",
							localeId: basis.localeId,
							value: "Guten Morgen {name}",
							clientRevisionKey: "stale",
							expectedCandidateRevision: 0,
							basis,
						},
					],
				}),
			},
		);
		expect(stale.status).toBe(400);
		expect(await stale.json()).toMatchObject({ code: "STALE_BASIS" });
	});

	test("returns retryable HTTP semantics when an agent rate limit is reached", async () => {
		const user = await authenticatedBackend(t, "agent-translation-rate-limit");
		const { token } = await setupProject(user);
		const request = () =>
			agentRequest(t, token, "/api/agent/v1/translation-proposals", {
				method: "POST",
				body: JSON.stringify({
					clientProposalKey: "rate-limit-idempotent-proposal",
					target: { kind: "catalogWorkspace" },
				}),
			});
		for (let attempt = 0; attempt < 12; attempt += 1) {
			expect((await request()).status).toBe(200);
		}
		const limited = await request();
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await limited.json()).toMatchObject({
			code: "RATE_LIMITED",
			retryAfter: expect.any(Number),
		});
	});
});
