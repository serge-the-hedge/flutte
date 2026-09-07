import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Ingestion stages the complete Catalog Navigation Index for each accepted
// generation, so the real-catalog tests budget for that bounded extra work.
vi.setConfig({ testTimeout: 120_000 });

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
} from "../test/support";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const catalogs = { en, de, es, fr, ru, zh } as const;
type LocaleCode = keyof typeof catalogs;
const localeCodes = Object.keys(catalogs) as LocaleCode[];

const REPOSITORY = "github.com/brickit-app/brickit-flutter";
const COMMIT = "4c6b65419";

function pathFor(code: LocaleCode) {
	return `packages/brickit_generated/lib/l10n/intl_${code}.arb`;
}

function allFiles() {
	return localeCodes.map((code) => ({
		catalogPath: pathFor(code),
		content: catalogs[code],
	}));
}

describe("source snapshot ingestion", () => {
	let t: Backend;

	beforeEach(() => {
		// Scheduled reclamation workers must never fire on real timers while
		// an ingest action is mid-flight: convex-test runs one function at a
		// time, and a timer callback interleaving with the action's storage
		// writes would crash the run. Freeze timers and drain explicitly.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		t = createBackend();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A project with all six Locales created and bound to their catalogs. */
	async function bindAllLocales(
		user: AuthenticatedBackend,
		projectId: Id<"projects">,
	) {
		for (const code of localeCodes) {
			const locales = await user.query(api.locales.list, { projectId });
			const existing = locales.find((locale) => locale.code === code);
			const localeId =
				existing?._id ??
				(await user.mutation(api.locales.create, { projectId, code }));
			await user.action(api.locales.bind, {
				localeId,
				catalogPath: pathFor(code),
			});
		}
	}

	async function boundProject(): Promise<{
		user: AuthenticatedBackend;
		projectId: Id<"projects">;
	}> {
		const user = await authenticatedBackend(t, "owner");
		const projectId = await createProject(user);
		await bindAllLocales(user, projectId);
		return { user, projectId };
	}

	async function ingest(
		user: AuthenticatedBackend,
		projectId: Id<"projects">,
		files = allFiles(),
		options: {
			commit?: string;
			lineage?: {
				baselineCommit: string;
				relationship: "ancestor" | "descendant" | "divergent";
				mergeBase: string;
			};
		} = {},
	) {
		return await user.action(api.snapshots.ingest, {
			projectId,
			repository: REPOSITORY,
			commit: options.commit ?? COMMIT,
			files,
			...(options.lineage ? { lineage: options.lineage } : {}),
		});
	}

	test("publishes a snapshot from the six real catalogs", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(user, projectId);

		expect(result.snapshotId).not.toBeNull();

		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run.status).toBe("succeeded");
		expect(run.diagnostics).toEqual([]);
		expect(run.commit).toBe(COMMIT);

		const snapshot = await user.query(api.snapshots.get, {
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			snapshotId: result.snapshotId!,
		});
		expect(snapshot.files).toHaveLength(6);
		expect(snapshot.repository).toBe(REPOSITORY);
	});

	test("makes the first Source Snapshot the Baseline Snapshot", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(user, projectId);
		const baseline = await user.query(api.snapshots.getBaseline, { projectId });

		expect(baseline?._id).toBe(result.snapshotId);
		expect(baseline?.kind).toBe("baseline");
	});

	test("advances the Baseline Snapshot only for reported descendants", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const descendant = await ingest(user, projectId, allFiles(), {
			commit: "descendant-commit",
			lineage: {
				baselineCommit: COMMIT,
				relationship: "descendant",
				mergeBase: COMMIT,
			},
		});
		const baseline = await user.query(api.snapshots.getBaseline, { projectId });

		expect(baseline?._id).toBe(descendant.snapshotId);
		expect(baseline?._id).not.toBe(first.snapshotId);
	});

	test.each(["ancestor", "divergent"] as const)(
		"retains a reported %s as a Preview Snapshot",
		async (relationship) => {
			const { user, projectId } = await boundProject();
			const first = await ingest(user, projectId);
			const candidate = await ingest(user, projectId, allFiles(), {
				commit: `${relationship}-commit`,
				lineage: {
					baselineCommit: COMMIT,
					relationship,
					mergeBase: "shared-commit",
				},
			});
			if (!candidate.snapshotId)
				throw new Error("Expected a Preview Snapshot.");

			const snapshot = await user.query(api.snapshots.get, {
				snapshotId: candidate.snapshotId,
			});
			expect(snapshot.kind).toBe("preview");
			expect(snapshot.lineage?.relationship).toBe(relationship);
			expect(snapshot.lineage?.mergeBase).toBe("shared-commit");
			expect(
				(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
			).toBe(first.snapshotId);
		},
	);

	test("retains an unreported relationship as a Preview Snapshot", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const candidate = await ingest(user, projectId, allFiles(), {
			commit: "unreported-commit",
		});
		if (!candidate.snapshotId) throw new Error("Expected a Preview Snapshot.");

		const snapshot = await user.query(api.snapshots.get, {
			snapshotId: candidate.snapshotId,
		});
		expect(snapshot.kind).toBe("preview");
		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(first.snapshotId);
	});

	test("does not advance from a lineage report against a stale baseline", async () => {
		const { user, projectId } = await boundProject();
		await ingest(user, projectId);
		const current = await ingest(user, projectId, allFiles(), {
			commit: "current-baseline",
			lineage: {
				baselineCommit: COMMIT,
				relationship: "descendant",
				mergeBase: COMMIT,
			},
		});
		const stale = await ingest(user, projectId, allFiles(), {
			commit: "stale-candidate",
			lineage: {
				baselineCommit: COMMIT,
				relationship: "descendant",
				mergeBase: COMMIT,
			},
		});

		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(current.snapshotId);
		const staleSnapshot = await user.query(api.snapshots.get, {
			// biome-ignore lint/style/noNonNullAssertion: successful ingest asserted by the baseline behavior
			snapshotId: stale.snapshotId!,
		});
		expect(staleSnapshot.kind).toBe("preview");
	});

	test("advances an existing Preview Snapshot when lineage is reported later", async () => {
		const { user, projectId } = await boundProject();
		await ingest(user, projectId);
		const preview = await ingest(user, projectId, allFiles(), {
			commit: "later-reported",
		});
		const resumed = await ingest(user, projectId, allFiles(), {
			commit: "later-reported",
			lineage: {
				baselineCommit: COMMIT,
				relationship: "descendant",
				mergeBase: COMMIT,
			},
		});

		expect(resumed).toEqual(preview);
		expect(
			(await user.query(api.snapshots.getBaseline, { projectId }))?._id,
		).toBe(preview.snapshotId);
	});

	test.each(localeCodes)(
		"stores intl_%s.arb byte for byte",
		async (code: LocaleCode) => {
			const { user, projectId } = await boundProject();
			const result = await ingest(user, projectId);
			const text = await user.action(api.snapshots.catalogText, {
				// biome-ignore lint/style/noNonNullAssertion: ingest succeeded
				snapshotId: result.snapshotId!,
				localeCode: code,
			});
			expect(text).toBe(catalogs[code]);
		},
	);

	test("returns the existing run for the same snapshot identity", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const second = await ingest(user, projectId, [...allFiles()].reverse());

		expect(second).toEqual(first);
		expect(await user.query(api.snapshots.list, { projectId })).toHaveLength(1);
	});

	test("treats exact byte differences as a distinct snapshot identity", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const changed = allFiles().map((file) =>
			file.catalogPath === pathFor("de")
				? { ...file, content: ` ${file.content}` }
				: file,
		);
		const second = await ingest(user, projectId, changed);

		expect(second.runId).not.toBe(first.runId);
		expect(second.snapshotId).not.toBe(first.snapshotId);
		expect(await user.query(api.snapshots.list, { projectId })).toHaveLength(2);
	});

	test("treats the same files at a different commit as a distinct identity", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const second = await user.action(api.snapshots.ingest, {
			projectId,
			repository: REPOSITORY,
			commit: "next-commit",
			files: allFiles(),
		});

		expect(second.runId).not.toBe(first.runId);
		expect(second.snapshotId).not.toBe(first.snapshotId);
	});

	test("treats the same commit and files in another repository as distinct", async () => {
		const { user, projectId } = await boundProject();
		const first = await ingest(user, projectId);
		const second = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "github.com/brickit-app/brickit-school",
			commit: COMMIT,
			files: allFiles(),
		});

		expect(second.runId).not.toBe(first.runId);
		expect(second.snapshotId).not.toBe(first.snapshotId);
	});

	test("resumes a failed run for the same snapshot identity", async () => {
		const user = await authenticatedBackend(t, "owner-resume");
		const projectId = await createProject(user);
		const failed = await ingest(user, projectId);
		expect(failed.snapshotId).toBeNull();

		await bindAllLocales(user, projectId);

		const retried = await ingest(user, projectId);
		expect(retried.runId).toBe(failed.runId);
		expect(retried.snapshotId).not.toBeNull();
		const run = await user.query(api.snapshots.getRun, {
			runId: retried.runId,
		});
		expect(run.status).toBe("succeeded");
		expect(run.diagnostics).toEqual([]);
		expect(await user.query(api.snapshots.list, { projectId })).toHaveLength(1);
	});

	test("refuses a catalog that does not parse, naming the file and the position", async () => {
		const { user, projectId } = await boundProject();
		const broken = allFiles().map((file) =>
			file.catalogPath === pathFor("de")
				? { ...file, content: '{\n  "@@locale": "de",\n  "a": "1"\n' }
				: file,
		);
		const result = await ingest(user, projectId, broken);

		expect(result.snapshotId).toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run.status).toBe("failed");
		expect(run.diagnostics).toHaveLength(1);
		expect(run.diagnostics[0]?.catalogPath).toBe(pathFor("de"));
		expect(run.diagnostics[0]?.message).toMatch(/line \d+ column \d+/);
	});

	test("refuses a catalog whose @@locale disagrees with its binding, naming both", async () => {
		const { user, projectId } = await boundProject();
		// German content bound to the French path: the file says "de", the
		// binding says "fr".
		const swapped = allFiles().map((file) =>
			file.catalogPath === pathFor("fr") ? { ...file, content: de } : file,
		);
		const result = await ingest(user, projectId, swapped);

		expect(result.snapshotId).toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		const message = run.diagnostics[0]?.message ?? "";
		expect(message).toContain("fr");
		expect(message).toContain("de");
	});

	test("a failed ingest leaves no snapshot behind", async () => {
		const { user, projectId } = await boundProject();
		await ingest(
			user,
			projectId,
			allFiles().map((file) =>
				file.catalogPath === pathFor("de") ? { ...file, content: "{" } : file,
			),
		);

		expect(await user.query(api.snapshots.list, { projectId })).toEqual([]);
	});

	test("records an omitted bound target Locale as Snapshot evidence", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(
			user,
			projectId,
			allFiles().filter((file) => file.catalogPath !== pathFor("ru")),
		);

		expect(result.snapshotId).not.toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run.status).toBe("succeeded");
		expect(run.diagnostics).toEqual([]);
		if (!result.snapshotId) throw new Error("Expected a Source Snapshot.");
		const snapshot = await user.query(api.snapshots.get, {
			snapshotId: result.snapshotId,
		});
		expect(snapshot.absentTargetLocales).toEqual([
			expect.objectContaining({ localeCode: "ru", catalogPath: pathFor("ru") }),
		]);
	});

	test("refuses a submission that omits the bound source Locale", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(
			user,
			projectId,
			allFiles().filter((file) => file.catalogPath !== pathFor("en")),
		);

		expect(result.snapshotId).toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run.diagnostics[0]?.message).toContain(pathFor("en"));
	});

	test("records an unbound Locale file as setup evidence without failing the Snapshot", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(user, projectId, [
			...allFiles(),
			{ catalogPath: "lib/l10n/intl_it.arb", content: '{"@@locale":"it"}' },
		]);

		expect(result.snapshotId).not.toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run).toMatchObject({ status: "succeeded", diagnostics: [] });
		if (!result.snapshotId) throw new Error("Expected a Source Snapshot.");
		expect(
			(await user.query(api.snapshots.get, { snapshotId: result.snapshotId }))
				.unboundLocaleFiles,
		).toEqual([
			expect.objectContaining({
				catalogPath: "lib/l10n/intl_it.arb",
				declaredLocaleCode: "it",
				messageCount: 0,
			}),
		]);
	});

	test("refuses duplicate files for one Locale", async () => {
		const { user, projectId } = await boundProject();
		const duplicate = allFiles()[0];
		const result = await ingest(user, projectId, [
			...allFiles(),
			// biome-ignore lint/style/noNonNullAssertion: the real fixture set is non-empty
			duplicate!,
		]);

		expect(result.snapshotId).toBeNull();
		const run = await user.query(api.snapshots.getRun, { runId: result.runId });
		expect(run.diagnostics[0]?.message).toContain("More than one file");
	});

	test("refuses a submission with no files at all", async () => {
		const { user, projectId } = await boundProject();
		const result = await ingest(user, projectId, []);
		expect(result.snapshotId).toBeNull();
	});

	test("someone outside the project cannot ingest", async () => {
		const { projectId } = await boundProject();
		const outsider = await authenticatedBackend(t, "outsider");
		await expect(ingest(outsider, projectId)).rejects.toThrow();
	});
});
