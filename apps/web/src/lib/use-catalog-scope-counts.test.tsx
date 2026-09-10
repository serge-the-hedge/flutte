import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { act } from "react";
import { createDomTest } from "../test/dom";
import { type api, convexId } from "./convex-api";
import { useCatalogScopeCounts } from "./use-catalog-scope-counts";

type Page = FunctionReturnType<typeof api.catalogBrowse.scopeCounts>;
const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
const requests: {
	resolve: (page: Page) => void;
	localeIds: unknown;
	revision: unknown;
	cursor: unknown;
}[] = [];
const query = spyOn(client, "query").mockImplementation(
	(_query, args) =>
		new Promise<Page>((resolve) => {
			requests.push({
				resolve,
				localeIds: args.localeIds,
				revision: args.revision,
				cursor: args.cursor,
			});
		}),
);
beforeEach(() => {
	requests.length = 0;
	query.mockClear();
});
afterAll(async () => {
	query.mockRestore();
	await client.close();
});
function Harness({
	locale = "de",
	revision = 1,
	focus = "all",
}: {
	locale?: string;
	revision?: number;
	focus?: string;
}) {
	const counts = useCatalogScopeCounts({
		projectId: convexId<"projects">("project"),
		projectionId: convexId<"catalogProjections">("projection"),
		localeIds: [convexId<"locales">(locale)],
		revision,
	});
	return (
		<output>
			{focus}:{" "}
			{counts
				? `${counts.waiting} waiting, ${counts.introduced} introduced`
				: "counting"}
		</output>
	);
}
const view = (props: Parameters<typeof Harness>[0] = {}) => (
	<ConvexProvider client={client}>
		<Harness {...props} />
	</ConvexProvider>
);
const page = (
	waiting: number,
	introduced: number,
	cursor: string | null = null,
): Page => ({
	stale: false,
	counts: { waiting, introduced, unconfirmedImport: 0, stale: 0, settled: 0 },
	cursor,
});

test("totals all pages once and keeps the totals when focus changes", async () => {
	await dom.render(view());
	expect(dom.container.textContent).toContain("counting");
	await act(async () => requests[0]?.resolve(page(64, 0, "next")));
	expect(dom.container.textContent).toContain("counting");
	expect(requests[1]?.cursor).toBe("next");
	await act(async () => requests[1]?.resolve(page(17, 7)));
	expect(dom.container.textContent).toContain("81 waiting, 7 introduced");
	await dom.render(view({ focus: "introduced" }));
	expect(dom.container.textContent).toContain("81 waiting, 7 introduced");
	expect(query).toHaveBeenCalledTimes(2);
});

test("discards incomplete counts when languages or catalog revision change", async () => {
	await dom.render(view());
	await act(async () => requests[0]?.resolve(page(64, 0, "next")));
	await dom.render(view({ locale: "ja" }));
	await act(async () => requests[1]?.resolve(page(17, 7)));
	expect(dom.container.textContent).toContain("counting");
	await act(async () => requests[2]?.resolve(page(5, 1)));
	expect(dom.container.textContent).toContain("5 waiting, 1 introduced");
	await dom.render(view({ locale: "ja", revision: 2 }));
	expect(dom.container.textContent).toContain("counting");
	await act(async () => requests[3]?.resolve(page(3, 0)));
	expect(dom.container.textContent).toContain("3 waiting, 0 introduced");
});
