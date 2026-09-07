import { describe, expect, mock, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createDomTest } from "../test/dom";
import { useCatalogNavigationGuard } from "./use-catalog-navigation-guard";

describe("Strings draft navigation guard", () => {
	const dom = createDomTest();
	test("protects drafts when changing languages within the same route", async () => {
		function View() {
			useCatalogNavigationGuard(true);
			return <p>Strings</p>;
		}
		const route = createRootRoute({
			component: View,
			validateSearch: (search: Record<string, unknown>) => ({
				locale: typeof search.locale === "string" ? search.locale : undefined,
			}),
		});
		const router = createRouter({
			routeTree: route,
			history: createMemoryHistory({ initialEntries: ["/?locale=de"] }),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		const originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm");
		const confirm = mock(() => false);
		Object.defineProperty(window, "confirm", {
			configurable: true,
			writable: true,
			value: confirm,
		});
		try {
			await act(async () => {
				void router.navigate({ to: "/", search: { locale: "fr" } });
				await Promise.resolve();
			});
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(router.state.location.search.locale).toBe("de");
			confirm.mockReturnValue(true);
			await act(async () => {
				await router.navigate({ to: "/", search: { locale: "fr" } });
			});
			expect(router.state.location.search.locale).toBe("fr");
		} finally {
			if (originalConfirm)
				Object.defineProperty(window, "confirm", originalConfirm);
			else Reflect.deleteProperty(window, "confirm");
		}
	});
});
