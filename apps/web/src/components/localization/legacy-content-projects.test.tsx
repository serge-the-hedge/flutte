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
import {
	LegacyContentLink,
	LegacyContentProjects,
} from "./legacy-content-projects";

describe("Legacy content promotion", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "projectStructure:listLegacy"
					? [{ collectionId: "marketing", name: "Store text", status: "ready" }]
					: { projectId: "promoted", status: "complete" }) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	const mutation = spyOn(client, "mutation").mockResolvedValue(
		"promoted" as never,
	);
	afterAll(async () => {
		watch.mockRestore();
		mutation.mockRestore();
		await client.close();
	});
	test("only owners can move existing content and the action carries its original address", async () => {
		let owner = false;
		function View() {
			return <LegacyContentProjects projectId="old" canPromote={owner} />;
		}
		const root = createRootRoute({ component: View });
		const router = createRouter({
			routeTree: root,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		await dom.render(
			<ConvexProvider client={client}>
				<RouterProvider router={router} />
			</ConvexProvider>,
		);
		expect(dom.container.textContent).toContain(
			"A project owner can move this content",
		);
		expect(dom.container.querySelector("button")).toBeNull();
		owner = true;
		await dom.render(
			<ConvexProvider client={client}>
				<View />
			</ConvexProvider>,
		);
		await act(async () => {
			dom.container.querySelector("button")?.click();
		});
		expect(getFunctionName(mutation.mock.calls[0]?.[0] ?? "")).toBe(
			"projectStructure:promote",
		);
		expect(mutation.mock.calls[0]?.[1]).toEqual({
			projectId: "old",
			collectionId: "marketing",
		});
	});
	test("old content links open the promoted project and retain the focused string and languages", async () => {
		const root = createRootRoute({ component: Outlet });
		const old = createRoute({
			getParentRoute: () => root,
			path: "/old",
			component: () => (
				<LegacyContentLink
					projectId="old"
					collectionId="marketing"
					search={{
						collection: "marketing",
						key: "store.title",
						locales: ["fr"],
						cursor: "old-page",
					}}
				/>
			),
		});
		const destination = createRoute({
			getParentRoute: () => root,
			path: "/projects/$projectId/strings",
			component: () => <p>Promoted Strings</p>,
		});
		const router = createRouter({
			routeTree: root.addChildren([old, destination]),
			history: createMemoryHistory({ initialEntries: ["/old"] }),
		});
		await router.load();
		await dom.render(
			<ConvexProvider client={client}>
				<RouterProvider router={router} />
			</ConvexProvider>,
		);
		expect(router.state.location.pathname).toBe("/projects/promoted/strings");
		expect(router.state.location.search).toEqual({
			key: "store.title",
			locales: ["fr"],
		});
	});
});
