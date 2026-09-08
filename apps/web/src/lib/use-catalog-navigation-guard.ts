import { useBlocker } from "@tanstack/react-router";
import { useCallback } from "react";
import { stringsLanguageSelectionKey } from "./strings-languages";

/** Search, scopes, and handoffs stay inside the mounted Strings view. Leaving
 * that pathname ends its draft session. Language changes also do so unless the
 * caller retains those drafts; sent writes may still finish. */
export function useCatalogNavigationGuard(
	hasUnsavedWork: boolean,
	retainsDraftsOnLanguageChange = false,
) {
	useBlocker({
		disabled: !hasUnsavedWork,
		// The draft owner also protects reload/close, independently of the router.
		enableBeforeUnload: false,
		shouldBlockFn: useCallback(
			({ current, next }) => {
				if (
					current.pathname === next.pathname &&
					(current.search as Record<string, unknown>).collection ===
						(next.search as Record<string, unknown>).collection &&
					(retainsDraftsOnLanguageChange ||
						stringsLanguageSelectionKey(current.search) ===
							stringsLanguageSelectionKey(next.search))
				)
					return false;
				return !window.confirm(
					"Discard unsaved edits before changing this view? Saves already sent will still complete.",
				);
			},
			[retainsDraftsOnLanguageChange],
		),
	});
}
