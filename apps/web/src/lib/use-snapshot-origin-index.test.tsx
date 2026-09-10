import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { type api, convexId } from "./convex-api";
import { useSnapshotOriginIndex } from "./use-snapshot-origin-index";

describe("automatic snapshot filter preparation", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	type Status = FunctionReturnType<typeof api.snapshotOriginIndex.status>;
	let result: Status;
	const listeners = new Set<() => void>();
	const watch = spyOn(client, "watchQuery").mockImplementation(() => ({
		onUpdate: (callback) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
		localQueryResult: () => result as never,
		localQueryLogs: () => [],
		journal: () => undefined,
	}));
	const prepare = spyOn(client, "mutation").mockImplementation(
		async () => null as never,
	);
	function state(
		status: Status["snapshots"][number]["status"],
		processed = 0,
	): Status {
		return {
			ready: status === "ready",
			snapshots: [
				{
					snapshotId: convexId<"sourceSnapshots">("snapshot"),
					processed,
					expected: 100,
					...(status === "missing"
						? { status, updatedAt: null, failure: null }
						: {
								status,
								updatedAt: Date.now(),
								failure: status === "failed" ? "Preparation interrupted" : null,
							}),
				},
			],
		};
	}
	beforeEach(() => {
		result = state("missing");
		watch.mockClear();
		prepare.mockClear();
	});
	afterAll(async () => {
		watch.mockRestore();
		prepare.mockRestore();
		await client.close();
	});
	function Harness({ skip = false }: { skip?: boolean }) {
		const index = useSnapshotOriginIndex(
			skip
				? "skip"
				: {
						projectId: "project",
						projectionId: "projection",
						snapshotIds: ["snapshot"],
					},
		);
		return (
			<>
				<output>
					{index.ready ? "ready" : `${index.processed}/${index.expected}`}
					{index.error}
				</output>
				<button type="button" onClick={() => void index.retry()}>
					Retry
				</button>
			</>
		);
	}
	async function render(skip = false) {
		await dom.render(
			<ConvexProvider client={client}>
				<Harness skip={skip} />
			</ConvexProvider>,
		);
	}
	async function update(next: Status) {
		await act(async () => {
			result = next;
			for (const notify of listeners) notify();
		});
	}
	test("starts preparation once, shows progress, and only releases browsing when complete", async () => {
		await render();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare.mock.calls[0]?.[1]).toEqual({
			projectId: "project",
			projectionId: "projection",
			snapshotId: "snapshot",
		});
		expect(dom.container.textContent).toContain("0/100");
		await update(state("building", 50));
		expect(dom.container.textContent).toContain("50/100");
		await update(state("ready", 100));
		expect(dom.container.textContent).toContain("ready");
		expect(prepare).toHaveBeenCalledTimes(1);
	});
	test("reuses ready indexes and does no work for an unfiltered view", async () => {
		result = state("ready", 100);
		await render();
		expect(prepare).not.toHaveBeenCalled();
		watch.mockClear();
		await render(true);
		expect(prepare).not.toHaveBeenCalled();
		expect(watch).not.toHaveBeenCalled();
	});
	test("failed jobs require a deliberate retry instead of looping", async () => {
		result = state("failed", 50);
		await render();
		expect(dom.container.textContent).toContain("Preparation interrupted");
		expect(prepare).not.toHaveBeenCalled();
		await act(async () => dom.container.querySelector("button")?.click());
		expect(prepare).toHaveBeenCalledTimes(1);
	});
	test("a stalled scheduler becomes retryable without automatically restarting", async () => {
		result = state("building", 50);
		const snapshot = result.snapshots[0];
		if (!snapshot) throw new Error("Missing snapshot");
		snapshot.updatedAt = Date.now() - 59_950;
		await render();
		expect(dom.container.textContent).not.toContain("preparation paused");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
		expect(dom.container.textContent).toContain(
			"Snapshot preparation paused. Retry to continue.",
		);
		expect(prepare).not.toHaveBeenCalled();
		await act(async () => dom.container.querySelector("button")?.click());
		expect(prepare).toHaveBeenCalledTimes(1);
		await update(state("building", 60));
		expect(dom.container.textContent).not.toContain("preparation paused");
	});
});
