import { describe, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw Error("Missing synthetic fixture value");
	return value;
}

async function setup(count = 4, definitions: Record<string, unknown> = {}) {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "reuse-owner");
	const projectId = await createProject(owner);
	const sourceLocale = required(
		(await owner.query(api.locales.list, { projectId }))[0],
	);
	await owner.action(api.locales.bind, {
		localeId: sourceLocale._id,
		catalogPath: "en.arb",
	});
	for (const localeCode of ["pt", "it", "fr"])
		await owner.mutation(api.localeIntroductionTargets.save, {
			projectId,
			localeCode,
			label: localeCode,
			catalogPath: `${localeCode}.arb`,
			runtimeLocale: localeCode,
		});
	const source = {
		"@@locale": "en",
		...Object.fromEntries(
			Array.from({ length: count }, (_, i) => [`m${i}`, `Source ${i}`]),
		),
		...definitions,
	};
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: [{ catalogPath: "en.arb", content: JSON.stringify(source) }],
	});
	const author = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Author",
		scopes: ["read", "propose"],
	});
	const copier = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Reuse author",
		scopes: ["read", "propose"],
	});
	const makeTask = (localeCode: string) =>
		owner.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: localeCode,
			target: { kind: "newLocale", localeCode },
			scope: { kind: "completeCatalog" },
		});
	const from = await makeTask("pt");
	const to = await makeTask("it");
	const request = (
		token: string,
		taskId: string,
		operation: string,
		body: unknown,
	) =>
		t.fetch(`/api/agent/v1/translation-tasks/${taskId}/${operation}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	async function submit(
		taskId: Id<"agentTranslationProposals">,
		items: Array<{
			messageId: string;
			value: string;
			intentionalBlankReason?: string;
		}>,
	) {
		const response = await request(author.token, taskId, "candidates", {
			items: items.map((item) => ({
				messageId: item.messageId,
				candidate:
					item.intentionalBlankReason === undefined
						? { kind: "value", value: item.value }
						: { kind: "intentionalBlank", reason: item.intentionalBlankReason },
			})),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		const result: {
			revisions: Array<{
				revisionId: Id<"agentTranslationCandidateRevisions">;
			}>;
		} = await response.json();
		return result.revisions;
	}
	const reuse = (
		clientReuseKey = "reuse",
		cursor = 0,
		sourceTaskId = from.taskId,
		destinationTaskId = to.taskId,
		token = copier.token,
	) =>
		request(token, destinationTaskId, "reuse", {
			sourceTaskId,
			clientReuseKey,
			cursor,
		});
	return {
		t,
		owner,
		projectId,
		author,
		copier,
		from,
		to,
		makeTask,
		submit,
		reuse,
		source,
	};
}

describe("explicit Translation Task authorship reuse", () => {
	test("copies exact accepted revisions and reasoned blanks as fresh agent candidates, with replayable receipts and independent review", async () => {
		const f = await setup();
		const revisions = await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "Translated" },
			{
				messageId: "m1",
				value: "",
				intentionalBlankReason: "Deliberate sentence fragment",
			},
			{ messageId: "m2", value: "Rejected" },
			{ messageId: "m3", value: "Pending" },
		]);
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(revisions[0]).revisionId,
			decision: { kind: "accept" },
		});
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(revisions[1]).revisionId,
			decision: {
				kind: "intentionalBlank",
				reason: "Deliberate sentence fragment",
			},
		});
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(revisions[2]).revisionId,
			decision: { kind: "reject" },
		});
		const response = await f.reuse();
		expect(response.status, await response.clone().text()).toBe(200);
		const result = await response.json();
		expect(result).toMatchObject({
			items: [
				{ messageId: "m0", status: "copied" },
				{ messageId: "m1", status: "copied" },
				{ messageId: "m2", status: "unreviewed" },
				{ messageId: "m3", status: "unreviewed" },
			],
			nextCursor: null,
		});
		expect(await (await f.reuse()).json()).toEqual(result);
		const page = await f.t.query(
			internal.agentTranslationProposals.newLocaleTaskCandidatesForAgent,
			{ token: f.copier.token, taskId: f.to.taskId, messageIds: ["m0", "m1"] },
		);
		expect(page).toMatchObject([
			{
				value: "Translated",
				latestReview: null,
				reusedFrom: {
					taskId: f.from.taskId,
					revisionId: required(revisions[0]).revisionId,
				},
			},
			{
				value: "",
				intentionalBlankReason: "Deliberate sentence fragment",
				latestReview: null,
			},
		]);
		const destination = await f.t.run((ctx) => ctx.db.get(f.to.taskId));
		expect(destination?.status).toBe("open");
		const copied = await f.t.run((ctx) =>
			ctx.db.get(required(page[0]).revisionId),
		);
		expect(copied?.createdBy).toEqual({ kind: "agent", id: f.copier.tokenId });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("localeProposalValues")
					.withIndex("by_proposal", (q) =>
						q.eq("proposalId", required(required(copied).localeProposalId)),
					)
					.collect(),
			),
		).toEqual([]);
		const reviewer = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Independent",
			scopes: ["read", "review"],
		});
		await expect(
			f.t.query(internal.agentTranslationProposals.contextForAgentReview, {
				token: reviewer.token,
				candidateRevisionId: required(page[0]).revisionId,
			}),
		).rejects.toThrow();
		await f.owner.mutation(api.agentTranslationProposals.grantCandidateReview, {
			candidateRevisionId: required(page[0]).revisionId,
			reviewerTokenId: reviewer.tokenId,
		});
		const context = await f.t.query(
			internal.agentTranslationProposals.contextForAgentReview,
			{
				token: reviewer.token,
				candidateRevisionId: required(page[0]).revisionId,
			},
		);
		expect(context).toMatchObject({
			kind: "candidate",
			candidate: {
				reusedFrom: copied?.reusedFrom,
				createdBy: copied?.createdBy,
			},
			alreadyReviewed: false,
		});
		expect(await (await f.reuse("another-pass")).json()).toMatchObject({
			items: [
				{ status: "alreadyCopied" },
				{ status: "alreadyCopied" },
				{ status: "unreviewed" },
				{ status: "unreviewed" },
			],
		});
		expect(
			await f.t.run((ctx) => ctx.db.get(required(revisions[0]).revisionId)),
		).toMatchObject({
			value: "Translated",
			createdBy: { id: f.author.tokenId },
		});
	});

	test("enforces project, task ownership and read/propose scope, including receipt reads", async () => {
		const f = await setup(1);
		const reader = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Reader",
			scopes: ["read"],
		});
		expect(
			(await f.reuse("scope", 0, f.from.taskId, f.to.taskId, reader.token))
				.status,
		).toBe(401);
		const otherProject = await createProject(f.owner, {
			name: "Other",
			slug: "other",
		});
		const other = await f.owner.mutation(api.apiTokens.create, {
			projectId: otherProject,
			name: "Other",
			scopes: ["read", "propose"],
		});
		expect(
			(await f.reuse("other", 0, f.from.taskId, f.to.taskId, other.token))
				.status,
		).toBe(400);
		const privateTask = await f.t.mutation(
			internal.agentTranslationProposals.create,
			{
				token: f.author.token,
				clientProposalKey: "private",
				target: {
					kind: "localeProposal",
					localeProposalId: required(
						required(await f.t.run((ctx) => ctx.db.get(f.from.taskId)))
							.localeProposalTaskScope,
					).localeProposalId,
				},
			},
		);
		expect((await f.reuse("private", 0, privateTask.proposalId)).status).toBe(
			400,
		);
		expect(
			(await f.reuse("same", 0, f.from.taskId, f.from.taskId)).status,
		).toBe(400);
		await f.reuse("bound");
		const third = await f.makeTask("fr");
		expect(
			(await f.reuse("bound", 0, f.from.taskId, third.taskId)).status,
		).toBe(400);
	});

	test("never overwrites destination candidates or applied values and isolates validation failure within a page", async () => {
		const f = await setup(3);
		const revisions = await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "Long translation" },
			{ messageId: "m1", value: "Source translation" },
			{ messageId: "m2", value: "OK" },
		]);
		for (const revision of revisions)
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: revision.revisionId,
				decision: { kind: "accept" },
			});
		await f.owner.mutation(api.messageConstraints.setCharacterLimit, {
			projectId: f.projectId,
			messageId: "m0",
			characterLimit: 3,
			expectedCharacterLimit: null,
		});
		await f.submit(f.to.taskId, [
			{ messageId: "m1", value: "Destination work" },
		]);
		const result = await f.reuse();
		expect(result.status, await result.clone().text()).toBe(200);
		expect(await result.json()).toMatchObject({
			items: [
				{ status: "invalidDestination" },
				{ status: "occupiedDestination" },
				{ status: "copied" },
			],
		});
	});

	test("compares Source text and runtime placeholder declarations across snapshots and reports source text drift", async () => {
		const f = await setup(2, {
			m0: "{count} items",
			"@m0": { placeholders: { count: { type: "int" } } },
		});
		const revisions = await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "{count} coisas" },
			{ messageId: "m1", value: "Other translation" },
		]);
		for (const revision of revisions)
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: revision.revisionId,
				decision: { kind: "accept" },
			});
		await f.owner.action(api.snapshots.ingest, {
			projectId: f.projectId,
			repository: "repo",
			commit: "changed",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({
						...f.source,
						m1: "Changed meaning",
						"@m0": { placeholders: { count: { type: "num" } } },
					}),
				},
			],
		});
		const destination = await f.makeTask("fr");
		const response = await f.reuse(
			"drift",
			0,
			f.from.taskId,
			destination.taskId,
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [
				{ messageId: "m0", status: "incompatibleSource" },
				{ messageId: "m1", status: "incompatibleSource" },
			],
		});
	});

	test("requires complete Snapshot metadata while ignoring object key order", async () => {
		const f = await setup(7, {
			m0: "Open",
			"@m0": { description: "Open a document" },
			m1: "{count} items",
			"@m1": { placeholders: { count: { type: "int", example: "2" } } },
			"@m2": { custom: { placement: "heading", labels: ["a", "b"] } },
			m3: "{count} items",
			"@m3": { placeholders: { count: { type: "int", custom: "original" } } },
			m4: "{count} items",
			"@m4": {
				description: "Same",
				custom: { a: 1, b: 2 },
				placeholders: { count: { type: "int", example: "2" } },
			},
			"@m5": { labels: ["first", "second"] },
		});
		const revisions = await f.submit(
			f.from.taskId,
			Array.from({ length: 7 }, (_, i) => ({
				messageId: `m${i}`,
				value: [1, 3, 4].includes(i) ? "{count} coisas" : "Translated",
			})),
		);
		for (const revision of revisions)
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: revision.revisionId,
				decision: { kind: "accept" },
			});
		await f.owner.action(api.snapshots.ingest, {
			projectId: f.projectId,
			repository: "repo",
			commit: "metadata-only",
			lineage: {
				baselineCommit: "baseline",
				relationship: "descendant",
				mergeBase: "baseline",
			},
			files: [
				{
					catalogPath: "en.arb",
					content: JSON.stringify({
						...f.source,
						"@m0": { description: "The store is open" },
						"@m1": { placeholders: { count: { type: "int", example: "3" } } },
						"@m2": { custom: { placement: "button", labels: ["a", "b"] } },
						"@m3": {
							placeholders: { count: { type: "int", custom: "changed" } },
						},
						"@m4": {
							placeholders: { count: { example: "2", type: "int" } },
							custom: { b: 2, a: 1 },
							description: "Same",
						},
						"@m5": { labels: ["second", "first"] },
					}),
				},
			],
		});
		const destination = await f.makeTask("fr");
		const response = await f.reuse(
			"metadata",
			0,
			f.from.taskId,
			destination.taskId,
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [
				{ messageId: "m0", status: "incompatibleSource" },
				{ messageId: "m1", status: "incompatibleSource" },
				{ messageId: "m2", status: "incompatibleSource" },
				{ messageId: "m3", status: "incompatibleSource" },
				{ messageId: "m4", status: "copied" },
				{ messageId: "m5", status: "incompatibleSource" },
				{ messageId: "m6", status: "copied" },
			],
		});
	});

	test("retains ICU plural candidates through ordinary destination validation across Locale identities", async () => {
		const f = await setup(1, {
			m0: "{count, plural, other{# items}}",
			"@m0": { placeholders: { count: { type: "int" } } },
		});
		const revisions = await f.submit(f.from.taskId, [
			{
				messageId: "m0",
				value: "{count, plural, many{# coisas} other{# coisas}}",
			},
		]);
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(revisions[0]).revisionId,
			decision: { kind: "accept" },
		});
		const response = await f.reuse();
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [{ status: "copied" }],
		});
	});

	test("rechecks the latest origin revision after contract preparation", async () => {
		const f = await setup(1);
		const revisions = await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "Accepted" },
		]);
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(revisions[0]).revisionId,
			decision: { kind: "accept" },
		});
		const args = {
			token: f.copier.token,
			sourceTaskId: f.from.taskId,
			destinationTaskId: f.to.taskId,
			clientReuseKey: "race",
			cursor: 0,
		};
		const plan = await f.t.query(internal.taskReuse.plan, args);
		if (plan.kind !== "plan") throw Error("Expected plan");
		await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "Correction awaiting review" },
		]);
		const result = await f.t.mutation(internal.taskReuse.commitPage, {
			...args,
			destinationSnapshotId: plan.destinationSnapshotId,
			checked: [
				{
					messageId: "m0",
					originRevisionId: required(revisions[0]).revisionId,
					compatible: true,
				},
			],
		});
		expect(result.items).toMatchObject([{ status: "sourceChanged" }]);
		expect(await (await f.reuse("latest-only")).json()).toMatchObject({
			items: [{ status: "unreviewed" }],
		});
	});

	test("paginates frozen source scope in at most 16 items and resumes after a lost response", async () => {
		const f = await setup(18);
		const revisions = await f.submit(f.from.taskId, [
			{ messageId: "m0", value: "OK" },
			{ messageId: "m17", value: "Done" },
		]);
		for (const revision of revisions)
			await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: revision.revisionId,
				decision: { kind: "accept" },
			});
		const first = await f.reuse();
		const page: { items: unknown[]; nextCursor: number } = await first.json();
		expect(page.items).toHaveLength(16);
		expect(page.nextCursor).toBe(16);
		expect(await (await f.reuse()).json()).toEqual(page);
		expect(
			await (await f.reuse("reuse", page.nextCursor)).json(),
		).toMatchObject({
			items: [
				{ messageId: "m16", status: "unreviewed" },
				{ messageId: "m17", status: "copied" },
			],
			nextCursor: null,
		});
	});
});

test("Basic reuse reconstructs captured source metadata, preserves text and blanks, and rechecks after preparation", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "basic-reuse");
	const projectId = await owner.mutation(api.projects.create, {
		name: "Basic",
		type: "basic",
		sourceLocaleCode: "en",
		sourceLocaleLabel: "English",
	});
	const collectionId = required(
		(await owner.query(api.projects.get, { projectId })).managedCollectionId,
	);
	const sourceLocaleId = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	const destinationLocaleId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	await owner.mutation(api.contentCollections.setLocales, {
		projectId,
		collectionId,
		expectedMembershipRevision: 1,
		localeIds: [sourceLocaleId, destinationLocaleId],
	});
	for (let i = 0; i < 9; i++)
		await owner.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId,
			key: `m${i}`,
			sourceValue: "Literal {braces}",
			name: `Name ${i}`,
			context: "Original context",
			...(i === 2
				? {
						translations: [
							{ localeId: destinationLocaleId, value: "Occupied" },
						],
					}
				: {}),
		});
	const task = (localeId: Id<"locales">, messageIds: string[]) =>
		owner.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Plain",
			target: { kind: "existingLocale", localeId },
			scope: { kind: "selectedMessages", messageIds },
		});
	const messageIds = Array.from({ length: 9 }, (_, i) => `m${i}`);
	const from = await task(sourceLocaleId, messageIds);
	const to = await task(
		destinationLocaleId,
		messageIds.filter((id) => id !== "m3"),
	);
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Author",
		scopes: ["read", "propose"],
	});
	const context = await t.query(
		internal.agentTranslationProposals.taskSubmissionContext,
		{
			token: token.token,
			taskId: from.taskId,
			messageIds,
		},
	);
	const submitted = await t.mutation(
		internal.agentTranslationProposals.submitRevisions,
		{
			token: token.token,
			proposalId: from.taskId,
			items: context.map((item) => ({
				messageId: item.messageId,
				localeId: sourceLocaleId,
				value: item.messageId === "m1" ? "" : "自由 {literal}",
				...(item.messageId === "m1"
					? { intentionalBlankReason: "Intentional plain blank" }
					: {}),
				clientRevisionKey: item.messageId,
				expectedCandidateRevision: 0,
				basis: item.basis,
			})),
		},
	);
	for (const revision of submitted.revisions)
		await owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: revision.revisionId,
			decision: { kind: "accept" },
		});
	const args = {
		token: token.token,
		sourceTaskId: from.taskId,
		destinationTaskId: to.taskId,
		clientReuseKey: "plain",
		cursor: 0,
	};
	const prepared = await t.query(internal.taskReuse.plan, args);
	if (prepared.kind !== "plan") throw Error("Expected plan");
	await owner.mutation(api.managedContent.saveSource, {
		projectId,
		collectionId,
		messageId: "m4",
		sourceValue: "Changed source",
		expectedSourceRevision: 1,
	});
	for (const [messageId, change] of [
		["m5", { context: "Changed context" }],
		["m6", { name: "Changed name" }],
		["m8", { context: "Temporary context" }],
	] as const)
		await owner.mutation(api.managedContent.saveSource, {
			projectId,
			collectionId,
			messageId,
			sourceValue: "Literal {braces}",
			expectedSourceRevision: 1,
			...change,
		});
	await owner.mutation(api.managedContent.saveSource, {
		projectId,
		collectionId,
		messageId: "m8",
		sourceValue: "Literal {braces}",
		context: "Original context",
		expectedSourceRevision: 2,
	});
	await t.run(async (ctx) => {
		const history = await ctx.db
			.query("managedSourceRevisions")
			.withIndex("by_collectionId_and_messageId_and_sourceRevision", (q) =>
				q
					.eq("collectionId", collectionId)
					.eq("messageId", "m7")
					.eq("sourceRevision", 1),
			)
			.unique();
		await ctx.db.delete(required(history)._id);
	});
	// Prepared flags predate the context edits. The mutation must reconstruct
	// and compare current Basic source rather than trusting these flags.
	const committed = await t.mutation(internal.taskReuse.commitPage, {
		...args,
		destinationSnapshotId: prepared.destinationSnapshotId,
		checked: prepared.items.map((item) => ({
			messageId: item.messageId,
			originRevisionId: item.revision?._id ?? null,
			compatible: true,
		})),
	});
	const response = await t.fetch(
		`/api/agent/v1/translation-tasks/${to.taskId}/reuse`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sourceTaskId: from.taskId,
				clientReuseKey: "plain",
			}),
		},
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const receipt = await response.json();
	expect(receipt).toEqual(committed);
	expect(receipt).toMatchObject({
		items: [
			{ status: "copied" },
			{ status: "copied" },
			{ status: "occupiedDestination" },
			{ status: "outsideDestination" },
			{ status: "incompatibleSource" },
			{ status: "incompatibleSource" },
			{ status: "incompatibleSource" },
			{ status: "incompatibleSource" },
			{ status: "copied" },
		],
	});
	const page = await t.query(internal.agentTranslationProposals.taskForAgent, {
		token: token.token,
		taskId: to.taskId,
		cursor: 0,
		limit: 16,
	});
	expect(page.targets[0]?.candidate).toMatchObject({
		value: "自由 {literal}",
		latestReview: null,
	});
	expect(page.targets[1]?.candidate).toMatchObject({
		value: "",
		intentionalBlankReason: "Intentional plain blank",
		latestReview: null,
	});
	// Exercise the action's managed path independently of the saved receipt.
	const matching = await task(destinationLocaleId, ["m8"]);
	const matchingPage = await t.fetch(
		`/api/agent/v1/translation-tasks/${matching.taskId}/reuse`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sourceTaskId: from.taskId,
				clientReuseKey: "matching-restored",
			}),
		},
	);
	expect(matchingPage.status, await matchingPage.clone().text()).toBe(200);
	expect(await matchingPage.json()).toMatchObject({
		items: [
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ status: "outsideDestination" },
			{ messageId: "m8", status: "copied" },
		],
	});
});

test("existing Locale tasks reuse missing workspace targets and recheck the destination Snapshot after preparation", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "existing-reuse");
	const projectId = await createProject(owner);
	const locales = await owner.query(api.locales.list, { projectId });
	const en = required(locales[0])._id;
	const fr = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	const de = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	for (const [localeId, catalogPath] of [
		[en, "en.arb"],
		[fr, "fr.arb"],
		[de, "de.arb"],
	] as const)
		await owner.action(api.locales.bind, { localeId, catalogPath });
	const files = [
		{
			catalogPath: "en.arb",
			content: JSON.stringify({
				"@@locale": "en",
				m0: "Source",
				m1: "Another source",
			}),
		},
		...["fr", "de"].map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({ "@@locale": code, m0: "", m1: "" }),
		})),
	];
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files,
	});
	const task = (localeId: Id<"locales">) =>
		owner.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Selected",
			target: { kind: "existingLocale", localeId },
			scope: { kind: "selectedMessages", messageIds: ["m0", "m1"] },
		});
	const from = await task(fr);
	const to = await task(de);
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Agent",
		scopes: ["read", "propose"],
	});
	const context = await t.query(
		internal.agentTranslationProposals.taskSubmissionContext,
		{ token: token.token, taskId: from.taskId, messageIds: ["m0", "m1"] },
	);
	const submitted = await t.mutation(
		internal.agentTranslationProposals.submitRevisions,
		{
			token: token.token,
			proposalId: from.taskId,
			items: context.map((item) => ({
				messageId: item.messageId,
				localeId: fr,
				value: "Translated",
				clientRevisionKey: item.messageId,
				expectedCandidateRevision: 0,
				basis: item.basis,
			})),
		},
	);
	for (const revision of submitted.revisions)
		await owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: revision.revisionId,
			decision: { kind: "accept" },
		});
	const args = {
		token: token.token,
		sourceTaskId: from.taskId,
		destinationTaskId: to.taskId,
		clientReuseKey: "race",
		cursor: 0,
	};
	const plan = await t.query(internal.taskReuse.plan, args);
	if (plan.kind !== "plan") throw Error("Expected plan");
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "next",
		lineage: {
			baselineCommit: "baseline",
			relationship: "descendant",
			mergeBase: "baseline",
		},
		files,
	});
	const raced = await t.mutation(internal.taskReuse.commitPage, {
		...args,
		destinationSnapshotId: plan.destinationSnapshotId,
		checked: plan.items.map((item) => ({
			messageId: item.messageId,
			originRevisionId: required(item.revision)._id,
			compatible: true,
		})),
	});
	expect(raced.items).toMatchObject([
		{ status: "incompatibleSource" },
		{ status: "incompatibleSource" },
	]);
	const response = await t.fetch(
		`/api/agent/v1/translation-tasks/${to.taskId}/reuse`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sourceTaskId: from.taskId,
				clientReuseKey: "current",
			}),
		},
	);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.json()).toMatchObject({
		items: [{ status: "copied" }, { status: "copied" }],
	});
});

test("commits a full 16-candidate page within real transaction limits", async () => {
	const f = await setup(16);
	const revisions = await f.submit(
		f.from.taskId,
		Array.from({ length: 16 }, (_, i) => ({
			messageId: `m${i}`,
			value: `Translation ${i}`,
		})),
	);
	for (const revision of revisions)
		await f.owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: revision.revisionId,
			decision: { kind: "accept" },
		});
	const response = await f.reuse();
	expect(response.status, await response.clone().text()).toBe(200);
	const result: {
		items: Array<{ status: string; revisionId: string }>;
		nextCursor: null;
	} = await response.json();
	expect(result.nextCursor).toBeNull();
	expect(result.items).toHaveLength(16);
	expect(result.items.every((item) => item.status === "copied")).toBe(true);
	expect(new Set(result.items.map((item) => item.revisionId)).size).toBe(16);
	const task = await f.t.run((ctx) => ctx.db.get(f.to.taskId));
	expect(task).toMatchObject({
		candidateCount: 16,
		revisionCount: 16,
		status: "open",
	});
});

test.each([
	{ count: 16, sourceBytes: 128 * 1024, editedReview: false },
	{ count: 8, sourceBytes: 256 * 1024, editedReview: true },
])(
	"traverses $count large Basic values with $sourceBytes-byte Source and durable bounded receipts",
	async ({ count, sourceBytes, editedReview }) => {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, `reuse-capacity-${count}`);
		const projectId = await owner.mutation(api.projects.create, {
			name: "Capacity fixture",
			type: "basic",
			sourceLocaleCode: "en",
			sourceLocaleLabel: "English",
		});
		const collectionId = required(
			(await owner.query(api.projects.get, { projectId })).managedCollectionId,
		);
		const fromLocaleId = await owner.mutation(api.locales.create, {
			projectId,
			code: "fr",
		});
		const toLocaleId = await owner.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		await owner.mutation(api.contentCollections.setLocales, {
			projectId,
			collectionId,
			expectedMembershipRevision: 1,
			localeIds: [fromLocaleId, toLocaleId],
		});
		const messageIds = Array.from(
			{ length: count },
			(_, index) => `large.${index}`,
		);
		const candidateValue = "v".repeat(256 * 1024);
		for (const key of messageIds)
			await owner.mutation(api.managedContent.createMessage, {
				projectId,
				collectionId,
				key,
				name: "n".repeat(256),
				sourceValue: "s".repeat(sourceBytes),
				context: "c".repeat(8192),
			});
		const task = (localeId: Id<"locales">) =>
			owner.mutation(api.agentTranslationProposals.createTask, {
				projectId,
				title: "Capacity",
				target: { kind: "existingLocale", localeId },
				scope: { kind: "selectedMessages", messageIds },
			});
		const from = await task(fromLocaleId);
		const to = await task(toLocaleId);
		const token = await owner.mutation(api.apiTokens.create, {
			projectId,
			name: "Capacity author",
			scopes: ["read", "propose"],
		});
		// Individual ordinary submissions and reviews prove that these payloads are
		// legal; the maximum-Source case also exercises a review storing value twice.
		for (const messageId of messageIds) {
			const [context] = await t.query(
				internal.agentTranslationProposals.taskSubmissionContext,
				{ token: token.token, taskId: from.taskId, messageIds: [messageId] },
			);
			const submitted = await t.mutation(
				internal.agentTranslationProposals.submitRevisions,
				{
					token: token.token,
					proposalId: from.taskId,
					items: [
						{
							messageId,
							localeId: fromLocaleId,
							value: candidateValue,
							clientRevisionKey: messageId,
							expectedCandidateRevision: 0,
							basis: required(context).basis,
						},
					],
				},
			);
			await owner.mutation(api.agentTranslationProposals.reviewCandidate, {
				candidateRevisionId: required(submitted.revisions[0]).revisionId,
				decision: editedReview
					? { kind: "acceptWithEdits", value: candidateValue }
					: { kind: "accept" },
			});
		}
		const reuse = (cursor: number) =>
			t.fetch(`/api/agent/v1/translation-tasks/${to.taskId}/reuse`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					sourceTaskId: from.taskId,
					clientReuseKey: "capacity",
					cursor,
				}),
			});
		const visited: string[] = [];
		const revisionIds = new Set<string>();
		const receipts = [];
		let cursor: number | null = 0;
		while (cursor !== null) {
			const response = await reuse(cursor);
			expect(response.status, await response.clone().text()).toBe(200);
			const receipt: {
				items: Array<{ messageId: string; status: string; revisionId: string }>;
				nextCursor: number | null;
			} = await response.json();
			expect(receipt.items.length).toBeGreaterThan(0);
			expect(receipt.items.length).toBeLessThanOrEqual(16);
			expect(receipt.items.every((item) => item.status === "copied")).toBe(
				true,
			);
			expect(receipt.items.map((item) => item.messageId)).toEqual(
				messageIds.slice(visited.length, visited.length + receipt.items.length),
			);
			visited.push(...receipt.items.map((item) => item.messageId));
			for (const item of receipt.items) revisionIds.add(item.revisionId);
			const replay = await reuse(cursor);
			expect(replay.status, await replay.clone().text()).toBe(200);
			expect(await replay.json()).toEqual(receipt);
			receipts.push(receipt);
			expect(receipt.nextCursor).toBe(
				visited.length === count ? null : visited.length,
			);
			cursor = receipt.nextCursor;
		}
		expect(receipts.length).toBeGreaterThan(1);
		expect(visited).toEqual(messageIds);
		expect(revisionIds.size).toBe(count);
		const stored = await t.run(async (ctx) => {
			const task = await ctx.db.get(to.taskId);
			const revisions = await ctx.db
				.query("agentTranslationCandidateRevisions")
				.withIndex("by_proposal", (q) => q.eq("proposalId", to.taskId))
				.take(count + 1);
			const pages = await ctx.db
				.query("translationTaskReusePages")
				.withIndex(
					"by_projectId_and_createdByTokenId_and_clientReuseKey_and_cursor",
					(q) =>
						q
							.eq("projectId", projectId)
							.eq("createdByTokenId", token.tokenId)
							.eq("clientReuseKey", "capacity"),
				)
				.take(count + 1);
			return {
				task,
				revisions: revisions.map((revision) => ({
					valueMatches: revision.value === candidateValue,
					revision: revision.revision,
					sourceRevision:
						revision.basis.kind === "managed"
							? revision.basis.sourceRevision
							: null,
					origin: revision.reusedFrom,
				})),
				receipts: pages.map((page) => page.result),
			};
		});
		expect(stored.task).toMatchObject({
			candidateCount: count,
			revisionCount: count,
			status: "open",
		});
		expect(stored.revisions).toHaveLength(count);
		for (const revision of stored.revisions)
			expect(revision).toMatchObject({
				valueMatches: true,
				revision: 1,
				sourceRevision: 1,
				origin: { taskId: from.taskId },
			});
		expect(stored.receipts).toEqual(receipts);
	},
);

test("bounds heavy frozen repository membership and copies the first item with large project metadata", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(
		t,
		"repository-reuse-capacity",
		60 * 60_000,
	);
	const projectId = await createProject(owner);
	const en = required(
		(await owner.query(api.locales.list, { projectId }))[0],
	)._id;
	const fr = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	const de = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	for (const [localeId, code] of [
		[en, "en"],
		[fr, "fr"],
		[de, "de"],
	] as const)
		await owner.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	const messageIds = Array.from({ length: 17 }, (_, i) => `k${i}`);
	const sourceValue = "s".repeat(240 * 1024);
	const frozenTargetValue = "x".repeat(255 * 1024);
	const candidateValue = "v".repeat(256 * 1024);
	const files = (targetValue: string) =>
		["en", "fr", "de"].map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				...Object.fromEntries(
					messageIds.map((id) => [
						id,
						code === "en" ? sourceValue : targetValue,
					]),
				),
			}),
		}));
	expect(required(files("initial")[0]).content.length).toBeLessThan(
		4 * 1024 * 1024,
	);
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: files("initial"),
	});
	const navigation = await owner.query(
		api.catalogWorkspaceNavigation.navigation,
		{ projectId },
	);
	if (navigation.kind !== "ready") throw Error("Expected projection");
	for (const messageId of messageIds) {
		const [card] = await owner.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: navigation.projectionId,
			messageIds: [messageId],
		});
		for (const localeId of [fr, de]) {
			const target = required(
				required(card).values.find((value) => value.localeId === localeId),
			);
			await owner.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId,
				localeId,
				intent: { kind: "save", value: frozenTargetValue },
				expectedGitValueFingerprint: required(target.gitValueFingerprint),
				expectedGitValueRevision: required(target.gitValueRevision),
				expectedWorkspaceRevision: target.workspaceRevision,
				expectedSourceFingerprint: required(target.expectedSourceFingerprint),
			});
		}
	}
	const task = (localeId: Id<"locales">) =>
		owner.mutation(api.agentTranslationProposals.createTask, {
			projectId,
			title: "Heavy frozen repository",
			target: { kind: "existingLocale", localeId },
			scope: { kind: "selectedMessages", messageIds },
		});
	const from = await task(fr);
	const to = await task(de);
	const frozenBytes = await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("translationTaskTargets")
			.withIndex("by_proposal_and_catalogIndex", (q) =>
				q.eq("proposalId", from.taskId),
			)
			.take(18);
		return rows.reduce(
			(sum, row) =>
				sum + (row.sourceValue?.length ?? 0) + (row.targetValue?.length ?? 0),
			0,
		);
	});
	expect(frozenBytes).toBeGreaterThan(8 * 1024 * 1024);
	await owner.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "next",
		files: files(""),
		lineage: {
			baselineCommit: "baseline",
			relationship: "descendant",
			mergeBase: "baseline",
		},
	});
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Capacity author",
		scopes: ["read", "propose"],
	});
	for (const messageId of messageIds) {
		const [context] = await t.query(
			internal.agentTranslationProposals.taskSubmissionContext,
			{
				token: token.token,
				taskId: from.taskId,
				messageIds: [messageId],
			},
		);
		const submitted = await t.mutation(
			internal.agentTranslationProposals.submitRevisions,
			{
				token: token.token,
				proposalId: from.taskId,
				items: [
					{
						messageId,
						localeId: fr,
						value: candidateValue,
						clientRevisionKey: messageId,
						expectedCandidateRevision: 0,
						basis: required(context).basis,
					},
				],
			},
		);
		await owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: required(submitted.revisions[0]).revisionId,
			decision: { kind: "acceptWithEdits", value: candidateValue },
		});
	}
	await owner.mutation(api.projects.update, {
		projectId,
		name: "p".repeat(800 * 1024),
	});
	const args = {
		token: token.token,
		sourceTaskId: from.taskId,
		destinationTaskId: to.taskId,
		clientReuseKey: "repository-capacity",
		cursor: 0,
	};
	const prepared = await t.query(internal.taskReuse.plan, args);
	if (prepared.kind !== "plan") throw Error("Expected plan");
	expect(prepared.items.length).toBeGreaterThan(0);
	expect(prepared.items.length).toBeLessThan(16);
	const commitArgs = {
		...args,
		destinationSnapshotId: prepared.destinationSnapshotId,
		checked: prepared.items.map((item) => ({
			messageId: item.messageId,
			originRevisionId: required(item.revision)._id,
			compatible: true,
		})),
	};
	// Public token names also have no app byte cap. Combined oversized supporting
	// records can exceed even a one-item budget: reject explicitly, then prove that
	// the same content remains reusable with ordinary-size credential metadata.
	const heavyToken = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "t".repeat(900 * 1024),
		scopes: ["read", "propose"],
	});
	const refused = await t.run(async (ctx) => {
		try {
			await ctx.runMutation(internal.taskReuse.commitPage, {
				...commitArgs,
				token: heavyToken.token,
			});
			return {
				message: "unexpected success",
				metrics: await ctx.meta.getTransactionMetrics(),
			};
		} catch (error) {
			return {
				message: error instanceof Error ? error.message : String(error),
				metrics: await ctx.meta.getTransactionMetrics(),
			};
		}
	});
	expect(refused.message).toContain("Task reuse cannot fit one complete item");
	expect(refused.metrics.bytesRead.used).toBeLessThan(16 * 1024 * 1024);
	for (let attempt = 0; attempt < 2; attempt++) {
		const refusedHttp = await t.fetch(
			`/api/agent/v1/translation-tasks/${to.taskId}/reuse`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${heavyToken.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					sourceTaskId: from.taskId,
					clientReuseKey: args.clientReuseKey,
					cursor: 0,
				}),
			},
		);
		expect(refusedHttp.status).toBe(413);
		expect(await refusedHttp.json()).toMatchObject({
			code: "LIMIT_EXCEEDED",
			error: expect.stringContaining("Task reuse cannot fit one complete item"),
		});
	}

	// A deliberately tighter parent budget must refuse before the first write,
	// without a misleading skip, an empty receipt or an unrecoverable checkpoint.
	await expect(
		t.run((ctx) =>
			ctx.runMutation(internal.taskReuse.commitPage, commitArgs, {
				transactionLimits: { bytesRead: 4 * 1024 * 1024 },
			}),
		),
	).rejects.toThrow("Task reuse cannot fit one complete item");
	const counts = () =>
		t.run(async (ctx) => ({
			candidates: (
				await ctx.db
					.query("agentTranslationCandidates")
					.withIndex("by_proposal", (q) => q.eq("proposalId", to.taskId))
					.take(18)
			).length,
			receipts: (
				await ctx.db
					.query("translationTaskReusePages")
					.withIndex(
						"by_projectId_and_createdByTokenId_and_clientReuseKey_and_cursor",
						(q) => q.eq("projectId", projectId),
					)
					.take(18)
			).length,
		}));
	expect(await counts()).toEqual({ candidates: 0, receipts: 0 });

	// Measure the actual registered mutation, including outer setup, nested
	// eligibility/ordinary submission and receipt persistence. Roll back only the
	// test wrapper afterward so the first real POST still performs a fresh commit.
	let firstReadBytes = 0;
	let firstWriteBytes = 0;
	let firstMessageIds: string[] = [];
	let firstNextCursor: number | null = null;
	await expect(
		t.run(async (ctx) => {
			const receipt = await ctx.runMutation(
				internal.taskReuse.commitPage,
				commitArgs,
			);
			expect(receipt.items.every((item) => item.status === "copied")).toBe(
				true,
			);
			const metrics = await ctx.meta.getTransactionMetrics();
			firstReadBytes = metrics.bytesRead.used;
			firstWriteBytes = metrics.bytesWritten.used;
			firstMessageIds = receipt.items.map((item) => item.messageId);
			firstNextCursor = receipt.nextCursor;
			throw Error("rollback measured capacity transaction");
		}),
	).rejects.toThrow("rollback measured capacity transaction");

	expect(firstMessageIds.length).toBeGreaterThan(0);
	expect(firstReadBytes).toBeLessThan(16 * 1024 * 1024);
	expect(firstWriteBytes).toBeLessThan(16 * 1024 * 1024);
	expect(await counts()).toEqual({ candidates: 0, receipts: 0 });

	let clock = Date.now();
	const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
	const reuse = (cursor: number) => {
		clock += 3_000; // Pace synthetic POSTs through the real HTTP rate limiter.
		return t.fetch(`/api/agent/v1/translation-tasks/${to.taskId}/reuse`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sourceTaskId: from.taskId,
				clientReuseKey: args.clientReuseKey,
				cursor,
			}),
		});
	};
	try {
		const visited: string[] = [];
		const revisions = new Set<string>();
		let cursor: number | null = 0;
		let pages = 0;
		while (cursor !== null) {
			const response = await reuse(cursor);
			expect(response.status, await response.clone().text()).toBe(200);
			const receipt: {
				items: Array<{ messageId: string; status: string; revisionId: string }>;
				nextCursor: number | null;
			} = await response.json();
			if (cursor === 0) {
				expect(receipt.items.map((item) => item.messageId)).toEqual(
					firstMessageIds,
				);
				expect(receipt.nextCursor).toBe(firstNextCursor);
			}
			expect(receipt.items.length).toBeGreaterThan(0);
			expect(receipt.items.every((item) => item.status === "copied")).toBe(
				true,
			);
			expect(receipt.items.map((item) => item.messageId)).toEqual(
				messageIds.slice(visited.length, visited.length + receipt.items.length),
			);
			visited.push(...receipt.items.map((item) => item.messageId));
			for (const item of receipt.items) revisions.add(item.revisionId);
			const replay = await reuse(cursor);
			expect(replay.status, await replay.clone().text()).toBe(200);
			expect(await replay.json()).toEqual(receipt);
			expect(receipt.nextCursor).toBe(
				visited.length === 17 ? null : visited.length,
			);
			cursor = receipt.nextCursor;
			pages++;
		}
		expect(visited).toEqual(messageIds);
		expect(revisions.size).toBe(17);
		expect(await counts()).toEqual({ candidates: 17, receipts: pages });
	} finally {
		time.mockRestore();
	}
}, 60_000);
