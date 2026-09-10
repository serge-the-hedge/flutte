import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import { SyncResult } from "./sync-result";

describe("Sync result", () => {
	const dom = createDomTest();
	const run = {
		id: convexId<"snapshotIngestionRuns">("run"),
		status: "succeeded",
		commit: "abcdef1234567890",
		snapshotKind: "baseline",
		snapshotId: convexId<"sourceSnapshots">("snapshot"),
		createdAt: 1_000,
		diagnosticCount: 0,
		diagnostics: [],
		unboundLocaleFileCount: 0,
		absentTargetLocaleCount: 0,
		summary: {
			outcome: "updated",
			sourceKeyCount: 100,
			addedKeyCount: 3,
			changedSourceKeyCount: 2,
			removedKeyCount: 1,
			targetValueChangeCount: 8,
		},
	} satisfies ComponentProps<typeof SyncResult>["run"];

	test("shows recorded snapshot facts with their commit", async () => {
		await dom.render(<SyncResult run={run} />);
		expect(dom.container.textContent).toContain("Changes in this snapshot.");
		expect(dom.container.textContent).toContain("abcdef123456");
		expect(
			[...dom.container.querySelectorAll("dd")].map((node) => node.textContent),
		).toEqual(["3", "2", "1", "8"]);
	});

	test("does not invent zero changes for an older sync or preview", async () => {
		await dom.render(<SyncResult run={{ ...run, summary: null }} />);
		expect(dom.container.textContent).toContain(
			"Change totals were not recorded",
		);
		expect(dom.container.querySelector("dl")).toBeNull();
		await dom.render(
			<SyncResult run={{ ...run, summary: null, snapshotKind: "preview" }} />,
		);
		expect(dom.container.textContent).toContain(
			"Preview saved; your accepted catalog is unchanged.",
		);
		expect(dom.container.querySelector("dl")).toBeNull();
	});

	test("failed sync shows actionable diagnostics without success totals", async () => {
		await dom.render(
			<SyncResult
				run={{
					...run,
					status: "failed",
					summary: null,
					diagnosticCount: 1,
					diagnostics: [
						{ catalogPath: "intl_en.arb", message: "Invalid JSON" },
					],
				}}
			/>,
		);
		expect(dom.container.textContent).toContain("The sync did not complete.");
		expect(dom.container.textContent).toContain("intl_en.arb: Invalid JSON");
		expect(dom.container.querySelector("dl")).toBeNull();
	});
});
