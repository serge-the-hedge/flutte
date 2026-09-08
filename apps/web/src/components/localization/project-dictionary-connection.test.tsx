import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { ProjectDictionaryConnection } from "./project-dictionary-connection";

describe("Project dictionary connection", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "dictionaries:projectConnection"
					? { dictionaryId: null, connectionRevision: 3 }
					: [
							{ _id: "shared", name: "Shared terminology", canEdit: true },
							{ _id: "read-only", name: "Read-only terms", canEdit: false },
						]) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	let resolveWrite: (() => void) | undefined;
	const mutation = spyOn(client, "mutation").mockImplementation(async () => {
		await new Promise<void>((resolve) => {
			resolveWrite = resolve;
		});
		return null as never;
	});
	afterAll(async () => {
		watch.mockRestore();
		mutation.mockRestore();
		await client.close();
	});
	const view = (canEdit: boolean) => (
		<ConvexProvider client={client}>
			<ProjectDictionaryConnection
				projectId="project"
				projectName="Store copy"
				canEdit={canEdit}
				legacyRevision={4}
				legacyTermCount={0}
			/>
		</ConvexProvider>
	);
	test("non-owners see the connection without controls or a dictionary-list subscription", async () => {
		watch.mockClear();
		await dom.render(view(false));
		expect(dom.container.textContent).toContain(
			"A project owner can connect one",
		);
		expect(dom.container.querySelector("form")).toBeNull();
		expect(watch.mock.calls.map(([fn]) => getFunctionName(fn))).not.toContain(
			"dictionaries:list",
		);
	});
	test("connecting freezes both replacement forms until the checked connection revision is saved", async () => {
		await dom.render(view(true));
		const select = dom.container.querySelector<HTMLSelectElement>(
			"#project-dictionary",
		);
		expect(select).not.toBeNull();
		expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
			"",
			"shared",
		]);
		await act(async () => {
			if (select) {
				select.value = "shared";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await act(async () => {
			dom.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(mutation.mock.calls[0]?.[1]).toEqual({
			projectId: "project",
			dictionaryId: "shared",
			expectedConnectionRevision: 3,
		});
		expect(
			[...dom.container.querySelectorAll("fieldset")].every(
				(fieldset) => fieldset.disabled,
			),
		).toBe(true);
		await act(async () => {
			resolveWrite?.();
		});
		expect(select?.value).toBe("");
		expect(
			[...dom.container.querySelectorAll("fieldset")].some(
				(fieldset) => fieldset.disabled,
			),
		).toBe(false);
	});
});
