import { expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createLegacyCollection,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "owner");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	const collectionId = await createLegacyCollection(t, {
		projectId,
		name: "Website",
		localeIds: [localeId],
	});
	for (const key of ["hero", "footer"])
		await owner.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId,
			key,
			sourceValue: `${key} {literal}`,
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
	const request = async (token: string, path: string, body?: unknown) =>
		t.fetch(`/api/agent/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const created = await request(translator.token, "/translation-tasks", {
		clientTaskKey: "Website German",
		target: { kind: "managedLocale", collectionId, localeCode: "de" },
		scope: { kind: "selectedMessages", messageIds: ["hero", "footer"] },
	});
	expect(created.status).toBe(200);
	const { taskId } = (await created.json()) as {
		taskId: Id<"agentTranslationProposals">;
	};
	return {
		t,
		owner,
		projectId,
		localeId,
		collectionId,
		translator,
		reviewer,
		request,
		taskId,
	};
}

test("managed HTTP tasks submit literal text and share independent review without snapshots", async () => {
	const f = await setup();
	const page = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}?limit=1`,
	);
	expect(page.status).toBe(200);
	expect(await page.json()).toMatchObject({
		targets: [{ messageId: "hero", sourceValue: "hero {literal}" }],
		nextCursor: 1,
	});
	const submitted = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}/candidates`,
		{
			items: [
				{ messageId: "hero", value: "Hallo {wörtlich" },
				{
					messageId: "footer",
					candidate: { kind: "intentionalBlank", reason: "No footer here" },
				},
			],
		},
	);
	expect(submitted.status).toBe(200);
	const result = (await submitted.json()) as {
		revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
	};
	const revisionId = result.revisions[0]?.revisionId;
	if (!revisionId) throw new Error("Expected revision");
	expect(
		(await f.request(f.reviewer.token, `/candidate-reviews/${revisionId}`))
			.status,
	).toBe(403);
	await f.owner.mutation(api.projects.setAgentReviewPolicy, {
		projectId: f.projectId,
		enabled: true,
	});
	const context = (await (
		await f.request(f.reviewer.token, `/candidate-reviews/${revisionId}`)
	).json()) as { reviewToken: string };
	expect(
		(
			await f.request(f.reviewer.token, `/candidate-reviews/${revisionId}`, {
				reviewToken: context.reviewToken,
				decision: { kind: "accept" },
			})
		).status,
	).toBe(200);
	const blankId = result.revisions[1]?.revisionId;
	if (!blankId) throw new Error("Expected blank revision");
	const blank = (await (
		await f.request(f.reviewer.token, `/candidate-reviews/${blankId}`)
	).json()) as { reviewToken: string };
	expect(
		(
			await f.request(f.reviewer.token, `/candidate-reviews/${blankId}`, {
				reviewToken: blank.reviewToken,
				decision: { kind: "accept" },
			})
		).status,
	).toBe(200);
	const targets = await f.owner.query(api.managedContent.context, {
		projectId: f.projectId,
		collectionId: f.collectionId,
		messageIds: ["hero", "footer"],
		localeIds: [f.localeId],
	});
	expect(targets.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				value: "Hallo {wörtlich",
				valueState: "settled",
			}),
			expect.objectContaining({
				value: "",
				intentionalBlank: "No footer here",
				valueState: "settled",
			}),
		]),
	);
	expect(
		await f.t.run(
			async (ctx) => (await ctx.db.query("sourceSnapshots").collect()).length,
		),
	).toBe(0);
	const evidence = await f.t.run(
		async (ctx) =>
			await ctx.db.query("agentTranslationCandidateReviews").collect(),
	);
	expect(evidence).toHaveLength(2);
	expect(evidence[0]?.reviewer.kind).toBe("agent");
});

test("managed basis expires and human review can deliberately use current source", async () => {
	const f = await setup();
	const context = await f.t.query(
		internal.agentTranslationProposals.taskSubmissionContext,
		{ token: f.translator.token, taskId: f.taskId, messageIds: ["hero"] },
	);
	const target = context[0];
	if (!target) throw new Error("Expected task target");
	await f.owner.mutation(api.managedContent.saveSource, {
		projectId: f.projectId,
		collectionId: f.collectionId,
		messageId: "hero",
		sourceValue: "New source",
		expectedSourceRevision: 1,
	});
	await expect(
		f.t.mutation(internal.agentTranslationProposals.submitRevisions, {
			token: f.translator.token,
			proposalId: f.taskId,
			items: [
				{
					messageId: "hero",
					localeId: f.localeId,
					value: "Wert",
					clientRevisionKey: "stale",
					expectedCandidateRevision: 0,
					basis: target.basis,
				},
			],
		}),
	).rejects.toThrow(/changed/);
	const submitted = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}/candidates`,
		{ items: [{ messageId: "hero", value: "Wert" }] },
	);
	expect(submitted.status).toBe(200);
	const { revisions } = (await submitted.json()) as {
		revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
	};
	const revisionId = revisions[0]?.revisionId;
	if (!revisionId) throw new Error("Expected revision");
	await f.owner.mutation(api.projects.setAgentReviewPolicy, {
		projectId: f.projectId,
		enabled: true,
	});
	const before = (await (
		await f.request(f.reviewer.token, `/candidate-reviews/${revisionId}`)
	).json()) as { reviewToken: string };
	await f.owner.mutation(api.managedContent.saveSource, {
		projectId: f.projectId,
		collectionId: f.collectionId,
		messageId: "hero",
		sourceValue: "Newest source",
		expectedSourceRevision: 2,
	});
	expect(
		(
			await f.request(f.reviewer.token, `/candidate-reviews/${revisionId}`, {
				reviewToken: before.reviewToken,
				decision: { kind: "accept" },
			})
		).status,
	).toBe(409);
	await f.owner.mutation(api.agentTranslationProposals.saveTaskValue, {
		taskId: f.taskId,
		messageId: "hero",
		candidateToken: revisionId,
		value: "Wert",
	});
	expect(
		await f.owner.query(api.agentTranslationProposals.contextForReview, {
			revisionId: revisionId,
		}),
	).toMatchObject({
		available: true,
		kind: "managedCollection",
		basisIsCurrent: false,
		reviewBasisIsCurrent: true,
	});
	await f.owner.mutation(api.contentCollections.setLocales, {
		projectId: f.projectId,
		collectionId: f.collectionId,
		localeIds: [],
		expectedMembershipRevision: 1,
	});
	await expect(
		f.t.query(internal.agentTranslationProposals.taskSubmissionContext, {
			token: f.translator.token,
			taskId: f.taskId,
			messageIds: ["footer"],
		}),
	).rejects.toThrow(/enabled/);
});

