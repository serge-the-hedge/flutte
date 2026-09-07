import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import de from "../fixtures/arb/intl_de.arb?raw";
import en from "../fixtures/arb/intl_en.arb?raw";
import es from "../fixtures/arb/intl_es.arb?raw";
import fr from "../fixtures/arb/intl_fr.arb?raw";
import ru from "../fixtures/arb/intl_ru.arb?raw";
import zh from "../fixtures/arb/intl_zh.arb?raw";
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
import { MAX_CATALOG_WORKSPACE_WINDOW_KEYS } from "./catalogWorkspaceNavigation";

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

describe("Catalog Workspace Window read", () => {
	let t: Backend;

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		t = createBackend({ transactionLimits: true });
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

	async function expectedProjectionId(
		user: AuthenticatedBackend,
		projectId: Id<"projects">,
	): Promise<Id<"catalogProjections">> {
		const read = await user.query(api.catalogWorkspaceNavigation.navigation, {
			projectId,
		});
		if (read.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		return read.projectionId;
	}

	test("returns the exact complete-read cards for requested subsets", async () => {
		const owner = await authenticatedBackend(t, "window-owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		// A translated head and an unconfirmed import coexist so the window
		// composes distinct states.
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
		const projectionId = await expectedProjectionId(owner, projectId);
		const complete = await readWorkspaceKeyCards(owner, projectId);
		// Requested order is preserved: reverse the Catalog Order.
		const requested = ["farewell", "greeting", "blank"];
		const windowCards = await owner.query(
			api.catalogWorkspaceNavigation.window,
			{ projectId, expectedProjectionId: projectionId, messageIds: requested },
		);
		expect(windowCards.map((card) => card.id)).toEqual(requested);
		for (const card of windowCards) {
			const legacy = complete.keys.find((key) => key.id === card.id);
			if (!legacy) throw new Error("Expected the key in the complete read.");
			expect(card).toEqual(legacy);
		}
		// The complete read keeps its catalog order regardless.
		expect(complete.keys.map((key) => key.id)).toEqual([
			"greeting",
			"farewell",
			"blank",
		]);
	});

	test("rejects duplicates, oversized windows, missing keys, and stale projections", async () => {
		const owner = await authenticatedBackend(t, "reject-owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		const projectionId = await expectedProjectionId(owner, projectId);
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: projectionId,
				messageIds: ["greeting", "greeting"],
			}),
		).rejects.toThrow("repeats a message identifier");
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: projectionId,
				messageIds: Array.from(
					{ length: MAX_CATALOG_WORKSPACE_WINDOW_KEYS + 1 },
					(_, index) => `key-${index}`,
				),
			}),
		).rejects.toThrow("capped at 32 keys");
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: projectionId,
				messageIds: ["not-a-key"],
			}),
		).rejects.toThrow("not an active Catalog key");
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId:
					"0000000099999catalogProjections" as Id<"catalogProjections">,
				messageIds: ["greeting"],
			}),
		).rejects.toThrow("no longer the active Baseline");
	});

	test("matches the complete read on a Brickit-sized window", async () => {
		const owner = await authenticatedBackend(t, "brickit-window");
		const projectId = await createProject(owner);
		const locales = await owner.query(api.locales.list, { projectId });
		const source = locales.find((locale) => locale.code === "en");
		if (!source) throw new Error("Expected the source Locale.");
		await owner.action(api.locales.bind, {
			localeId: source._id,
			catalogPath: "intl_en.arb",
		});
		for (const code of ["de", "es", "fr", "ru", "zh"]) {
			const id = await owner.mutation(api.locales.create, {
				projectId,
				code,
			});
			await owner.action(api.locales.bind, {
				localeId: id,
				catalogPath: `intl_${code}.arb`,
			});
		}
		await owner.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit: "baseline",
			files: [
				{ catalogPath: "intl_en.arb", content: en },
				{ catalogPath: "intl_de.arb", content: de },
				{ catalogPath: "intl_es.arb", content: es },
				{ catalogPath: "intl_fr.arb", content: fr },
				{ catalogPath: "intl_ru.arb", content: ru },
				{ catalogPath: "intl_zh.arb", content: zh },
			],
		});
		const navigation = await owner.query(
			api.catalogWorkspaceNavigation.navigation,
			{ projectId },
		);
		if (navigation.kind !== "ready") {
			throw new Error("Expected a ready Navigation read.");
		}
		expect(navigation.keys.length).toBeGreaterThan(32);
		const requested = navigation.keys.slice(0, 32).map((key) => key.messageId);
		const windowCards = await owner.query(
			api.catalogWorkspaceNavigation.window,
			{
				projectId,
				expectedProjectionId: navigation.projectionId,
				messageIds: requested,
			},
		);
		// The window preserves the Navigation Index order exactly.
		expect(windowCards.map((card) => card.id)).toEqual(requested);
		const payloadBytes = new TextEncoder().encode(
			JSON.stringify(windowCards),
		).length;
		expect(payloadBytes).toBeLessThan(1024 * 1024);
	});

	test("caps at 32 keys and refuses outsiders", async () => {
		const owner = await authenticatedBackend(t, "cap-owner");
		const projectId = await createProject(owner);
		await bindAndIngest(owner, projectId);
		const projectionId = await expectedProjectionId(owner, projectId);
		const outsider = await authenticatedBackend(t, "cap-outsider");
		await expect(
			outsider.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: projectionId,
				messageIds: ["greeting"],
			}),
		).rejects.toThrow("Insufficient project permissions");
		const keys = Array.from({ length: 32 }, (_, index) => `key-${index}`);
		await expect(
			owner.query(api.catalogWorkspaceNavigation.window, {
				projectId,
				expectedProjectionId: projectionId,
				messageIds: keys,
			}),
		).rejects.toThrow("not an active Catalog key");
	});
});
