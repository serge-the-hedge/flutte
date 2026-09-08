import { describe, expect, mock, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createDomTest } from "../test/dom";
import { stringsLanguagesFromSearch } from "./strings-languages";
import { useCatalogNavigationGuard } from "./use-catalog-navigation-guard";

describe("Strings draft navigation guard", () => {
	const dom = createDomTest();
	test.each([
		{ entry: "/?locale=de", before: ["de"], after: ["fr"] },
		{ entry: "/", before: undefined, after: ["de", "fr"] },
		{ entry: "/?locales=%5B%5D", before: [], after: undefined },
	])(
		"protects drafts when changing languages from $entry",
		async ({ entry, before, after }) => {
			function View() {
				useCatalogNavigationGuard(true);
				return <p>Strings</p>;
			}
			const route = createRootRoute({
				component: View,
				validateSearch: (search: Record<string, unknown>) => ({
					locales: stringsLanguagesFromSearch(search),
				}),
			});
			const router = createRouter({
				routeTree: route,
				history: createMemoryHistory({ initialEntries: [entry] }),
			});
			await router.load();
			await dom.render(<RouterProvider router={router} />);
			const originalConfirm = Object.getOwnPropertyDescriptor(
				window,
				"confirm",
			);
			const confirm = mock(() => false);
			Object.defineProperty(window, "confirm", {
				configurable: true,
				writable: true,
				value: confirm,
			});
			try {
				await act(async () => {
					void router.navigate({ to: "/", search: { locales: after } });
					await Promise.resolve();
				});
				expect(confirm).toHaveBeenCalledTimes(1);
				expect(router.state.location.search.locales).toEqual(
					before === undefined ? undefined : [...before],
				);
				confirm.mockReturnValue(true);
				await act(async () => {
					await router.navigate({ to: "/", search: { locales: after } });
				});
				expect(router.state.location.search.locales).toEqual(
					after === undefined ? undefined : [...after],
				);
			} finally {
				if (originalConfirm)
					Object.defineProperty(window, "confirm", originalConfirm);
				else Reflect.deleteProperty(window, "confirm");
			}
		},
	);
});
