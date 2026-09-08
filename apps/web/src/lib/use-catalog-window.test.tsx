import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { Component, type ReactNode } from "react";
import { createDomTest } from "../test/dom";
import { type api, convexId } from "./convex-api";
import { useCatalogWindow } from "./use-catalog-window";

describe("Catalog Window subscriptions", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const result: never[] = [];
	const watch = spyOn(client, "watchQuery").mockImplementation(() => ({
		onUpdate: () => () => {},
		localQueryResult: () => result,
		localQueryLogs: () => [],
		journal: () => undefined,
	}));
	afterEach(() => watch.mockClear());
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	function Harness({
		skip = false,
		messageIds = ["greeting"],
	}: {
		skip?: boolean;
		messageIds?: string[];
	}) {
		const args = {
			projectId: "project",
			expectedProjectionId: "projection",
			messageIds,
		} as FunctionArgs<typeof api.catalogWorkspaceNavigation.window>;
		const { cards: values } = useCatalogWindow(skip ? "skip" : args);
		return (
			<output>
				{values === undefined ? "loading" : `${values.length} cards`}
			</output>
		);
	}
	test("retains subscriptions when callers recreate equal window arguments", async () => {
		await dom.render(
			<ConvexProvider client={client}>
				<Harness />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("0 cards");
		await dom.render(
			<ConvexProvider client={client}>
				<Harness />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("0 cards");
	});
	test("can pause and resume window subscriptions", async () => {
		await dom.render(
			<ConvexProvider client={client}>
				<Harness skip />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("loading");
		await dom.render(
			<ConvexProvider client={client}>
				<Harness />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("0 cards");
		await dom.render(
			<ConvexProvider client={client}>
				<Harness skip />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("loading");
	});
	test("settles after splitting a server-rejected window", async () => {
		watch.mockImplementation((_query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () => {
				if (Array.isArray(args.messageIds) && args.messageIds.length > 1)
					throw new ConvexError({ code: "WINDOW_TOO_LARGE" });
				return result;
			},
			localQueryLogs: () => [],
			journal: () => undefined,
		}));
		await dom.render(
			<ConvexProvider client={client}>
				<Harness messageIds={["greeting", "farewell"]} />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toBe("0 cards");
	});
});

describe("progressive language windows", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	type Args = FunctionArgs<typeof api.catalogWorkspaceNavigation.window>;
	type Result = import("./catalog-window-requests").CatalogWindowResult;
	const responses = new Map<string, Result | Error>();
	const callbacks = new Map<string, Set<() => void>>();
	const requests = new Map<string, Args>();
	const keyFor = (args: Args) =>
		JSON.stringify([args.messageIds, args.localeIds]);
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(_query, raw) => {
			const args = raw as Args;
			const key = keyFor(args);
			requests.set(key, args);
			return {
				onUpdate: (callback) => {
					const set = callbacks.get(key) ?? new Set();
					set.add(callback);
					callbacks.set(key, set);
					return () => {
						set.delete(callback);
					};
				},
				localQueryResult: () => {
					const result = responses.get(key);
					if (result instanceof Error) throw result;
					return result;
				},
				localQueryLogs: () => [],
				journal: () => undefined,
			};
		},
	);
	afterEach(() => {
		responses.clear();
		callbacks.clear();
		requests.clear();
		watch.mockClear();
	});
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	function cards(args: Args, sourceRevision = 0): Result {
		return [...args.messageIds].reverse().map((id) => ({
			id,
			icuType: "plain",
			messageSignature: {
				declaredPlaceholderNames: [],
				declaredPlaceholderNamesComplete: true,
				declaredPlaceholderNameCount: 0,
				argumentNames: args.localeIds?.map(String) ?? [],
				argumentNamesComplete: true,
			},
			values: ["source", ...(args.localeIds ?? [])].map((localeId) => ({
				localeId: convexId<"locales">(localeId),
				localeCode: localeId,
				isSource: localeId === "source",
				value: `${id}:${localeId}`,
				catalogPath: `${localeId}.arb`,
				sourceFingerprint: String(sourceRevision),
				icuType: "plain",
				argumentNamesComplete: true,
				argumentNameCount: 0,
				snapshotId: convexId<"sourceSnapshots">("snapshot"),
				valueState: "settled" as const,
				materialized: true,
				gitValueFingerprint: "git",
				gitValueRevision: 0,
				workspaceRevision: sourceRevision,
				expectedSourceFingerprint: String(sourceRevision),
			})),
		}));
	}
	function Harness({
		locales,
		ids = ["b", "a"],
		skip = false,
	}: {
		locales: string[];
		ids?: string[];
		skip?: boolean;
	}) {
		const result = useCatalogWindow(
			skip
				? "skip"
				: ({
						projectId: "project",
						expectedProjectionId: "projection",
						messageIds: ids,
						localeIds: locales,
					} as Args),
		);
		return (
			<output>
				{JSON.stringify({
					loading: result.isLoading,
					cards: result.cards?.map((card) => ({
						id: card.id,
						locales: card.values.map((value) => value.localeId),
						args: card.messageSignature.argumentNames,
						complete: card.messageSignature.argumentNamesComplete,
					})),
				})}
			</output>
		);
	}
	async function render(locales: string[], skip = false) {
		await dom.render(
			<ConvexProvider client={client}>
				<Harness locales={locales} skip={skip} />
			</ConvexProvider>,
		);
	}
	async function respond(key: string, result: Result | Error) {
		const { act } = await import("react");
		await act(async () => {
			responses.set(key, result);
			for (const callback of callbacks.get(key) ?? []) callback();
		});
	}
	test("limits pending fanout, merges in requested order, and keeps completed batches reactive", async () => {
		const locales = Array.from({ length: 21 }, (_, index) => `locale${index}`);
		await render(locales);
		expect(requests.size).toBe(4);
		const first = [...requests.entries()][0];
		if (!first) throw new Error("Expected request");
		await respond(first[0], cards(first[1]));
		expect(requests.size).toBe(5);
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual({
			loading: true,
			cards: ["b", "a"].map((id) => ({
				id,
				locales: ["source", ...locales.slice(0, 4)],
				args: locales.slice(0, 4),
				complete: false,
			})),
		});
		for (const [key, args] of requests)
			if (!responses.has(key)) await respond(key, cards(args));
		expect(requests.size).toBe(6);
		const completed = JSON.parse(dom.container.textContent ?? "{}");
		expect(completed.loading).toBe(false);
		expect(completed.cards[0].locales).toEqual(["source", ...locales]);
		expect(completed.cards[0].args).toEqual(locales);
		const count = watch.mock.calls.length;
		await render([...locales]);
		expect(watch.mock.calls.length).toBe(count);
		await respond(first[0], cards(first[1], 1));
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual({
			loading: true,
			cards: [],
		});
		for (const [key, args] of requests)
			if (key !== first[0]) await respond(key, cards(args, 1));
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual(completed);
		await render(["different"]);
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual({
			loading: true,
		});
		await render(["different"], true);
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual({
			loading: false,
		});
	});
	test("splits failed key windows and then language windows until one-by-one responses fit", async () => {
		await render(["de", "fr"]);
		for (const [key, args] of requests) {
			if (args.messageIds.length > 1 || (args.localeIds?.length ?? 0) > 1)
				await respond(key, new ConvexError({ code: "WINDOW_TOO_LARGE" }));
			else await respond(key, cards(args));
		}
		expect(JSON.parse(dom.container.textContent ?? "{}")).toEqual({
			loading: false,
			cards: ["b", "a"].map((id) => ({
				id,
				locales: ["source", "de", "fr"],
				args: ["de", "fr"],
				complete: true,
			})),
		});
	});
	class ErrorBoundary extends Component<
		{ children: ReactNode },
		{ error: Error | null }
	> {
		state = { error: null as Error | null };
		static getDerivedStateFromError(error: Error) {
			return { error };
		}
		render() {
			return this.state.error ? (
				<output>{this.state.error.message}</output>
			) : (
				this.props.children
			);
		}
	}
	test("passes unexpected subscription errors to the route error boundary", async () => {
		const error = new Error("Permission revoked");
		const args = {
			projectId: "project",
			expectedProjectionId: "projection",
			messageIds: ["b", "a"],
			localeIds: ["de"],
		} as Args;
		responses.set(keyFor(args), error);
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			await dom.render(
				<ConvexProvider client={client}>
					<ErrorBoundary>
						<Harness locales={["de"]} />
					</ErrorBoundary>
				</ConvexProvider>,
			);
			expect(dom.container.textContent).toBe("Permission revoked");
		} finally {
			log.mockRestore();
		}
	});
});
