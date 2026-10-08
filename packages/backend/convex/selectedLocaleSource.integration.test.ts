import { describe, expect, test } from "vitest";
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

describe("immutable selected Locale Source", () => {
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
