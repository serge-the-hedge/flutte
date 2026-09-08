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
import { ProjectShell } from "./project-shell";
import { RepositoryProjectOnly } from "./repository-project-only";

describe("Project navigation", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	let type: "basic" | "repository" = "basic";
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "projects:get"
					? { name: "Marketing", role: "owner", type }
					: []) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	afterAll(async () => {
		watch.mockRestore();
		await client.close();
	});
	async function render(entry: string) {
		const root = createRootRoute({ component: Outlet });
		const settings = createRoute({
			getParentRoute: () => root,
			path: "/projects/$projectId/settings/members",
			component: () => (
				<ProjectShell projectId="project" title="Marketing">
					<p>Members page</p>
				</ProjectShell>
			),
		});
		const tasks = createRoute({
			getParentRoute: () => root,
			path: "/projects/$projectId/proposals",
			component: () => (
				<ProjectShell projectId="project" title="Marketing">
					<p>Tasks page</p>
				</ProjectShell>
			),
		});
		const release = createRoute({
			getParentRoute: () => root,
			path: "/projects/$projectId/release",
			component: () => (
				<RepositoryProjectOnly projectId="project">
					<p>Repository release controls</p>
				</RepositoryProjectOnly>
			),
		});
		const router = createRouter({
			routeTree: root.addChildren([settings, tasks, release]),
			history: createMemoryHistory({ initialEntries: [entry] }),
		});
		await router.load();
		await dom.render(
			<ConvexProvider client={client}>
				<RouterProvider router={router} />
			</ConvexProvider>,
		);
		return router;
	}
	const links = () =>
		[...document.querySelectorAll("nav[aria-label='Project'] a")].map(
			(link) => link.textContent,
		);
	test("Basic navigation stays consistent from settings to tasks, including the mobile menu", async () => {
		type = "basic";
		const router = await render("/projects/project/settings/members");
		expect(links()).toContain("Strings");
		expect(links()).not.toContain("Sync");
		expect(links()).not.toContain("Release");
		await act(async () => {
			await router.navigate({
				to: "/projects/$projectId/proposals",
				params: { projectId: "project" },
			});
		});
		expect(dom.container.textContent).toContain("Tasks page");
		expect(links()).not.toContain("Release");
		await act(async () => {
			dom.container
				.querySelector<HTMLButtonElement>(
					"[aria-label='Open project navigation']",
				)
				?.click();
		});
		expect(document.querySelector("[role='dialog']")?.textContent).toContain(
			"Basic",
		);
		expect(
			document.querySelector("[role='dialog']")?.textContent,
		).not.toContain("Release");
	});
	test("Basic direct release URL never mounts repository controls", async () => {
		type = "basic";
		await render("/projects/project/release");
		expect(dom.container.textContent).toContain("Open Strings");
		expect(dom.container.textContent).not.toContain(
			"Repository release controls",
		);
	});
	test("Repository settings keep Sync and Release available", async () => {
		type = "repository";
		await render("/projects/project/settings/members");
		expect(links()).toContain("Sync");
		expect(links()).toContain("Release");
		expect(dom.container.textContent).toContain("Repository");
	});
});
