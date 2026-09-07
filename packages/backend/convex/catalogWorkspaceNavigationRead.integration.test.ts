import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

// Scheduled reclamation workers must never fire on real timers while an
// ingest action is mid-flight; see snapshots.integration.test.ts.
vi.setConfig({ testTimeout: 120_000 });

const ENGLISH = JSON.stringify({
	"@@locale": "en",
	greeting: "Hello {name}",
	farewell: "Goodbye",
	blank: "",
});
const GERMAN = JSON.stringify({
	"@@locale": "de",
	greeting: "Hallo {name}",
	farewell: "Tschüss",
	blank: "",
});

describe("Catalog Workspace Navigation read", () => {
	let t: Backend;

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		t = createBackend();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function bindAndIngest(
		user: AuthenticatedBackend,
		projectId: Id<"projects">,
	): Promise<void> {
		const locales = await user.query(api.locales.list, { projectId });
		const source = locales.find((locale) => locale.code === "en");
		if (!source) throw new Error("Expected the source Locale.");
		await user.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "en.arb",
		});
		const de = await user.mutation(api.locales.create, {
			projectId,
			code: "de",
		});
		await user.action(api.locales.bind, {
			localeId: de,
			catalogPath: "de.arb",
		});
		await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "en.arb", content: ENGLISH },
				{ catalogPath: "de.arb", content: GERMAN },
			],
		});
	}

	test("reports an explicit noBaseline state before any Baseline exists", async () => {
		const user = await authenticatedBackend(t, "reader");
		const projectId = await createProject(user);
		const read = await user.query(api.catalogWorkspaceNavigation.navigation, {
			projectId,
		});
		expect(read).toEqual({ kind: "noBaseline" });
	});

	test("refuses outsiders and reports capability per role", async () => {
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		const outsider = await authenticatedBackend(t, "outsider");
		await expect(
			outsider.query(api.catalogWorkspaceNavigation.navigation, { projectId }),
		).rejects.toThrow("Insufficient project permissions");
		const viewer = await authenticatedBackend(t, "viewer");
		await t.run(async (ctx) => {
			await ctx.db.insert("projectMembers", {
				projectId,
				userId: "viewer",
				role: "viewer",
				createdAt: Date.now(),
			});
		});
		const viewerRead = await viewer.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		expect(viewerRead.kind).toBe("ready");
		if (viewerRead.kind !== "ready") throw new Error("unreachable");
		expect(viewerRead.canEdit).toBe(false);
		const editor = await authenticatedBackend(t, "editor");
		await t.run(async (ctx) => {
			await ctx.db.insert("projectMembers", {
				projectId,
				userId: "editor",
				role: "editor",
				createdAt: Date.now(),
			});
		});
		const editorRead = await editor.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		expect(editorRead.kind).toBe("ready");
		if (editorRead.kind !== "ready") throw new Error("unreachable");
		expect(editorRead.canEdit).toBe(true);
	});

	test("matches the complete read for counts and per-key state facts", async () => {
		const owner = await authenticatedBackend(t, "parity-owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		// One untouched import and one translated head produce distinct states.
		const locales = await owner.query(api.locales.list, { projectId });
		const de = locales.find((locale) => locale.code === "de");
		if (!de) throw new Error("Expected the German Locale.");
		const before = await readWorkspaceKeyCards(owner, projectId);
		const greetingKey = before.keys.find((key) => key.id === "greeting");
		const german = greetingKey?.values.find(
			(value) => value.localeId === de._id,
		);
		if (!german || german.isSource) {
			throw new Error("Expected the German greeting value.");
		}
		await owner.mutation(api.catalogWorkspace.commit, {
			projectId,
			localeId: de._id,
			messageId: "greeting",
			intent: { kind: "save", value: "Hallo auch {name}" },
			expectedGitValueFingerprint: german.gitValueFingerprint ?? "",
			expectedGitValueRevision: german.gitValueRevision,
			expectedWorkspaceRevision: german.workspaceRevision,
			...(german.expectedSourceFingerprint === undefined
				? {}
				: { expectedSourceFingerprint: german.expectedSourceFingerprint }),
		});
		const navigation = await owner.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		const workspace = await readWorkspaceKeyCards(owner, projectId);
		// Whole-workspace counts come from the same target states.
		expect(navigation.valueStateCounts).toEqual(workspace.valueStateCounts);
		// Exactly one digest per active key, in Catalog Order.
		expect(navigation.keys).toHaveLength(workspace.keys.length);
		expect(navigation.keys.map((key) => key.catalogIndex)).toEqual(
			navigation.keys.map((_, index) => index),
		);
		for (const [index, key] of workspace.keys.entries()) {
			const digest = navigation.keys[index];
			expect(digest.messageId).toBe(key.id);
			expect(digest.targets).toHaveLength(key.values.length - 1);
			const workspaceTargets = key.values.filter((value) => !value.isSource);
			for (const [targetIndex, target] of digest.targets.entries()) {
				const workspaceTarget = workspaceTargets[targetIndex];
				expect(target.localeId).toBe(workspaceTarget.localeId);
				expect("valueFingerprint" in target).toBe(false);
				if (!("valueState" in workspaceTarget)) {
					throw new Error("Expected a target value state.");
				}
				expect(target.valueState).toBe(workspaceTarget.valueState);
			}
		}
		// The digest carries identity and search facts, never values.
		const greeting = navigation.keys.find(
			(key) => key.messageId === "greeting",
		);
		if (!greeting) throw new Error("Expected the greeting digest.");
		expect(greeting.searchCorpus).toContain("hallo auch {name}");
		expect(JSON.stringify(greeting)).not.toContain("Hallo auch {name}");
		expect(navigation.ordinaryImports.total).toBe(3);
		expect(navigation.envelope.rowCount).toBe(navigation.keys.length);
	});

	test("reports an explicit incomplete index while it is not ready", async () => {
		const owner = await authenticatedBackend(t, "incomplete-owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("catalogWorkspaceNavigationStates")
				.withIndex("by_project", (q) => q.eq("projectId", projectId))
				.unique();
			if (!state) throw new Error("Expected a Navigation envelope.");
			await ctx.db.patch(state._id, { status: "staging" });
		});
		const read = await owner.query(api.catalogWorkspaceNavigation.navigation, {
			projectId,
		});
		expect(read.kind).toBe("incomplete");
		if (read.kind !== "incomplete") throw new Error("unreachable");
		expect(read.canEdit).toBe(true);
		expect(read.progress).toMatchObject({ rowCount: 3, expectedRowCount: 3 });
		expect(read.snapshotId).not.toBeNull();
	});
});
