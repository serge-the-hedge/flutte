import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { NewProject } from "./new-project";

describe("New project", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	let resolveCreate: (() => void) | undefined;
	const calls: Array<{ name: string; args: unknown }> = [];
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (fn, args) => {
			calls.push({ name: getFunctionName(fn), args });
			await new Promise<void>((resolve) => {
				resolveCreate = resolve;
			});
			return "new-project" as never;
		},
	);
	afterAll(async () => {
		mutation.mockRestore();
		await client.close();
	});
	test.each(["basic", "repository"] as const)(
		"creates %s atomically and opens its primary workflow",
		async (type) => {
			calls.length = 0;
			const root = createRootRoute({ component: Outlet });
			const route = createRoute({
				getParentRoute: () => root,
				path: "/projects/new",
				component: NewProject,
			});
			const strings = createRoute({
				getParentRoute: () => root,
				path: "/projects/$projectId/strings",
				component: () => <p>Strings destination</p>,
			});
			const sync = createRoute({
				getParentRoute: () => root,
				path: "/projects/$projectId/sync",
				component: () => <p>Sync destination</p>,
			});
			const router = createRouter({
				routeTree: root.addChildren([route, strings, sync]),
				history: createMemoryHistory({ initialEntries: ["/projects/new"] }),
			});
			await router.load();
			await dom.render(
				<ConvexProvider client={client}>
					<RouterProvider router={router} />
				</ConvexProvider>,
			);
			expect(
				dom.container.querySelector<HTMLInputElement>("input[value='basic']")
					?.checked,
			).toBe(true);
			await act(async () => {
				const name =
					dom.container.querySelector<HTMLInputElement>("#project-name");
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(name, "Store copy");
				name?.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				dom.container
					.querySelector<HTMLInputElement>(`input[value='${type}']`)
					?.click();
			});
			await act(async () => {
				dom.container
					.querySelector("form")
					?.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					);
			});
			expect(calls).toEqual([
				{
					name: "projects:create",
					args: {
						type,
						name: "Store copy",
						slug: "store-copy",
						sourceLocaleCode: "en",
						sourceLocaleLabel: "English",
					},
				},
			]);
			expect(dom.container.querySelector("fieldset")?.disabled).toBe(true);
			await act(async () => {
				resolveCreate?.();
				await Promise.resolve();
			});
			expect(router.state.location.pathname).toBe(
				`/projects/new-project/${type === "basic" ? "strings" : "sync"}`,
			);
			expect(router.state.location.search).toEqual({});
		},
	);
});
