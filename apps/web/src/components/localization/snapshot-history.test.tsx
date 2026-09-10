import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import { SnapshotOriginRecovery, SnapshotRow } from "./snapshot-history";

describe("snapshot metadata", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const writes: { name: string; args: unknown }[] = [];
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(_query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				({
					page: args.paginationOpts.cursor ? [{ messageId: "new_title" }] : [],
					isDone: !!args.paginationOpts.cursor,
					continueCursor: "next-preview",
					projectionId: "projection",
					initialCatalog: false,
				}) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (query, args) => {
			writes.push({ name: getFunctionName(query), args });
			return { applied: 1, alreadyRecorded: 0 } as never;
		},
	);
	beforeEach(() => {
		writes.length = 0;
		watch.mockClear();
	});
	afterAll(async () => {
		watch.mockRestore();
		mutation.mockRestore();
		await client.close();
	});
	const snapshot = {
		snapshotId: convexId<"sourceSnapshots">("snapshot"),
		name: "September release",
		commit: "abcdef0123456789",
		createdAt: 1788940800000,
		initialCatalog: false,
	};
	async function render(canEdit = true) {
		await dom.render(
			<ConvexProvider client={client}>
				<ul>
					<SnapshotRow
						projectId="project"
						snapshot={snapshot}
						canEdit={canEdit}
					/>
				</ul>
			</ConvexProvider>,
		);
	}
	function button(label: string) {
		const result = Array.from(dom.container.querySelectorAll("button")).find(
			(item) =>
				item.getAttribute("aria-label") === label || item.textContent === label,
		);
		if (!result) throw Error(`Missing ${label}`);
		return result;
	}
	async function click(label: string) {
		await act(async () => button(label).click());
	}
	test("viewers see names, dates and commit but no metadata mutations", async () => {
		await render(false);
		expect(dom.container.textContent).toContain("September release");
		expect(dom.container.textContent).toContain("abcdef0");
		expect(dom.container.querySelector("time")?.dateTime).toBe(
			new Date(snapshot.createdAt).toISOString(),
		);
		expect(dom.container.querySelector("button")).toBeNull();
		expect(dom.container.querySelector("details")).toBeNull();
		expect(watch).not.toHaveBeenCalled();
	});
	test("clearing a name saves with the original concurrency basis; Escape cancels", async () => {
		await render();
		await click("Rename snapshot");
		const input = dom.container.querySelector("input");
		if (!input) throw Error("Name field missing");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			dom.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				),
		);
		expect(writes).toEqual([
			{
				name: "snapshotCatalog:rename",
				args: {
					projectId: "project",
					snapshotId: "snapshot",
					name: "",
					expectedName: "September release",
				},
			},
		]);
		await click("Rename snapshot");
		await act(async () =>
			dom.container
				.querySelector("input")
				?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				),
		);
		expect(dom.container.querySelector("input")).toBeNull();
		expect(writes).toHaveLength(1);
	});
	test("recovery requires an explicit preview and applies only the displayed page", async () => {
		await dom.render(
			<ConvexProvider client={client}>
				<SnapshotOriginRecovery projectId="project" snapshots={[snapshot]} />
			</ConvexProvider>,
		);
		const details = dom.container.querySelector("details");
		if (!details) throw Error("Recovery missing");
		await act(async () => {
			details.open = true;
			details.dispatchEvent(new Event("toggle"));
		});
		expect(watch).not.toHaveBeenCalled();
		expect(writes).toHaveLength(0);
		await click("Preview strings");
		expect(dom.container.textContent).toContain(
			"No provable introductions on this page.",
		);
		await click("Next page");
		expect(dom.container.textContent).toContain("new_title");
		expect(writes).toHaveLength(0);
		await click("Recover 1 link");
		expect(writes).toEqual([
			{
				name: "snapshotCatalog:applyOrigins",
				args: {
					projectId: "project",
					snapshotId: "snapshot",
					projectionId: "projection",
					messageIds: ["new_title"],
				},
			},
		]);
		expect(dom.container.textContent).toContain(
			"1 recovered · 0 already recorded",
		);
		expect(button("Recover 1 link").disabled).toBe(true);
	});
});
