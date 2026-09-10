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
	function Harness({ initial }: { initial?: string[] | "unknown" }) {
		const [value, setValue] = useState<string[] | "unknown" | undefined>(
			initial,
		);
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
	async function render(initial?: string[] | "unknown") {
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
			expect.stringContaining("Introduction unavailable"),
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
	test("unknown origins are an explicit, exclusive selection", async () => {
		await render("unknown");
		expect(dom.container.querySelector("button")?.textContent).toContain(
			"Introduction unavailable",
		);
		await open();
		await clickText("New onboarding");
		expect(dom.container.querySelector("output")?.textContent).toBe(
			'["newer"]',
		);
		await clickText("Introduction unavailable");
		expect(dom.container.querySelector("output")?.textContent).toBe(
			'"unknown"',
		);
		await clickText("All snapshots");
		expect(dom.container.querySelector("output")?.textContent).toBe('"all"');
	});
	test("bounds metadata requests for selections spanning several pages", async () => {
		await render(["newer", "older", "linked", "fourth", "fifth"]);
		const calls = watch.mock.calls.filter(
			([query]) => getFunctionName(query) === "snapshotCatalog:getSelected",
		);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.every(([, args]) => args.snapshotIds.length <= 4)).toBe(true);
	});
});