test("managed tasks enforce collection membership, frozen scope, and exact batch review", async () => {
	const f = await setup();
	const otherProject = await createProject(f.owner, { slug: "other-project" });
	const otherLocale = await f.owner.mutation(api.locales.create, {
		projectId: otherProject,
		code: "de",
	});
	const foreignCollection = await createLegacyCollection(f.t, {
		projectId: otherProject,
		name: "Other",
		localeIds: [otherLocale],
	});
	await expect(
		f.owner.mutation(api.agentTranslationProposals.createTask, {
			projectId: f.projectId,
			title: "Foreign",
			target: {
				kind: "managedLocale",
				collectionId: foreignCollection,
				localeId: f.localeId,
			},
			scope: { kind: "selectedMessages", messageIds: ["hero"] },
		}),
	).rejects.toThrow();
	const retry = await f.request(f.translator.token, "/translation-tasks", {
		clientTaskKey: "Website German",
		target: {
			kind: "managedLocale",
			collectionId: f.collectionId,
			localeCode: "de",
		},
		scope: { kind: "selectedMessages", messageIds: ["hero", "footer"] },
	});
	expect(await retry.json()).toMatchObject({ taskId: f.taskId });
	const invalid = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}/candidates`,
		{ items: [{ messageId: "outside", value: "Wert" }] },
	);
	expect(invalid.status).toBe(400);
	const submitted = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}/candidates`,
		{
			items: [
				{ messageId: "hero", value: "Titel" },
				{ messageId: "footer", value: "Fuß" },
			],
		},
	);
	expect(submitted.status).toBe(200);
	const result = (await submitted.json()) as {
		revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
	};
	expect(
		await f.owner.mutation(api.agentTranslationProposals.acceptTaskCandidates, {
			proposalId: f.taskId,
			candidateRevisionIds: result.revisions.map((r) => r.revisionId),
		}),
	).toMatchObject({ accepted: 2, status: "accepted" });
	const inbox = await f.t.query(
		internal.agentTranslationProposals.listTasksForAgent,
		{ token: f.translator.token },
	);
	expect(inbox).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "managedLocale",
				collectionId: f.collectionId,
				taskId: f.taskId,
			}),
		]),
	);
});

