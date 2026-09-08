import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { act } from "react";
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
		skip = false,
		localeIds,
	}: {
		q?: string;
		after?: number;
		revision?: number;
		skip?: boolean;
		localeIds?: BrowseArgs["localeIds"];
	}) {
		const args: BrowseArgs = {
			projectId: convexId<"projects">("project"),
			projectionId: convexId<"catalogProjections">("projection"),
			q,
			after,
			localeIds,
		};
		const page = useCatalogBrowsePage(skip ? "skip" : args, revision);
		return (
			<output>
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
	) => (
		<ConvexProvider client={client}>
			<Harness
				q={q}
				after={after}
				revision={revision}
				skip={skip}
				localeIds={localeIds}
			/>
		</ConvexProvider>
	);
	async function publish(
		q: string,
		after: number,
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
