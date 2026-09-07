import { useBlocker } from "@tanstack/react-router";
import { useCallback } from "react";

/** Search, scopes, and handoffs stay inside the mounted Strings view. Leaving
 * that pathname or changing the working language ends its draft session; sent writes may still finish. */
export function useCatalogNavigationGuard(hasUnsavedWork: boolean) {
	useBlocker({
		disabled: !hasUnsavedWork,
		// The draft owner also protects reload/close, independently of the router.
		enableBeforeUnload: false,
		shouldBlockFn: useCallback(({ current, next }) => {
			if (
				current.pathname === next.pathname &&
				("locale" in current.search ? current.search.locale : undefined) ===
					("locale" in next.search ? next.search.locale : undefined)
			)
				return false;
			return !window.confirm(
				"Discard unsaved edits before changing this view? Saves already sent will still complete.",
			);
		}, []),
	});
}
