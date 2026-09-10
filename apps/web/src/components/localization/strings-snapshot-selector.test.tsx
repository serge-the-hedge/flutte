import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act, useState } from "react";
import { createDomTest } from "@/test/dom";
import { StringsSnapshotSelector } from "./strings-snapshot-selector";

describe("snapshot selection", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const snapshot = (
		snapshotId: string,
		createdAt: number,
		name: string | null = null,
	) => ({
		snapshotId,
		createdAt,
		name,
		commit: `${snapshotId}abcdef`,
		initialCatalog: false,
	});
	const newer = snapshot("newer", 1788940800000, "New onboarding");
	const older = snapshot("older", 1788854400000);
	const linked = snapshot("linked", 1788768000000, "Old selected snapshot");
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "snapshotCatalog:getSelected"
					? [newer, older, linked].filter((s) =>
							args.snapshotIds.includes(s.snapshotId),
						)
					: {
							page: args.paginationOpts.cursor ? [older] : [newer],
							isDone: !!args.paginationOpts.cursor,
							continueCursor: args.paginationOpts.cursor ? "" : "next",
							canRename: true,
						}) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	beforeEach(() => watch.mockClear());
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	function Harness({ initial }: { initial?: string[] }) {
		const [value, setValue] = useState(initial);
		return (
			<>
				<StringsSnapshotSelector
					projectId="project"
					value={value}
					onChange={setValue}
				/>
				<output>{JSON.stringify(value ?? "all")}</output>
			</>
		);
	}
	async function render(initial?: string[]) {
		await dom.render(
			<ConvexProvider client={client}>
				<Harness initial={initial} />
			</ConvexProvider>,
		);
	}
	async function open() {
		await act(async () => dom.container.querySelector("button")?.click());
	}
	async function clickText(text: string) {
		const element = [
			...document.querySelectorAll<HTMLElement>(
				'[role="menuitem"], [role="menuitemcheckbox"]',
			),
		].find((el) => el.textContent?.includes(text));
		if (!element) throw Error(`Missing item ${text}`);
		await act(async () => element.click());
	}
	test("loads on opening, pages newest first, and combines or clears snapshot selections", async () => {
		await render();
		expect(watch).not.toHaveBeenCalled();
		await open();
		await clickText("New onboarding");
		expect(dom.container.querySelector("output")?.textContent).toBe(
			'["newer"]',
		);
		await clickText("Older snapshots");
		const rows = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("All snapshots"),
			expect.stringContaining("New onboarding"),
			expect.stringContaining("olderab"),
		]);
		await clickText("olderab");
		expect(dom.container.querySelector("output")?.textContent).toBe(
			'["newer","older"]',
		);
		await clickText("All snapshots");
		expect(dom.container.querySelector("output")?.textContent).toBe('"all"');
	});
	test("resolves and removes a linked selection outside the loaded pages", async () => {
		await render(["linked"]);
		expect(dom.container.querySelector("button")?.textContent).toContain(
			"Old selected snapshot",
		);
		await open();
		await clickText("Old selected snapshot");
		expect(dom.container.querySelector("output")?.textContent).toBe('"all"');
	});
});
