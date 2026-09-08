import { describe, expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createDomTest } from "@/test/dom";
import { useCanonicalTaskProject } from "./use-canonical-task-project";

describe("Task project links", () => {
	const dom = createDomTest();
	test("replaces a moved task's project before controls mount and preserves review URL state", async () => {
		const mounted: string[] = [];
		function Controls({ projectId }: { projectId: string }) {
			mounted.push(projectId);
			return <p>Review in {projectId}</p>;
		}
		function View() {
			const { projectId, proposalId } = route.useParams();
			const relocating = useCanonicalTaskProject(
				projectId,
				proposalId,
				"destination",
			);
			return relocating ? (
				<p>Opening task…</p>
			) : (
				<Controls projectId={projectId} />
			);
		}
		const root = createRootRoute({ component: Outlet });
		const route = createRoute({
			getParentRoute: () => root,
			path: "/projects/$projectId/proposals/$proposalId",
			component: View,
		});
		const router = createRouter({
			routeTree: root.addChildren([route]),
			history: createMemoryHistory({
				initialEntries: [
					"/projects/source/proposals/task?candidate=revision#review",
				],
			}),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		expect(router.state.location.pathname).toBe(
			"/projects/destination/proposals/task",
		);
		expect(router.state.location.search).toEqual({ candidate: "revision" });
		expect(router.state.location.hash).toBe("review");
		expect(router.history.length).toBe(1);
		expect(mounted.length).toBeGreaterThan(0);
		expect(mounted.every((projectId) => projectId === "destination")).toBe(
			true,
		);
	});
});
