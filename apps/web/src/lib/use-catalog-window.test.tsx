import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { createDomTest } from "../test/dom";
import type { api } from "./convex-api";
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
		const values = useCatalogWindow(skip ? "skip" : args);
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
