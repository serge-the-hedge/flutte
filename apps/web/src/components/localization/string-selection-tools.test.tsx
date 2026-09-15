import { afterAll, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { act, useState } from "react";
import { type api, convexId } from "@/lib/convex-api";
import { matchingRepositoryKeys } from "@/lib/strings-matching-keys";
import { createDomTest } from "@/test/dom";
import { StringSelectionTools } from "./string-selection-tools";

const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
type Page = FunctionReturnType<typeof api.catalogBrowse.page>;
const pages: Page[] = [];
const query = spyOn(client, "query").mockImplementation(async () => {
	const page = pages.shift();
	if (!page) throw new Error("Unexpected scan");
	return page;
});
afterAll(async () => {
	query.mockRestore();
	await client.close();
});
function page(messageId: string, nextAfter: number | null): Page {
	return {
		stale: false,
		tagRevision: 0,
		nextAfter,
		nextTargetIndex: nextAfter === null ? null : 0,
		counts: { waiting: 0, unconfirmedImport: 0, stale: 0, settled: 0 },
		keys: [
			{
				messageId,
				catalogIndex: 1,
				searchCorpus: [],
				source: {
					localeId: convexId<"locales">("en"),
					gitValueFingerprint: "source",
				},
				pendingSourceProposal: false,
				introductionReviewPending: 0,
				targets: [],
			},
		],
	};
}
function Harness() {
	const [selected, setSelected] = useState<readonly string[]>([]);
	return (
		<ConvexProvider client={client}>
			<StringSelectionTools
				projectId="project"
				tags={[]}
				selected={selected}
				onSelectionChange={setSelected}
				canEdit={false}
				selectAll={(progress) =>
					matchingRepositoryKeys(
						client,
						{
							projectId: convexId<"projects">("project"),
							projectionId: convexId<"catalogProjections">("projection"),
							q: "known_key",
						},
						progress,
					)
				}
			/>
		</ConvexProvider>
	);
}

test("selects the indexed exact key and other literal matches", async () => {
	pages.push(page("known_key", -1), page("other_match", null));
	await dom.render(<Harness />);
	const button = [...dom.container.querySelectorAll("button")].find(
		(node) => node.textContent === "Select all matching",
	);
	if (!button) throw new Error("Missing select control");
	await act(async () => button.click());
	expect(dom.container.textContent).toContain("2 selected");
	expect(dom.container.textContent).not.toContain("did not advance");
	expect(pages).toHaveLength(0);
});

test("stops if the ordinary scan repeats its cursor", async () => {
	pages.push(page("known_key", -1), page("known_key", -1));
	await dom.render(<Harness />);
	const button = [...dom.container.querySelectorAll("button")].find(
		(node) => node.textContent === "Select all matching",
	);
	if (!button) throw new Error("Missing select control");
	await act(async () => button.click());
	expect(dom.container.textContent).toContain("Catalog search did not advance");
	expect(pages).toHaveLength(0);
});
