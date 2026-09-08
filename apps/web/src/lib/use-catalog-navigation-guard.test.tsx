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
		{
			entry: "/?locale=de",
			before: ["de"],
			after: ["fr"],
			collection: undefined,
		},
		{
			entry: "/",
			before: undefined,
			after: ["de", "fr"],
			collection: undefined,
		},
		{
			entry: "/?locales=%5B%5D",
			before: [],
			after: undefined,
			collection: undefined,
		},
		{
			entry: "/",
			before: undefined,
			after: undefined,
			collection: "marketing",
		},
	])(
		"protects drafts when changing languages or collection from $entry",
		async ({ entry, before, after, collection }) => {
			function View() {
				useCatalogNavigationGuard(true);
				return <p>Strings</p>;
			}
			const route = createRootRoute({
				component: View,
				validateSearch: (search: Record<string, unknown>) => ({
					locales: stringsLanguagesFromSearch(search),
					collection:
						typeof search.collection === "string"
							? search.collection
							: undefined,
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
					void router.navigate({
						to: "/",
						search: { locales: after, collection },
					});
					await Promise.resolve();
				});
				expect(confirm).toHaveBeenCalledTimes(1);
				expect(router.state.location.search.collection).toBeUndefined();
				expect(router.state.location.search.locales).toEqual(
					before === undefined ? undefined : [...before],
				);
				confirm.mockReturnValue(true);
				await act(async () => {
					await router.navigate({
						to: "/",
						search: { locales: after, collection },
					});
				});
				expect(router.state.location.search.locales).toEqual(
					after === undefined ? undefined : [...after],
				);
				expect(router.state.location.search.collection).toBe(collection);
			} finally {
				if (originalConfirm)
					Object.defineProperty(window, "confirm", originalConfirm);
				else Reflect.deleteProperty(window, "confirm");
			}
		},
	);
	test("persistent composer drafts allow language filters but still protect leaving the project", async () => {
		function View() {
			useCatalogNavigationGuard(true, true);
			return <p>Composer draft</p>;
		}
		const route = createRootRoute({
			component: View,
			validateSearch: (search: Record<string, unknown>) => ({
				locales: stringsLanguagesFromSearch(search),
				collection: search.collection,
			}),
		});
		const router = createRouter({
			routeTree: route,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		const original = window.confirm;
		const confirm = mock(() => false);
		window.confirm = confirm;
		try {
			await act(async () => {
				await router.navigate({
					to: "/",
					search: { locales: ["fr"], collection: undefined },
				});
			});
			expect(confirm).not.toHaveBeenCalled();
			expect(router.state.location.search.locales).toEqual(["fr"]);
			await act(async () => {
				void router.navigate({
					to: "/",
					search: { locales: ["fr"], collection: "legacy-other" },
				});
				await Promise.resolve();
			});
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(router.state.location.search.collection).toBeUndefined();
		} finally {
			window.confirm = original;
		}
	});
});
