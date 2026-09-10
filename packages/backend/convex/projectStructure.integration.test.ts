import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createLegacyCollection,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("Basic creation is atomic and project-scoped agent routes need no collection selection", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "basic-owner");
	const projectId = await owner.mutation(api.projects.create, {
		name: "Marketing",
		sourceLocaleCode: "en",
		type: "basic",
	});
	const project = await owner.query(api.projects.get, { projectId });
	expect(project.type).toBe("basic");
	if (!project.sourceLocale) throw new Error("Missing source");
	await expect(
		owner.action(api.locales.bind, {
			localeId: project.sourceLocale._id,
			catalogPath: "en.arb",
		}),
	).rejects.toThrow(/no repository file binding/);
	const collectionId = project.managedCollectionId;
	if (!collectionId) throw new Error("Missing strings store");
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "fr",
	});
	await owner.mutation(api.contentCollections.setLocales, {
		projectId,
		collectionId,
		localeIds: [localeId],
		expectedMembershipRevision: 1,
	});
	await owner.mutation(api.managedContent.createMessage, {
		projectId,
		collectionId,
		key: "title",
		sourceValue: "Make {anything}",
	});
	await expect(
		owner.mutation(api.contentCollections.create, {
			projectId,
			name: "Nested",
			localeIds: [],
		}),
	).rejects.toThrow(/one set of strings/);
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "search", "propose"],
	});
	const request = (path: string, body?: unknown) =>
		t.fetch(`/api/agent/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const discovery = await (await request("/projects/current")).json();
	expect(discovery.type).toBe("basic");
	expect(discovery.locales).toEqual(["en", "fr"]);
	const context = await request("/workspace/context", {
		keys: ["title"],
		locales: ["fr"],
	});
	expect(context.status).toBe(200);
	expect((await context.json()).items[0].sourceValue).toBe("Make {anything}");
	const search = await request("/workspace/search?q=Make&localeCode=fr");
	expect(search.status).toBe(200);
	expect((await search.json()).items[0].messageId).toBe("title");
	const body = {
		clientTaskKey: "French title",
		target: { kind: "existingLocale", localeCode: "fr" },
		scope: { kind: "selectedMessages", messageIds: ["title"] },
	};
	const created = await request("/translation-tasks", body);
	expect(created.status).toBe(200);
	const task = await created.json();
	const resumed = await request("/translation-tasks", body);
	expect(resumed.status).toBe(200);
	expect((await resumed.json()).taskId).toBe(task.taskId);
	const download = await request("/workspace/download", {
		keys: ["title"],
		locales: ["fr"],
		mode: "draft",
	});
	expect(download.status).toBe(200);
	expect((await download.json()).mode).toBe("draft");
});

test("promotion moves bounded content and exact review history while separating credentials and locales", async () => {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "legacy-owner");
	const stranger = await authenticatedBackend(t, "stranger");
	const projectId = await createProject(owner);
	const localeId = await owner.mutation(api.locales.create, {
		projectId,
		code: "de",
	});
	const collectionId = await createLegacyCollection(t, {
		projectId,
		name: "Marketing",
		localeIds: [localeId],
	});
	const retained = await createLegacyCollection(t, {
		projectId,
		name: "Other",
		localeIds: [localeId],
	});
	for (let i = 0; i < 9; i++)
		await owner.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId,
			key: `line${i}`,
			sourceValue: `Line ${i}`,
		});
	await owner.mutation(api.managedContent.createMessage, {
		projectId,
		collectionId: retained,
		key: "line0",
		sourceValue: "Separate",
	});
	await owner.mutation(api.messageConstraints.setCharacterLimit, {
		projectId,
		collectionId,
		messageId: "line0",
		characterLimit: 20,
		expectedCharacterLimit: null,
	});
	const token = await owner.mutation(api.apiTokens.create, {
		projectId,
		name: "Translator",
		scopes: ["read", "propose"],
	});
	const task = await t.mutation(
		internal.agentTranslationProposals.createTaskForAgent,
		{
			token: token.token,
			clientTaskKey: "Translate",
			collectionId,
			localeCode: "de",
			messageIds: ["line0"],
		},
	);
	const response = await t.fetch(
		`/api/agent/v1/translation-tasks/${task.taskId}/candidates`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ items: [{ messageId: "line0", value: "Zeile" }] }),
		},
	);
	expect(response.status).toBe(200);
	const submitted = (await response.json()) as {
		revisions: { revisionId: Id<"agentTranslationCandidateRevisions"> }[];
	};
	const revisionId = submitted.revisions[0]?.revisionId;
	if (!revisionId) throw new Error("Missing revision");
	const review = await owner.mutation(
		api.agentTranslationProposals.reviewCandidate,
		{ candidateRevisionId: revisionId, decision: { kind: "accept" } },
	);
	const original = await t.run((ctx) => ctx.db.get(revisionId));
	await expect(
		stranger.mutation(api.projectStructure.promote, {
			projectId,
			collectionId,
		}),
	).rejects.toThrow(/permissions/);
	const term = await owner.mutation(api.translationGuidance.saveTerm, {
		projectId,
		expectedRevision: 0,
		term: {
			kind: "untranslatable",
			sourceTerm: "Brickit",
			definition: "Product",
		},
	});
	await owner.mutation(api.translationGuidance.saveProjectVoiceGuide, {
		projectId,
		expectedRevision: term.revision,
		text: "Warm and concise",
		examples: [],
	});
	const destination = await owner.mutation(api.projectStructure.promote, {
		projectId,
		collectionId,
	});
	expect(
		await owner.mutation(api.projectStructure.promote, {
			projectId,
			collectionId,
		}),
	).toBe(destination);
	await expect(
		owner.mutation(api.managedContent.createMessage, {
			projectId,
			collectionId,
			key: "racing",
			sourceValue: "Race",
		}),
	).rejects.toThrow(/moving/);
	await expect(
		owner.mutation(api.agentTranslationProposals.reviewCandidate, {
			candidateRevisionId: revisionId,
			decision: { kind: "reject" },
		}),
	).rejects.toThrow(/moving/);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const guidance = await owner.query(api.translationGuidance.list, {
		projectId: destination,
	});
	expect(guidance.projectGuide?.text).toBe("Warm and concise");
	expect(guidance.terms[0]?.revisionId).toBe(term.revisionId);
	expect(
		(await owner.query(api.translationGuidance.list, { projectId })).dictionary
			?.id,
	).toBe(guidance.dictionary?.id);
	const moved = await owner.query(api.projects.get, { projectId: destination });
	expect(moved.type).toBe("basic");
	expect(moved.migrationPending).toBeUndefined();
	expect(moved.agentReviewPolicy).toBeUndefined();
	const locales = await owner.query(api.locales.list, {
		projectId: destination,
	});
	const de = locales.find((l) => l.code === "de");
	if (!de) throw new Error("Missing language");
	expect(de._id).not.toBe(localeId);
	expect(de.catalogPath).toBeUndefined();
	const page = await owner.query(api.managedContent.page, {
		projectId: destination,
		collectionId,
	});
	expect(page.items).toHaveLength(9);
	expect(
		page.items.find((item) => item.messageId === "line0")?.characterLimit,
	).toBe(20);
	const context = await owner.query(api.managedContent.context, {
		projectId: destination,
		collectionId,
		messageIds: ["line0"],
		localeIds: [de._id],
	});
	expect(context.items[0]?.value).toBe("Zeile");
	expect(context.items[0]?.valueState).toBe("settled");
	const revision = await t.run((ctx) => ctx.db.get(revisionId));
	expect(revision?.value).toBe(original?.value);
	expect(revision?.basis).toEqual(original?.basis);
	expect(revision?.createdBy).toEqual(original?.createdBy);
	expect(revision?.projectId).toBe(destination);
	expect(revision?.localeId).toBe(de._id);
	expect((await t.run((ctx) => ctx.db.get(review.reviewId)))?.projectId).toBe(
		destination,
	);
	await expect(
		t.query(internal.agentTranslationProposals.get, {
			token: token.token,
			proposalId: task.taskId,
		}),
	).rejects.toThrow();
	const newToken = await owner.mutation(api.apiTokens.create, {
		projectId: destination,
		name: "New translator",
		scopes: ["read", "propose"],
	});
	const continued = await t.query(internal.agentTranslationProposals.get, {
		token: newToken.token,
		proposalId: task.taskId,
	});
	expect(continued.proposalId).toBe(task.taskId);
	expect(
		(
			await owner.query(api.managedContent.page, {
				projectId,
				collectionId: retained,
			})
		).items[0]?.sourceValue,
	).toBe("Separate");
	expect(
		await owner.query(api.projectStructure.resolveLegacy, {
			projectId,
			collectionId,
		}),
	).toEqual({ projectId: destination, status: "complete" });
	expect(
		(await owner.query(api.projectStructure.listLegacy, { projectId })).find(
			(c) => c.collectionId === collectionId,
		)?.status,
	).toBe("complete");
});
