import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

test("large edited catalogs request smaller windows while individual complete keys remain readable", async () => {
	const t = createBackend();
	const user = await authenticatedBackend(t, "large-window-owner");
	const projectId = await createProject(user);
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Expected Source Locale");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	const files = [
		{
			catalogPath: "en.arb",
			content: JSON.stringify({
				"@@locale": "en",
				first: "First",
				second: "Second",
			}),
		},
	];
	for (const code of ["de", "es", "fr", "ru", "zh", "pt", "it", "ja", "ko"]) {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code,
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
		files.push({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				first: `${code} first ${"a".repeat(180_000)}`,
				second: `${code} second ${"b".repeat(180_000)}`,
			}),
		});
	}
	const ingested = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "large",
		files,
	});
	expect(ingested.snapshotId).not.toBeNull();
	const navigation = await user.query(
		api.catalogWorkspaceNavigation.navigation,
		{ projectId },
	);
	if (navigation.kind !== "ready") throw new Error("Expected ready Navigation");
	const args = {
		projectId,
		expectedProjectionId: navigation.projectionId,
		messageIds: ["first", "second"],
	};
	const initial = await user.query(api.catalogWorkspaceNavigation.window, args);
	for (const key of initial) {
		for (const value of key.values) {
			if (
				value.isSource ||
				value.gitValueFingerprint === undefined ||
				value.gitValueRevision === undefined ||
				value.expectedSourceFingerprint === undefined
			)
				continue;
			await user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: key.id,
				localeId: value.localeId,
				intent: { kind: "save", value: `Revised ${value.value}` },
				expectedGitValueFingerprint: value.gitValueFingerprint,
				expectedGitValueRevision: value.gitValueRevision,
				expectedWorkspaceRevision: value.workspaceRevision,
				expectedSourceFingerprint: value.expectedSourceFingerprint,
			});
		}
	}
	await expect(
		user.query(api.catalogWorkspaceNavigation.window, args),
	).rejects.toThrow("Request fewer keys");
	for (const messageId of args.messageIds) {
		const [key] = await user.query(api.catalogWorkspaceNavigation.window, {
			...args,
			messageIds: [messageId],
		});
		expect(key?.values).toHaveLength(10);
		expect(
			key?.values
				.filter((value) => !value.isSource)
				.every((value) => value.value.startsWith("Revised ")),
		).toBe(true);
	}
}, 60_000);

test("archived Locale heads awaiting reconciliation do not block replacement Locale edits or Navigation staging", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	const t = createBackend();
	const user = await authenticatedBackend(t, "replacement-locales-owner");
	const projectId = await createProject(user);
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Expected Source Locale");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "en.arb",
	});
	const sourceFile = {
		catalogPath: "en.arb",
		content: '{"@@locale":"en","greeting":"Hello"}',
	};
	const codes = ["de", "es", "fr", "ru", "zh", "pt", "it", "ja", "ko"];
	const localeIds = new Map<string, typeof source._id>();
	for (const code of codes) {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code,
		});
		localeIds.set(code, localeId);
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	}
	const filesFor = (targets: string[]) => [
		sourceFile,
		...targets.map((code) => ({
			catalogPath: `${code}.arb`,
			content: JSON.stringify({
				"@@locale": code,
				greeting: `${code} greeting`,
			}),
		})),
	];
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "baseline",
		files: filesFor(codes),
	});
	const saveTargets = async (targetCodes: string[]) => {
		const navigation = await user.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") throw new Error("Expected Navigation");
		const [key] = await user.query(api.catalogWorkspaceNavigation.window, {
			projectId,
			expectedProjectionId: navigation.projectionId,
			messageIds: ["greeting"],
		});
		for (const value of key?.values ?? []) {
			if (
				value.isSource ||
				!targetCodes.includes(value.localeCode) ||
				value.gitValueFingerprint === undefined ||
				value.gitValueRevision === undefined ||
				value.expectedSourceFingerprint === undefined
			)
				continue;
			await user.mutation(api.catalogWorkspace.commit, {
				projectId,
				messageId: "greeting",
				localeId: value.localeId,
				intent: { kind: "save", value: `Reviewed ${value.localeCode}` },
				expectedGitValueFingerprint: value.gitValueFingerprint,
				expectedGitValueRevision: value.gitValueRevision,
				expectedWorkspaceRevision: value.workspaceRevision,
				expectedSourceFingerprint: value.expectedSourceFingerprint,
			});
		}
	};
	await saveTargets(codes);
	for (const code of ["de", "es"]) {
		const localeId = localeIds.get(code);
		if (!localeId) throw new Error("Missing replaced Locale");
		await user.mutation(api.locales.archive, { localeId });
	}
	for (const code of ["nl", "sv"]) {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code,
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: `${code}.arb`,
		});
	}
	const replacements = [...codes.slice(2), "nl", "sv"];
	await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "replaced",
		lineage: {
			baselineCommit: "baseline",
			relationship: "descendant",
			mergeBase: "baseline",
		},
		files: filesFor(replacements),
	});
	// Background cleanup is deliberately still queued: these valid historical
	// heads must not count as active Locale rows while current edits proceed.
	await saveTargets(["nl", "sv"]);
	expect(
		await t.run((ctx) => ctx.db.query("catalogWorkspaceValueHeads").collect()),
	).toHaveLength(11);
	const next = await user.action(api.snapshots.ingest, {
		projectId,
		repository: "repo",
		commit: "next",
		lineage: {
			baselineCommit: "replaced",
			relationship: "descendant",
			mergeBase: "replaced",
		},
		files: filesFor(replacements),
	});
	expect(next.snapshotId).not.toBeNull();
	expect(
		await user.query(api.catalogWorkspaceNavigation.navigation, { projectId }),
	).toMatchObject({ kind: "ready" });
});
