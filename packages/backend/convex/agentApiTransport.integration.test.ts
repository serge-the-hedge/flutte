import { describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup(messageCount = 2) {
	const t = createBackend();
	const owner = await authenticatedBackend(t, "transport-owner");
	const projectId = await createProject(owner);
	const source = (await owner.query(api.locales.list, { projectId }))[0];
	if (!source) throw new Error("Expected source Locale.");
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await owner.mutation(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await owner.mutation(api.locales.bind, { localeId, catalogPath: "de.arb" });
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [
			{
				catalogPath: "en.arb",
				content: JSON.stringify({
					"@@locale": "en",
					greeting: "Hello",
					...Object.fromEntries(
						Array.from({ length: messageCount - 1 }, (_, index) => [
							`other${index}`,
							"Other",
						]),
					),
				}),
			},
			{
				catalogPath: "de.arb",
				content: JSON.stringify({
					"@@locale": "de",
					greeting: "Hallo",
					...Object.fromEntries(
						Array.from({ length: messageCount - 1 }, (_, index) => [
							`other${index}`,
							"Andere",
						]),
					),
				}),
			},
		],
	});
	await owner.mutation(api.projects.update, {
		projectId,
		name: "Primary project",
		minimumCliVersion: "0.2.0",
		minimumCliProtocol: 2,
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
	function request(token: string, path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body !== undefined)
			headers.set("Content-Type", "application/json");
		return t.fetch(path, { ...init, headers });
	}
	return { t, owner, projectId, localeId, translator, reviewer, request };
}

describe("Agent and repository client transport", () => {
	test("supports discovery, translation, and independently authorized review without CLI headers", async () => {
		const f = await setup();
		for (const path of [
			"/api/agent/v1/projects/current",
			"/api/agent/v1/workspace/search?q=Hello&localeCode=de",
		]) {
			const response = await f.request(f.reviewer.token, path);
			expect(response.status).toBe(200);
			expect(response.headers.has("X-Blabla-Minimum-CLI-Protocol")).toBe(false);
		}
		const context = await f.request(
			f.reviewer.token,
			"/api/agent/v1/workspace/context",
			{
				method: "POST",
				body: JSON.stringify({ keys: ["greeting"], locales: ["de"] }),
			},
		);
		expect(context.status).toBe(200);
		const createBody = JSON.stringify({
			clientTaskKey: "german-greeting",
			target: { kind: "existingLocale", localeCode: "de" },
			messageIds: ["greeting"],
		});
		expect(
			(
				await f.request(f.reviewer.token, "/api/agent/v1/translation-tasks", {
					method: "POST",
					body: createBody,
				})
			).status,
		).toBe(401);
		const created = await f.request(
			f.translator.token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: createBody,
			},
		);
		expect(created.status).toBe(200);
		const { taskId } = (await created.json()) as {
			taskId: Id<"agentTranslationProposals">;
		};
		const submitted = await f.request(
			f.translator.token,
			`/api/agent/v1/translation-tasks/${taskId}/candidates`,
			{
				method: "POST",
				body: JSON.stringify({
					items: [{ messageId: "greeting", value: "Guten Tag" }],
				}),
			},
		);
		expect(submitted.status).toBe(200);
		const { revisions } = (await submitted.json()) as {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		};
		const revisionId = revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected candidate revision.");
		const reviewUrl = `/api/agent/v1/candidate-reviews/${revisionId}`;
		expect((await f.request(f.reviewer.token, reviewUrl)).status).toBe(403);
		await f.owner.mutation(api.agentTranslationProposals.grantCandidateReview, {
			candidateRevisionId: revisionId,
			reviewerTokenId: f.reviewer.tokenId,
		});
		const readable = await f.request(f.reviewer.token, reviewUrl);
		expect(readable.status).toBe(200);
		const { reviewToken } = (await readable.json()) as { reviewToken: string };
		const accepted = await f.request(f.reviewer.token, reviewUrl, {
			method: "POST",
			body: JSON.stringify({ reviewToken, decision: { kind: "accept" } }),
		});
		expect(accepted.status).toBe(200);
	});

	test.each(["existingLocale", "newLocale"] as const)(
		"returns latest candidate review feedback for %s tasks, resetting it for corrections",
		async (kind) => {
			const f = await setup();
			const created = await f.request(
				f.translator.token,
				"/api/agent/v1/translation-tasks",
				{
					method: "POST",
					body: JSON.stringify({
						clientTaskKey: "review-feedback",
						target: { kind, localeCode: kind === "newLocale" ? "pt" : "de" },
						...(kind === "existingLocale"
							? { messageIds: ["greeting", "other0"] }
							: {}),
					}),
				},
			);
			expect(created.status).toBe(200);
			const { taskId } = (await created.json()) as { taskId: string };
			const taskUrl = `/api/agent/v1/translation-tasks/${taskId}`;
			async function greeting() {
				const response = await f.request(f.translator.token, taskUrl);
				expect(response.status).toBe(200);
				const body = (await response.json()) as {
					targets: Array<{
						messageId: string;
						candidate: {
							revisionId: Id<"agentTranslationCandidateRevisions">;
						} | null;
					}>;
				};
				return body.targets.find((target) => target.messageId === "greeting");
			}
			async function submit(value: string) {
				const response = await f.request(
					f.translator.token,
					`${taskUrl}/candidates`,
					{
						method: "POST",
						body: JSON.stringify({ items: [{ messageId: "greeting", value }] }),
					},
				);
				expect(response.status).toBe(200);
				const { revisions } = (await response.json()) as {
					revisions: Array<{
						revisionId: Id<"agentTranslationCandidateRevisions">;
					}>;
				};
				const revisionId = revisions[0]?.revisionId;
				if (!revisionId) throw new Error("Expected candidate revision.");
				return revisionId;
			}
			expect(await greeting()).toMatchObject({ candidate: null });
			const rejectedId = await submit("Formal wording");
			expect(await greeting()).toMatchObject({
				candidate: { revisionId: rejectedId, latestReview: null },
			});
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: rejectedId,
				decision: {
					kind: "reject",
					reason: "Use the established informal address.",
				},
			});
			expect(await greeting()).toMatchObject({
				candidate: {
					revisionId: rejectedId,
					latestReview: {
						decision: {
							kind: "reject",
							reason: "Use the established informal address.",
						},
						reviewer: { kind: "user" },
					},
				},
			});
			const correctedId = await submit("Informal wording");
			expect(await greeting()).toMatchObject({
				candidate: {
					revisionId: correctedId,
					value: "Informal wording",
					latestReview: null,
				},
			});
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: correctedId,
				decision: { kind: "accept" },
			});
			expect(await greeting()).toMatchObject({
				candidate: {
					revisionId: correctedId,
					latestReview: { decision: { kind: "accept" } },
				},
			});
		},
	);

	test("paginates large existing-Locale candidate feedback without losing targets", async () => {
		const f = await setup(5);
		const messageIds = ["greeting", "other0", "other1", "other2", "other3"];
		const created = await f.request(
			f.translator.token,
			"/api/agent/v1/translation-tasks",
			{
				method: "POST",
				body: JSON.stringify({
					clientTaskKey: "large-feedback",
					target: { kind: "existingLocale", localeCode: "de" },
					messageIds,
				}),
			},
		);
		expect(created.status).toBe(200);
		const { taskId } = (await created.json()) as { taskId: string };
		for (const messageId of messageIds) {
			const submitted = await f.request(
				f.translator.token,
				`/api/agent/v1/translation-tasks/${taskId}/candidates`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ messageId, value: "A".repeat(256 * 1024) }],
					}),
				},
			);
			expect(submitted.status).toBe(200);
		}
		const readIds: string[] = [];
		let cursor: number | null = 0;
		do {
			const response = await f.request(
				f.translator.token,
				`/api/agent/v1/translation-tasks/${taskId}?cursor=${cursor}&limit=16`,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				targets: Array<{ messageId: string }>;
				nextCursor: number | null;
			};
			expect(body.targets.length).toBeGreaterThan(0);
			expect(body.targets.length).toBeLessThan(5);
			expect(
				new TextEncoder().encode(JSON.stringify(body.targets)).byteLength,
			).toBeLessThan(1024 * 1024);
			readIds.push(...body.targets.map((target) => target.messageId));
			cursor = body.nextCursor;
		} while (cursor !== null);
		expect(readIds).toEqual(messageIds);
	});

	test("still enforces the CLI floor for snapshot and release delivery clients", async () => {
		const f = await setup();
		const adapter = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Repository adapter",
			scopes: ["snapshot-submission", "export"],
		});
		for (const path of [
			"/api/repository-adapter/v1/snapshot-context",
			"/api/repository-adapter/v1/releases/unread-record",
		]) {
			for (const protocol of [undefined, "1", "invalid", "2.5"]) {
				const response = await f.request(adapter.token, path, {
					headers:
						protocol === undefined ? {} : { "X-Blabla-CLI-Protocol": protocol },
				});
				expect(response.status).toBe(426);
				expect(await response.json()).toMatchObject({
					code: "CLI_UPGRADE_REQUIRED",
				});
			}
		}
		const compatible = await f.request(
			adapter.token,
			"/api/repository-adapter/v1/snapshot-context",
			{
				headers: { "X-Blabla-CLI-Protocol": "2" },
			},
		);
		expect(compatible.status).toBe(200);
		expect(compatible.headers.get("X-Blabla-Minimum-CLI-Version")).toBe(
			"0.2.0",
		);
		expect(compatible.headers.get("X-Blabla-Minimum-CLI-Protocol")).toBe("2");
	});

	test("requires CLI compatibility only for legacy locale delivery reads", async () => {
		const f = await setup();
		const created = await f.request(
			f.translator.token,
			"/api/agent/v1/locale-proposals/pt",
			{ method: "POST" },
		);
		expect(created.status).toBe(200);
		const { proposalId } = (await created.json()) as { proposalId: string };
		for (const suffix of ["", "/artifact"]) {
			const response = await f.request(
				f.translator.token,
				`/api/agent/v1/locale-proposals/pt${suffix}?proposalId=${proposalId}`,
			);
			expect(response.status).toBe(426);
			expect(await response.json()).toMatchObject({
				code: "CLI_UPGRADE_REQUIRED",
			});
		}
		for (const suffix of ["/template", "/values"]) {
			const response = await f.request(
				f.translator.token,
				`/api/agent/v1/locale-proposals/pt${suffix}?proposalId=${proposalId}`,
			);
			expect(response.status).toBe(200);
		}
	});
});
