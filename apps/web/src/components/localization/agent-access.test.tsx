import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";

mock.module("@blabla/env/web", () => ({
	env: { VITE_CONVEX_SITE_URL: "https://example.convex.site" },
}));
const { AgentAccess } = await import("./agent-access");

describe("Agent access", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	let type: "basic" | "repository" = "basic";
	let role = "owner";
	const calls: { name: string; args: unknown }[] = [];
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "projects:get"
					? {
							name: "Marketing",
							type,
							role,
							agentReviewPolicy: { enabled: false },
						}
					: []) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (query, args) => {
			calls.push({ name: getFunctionName(query), args });
			return { token: "test-token" } as never;
		},
	);
	afterAll(async () => {
		watch.mockRestore();
		mutation.mockRestore();
		await client.close();
	});
	async function render() {
		calls.length = 0;
		const root = createRootRoute({
			component: () => (
				<ConvexProvider client={client}>
					<AgentAccess projectId="project" />
				</ConvexProvider>
			),
		});
		const router = createRouter({
			routeTree: root,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
	}
	function button(text: string) {
		const found = [...dom.container.querySelectorAll("button")].find(
			(item) => item.textContent?.trim() === text,
		);
		if (!found) throw new Error(`Missing button ${text}`);
		return found;
	}
	async function click(element: HTMLElement | null) {
		if (!element) throw new Error("Missing control");
		await act(async () => element.click());
	}
	test("owners can enable review and deliberately grant creation; reviewer credentials remain separate", async () => {
		type = "basic";
		role = "owner";
		await render();
		expect(dom.container.textContent).toContain("Agent review · off");
		expect(
			dom.container.querySelector(
				'a[href="/projects/project/settings/api-tokens"]',
			)?.textContent,
		).toBe("Agent access");
		expect(calls).toEqual([]);
		await click(button("Enable agent review"));
		expect(calls).toContainEqual({
			name: "projects:setAgentReviewPolicy",
			args: { projectId: "project", enabled: true },
		});
		const creation = dom.container.querySelector<HTMLInputElement>(
			"#strings-write-token",
		);
		expect(creation?.checked).toBe(false);
		await click(
			dom.container.querySelector('label[for="strings-write-token"]'),
		);
		await click(button("Create workspace connection"));
		expect(
			calls.find((call) => call.name === "apiTokens:create")?.args,
		).toMatchObject({ scopes: expect.arrayContaining(["strings-write"]) });
		calls.length = 0;
		await click(
			dom.container.querySelector<HTMLElement>('label[for="reviewer-token"]'),
		);
		expect(dom.container.querySelector("#strings-write-token")).toBeNull();
		await click(button("Create Reviewer token"));
		expect(
			calls.find((call) => call.name === "apiTokens:create")?.args,
		).toMatchObject({ scopes: ["read", "search", "review"] });
	});
	test("repository projects show review policy without offering managed creation; nonowners cannot change it", async () => {
		type = "repository";
		role = "editor";
		await render();
		expect(dom.container.textContent).toContain("Agent review · off");
		expect(dom.container.textContent).toContain(
			"Only project owners can change this setting.",
		);
		expect(dom.container.querySelector("#strings-write-token")).toBeNull();
		expect(dom.container.textContent).not.toContain("Enable agent review");
	});
});
