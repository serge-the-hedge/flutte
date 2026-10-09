import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
	type AuthenticatedBackend,
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib";
import type { SourceFact } from "./localeSourceFactModel";
import { sourceFactFor } from "./localeSourceFacts";

const repository = "github.com/brickit-app/brickit-flutter";
async function ingest(
	user: AuthenticatedBackend,
	projectId: Id<"projects">,
	commit: string,
	content: Record<string, unknown>,
	relationship?: "divergent" | "descendant",
) {
	const result = await user.action(api.snapshots.ingest, {
		projectId,
		repository,
		commit,
		files: [
			{
				catalogPath: "en.arb",
				content: JSON.stringify({ "@@locale": "en", ...content }),
			},
		],
		...(relationship
			? {
					lineage: {
						baselineCommit: "baseline",
						mergeBase: "baseline",
						relationship,
					},
				}
			: {}),
	});
	if (!result.snapshotId) throw new Error("Expected captured snapshot");
	return result.snapshotId;
}
async function setup(
	content: Record<string, unknown> = { welcome: "Original" },
) {
	const t = createBackend({ transactionLimits: true });
	const user = await authenticatedBackend(t, "selected-owner");
	const projectId = await createProject(user);
	await t.run((ctx) => ctx.db.patch(projectId, { repository }));
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing source");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	await user.mutation(api.localeIntroductionTargets.save, {
		projectId,
		localeCode: "pt",
		label: "Portuguese",
		catalogPath: "pt.arb",
		runtimeLocale: "pt-BR",
	});
	const baseline = await ingest(user, projectId, "baseline", content);
	const translator = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "Author",
		scopes: ["read", "search", "propose"],
	});
	return { t, user, projectId, baseline, translator };
}
async function request<T>(
	t: Backend,
	token: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await t.fetch(`/api/agent/v1/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return JSON.parse(text) as T;
}
async function proposalFor(
	user: AuthenticatedBackend,
	taskId: Id<"agentTranslationProposals">,
) {
	const detail = await user.query(api.agentTranslationProposals.getForReview, {
		proposalId: taskId,
	});
	const id = detail?.proposal.localeProposalTaskScope?.localeProposalId;
	if (!id) throw new Error("Expected locale task");
	return id;
}
const bytes = (row: unknown) =>
	new TextEncoder().encode(JSON.stringify(row)).byteLength;
async function fact(
	messageId: string,
	value: string,
	catalogIndex: number,
): Promise<SourceFact> {
	return {
		messageId,
		value,
		catalogIndex,
		sourceFingerprint: await sha256Hex(value),
		icuType: "plain",
		argumentNames: [],
		argumentNamesComplete: true,
		declaredPlaceholderNames: [],
		declaredPlaceholderNamesComplete: true,
	};
}

/** Drive the installed runner through the real in-memory HTTP endpoints. */
async function workflow(t: Backend, token: string) {
	const directory = await mkdtemp(join(tmpdir(), "prepared-workflow-"));
	const server = createServer(async (incoming, outgoing) => {
		try {
			let body = "";
			for await (const chunk of incoming) body += chunk;
			const response = await t.fetch(incoming.url ?? "", {
				method: incoming.method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				...(body ? { body } : {}),
			});
			outgoing.writeHead(response.status, {
				"Content-Type": "application/json",
			});
			outgoing.end(await response.text());
		} catch {
			outgoing.writeHead(500);
			outgoing.end("Fixture request failed");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture port");
	const origin = `http://127.0.0.1:${address.port}`;
	const pacing = join(
		tmpdir(),
		`blabla-agent-${process.getuid?.() ?? "user"}`,
		createHash("sha256").update(`${origin}\0${token}`).digest("hex"),
	);
	return {
		directory,
		async run(args: string[], body?: unknown) {
			const child = spawn(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							"../../../agent-kit/_blabla/scripts/blabla-workflow.mjs",
							import.meta.url,
						),
					),
					...args,
					"--state",
					directory,
					...(body === undefined ? [] : ["--body", "-"]),
				],
				{
					env: {
						...process.env,
						BLABLA_PROFILE: undefined,
						BLABLA_API_URL: origin,
						BLABLA_TOKEN: token,
						BLABLA_AGENT_URL: undefined,
						BLABLA_AGENT_TOKEN: undefined,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let output = "";
			let error = "";
			child.stdout.on("data", (data) => {
				output += data;
			});
			child.stderr.on("data", (data) => {
				error += data;
			});
			const done = new Promise<number | null>((resolve, reject) => {
				child.on("close", resolve);
				child.on("error", reject);
			});
			child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
			expect(await done, error).toBe(0);
			return JSON.parse(output) as {
				work: string[];
				submittedScopeComplete: boolean;
				reviewHandoff: string | null;
				counts: {
					prepared: number;
					preparedIntentionalBlank: number;
					pendingReview: number;
					accepted: number;
					missing: number;
				};
				allLatestReviewed: boolean;
				allTargetsReviewed: boolean;
			};
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
			await rm(pacing, { recursive: true, force: true });
		},
	};
}

describe("immutable selected Locale Source", () => {
	test("staging is not prepared proof for unreviewed, stale, invalid, obsolete-blank or over-limit values", async () => {
		const content = {
			good: "Good",
			unreviewed: "Plain",
			stale: "Plain",
			invalid: "Hello {name}",
			reason: "Plain",
			limit: "Plain",
		};
		const f = await setup(content);
		const selected = await ingest(
			f.user,
			f.projectId,
			"invalid-prepared",
			content,
			"divergent",
		);
		const task = await f.user.action(
			api.agentTranslationProposals.createNewLocaleTaskOnSnapshot,
			{
				projectId: f.projectId,
				title: "Check proof",
				localeCode: "pt",
				sourceSnapshotId: selected,
			},
		);
		const proposalId = await proposalFor(f.user, task.taskId);
		await f.user.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId,
			items: await Promise.all(
				Object.entries(content).map(async ([messageId, source]) => ({
					messageId,
					value: messageId === "invalid" ? "Olá {name}" : "pt",
					sourceFingerprint: await sha256Hex(source),
				})),
			),
		});
		await f.t.run(async (ctx) => {
			for (const value of await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.collect()) {
				if (value.messageId === "unreviewed")
					await ctx.db.patch(value._id, {
						updatedBy: { kind: "agent", id: f.translator.tokenId },
					});
				if (value.messageId === "stale")
					await ctx.db.patch(value._id, { sourceFingerprint: "0".repeat(64) });
				if (value.messageId === "invalid")
					await ctx.db.patch(value._id, { value: "Olá {xxxx}" });
				if (value.messageId === "reason") {
					const item = {
						messageId: value.messageId,
						value: value.value,
						sourceFingerprint: value.sourceFingerprint,
						intentionalBlankReason: "Old",
					};
					await ctx.db.patch(value._id, {
						intentionalBlankReason: item.intentionalBlankReason,
						byteLength: bytes(item),
					});
				}
			}
		});
		await f.user.mutation(api.messageConstraints.setCharacterLimit, {
			projectId: f.projectId,
			messageId: "limit",
			characterLimit: 1,
			expectedCharacterLimit: null,
		});
		const page = await request<{
			targets: Array<{ messageId: string; preparedValue: unknown }>;
		}>(f.t, f.translator.token, `translation-tasks/${task.taskId}`);
		expect(
			page.targets
				.filter((row) => row.preparedValue)
				.map((row) => row.messageId),
		).toEqual(["good"]);
		const ordinaryTask = await f.user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId: f.projectId,
				title: "Default stale",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const ordinaryId = await proposalFor(f.user, ordinaryTask.taskId);
		await f.user.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId: ordinaryId,
			items: [
				{
					messageId: "good",
					value: "pt",
					sourceFingerprint: await sha256Hex("Good"),
				},
			],
		});
		await ingest(f.user, f.projectId, "advance", content, "descendant");
		const stalePage = await request<{
			targets: Array<{ preparedValue: unknown }>;
		}>(f.t, f.translator.token, `translation-tasks/${ordinaryTask.taskId}`);
		expect(stalePage.targets.every((row) => row.preparedValue === null)).toBe(
			true,
		);
	});

	test("prepared proof does not duplicate legal large target bytes and retains bounded continuations", async () => {
		const source = "字".repeat(80_000);
		const target = "文".repeat(60_000);
		const f = await setup({ first: source, second: source });
		const selected = await ingest(
			f.user,
			f.projectId,
			"large-prepared",
			{ first: source, second: source },
			"divergent",
		);
		const task = await f.user.action(
			api.agentTranslationProposals.createNewLocaleTaskOnSnapshot,
			{
				projectId: f.projectId,
				title: "Large proof",
				localeCode: "pt",
				sourceSnapshotId: selected,
			},
		);
		const proposalId = await proposalFor(f.user, task.taskId);
		await f.user.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId,
			items: [
				{
					messageId: "first",
					value: target,
					sourceFingerprint: await sha256Hex(source),
				},
				{
					messageId: "second",
					value: target,
					sourceFingerprint: await sha256Hex(source),
				},
			],
		});
		const first = await request<{
			targets: Array<{
				targetValue: string;
				preparedValue: { value?: string; valueFingerprint: string };
			}>;
			nextCursor: number | null;
		}>(f.t, f.translator.token, `translation-tasks/${task.taskId}`);
		expect(first.targets).toHaveLength(1);
		expect(first.targets[0].targetValue).toBe(target);
		expect(first.targets[0].preparedValue).toMatchObject({
			valueFingerprint: await sha256Hex(target),
		});
		expect(first.targets[0].preparedValue.value).toBeUndefined();
		expect(first.nextCursor).toBe(1);
		const second = await request<{
			targets: Array<{ preparedValue: unknown }>;
			nextCursor: number | null;
		}>(
			f.t,
			f.translator.token,
			`translation-tasks/${task.taskId}?cursor=${first.nextCursor}`,
		);
		expect(second.targets).toHaveLength(1);
		expect(second.targets[0].preparedValue).not.toBeNull();
		expect(second.nextCursor).toBeNull();
	});
	test("actual task API and runner preserve reviewed carry while only 27 changed values need candidates and independent review", async () => {
		const changed = Object.fromEntries(
			Array.from({ length: 27 }, (_, index) => [
				`changed${index}`,
				`Before ${index}`,
			]),
		);
		const original = { same: "Same", blank: "Hide", ...changed };
		const f = await setup(original);
		const oldTask = await f.user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId: f.projectId,
				title: "Original carry",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const oldProposal = await proposalFor(f.user, oldTask.taskId);
		const items = await Promise.all(
			Object.entries(original).map(async ([messageId, source]) => ({
				messageId,
				value: messageId === "blank" ? "" : `pt ${messageId}`,
				sourceFingerprint: await sha256Hex(source),
				...(messageId === "blank"
					? { intentionalBlankReason: "Reviewed hidden label" }
					: {}),
			})),
		);
		for (let offset = 0; offset < items.length; offset += 16)
			await f.user.mutation(api.localeProposals.stageForReview, {
				projectId: f.projectId,
				proposalId: oldProposal,
				items: items.slice(offset, offset + 16),
			});
		const selected = await ingest(
			f.user,
			f.projectId,
			"carry-pr",
			{
				...original,
				...Object.fromEntries(
					Object.keys(changed).map((key) => [key, `After ${key}`]),
				),
			},
			"divergent",
		);
		const continued = await f.user.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: oldTask.taskId, sourceSnapshotId: selected },
		);
		expect(continued).toMatchObject({
			carriedValueCount: 2,
			incompatibleValueCount: 27,
			remainingValueCount: 27,
		});
		const first = await request<{
			task: { localeProposalId: string; sourceSnapshotId: string };
			targets: Array<{
				messageId: string;
				candidate: unknown;
				preparedValue: {
					valueFingerprint: string;
					intentionalBlankReason?: string;
					basis: unknown;
					provenance: { updatedBy: unknown };
				} | null;
			}>;
		}>(f.t, f.translator.token, `translation-tasks/${continued.taskId}`);
		expect(first.task).toMatchObject({
			localeProposalId: continued.localeProposalId,
			sourceSnapshotId: selected,
		});
		expect(first.targets[0]).toMatchObject({
			candidate: null,
			preparedValue: {
				valueFingerprint: await sha256Hex("pt same"),
				basis: {
					localeProposalId: continued.localeProposalId,
					snapshotId: selected,
					sourceFingerprint: await sha256Hex("Same"),
				},
				provenance: { updatedBy: { kind: "user" } },
			},
		});
		expect(first.targets[1].preparedValue?.intentionalBlankReason).toBe(
			"Reviewed hidden label",
		);
		const runner = await workflow(f.t, f.translator.token);
		try {
			const initial = await runner.run(["task", "read", continued.taskId]);
			expect(initial.work).toHaveLength(14);
			expect(initial.work).not.toContain("same");
			expect(initial.work).not.toContain("blank");
			const revisions: string[] = [];
			for (
				let page = initial;
				!page.submittedScopeComplete;
				page = await runner.run(["task", "read", continued.taskId])
			) {
				const submitted = await runner.run(
					["task", "submit", continued.taskId],
					{
						items: page.work.map((messageId) => ({
							messageId,
							candidate: { kind: "value", value: `pt updated ${messageId}` },
						})),
					},
				);
				if (submitted.reviewHandoff) {
					const handoff = JSON.parse(
						await readFile(submitted.reviewHandoff, "utf8"),
					) as { revisions: Array<{ revisionId: string }> };
					revisions.push(...handoff.revisions.map((row) => row.revisionId));
				}
			}
			expect(revisions).toHaveLength(27);
			const pending = await runner.run([
				"task",
				"status",
				continued.taskId,
				"--restart",
			]);
			expect(pending.counts).toMatchObject({
				prepared: 1,
				preparedIntentionalBlank: 1,
				pendingReview: 27,
				accepted: 0,
				missing: 0,
			});
			expect(pending.allTargetsReviewed).toBe(false);
			await expect(
				f.user.action(api.agentTranslationProposals.finalizeTask, {
					taskId: continued.taskId,
				}),
			).rejects.toThrow();
			await f.user.mutation(api.projects.setAgentReviewPolicy, {
				projectId: f.projectId,
				enabled: true,
			});
			const reviewer = await f.user.mutation(api.apiTokens.create, {
				projectId: f.projectId,
				name: "Independent carry residue",
				scopes: ["read", "review"],
			});
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				for (const revisionId of revisions) {
					vi.setSystemTime(Date.now() + 1500);
					const context = await request<{ reviewToken: string }>(
						f.t,
						reviewer.token,
						`candidate-reviews/${revisionId}`,
					);
					await request(
						f.t,
						reviewer.token,
						`candidate-reviews/${revisionId}`,
						{
							reviewToken: context.reviewToken,
							decision: { kind: "accept" },
						},
					);
				}
			} finally {
				vi.useRealTimers();
			}
			const complete = await runner.run([
				"task",
				"status",
				continued.taskId,
				"--restart",
			]);
			expect(complete.counts).toMatchObject({
				prepared: 1,
				preparedIntentionalBlank: 1,
				accepted: 27,
				pendingReview: 0,
				missing: 0,
			});
			expect(complete.allLatestReviewed).toBe(false);
			expect(complete.allTargetsReviewed).toBe(true);
			expect(
				await f.user.action(api.agentTranslationProposals.finalizeTask, {
					taskId: continued.taskId,
				}),
			).toMatchObject({ deliveryStatus: "stale" });
		} finally {
			await runner.close();
		}
	}, 30_000);
	test("same human title prepares distinct pins and each retry retains its task and candidates", async () => {
		const f = await setup();
		const firstPin = await ingest(
			f.user,
			f.projectId,
			"first-pr",
			{ welcome: "First copy" },
			"divergent",
		);
		const secondPin = await ingest(
			f.user,
			f.projectId,
			"second-pr",
			{ welcome: "Second copy" },
			"divergent",
		);
		const prepare = (sourceSnapshotId: Id<"sourceSnapshots">) =>
			f.user.action(
				api.agentTranslationProposals.createNewLocaleTaskOnSnapshot,
				{
					projectId: f.projectId,
					title: "Translate pt",
					localeCode: "pt",
					sourceSnapshotId,
				},
			);
		const first = await prepare(firstPin);
		await request(
			f.t,
			f.translator.token,
			`translation-tasks/${first.taskId}/candidates`,
			{
				items: [{ messageId: "welcome", value: "Primeiro texto" }],
			},
		);
		const firstState = await f.t.run((ctx) => ctx.db.get(first.taskId));
		const firstCandidates = await f.user.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: first.taskId },
		);
		const second = await prepare(secondPin);
		expect(first.taskId).not.toBe(second.taskId);
		expect(first.title).toBe("Translate pt");
		expect(second.title).toBe("Translate pt");
		expect(await prepare(firstPin)).toEqual(first);
		expect(await prepare(secondPin)).toEqual(second);
		expect(await f.t.run((ctx) => ctx.db.get(first.taskId))).toEqual(
			firstState,
		);
		expect(
			await f.user.query(api.agentTranslationProposals.getForReview, {
				proposalId: first.taskId,
			}),
		).toEqual(firstCandidates);
		const secondPage = await request<{
			targets: Array<{ messageId: string; sourceValue: string }>;
		}>(f.t, f.translator.token, `translation-tasks/${second.taskId}?limit=16`);
		expect(secondPage.targets).toMatchObject([
			{ messageId: "welcome", sourceValue: "Second copy" },
		]);
	});
	test("normal agent author, independent review, examples and final artifact use exact captured Source", async () => {
		const f = await setup();
		const ordinary = await f.user.mutation(
			api.localeProposals.ensureForReview,
			{ projectId: f.projectId, localeCode: "pt" },
		);
		const selected = await ingest(
			f.user,
			f.projectId,
			"approved-pr",
			{
				welcome: "Approved English",
				"@welcome": {
					description: "Exact reviewed source",
					custom: { lossless: true },
				},
			},
			"divergent",
		);
		const before = await f.t.run((ctx) => ctx.db.get(f.projectId));
		const task = await f.user.action(
			api.agentTranslationProposals.createNewLocaleTaskOnSnapshot,
			{
				projectId: f.projectId,
				title: "Approved PR Portuguese",
				localeCode: "pt",
				sourceSnapshotId: selected,
			},
		);
		const proposalId = await proposalFor(f.user, task.taskId);
		const taskRead = await request<{
			targets: Array<{ messageId: string; sourceValue: string }>;
		}>(f.t, f.translator.token, `translation-tasks/${task.taskId}`);
		expect(taskRead.targets).toMatchObject([
			{ messageId: "welcome", sourceValue: "Approved English" },
		]);

		const template = await request<{
			messages: Array<{ sourceValue: string; metadataJson?: string }>;
		}>(
			f.t,
			f.translator.token,
			`locale-proposals/pt/template?proposalId=${proposalId}`,
		);
		expect(template.messages[0]).toMatchObject({
			sourceValue: "Approved English",
			metadataJson: JSON.stringify({
				description: "Exact reviewed source",
				custom: { lossless: true },
			}),
		});
		await request(
			f.t,
			f.translator.token,
			`translation-tasks/${task.taskId}/candidates`,
			{ items: [{ messageId: "welcome", value: "Bem-vindo" }] },
		);
		await expect(
			f.user.action(api.agentTranslationProposals.finalizeTask, {
				taskId: task.taskId,
			}),
		).rejects.toThrow();
		const page = await f.user.query(api.localeProposals.getForReview, {
			proposalId,
			taskId: task.taskId,
			limit: 16,
		});
		expect(page).toMatchObject({
			isCurrentBaseline: false,
			sourceIsEligible: true,
			sourceSelection: "selectedSnapshot",
		});
		const candidate = page?.messages[0]?.candidate;
		if (!candidate) throw new Error("Missing candidate");
		const reviewer = await f.user.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Independent",
			scopes: ["read", "review"],
		});
		await f.user.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const context = await request<{
			reviewToken: string;
			basisIsCurrent: boolean;
			source: { value: string };
		}>(f.t, reviewer.token, `candidate-reviews/${candidate.revisionId}`);
		expect(context).toMatchObject({
			basisIsCurrent: true,
			source: {
				value: "Approved English",
				icuType: "plain",
				argumentNames: [],
				argumentNamesComplete: true,
				declaredPlaceholderNames: [],
				declaredPlaceholderNamesComplete: true,
			},
		});
		await request(
			f.t,
			reviewer.token,
			`candidate-reviews/${candidate.revisionId}`,
			{ reviewToken: context.reviewToken, decision: { kind: "accept" } },
		);
		const examples = await request<{
			items: Array<{ source: { value: string } }>;
		}>(f.t, f.translator.token, "proposal-examples/search", {
			scope: { kind: "task", taskId: task.taskId },
			q: "welcome",
			searchIn: "key",
			match: "exact",
		});
		expect(JSON.stringify(examples)).toContain("Approved English");
		await f.user.action(api.agentTranslationProposals.finalizeTask, {
			taskId: task.taskId,
		});
		const artifact = await request<{
			sourceSnapshot: { id: string };
			catalog: { content: string };
		}>(
			f.t,
			f.translator.token,
			`locale-proposals/pt/artifact?proposalId=${proposalId}`,
		);
		expect(artifact.sourceSnapshot.id).toBe(selected);
		expect(JSON.parse(artifact.catalog.content)).toMatchObject({
			welcome: "Bem-vindo",
			"@welcome": { custom: { lossless: true } },
		});
		const finalized = await f.user.query(api.localeProposals.getForReview, {
			proposalId,
		});
		expect(finalized?.proposal).toMatchObject({
			status: "ready",
			deliveryStatus: "stale",
		});
		const after = await f.t.run((ctx) => ctx.db.get(f.projectId));
		expect(after?.baselineSnapshotId).toBe(before?.baselineSnapshotId);
		expect(after?.activeCatalogProjectionId).toEqual(
			before?.activeCatalogProjectionId,
		);
		expect(
			await f.user.action(api.localeProposals.prepareForReview, {
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: f.baseline,
			}),
		).toEqual(ordinary);
		const originValue = await f.t.run((ctx) =>
			ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
				.unique(),
		);
		expect(originValue?.reviewAuthorization).toMatchObject({
			candidateRevisionId: candidate.revisionId,
			reviewerTokenId: reviewer.tokenId,
		});
		const nextPin = await ingest(
			f.user,
			f.projectId,
			"approved-metadata",
			{
				welcome: "Approved English",
				"@welcome": {
					description: "Updated descriptive guidance",
					custom: { lossless: true },
				},
			},
			"divergent",
		);
		const carried = await f.user.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: task.taskId, sourceSnapshotId: nextPin },
		);
		expect(carried).toMatchObject({
			carriedValueCount: 1,
			remainingValueCount: 0,
		});
		const carriedValue = await f.t.run((ctx) =>
			ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal", (q) =>
					q.eq("proposalId", carried.localeProposalId),
				)
				.unique(),
		);
		expect(carriedValue?.reviewAuthorization).toEqual(
			originValue?.reviewAuthorization,
		);
		const carriedPage = await request<{
			targets: Array<{
				candidate: unknown;
				preparedValue: { provenance: { reviewAuthorization: unknown } };
			}>;
		}>(f.t, f.translator.token, `translation-tasks/${carried.taskId}`);
		expect(carriedPage.targets[0].candidate).toBeNull();
		expect(
			carriedPage.targets[0].preparedValue.provenance.reviewAuthorization,
		).toEqual(originValue?.reviewAuthorization);
		expect(
			await f.t.run((ctx) => ctx.db.get(candidate.revisionId)),
		).toMatchObject({ proposalId: task.taskId, value: "Bem-vindo" });
	});
	test("carry preserves reviewed blanks and occupied destinations, excludes pending and changed Source, retains origin across Baseline movement", async () => {
		const content = {
			same: "Same",
			changed: "Before",
			blank: "Hide",
			pending: "Pending",
		};
		const f = await setup(content);
		const task = await f.user.mutation(
			api.agentTranslationProposals.createTask,
			{
				projectId: f.projectId,
				title: "Original",
				target: { kind: "newLocale", localeCode: "pt" },
				scope: { kind: "completeCatalog" },
			},
		);
		const old = await proposalFor(f.user, task.taskId);
		await f.user.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId: old,
			items: await Promise.all(
				["same", "changed", "blank"].map(async (messageId) => ({
					messageId,
					value: messageId === "blank" ? "" : `pt ${messageId}`,
					sourceFingerprint: await sha256Hex(
						content[messageId as keyof typeof content],
					),
					...(messageId === "blank"
						? { intentionalBlankReason: "Intentionally hidden" }
						: {}),
				})),
			),
		});
		await request(
			f.t,
			f.translator.token,
			`translation-tasks/${task.taskId}/candidates`,
			{ items: [{ messageId: "pending", value: "Unreviewed" }] },
		);
		const originalValues = await f.t.run((ctx) =>
			ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal", (q) => q.eq("proposalId", old))
				.collect(),
		);
		const next = { ...content, changed: "After", added: "Added" };
		const selected = await ingest(
			f.user,
			f.projectId,
			"approved",
			next,
			"divergent",
		);
		const destination = await f.user.action(
			api.localeProposals.prepareForReview,
			{ projectId: f.projectId, localeCode: "pt", sourceSnapshotId: selected },
		);
		await f.user.mutation(api.localeProposals.stageForReview, {
			projectId: f.projectId,
			proposalId: destination.proposalId,
			items: [
				{
					messageId: "same",
					value: "Human destination",
					sourceFingerprint: await sha256Hex("Same"),
				},
			],
		});
		const continued = await f.user.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: task.taskId, sourceSnapshotId: selected },
		);
		expect(continued).toMatchObject({
			carriedValueCount: 1,
			incompatibleValueCount: 1,
			remainingValueCount: 3,
			totalValueCount: 5,
		});
		const retry = await f.user.action(
			api.agentTranslationProposals.continueNewLocaleTask,
			{ taskId: task.taskId, sourceSnapshotId: selected },
		);
		expect(retry).toMatchObject({
			carriedValueCount: 0,
			taskId: continued.taskId,
		});
		const values = await f.t.run((ctx) =>
			ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal", (q) =>
					q.eq("proposalId", destination.proposalId),
				)
				.collect(),
		);
		expect(values).toHaveLength(2);
		expect(values.find((v) => v.messageId === "same")?.value).toBe(
			"Human destination",
		);
		expect(
			values.find((v) => v.messageId === "blank")?.intentionalBlankReason,
		).toBe("Intentionally hidden");
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("localeProposalValues")
					.withIndex("by_proposal", (q) => q.eq("proposalId", old))
					.collect(),
			),
		).toEqual(originalValues);
		// A correction candidate is inert beside carry; only its independent review applies it.
		await request(
			f.t,
			f.translator.token,
			`translation-tasks/${continued.taskId}/candidates`,
			{
				items: [
					{
						messageId: "same",
						candidate: { kind: "value", value: "Explicit correction" },
					},
				],
			},
		);
		const destinationValues = () =>
			f.t.run((ctx) =>
				ctx.db
					.query("localeProposalValues")
					.withIndex("by_proposal", (q) =>
						q.eq("proposalId", destination.proposalId),
					)
					.collect(),
			);
		expect(await destinationValues()).toEqual(values);
		const correctionPage = await f.user.query(
			api.localeProposals.getForReview,
			{
				proposalId: destination.proposalId,
				taskId: continued.taskId,
				limit: 16,
			},
		);
		const correction = correctionPage?.messages.find(
			(message) => message.messageId === "same",
		)?.candidate;
		if (!correction) throw new Error("Missing correction candidate");
		expect(correction).toMatchObject({
			value: "Explicit correction",
			review: null,
		});
		const reviewer = await f.user.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Independent carry correction",
			scopes: ["read", "review"],
		});
		await f.user.mutation(api.projects.setAgentReviewPolicy, {
			projectId: f.projectId,
			enabled: true,
		});
		const review = await request<{ reviewToken: string }>(
			f.t,
			reviewer.token,
			`candidate-reviews/${correction.revisionId}`,
		);
		await request(
			f.t,
			reviewer.token,
			`candidate-reviews/${correction.revisionId}`,
			{ reviewToken: review.reviewToken, decision: { kind: "accept" } },
		);
		const correctedValues = await destinationValues();
		expect(
			correctedValues.find((value) => value.messageId === "same"),
		).toMatchObject({
			value: "Explicit correction",
			updatedBy: { kind: "agent", id: reviewer.tokenId },
			reviewAuthorization: {
				candidateRevisionId: correction.revisionId,
				reviewerTokenId: reviewer.tokenId,
			},
		});
		expect(
			correctedValues.find((value) => value.messageId === "blank"),
		).toEqual(values.find((value) => value.messageId === "blank"));
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("localeProposalValues")
					.withIndex("by_proposal", (q) => q.eq("proposalId", old))
					.collect(),
			),
		).toEqual(originalValues);
		await ingest(f.user, f.projectId, "next", next, "descendant");
		expect(
			(
				await f.user.query(api.localeProposals.getForReview, {
					proposalId: destination.proposalId,
				})
			)?.sourceIsEligible,
		).toBe(true);
		await expect(
			f.user.mutation(api.localeProposals.stageForReview, {
				projectId: f.projectId,
				proposalId: old,
				items: [],
			}),
		).rejects.toThrow("Baseline");
		await expect(
			f.user.action(api.localeProposals.prepareForReview, {
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: f.baseline,
			}),
		).rejects.toThrow("historical proposal");
	});
	test("rejects unauthorized, cross-project and uncaptured snapshots and never derives origin from mutable kind", async () => {
		const f = await setup();
		const outsider = await authenticatedBackend(f.t, "outsider");
		await expect(
			outsider.action(api.localeProposals.prepareForReview, {
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: f.baseline,
			}),
		).rejects.toThrow();
		const other = await createProject(f.user, { slug: "other" });
		await expect(
			f.user.action(api.localeProposals.prepareForReview, {
				projectId: other,
				localeCode: "pt",
				sourceSnapshotId: f.baseline,
			}),
		).rejects.toThrow("project and repository");
		const forged = await f.t.run(async (ctx) => {
			const baseline = await ctx.db.get(f.baseline);
			if (!baseline) throw new Error();
			const { _id, _creationTime, ...snapshot } = baseline;
			return await ctx.db.insert("sourceSnapshots", {
				...snapshot,
				commit: "uncaptured",
			});
		});
		await expect(
			f.user.action(api.localeProposals.prepareForReview, {
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: forged,
			}),
		).rejects.toThrow("successful capture");
		const selected = await ingest(
			f.user,
			f.projectId,
			"approved",
			{ welcome: "Approved" },
			"divergent",
		);
		const prepared = await f.user.action(api.localeProposals.prepareForReview, {
			projectId: f.projectId,
			localeCode: "pt",
			sourceSnapshotId: selected,
		});
		const original = await f.t.run((ctx) => ctx.db.get(prepared.proposalId));
		await f.t.run((ctx) => ctx.db.patch(selected, { kind: "baseline" }));
		expect(
			await f.user.query(api.localeProposals.getForReview, {
				proposalId: prepared.proposalId,
			}),
		).toMatchObject({
			sourceSelection: "selectedSnapshot",
			isCurrentBaseline: false,
			sourceIsEligible: true,
		});
		expect(
			await f.user.action(api.localeProposals.prepareForReview, {
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: selected,
			}),
		).toEqual(prepared);
		expect(await f.t.run((ctx) => ctx.db.get(prepared.proposalId))).toEqual(
			original,
		);
	});
	test("partial facts are unreadable, preparation retries and pages stop at actual UTF-8 byte boundaries", async () => {
		const f = await setup();
		const content = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [
				`key${i}`,
				`${i} ${"字".repeat(12000)}`,
			]),
		);
		const selected = await ingest(
			f.user,
			f.projectId,
			"large",
			content,
			"divergent",
		);
		const rows = await Promise.all(
			Object.entries(content).map(([key, value], i) => fact(key, value, i)),
		);
		const { file } = await f.t.query(internal.localeSourceFacts.evidence, {
			projectId: f.projectId,
			snapshotId: selected,
		});
		const text = await f.t.run(async (ctx) =>
			(await ctx.storage.get(file.storageId))?.text(),
		);
		if (!text) throw new Error("Missing bytes");
		await f.t.mutation(internal.localeSourceFacts.begin, {
			projectId: f.projectId,
			snapshotId: selected,
			contentHash: await sha256Hex(text),
			messageCount: rows.length,
			expectedBytes: rows.reduce((n, row) => n + bytes(row), 0),
		});
		await f.t.mutation(internal.localeSourceFacts.append, {
			sourceFileId: file._id,
			items: rows.slice(0, 3),
		});
		await expect(
			f.t.run((ctx) => sourceFactFor(ctx, file._id, "key0")),
		).rejects.toThrow("not completely prepared");
		await expect(
			f.t.mutation(internal.localeProposals.ensureSelectedForReview, {
				userId: "selected-owner",
				projectId: f.projectId,
				localeCode: "pt",
				sourceSnapshotId: selected,
			}),
		).rejects.toThrow("not completely prepared");
		await expect(
			f.t.mutation(internal.localeSourceFacts.append, {
				sourceFileId: file._id,
				items: rows.slice(3, 19),
			}),
		).rejects.toThrow("slice exceeds");
		const prepared = await f.user.action(api.localeProposals.prepareForReview, {
			projectId: f.projectId,
			localeCode: "pt",
			sourceSnapshotId: selected,
		});
		await f.t.mutation(internal.localeSourceFacts.append, {
			sourceFileId: file._id,
			items: rows.slice(0, 3),
		});
		const first = await f.user.query(api.localeProposals.getForReview, {
			proposalId: prepared.proposalId,
			limit: 48,
		});
		expect(first?.messages.length).toBeLessThan(20);
		expect(first?.isDone).toBe(false);
		if (first?.continueCursor == null) throw new Error("Missing continuation");
		const second = await f.user.query(api.localeProposals.getForReview, {
			proposalId: prepared.proposalId,
			limit: 48,
			cursor: first.continueCursor,
		});
		expect((first?.messages.length ?? 0) + (second?.messages.length ?? 0)).toBe(
			20,
		);
		expect(second?.isDone).toBe(true);
	});
});