test("task review pages stay bounded when large edited reviews exceed a whole-task response", async () => {
	const f = await setup();
	const keys = ["large_a", "large_b", "large_c"];
	for (const key of keys)
		await f.owner.mutation(api.managedContent.createMessage, {
			projectId: f.projectId,
			collectionId: f.collectionId,
			key,
			sourceValue: "Source",
		});
	const task = await f.owner.mutation(
		api.agentTranslationProposals.createTask,
		{
			projectId: f.projectId,
			title: "Large reviews",
			target: {
				kind: "managedLocale",
				collectionId: f.collectionId,
				localeId: f.localeId,
			},
			scope: { kind: "selectedMessages", messageIds: keys },
		},
	);
	for (const messageId of keys) {
		const submitted = await f.request(
			f.translator.token,
			`/translation-tasks/${task.taskId}/candidates`,
			{ items: [{ messageId, value: "a".repeat(200 * 1024) }] },
		);
		expect(submitted.status).toBe(200);
		const result = (await submitted.json()) as {
			revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
		};
		const revisionId = result.revisions[0]?.revisionId;
		if (!revisionId) throw new Error("Expected revision");
		await f.owner.mutation(api.agentTranslationProposals.saveTaskValue, {
			taskId: task.taskId,
			messageId,
			candidateToken: revisionId,
			value: "b".repeat(200 * 1024),
		});
	}
	const seen: string[] = [];
	let cursor: number | undefined;
	let pages = 0;
	do {
		const page = await f.owner.query(
			api.agentTranslationProposals.getForReview,
			{ proposalId: task.taskId, cursor, limit: 32 },
		);
		if (!page) throw new Error("Expected task page");
		expect(
			new TextEncoder().encode(JSON.stringify(page)).byteLength,
		).toBeLessThan(1024 * 1024);
		expect(page.proposal.taskScope?.targetCount).toBe(3);
		for (const entry of page.candidates) {
			expect(entry.revision?.value).toBe("a".repeat(200 * 1024));
			expect(entry.reviews[0]?.finalValue).toBe("b".repeat(200 * 1024));
		}
		seen.push(...page.candidates.map((entry) => entry.candidate.messageId));
		pages += 1;
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	expect(seen).toEqual(keys);
	expect(pages).toBe(3);
});

test("task review uses live optional names while retaining immutable message identities", async () => {
	const f = await setup();
	const address = {
		projectId: f.projectId,
		collectionId: f.collectionId,
		messageId: "hero",
		sourceValue: "hero {literal}",
	};
	await f.owner.mutation(api.managedContent.saveSource, {
		...address,
		expectedSourceRevision: 1,
		name: "Store headline",
	});
	const waiting = await f.owner.query(
		api.agentTranslationProposals.getForReview,
		{ proposalId: f.taskId },
	);
	expect(
		waiting?.taskTargets.find((target) => target.messageId === "hero"),
	).toMatchObject({ messageId: "hero", name: "Store headline" });
	expect(
		waiting?.taskTargets.find((target) => target.messageId === "footer"),
	).toMatchObject({ messageId: "footer", name: "footer" });
	const submitted = await f.request(
		f.translator.token,
		`/translation-tasks/${f.taskId}/candidates`,
		{ items: [{ messageId: "hero", value: "Titel" }] },
	);
	expect(submitted.status).toBe(200);
	const result = (await submitted.json()) as {
		revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
	};
	const revisionId = result.revisions[0]?.revisionId;
	if (!revisionId) throw new Error("Missing candidate revision");
	const original = await f.t.run((ctx) => ctx.db.get(revisionId));
	expect(
		await f.owner.query(api.agentTranslationProposals.contextForReview, {
			revisionId,
		}),
	).toMatchObject({ source: { name: "Store headline" } });
	await f.owner.mutation(api.managedContent.saveSource, {
		...address,
		expectedSourceRevision: 2,
		name: null,
	});
	expect(
		await f.owner.query(api.agentTranslationProposals.contextForReview, {
			revisionId,
		}),
	).toMatchObject({ source: { name: null } });
	expect(await f.t.run((ctx) => ctx.db.get(revisionId))).toEqual(original);
});
