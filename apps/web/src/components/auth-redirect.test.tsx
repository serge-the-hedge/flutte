import { expect, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import AuthRedirect from "@/components/auth-redirect";
import { createDomTest } from "@/test/dom";

const dom = createDomTest();

test.each([
	"/projects",
	"/projects/project/strings?locale=pt&search=hello#message",
])("sign-in redirects once and preserves %s", async (protectedHref) => {
	const root = createRootRoute({ component: Outlet });
	const projects = createRoute({
		getParentRoute: () => root,
		path: "/projects",
		component: AuthRedirect,
	});
	const nestedProject = createRoute({
		getParentRoute: () => projects,
		path: "$projectId/strings",
	});
	const signIn = createRoute({
		getParentRoute: () => root,
		path: "/sign-in",
		component: () => <h1>Sign in</h1>,
	});
	const history = createMemoryHistory({ initialEntries: [protectedHref] });
	const router = createRouter({
		routeTree: root.addChildren([
			projects.addChildren([nestedProject]),
			signIn,
		]),
		history,
	});
	const navigate = router.navigate.bind(router);
	let navigationCount = 0;
	const navigation = spyOn(router, "navigate").mockImplementation((options) => {
		navigationCount++;
		// Bound the original render loop so a regression fails without exhausting memory.
		return navigationCount <= 4 ? navigate(options) : Promise.resolve();
	});
	try {
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		expect(navigationCount).toBe(1);
		expect(router.state.location.pathname).toBe("/sign-in");
		expect(router.state.location.search).toEqual({
			mode: "sign-in",
			redirect: protectedHref,
		});
		expect(history.length).toBe(1);
		expect(dom.container.textContent).toBe("Sign in");
	} finally {
		navigation.mockRestore();
	}
});
