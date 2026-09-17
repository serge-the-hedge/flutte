import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { act } from "react";
import { StringsCatalogView } from "../components/localization/strings-catalog-view";
import { createDomTest } from "../test/dom";
import { type api, convexId } from "./convex-api";
import { useCatalogBrowsePage } from "./use-catalog-browse-page";

type BrowsePage = FunctionReturnType<typeof api.catalogBrowse.page>;
type BrowseArgs = FunctionArgs<typeof api.catalogBrowse.page>;
function result(
	nextAfter: number | null,
	messageId?: string,
	nextTargetIndex = 0,
): BrowsePage {
	return {
		stale: false,
		tagRevision: 0,
		nextAfter,
		nextTargetIndex: nextAfter === null ? null : nextTargetIndex,
		counts: { waiting: 0, unconfirmedImport: 0, stale: 0, settled: 0 },
		keys: messageId
			? [
					{
						messageId,
						catalogIndex: nextAfter ?? 130,
						searchCorpus: [],
						source: {
							localeId: convexId<"locales">("source"),
							gitValueFingerprint: "source-fingerprint",
						},
						pendingSourceProposal: false,
						introductionReviewPending: 0,
						targets: [],
					},
				]
			: [],
	};
}

describe("Strings sparse browse pages", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const responses = new Map<string, BrowsePage>();
	const callbacks = new Map<string, Set<() => void>>();
	const requests: { q: unknown; after: unknown }[] = [];
	const identity = (q: unknown, after: unknown, targetIndex: unknown = 0) =>
		`${String(q)}:${String(after)}:${String(targetIndex ?? 0)}`;
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(_query, args) => {
			const key = identity(args.q, args.after, args.scanTargetIndex);
			requests.push({ q: args.q, after: args.after });
			return {
				onUpdate: (callback: () => void) => {
					const listeners = callbacks.get(key) ?? new Set<() => void>();
					listeners.add(callback);
					callbacks.set(key, listeners);
					return () => {
						listeners.delete(callback);
					};
				},
				localQueryResult: () => responses.get(key),
				localQueryLogs: () => [],
				journal: () => undefined,
			};
		},
	);
	beforeEach(() => {
		responses.clear();
		callbacks.clear();
		requests.length = 0;
		watch.mockClear();
	});
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	function Harness({
		q = "first",
		after,
		revision,
		tagRevision,
		skip = false,
		localeIds,
		classificationRevision,
		scope,
		projection = "projection",
		project = "project",
		snapshotIds,
		expectedTagRevision,
		classificationGeneration,
	}: {
		q?: string;
		after?: number;
		revision?: number;
		tagRevision?: number;
		skip?: boolean;
		localeIds?: BrowseArgs["localeIds"];
		classificationRevision?: number;
		scope?: BrowseArgs["scope"];
		projection?: string;
		project?: string;
		snapshotIds?: BrowseArgs["introducedSnapshotIds"];
		expectedTagRevision?: number;
		classificationGeneration?: string;
	}) {
		const args: BrowseArgs = {
			projectId: convexId<"projects">(project),
			projectionId: convexId<"catalogProjections">(projection),
			q,
			after,
			localeIds,
			scope,
			introducedSnapshotIds: snapshotIds,
			expectedTagRevision,
		};
		const { page, isRefreshing } = useCatalogBrowsePage(skip ? "skip" : args, {
			content: revision,
			classification: classificationRevision,
			classificationGeneration,
			tags: tagRevision,
		});
		return (
			<output data-refreshing={isRefreshing}>
				{page === undefined ? "loading" : (page.keys[0]?.messageId ?? "empty")}{" "}
				· logical position {after ?? "start"}
			</output>
		);
	}
	const view = (
		q?: string,
		after?: number,
		revision?: number,
		skip = false,
		localeIds?: BrowseArgs["localeIds"],
		tagRevision?: number,
		options: Pick<
			Parameters<typeof Harness>[0],
			"classificationRevision" | "scope" | "projection"
		> = {},
	) => (
		<ConvexProvider client={client}>
			<Harness
				{...options}
				q={q}
				after={after}
				revision={revision}
				tagRevision={tagRevision}
				skip={skip}
				localeIds={localeIds}
			/>
		</ConvexProvider>
	);
	async function publish(
		q: string,
		after: number | undefined,
		page: BrowsePage,
		targetIndex = 0,
	) {
		await act(async () => {
			responses.set(identity(q, after, targetIndex), page);
			for (const callback of callbacks.get(identity(q, after, targetIndex)) ??
				[])
				callback();
		});
	}
	function EditorHarness({
		revision,
		classification = 1,
	}: {
		revision: number;
		classification?: number;
	}) {
		const { page } = useCatalogBrowsePage(
			{
				projectId: convexId<"projects">("project"),
				projectionId: convexId<"catalogProjections">("projection"),
				q: "",
				scope: "introduced",
			},
			{ content: revision, classification },
		);
		return (
			<StringsCatalogView
				navigation={
					page && !page.stale
						? {
								kind: "ready",
								projectionId: "projection",
								canEdit: true,
								keys: page.keys,
							}
						: undefined
				}
				hydratedCards={
					new Map([
						[
							"new-key",
							{
								id: "new-key",
								source: {
									localeId: "source",
									localeCode: "en",
									isSource: true,
									value: "Welcome",
									materialized: false,
									gitValueFingerprint: "source-fingerprint",
									gitValueRevision: 0,
									workspaceRevision: 0,
									expectedSourceFingerprint: "source-fingerprint",
								},
								targets: [],
							},
						],
					])
				}
				navigationState={{ query: "", scope: "introduced" }}
				onNavigationChange={() => {}}
				onConnectCheckout={() => {}}
				onWindowMessageIdsChange={() => {}}
				onCommitValue={async ({ basis }) => ({ basis })}
			/>
		);
	}

	test("a refresh preserves the real English editor, focus, and unsaved draft", async () => {
		responses.set(identity("", undefined), result(63));
		responses.set(identity("", 63), result(null, "new-key"));
		const editorView = (revision: number, classification = 1) => (
			<ConvexProvider client={client}>
				<EditorHarness revision={revision} classification={classification} />
			</ConvexProvider>
		);
		await dom.render(editorView(1));
		const field = dom.container.querySelector<
			HTMLInputElement | HTMLTextAreaElement
		>('[data-workspace-message-id="new-key"]');
		if (!field) throw new Error("English editor did not render");
		await act(async () => {
			field.focus();
			Object.getOwnPropertyDescriptor(
				field.tagName === "TEXTAREA"
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype,
				"value",
			)?.set?.call(field, "Still editing English");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		responses.delete(identity("", undefined));
		await dom.render(editorView(2));
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("Still editing English");
		await dom.render(editorView(2, 2));
		expect(
			dom.container.querySelector('[data-workspace-message-id="new-key"]'),
		).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("Still editing English");
		await publish("", undefined, result(null, "new-key"));
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("Still editing English");
	});

	test("scans empty responses until a match without changing the logical page", async () => {
		responses.set(identity("first", undefined), result(63));
		await dom.render(view());
		expect(dom.container.textContent).toBe("loading · logical position start");
		expect(requests).toContainEqual({ q: "first", after: 63 });
		await publish("first", 63, result(127));
		expect(dom.container.textContent).toBe("loading · logical position start");
		await publish("first", 127, result(191, "found"));
		expect(dom.container.textContent).toBe("found · logical position start");
		const count = requests.length;
		await dom.render(view());
		expect(requests).toHaveLength(count);
	});

	test("resumes targets within a key, then advances to the next key without skipping matches", async () => {
		responses.set(identity("first", undefined), result(-1, undefined, 4));
		await dom.render(view());
		expect(dom.container.textContent).toBe("loading · logical position start");
		await publish("first", -1, result(-1, undefined, 8), 4);
		expect(dom.container.textContent).toBe("loading · logical position start");
		await publish("first", -1, result(0), 8);
		await publish("first", 0, result(1, "later-target-match"));
		expect(dom.container.textContent).toBe(
			"later-target-match · logical position start",
		);
		// A displayed page ends on a completed key. URL Next can restart the
		// unfinished next key without carrying private target scan progress.
		responses.set(identity("first", 1), result(null, "next-key-match"));
		await dom.render(view("first", 1));
		expect(dom.container.textContent).toBe(
			"next-key-match · logical position 1",
		);
	});
	test("resets the scan for a new filter or logical position and ignores old updates", async () => {
		responses.set(identity("first", undefined), result(63));
		await dom.render(view());
		const oldCallbacks = [...(callbacks.get(identity("first", 63)) ?? [])];
		responses.set(identity("second", undefined), result(null, "new-filter"));
		await dom.render(view("second"));
		expect(dom.container.textContent).toBe(
			"new-filter · logical position start",
		);
		expect(requests).toContainEqual({ q: "second", after: undefined });
		await act(async () => {
			responses.set(identity("first", 63), result(127));
			for (const callback of oldCallbacks) callback();
		});
		expect(dom.container.textContent).toBe(
			"new-filter · logical position start",
		);
		responses.set(identity("second", 40), result(null, "new-position"));
		await dom.render(view("second", 40));
		expect(dom.container.textContent).toBe(
			"new-position · logical position 40",
		);
		expect(requests).toContainEqual({ q: "second", after: 40 });
		responses.set(
			identity("first", undefined),
			result(null, "returned-filter"),
		);
		await dom.render(view("first"));
		expect(dom.container.textContent).toBe(
			"returned-filter · logical position start",
		);
	});
	test("revisits a resolved search without repeating its empty scans", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null, "known-match"));
		responses.set(identity("second", undefined), result(null, "other-match"));
		await dom.render(view("first", undefined, 1));
		await dom.render(view("second", undefined, 1));
		requests.length = 0;
		await dom.render(view("first", undefined, 1));
		expect(dom.container.textContent).toBe(
			"known-match · logical position start",
		);
		expect(requests).not.toContainEqual({ q: "first", after: undefined });
		expect(requests).toContainEqual({ q: "first", after: 63 });
	});

	test("settles on an exhausted empty result", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null));
		await dom.render(view());
		expect(dom.container.textContent).toBe("empty · logical position start");
		const count = requests.length;
		await dom.render(view());
		expect(requests).toHaveLength(count);
	});
	test("restarts from the logical position when the catalog revision changes", async () => {
		responses.set(identity("first", undefined), result(-1, undefined, 4));
		responses.set(identity("first", -1, 4), result(null, "later-match"));
		await dom.render(view("first", undefined, 1));
		expect(dom.container.textContent).toBe(
			"later-match · logical position start",
		);
		responses.set(identity("first", undefined), result(null, "earlier-match"));
		await dom.render(view("first", undefined, 2));
		expect(dom.container.textContent).toBe(
			"earlier-match · logical position start",
		);
	});

	test("keeps New from Git's resolved scan when only English content changes", async () => {
		responses.set(identity("", undefined), result(63));
		responses.set(identity("", 63), result(null, "new-key"));
		const selection = {
			scope: "introduced" as const,
			classificationRevision: 7,
		};
		await dom.render(view("", undefined, 1, false, undefined, 0, selection));
		expect(dom.container.textContent).toBe("new-key · logical position start");
		requests.length = 0;
		responses.delete(identity("", undefined));
		await dom.render(view("", undefined, 2, false, undefined, 0, selection));
		expect(dom.container.textContent).toBe("new-key · logical position start");
		expect(requests).not.toContainEqual({ q: "", after: undefined });
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"false",
		);
	});

	test("keeps a key mounted during reclassification, then applies actual membership changes", async () => {
		responses.set(identity("", undefined), result(63));
		responses.set(identity("", 63), result(null, "new-key"));
		await dom.render(
			view("", undefined, 1, false, undefined, 0, {
				scope: "introduced",
				classificationRevision: 7,
			}),
		);
		responses.delete(identity("", undefined));
		await dom.render(
			view("", undefined, 2, false, undefined, 0, {
				scope: "introduced",
				classificationRevision: 8,
			}),
		);
		expect(dom.container.textContent).toBe("new-key · logical position start");
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"true",
		);
		expect(requests).toContainEqual({ q: "", after: undefined });
		await publish("", undefined, result(null));
		expect(dom.container.textContent).toBe("empty · logical position start");
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"false",
		);
	});

	test("keeps literal search's visible keys while finding newly matching earlier text", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null, "later-match"));
		await dom.render(view("first", undefined, 1));
		responses.delete(identity("first", undefined));
		await dom.render(view("first", undefined, 2));
		expect(dom.container.textContent).toBe(
			"later-match · logical position start",
		);
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"true",
		);
		await publish("first", undefined, result(null, "earlier-match"));
		expect(dom.container.textContent).toBe(
			"earlier-match · logical position start",
		);
	});

	test("never retains editable keys across a projection replacement or stale response", async () => {
		responses.set(identity("first", undefined), result(null, "old-key"));
		await dom.render(view("first", undefined, 1));
		responses.clear();
		await dom.render(
			view("first", undefined, 2, false, undefined, undefined, {
				projection: "replacement",
			}),
		);
		expect(dom.container.textContent).toBe("loading · logical position start");
		await publish("first", undefined, result(null, "new-key"));
		expect(dom.container.textContent).toBe("new-key · logical position start");
		await publish("first", undefined, { ...result(null), stale: true });
		expect(dom.container.textContent).toBe("empty · logical position start");
	});

	const changedSelections: Parameters<typeof Harness>[0][] = [
		{ project: "another-project" },
		{ projection: "another-snapshot" },
		{ q: "second" },
		{ scope: "waiting" as const },
		{ localeIds: [convexId<"locales">("ja")] },
		{ snapshotIds: [convexId<"sourceSnapshots">("snapshot-filter")] },
		{ after: 100 },
	];
	test.each(changedSelections)(
		"does not show the previous view while a different selection loads: %j",
		async (selection) => {
			responses.set(identity("first", undefined), result(null, "old-key"));
			await dom.render(view("first", undefined, 1));
			responses.clear();
			await dom.render(
				<ConvexProvider client={client}>
					<Harness q="first" revision={1} {...selection} />
				</ConvexProvider>,
			);
			expect(dom.container.textContent).toStartWith("loading");
		},
	);

	test("tag version and rebuilt classification generations refresh the same view without dropping it", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null, "tagged-key"));
		const retainedView = (
			expectedTagRevision: number,
			classificationGeneration = "generation-1",
		) => (
			<ConvexProvider client={client}>
				<Harness
					q="first"
					revision={1}
					expectedTagRevision={expectedTagRevision}
					classificationGeneration={classificationGeneration}
				/>
			</ConvexProvider>
		);
		await dom.render(retainedView(1));
		responses.delete(identity("first", undefined));
		await dom.render(retainedView(2));
		expect(dom.container.textContent).toBe(
			"tagged-key · logical position start",
		);
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"true",
		);
		await publish("first", 63, result(null, "updated-key"));
		await publish("first", undefined, result(63));
		expect(dom.container.textContent).toBe(
			"updated-key · logical position start",
		);
		requests.length = 0;
		responses.delete(identity("first", undefined));
		await dom.render(retainedView(2, "generation-2"));
		expect(requests).toContainEqual({ q: "first", after: undefined });
		expect(dom.container.textContent).toBe(
			"updated-key · logical position start",
		);
		expect(dom.container.querySelector("output")?.dataset.refreshing).toBe(
			"true",
		);
	});

	test("restarts a sparse tag scan when assignments change without a catalog revision", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null, "later-tagged"));
		await dom.render(view("first", undefined, 1, false, undefined, 1));
		expect(dom.container.textContent).toBe(
			"later-tagged · logical position start",
		);
		responses.set(
			identity("first", undefined),
			result(null, "newly-tagged-earlier"),
		);
		await dom.render(view("first", undefined, 1, false, undefined, 2));
		expect(dom.container.textContent).toBe(
			"newly-tagged-earlier · logical position start",
		);
	});

	test("restarts a partial target scan when selected languages change", async () => {
		const first = [convexId<"locales">("first-locale")];
		const second = [convexId<"locales">("second-locale")];
		responses.set(identity("first", undefined), result(-1, undefined, 4));
		responses.set(identity("first", -1, 4), result(null, "old-language"));
		await dom.render(view(undefined, undefined, undefined, false, first));
		expect(dom.container.textContent).toBe(
			"old-language · logical position start",
		);
		responses.set(identity("first", undefined), result(null, "new-language"));
		await dom.render(view(undefined, undefined, undefined, false, second));
		expect(dom.container.textContent).toBe(
			"new-language · logical position start",
		);
	});
	test("forgets a prior scan when reads pause and resume", async () => {
		responses.set(identity("first", undefined), result(63));
		responses.set(identity("first", 63), result(null, "later-match"));
		await dom.render(view());
		expect(dom.container.textContent).toBe(
			"later-match · logical position start",
		);
		await dom.render(view(undefined, undefined, undefined, true));
		expect(dom.container.textContent).toBe("loading · logical position start");
		responses.set(identity("first", undefined), result(null, "resumed"));
		await dom.render(view());
		expect(dom.container.textContent).toBe("resumed · logical position start");
	});
});
