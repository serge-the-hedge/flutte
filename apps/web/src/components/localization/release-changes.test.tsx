import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type FunctionReturnType, getFunctionName } from "convex/server";
import { act } from "react";
import { type api, convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import {
	ReleaseChangeRow,
	ReleaseChanges,
	ReleaseValueComparison,
} from "./release-changes";
import type { ReleaseSummary } from "./release-record-view";

type Key = FunctionReturnType<
	typeof api.releaseRecords.changes
>["page"][number];
type Value = FunctionReturnType<
	typeof api.releaseRecords.changeValues
>["page"][number];
const recordId = convexId<"releaseRecords">("release");
const key: Key = {
	_id: convexId<"releaseChangeKeys">("key"),
	messageId: "success_body",
	catalogIndex: 1,
	changedValueCount: 2,
	sourceChanged: true,
	localeCodes: ["en", "fr"],
};
const value: Value = {
	_id: convexId<"releaseChangeValues">("value"),
	localeId: convexId<"locales">("en"),
	localeCode: "en",
	isSource: true,
	before: "Old wording",
	after: "New wording\n\nSecond paragraph",
};
const record: ReleaseSummary = {
	recordId,
	projectionId: convexId<"catalogProjections">("projection"),
	snapshotId: convexId<"sourceSnapshots">("snapshot"),
	commit: "abc123",
	navigationRevision: 1,
	status: "ready",
	posture: "ready",
	progress: { cursor: 1, expectedKeyCount: 2 },
	deltaKeyCount: 1,
	scopeValueCount: 2,
	blockedCount: 0,
	needsDecisionCount: 0,
	intentionalBlankCount: 0,
	sourceIdenticalCount: 0,
	unconfirmedImportCount: 0,
	localeSummaries: [],
	failure: null,
	createdAt: 1,
	completedAt: 2,
};

describe("release text comparison", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				getFunctionName(query) === "releaseRecords:changes"
					? ({
							page: args.localeCode && !args.paginationOpts.cursor ? [] : [key],
							continueCursor: "next",
							isDone: !args.localeCode || Boolean(args.paginationOpts.cursor),
						} as never)
					: ({
							page: args.paginationOpts.cursor
								? [
										{
											...value,
											_id: "french",
											isSource: false,
											localeCode: "fr",
											before: null,
											after: "",
										},
									]
								: [value],
							isDone: Boolean(args.paginationOpts.cursor),
							continueCursor: "next",
						} as never),
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	beforeEach(() => watch.mockClear());
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	function button(text: string) {
		const result = [...dom.container.querySelectorAll("button")].find((node) =>
			node.textContent?.includes(text),
		);
		if (!result) throw new Error(`Missing button: ${text}`);
		return result;
	}
	test("fetches frozen values only when a key opens and pages through its languages", async () => {
		await dom.render(
			<ConvexProvider client={client}>
				<ReleaseChangeRow
					item={key}
					recordId={recordId}
					editLink={<a href="/strings">Open in Strings</a>}
				/>
			</ConvexProvider>,
		);
		expect(watch).not.toHaveBeenCalled();
		expect(button("success_body").getAttribute("aria-expanded")).toBe("false");
		await act(async () => button("success_body").click());
		expect(watch.mock.calls.map(([query]) => getFunctionName(query))).toContain(
			"releaseRecords:changeValues",
		);
		expect(watch.mock.calls.at(-1)?.[1]).toMatchObject({
			recordId,
			messageId: key.messageId,
		});
		expect(dom.container.textContent).toContain("Old wording");
		expect(dom.container.textContent).toContain(
			"New wording\n\nSecond paragraph",
		);
		expect(dom.container.textContent).toContain("en · Source");
		expect(dom.container.querySelector("a")?.textContent).toBe(
			"Open in Strings",
		);
		await act(async () => button("Next").click());
		expect(dom.container.textContent).toContain("Not present");
		expect(dom.container.textContent).toContain("Empty value");
		expect(dom.container.textContent).not.toContain("Old wording");
		await act(async () => button("Previous").click());
		expect(dom.container.textContent).toContain("Old wording");
		await act(async () => button("success_body").click());
		expect(dom.container.querySelector("section")).toBeNull();
	});

	test("continues sparse language filters and resets paging when the filter clears", async () => {
		await dom.render(
			<ConvexProvider client={client}>
				<ReleaseChanges
					record={{
						...record,
						changedKeyCount: 1,
						changedValueCount: 2,
						sourceLocaleCode: "en",
					}}
					projectId="project"
				/>
			</ConvexProvider>,
		);
		expect(button("success_body").textContent).toContain("en, fr");
		const select = dom.container.querySelector("select");
		if (!select) throw new Error("Missing language filter");
		await act(async () => {
			select.value = "en";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(button("success_body").textContent).toContain("en");
		expect(watch.mock.calls.at(-1)?.[1]).toMatchObject({
			localeCode: "en",
			paginationOpts: { cursor: "next" },
		});
		expect(dom.container.textContent).not.toContain("No matches on this page");
		await act(async () => {
			select.value = "";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(watch.mock.calls.at(-1)?.[1]).toMatchObject({
			paginationOpts: { cursor: null },
		});
		expect(button("success_body").textContent).toContain("en, fr");
	});

	test("keeps exact whitespace and long text in keyboard-scrollable comparisons", async () => {
		await dom.render(
			<ReleaseValueComparison
				value={{ ...value, after: `  ${"long line\n".repeat(200)}  ` }}
			/>,
		);
		const after = dom.container.querySelector(
			'[aria-label="en In this release"]',
		);
		expect(after?.textContent).toBe(`  ${"long line\n".repeat(200)}  `);
		expect(after?.getAttribute("tabindex")).toBe("0");
		expect(after?.className).toContain("max-h-64");
	});

	test("offers a fresh assessment for legacy reports without fabricating comparisons", async () => {
		let prepared = false;
		await dom.render(
			<ReleaseChanges
				record={record}
				projectId="project"
				prepareAction={
					<button
						type="button"
						onClick={() => {
							prepared = true;
						}}
					>
						Prepare current release
					</button>
				}
			/>,
		);
		expect(watch).not.toHaveBeenCalled();
		expect(dom.container.textContent).toContain(
			"older report did not retain a text comparison",
		);
		await act(async () => button("Prepare current release").click());
		expect(prepared).toBe(true);
	});

	test("does not call assessment-only keys text changes", async () => {
		await dom.render(
			<ReleaseChanges
				record={{ ...record, changedKeyCount: 0, changedValueCount: 0 }}
				projectId="project"
			/>,
		);
		expect(watch).not.toHaveBeenCalled();
		expect(dom.container.textContent).toContain("Changed strings · 0");
		expect(dom.container.textContent).toContain(
			"No text changes in existing languages",
		);
	});
});
