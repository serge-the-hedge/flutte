import { useBlocker } from "@tanstack/react-router";
import { useCallback } from "react";

/** Search, scopes, and handoffs stay inside the mounted Strings view. Leaving
 * that pathname ends its draft session; sent writes may still finish. */
export function useCatalogNavigationGuard(hasUnsavedWork: boolean) {
	useBlocker({
		disabled: !hasUnsavedWork,
		// The draft owner also protects reload/close, independently of the router.
		enableBeforeUnload: false,
		shouldBlockFn: useCallback(({ current, next }) => {
			if (current.pathname === next.pathname) return false;
			return !window.confirm(
				"Leave Strings and discard unsaved edits? Saves already sent will still complete.",
			);
		}, []),
	});
}
