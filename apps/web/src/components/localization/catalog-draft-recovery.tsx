import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@blabla/ui/components/alert";
import { Button } from "@blabla/ui/components/button";
import { Textarea } from "@blabla/ui/components/textarea";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { CatalogEditorDrafts } from "@/lib/strings-catalog-drafts";
import type { StringsNavigationRead } from "@/lib/strings-catalog-navigation";

/** A Git import can remove a key or Locale while its author is typing. Keep
 * those drafts available to copy or discard instead of hiding them forever. */
export function CatalogDraftRecovery({
	drafts,
	navigation,
	onUnsavedWorkChange,
}: {
	drafts: CatalogEditorDrafts;
	navigation: StringsNavigationRead | undefined;
	onUnsavedWorkChange?: (hasUnsavedWork: boolean) => void;
}) {
	useSyncExternalStore(
		drafts.subscribe,
		drafts.getSnapshot,
		drafts.getSnapshot,
	);
	const unsaved = drafts.unsaved();
	const hasUnsavedWork = unsaved.length > 0;
	useEffect(() => {
		onUnsavedWorkChange?.(hasUnsavedWork);
	}, [hasUnsavedWork, onUnsavedWorkChange]);
	useEffect(() => {
		if (!hasUnsavedWork) return;
		const warnBeforeClosing = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warnBeforeClosing);
		return () => window.removeEventListener("beforeunload", warnBeforeClosing);
	}, [hasUnsavedWork]);

	const keys = useMemo(
		() => new Map((navigation?.keys ?? []).map((key) => [key.messageId, key])),
		[navigation?.keys],
	);
	if (navigation?.kind !== "ready" && navigation?.kind !== "noBaseline")
		return null;
	const unavailable = unsaved.filter((session) => {
		const key = keys.get(session.messageId);
		return (
			navigation.canEdit === false ||
			!key ||
			(key.source.localeId !== session.localeId &&
				!key.targets.some((target) => target.localeId === session.localeId))
		);
	});
	if (unavailable.length === 0) return null;

	return (
		<Alert className="mb-4">
			<AlertTitle>
				{navigation.canEdit === false
					? "Unsaved edits you can no longer save"
					: "Unsaved edits outside the current catalog"}
			</AlertTitle>
			<AlertDescription>
				<p>
					{navigation.canEdit === false
						? "Your editing access changed."
						: "These keys or languages were removed."}{" "}
					Copy any text you want to keep before leaving Strings, or discard it.
				</p>
				<div className="flex flex-col gap-3">
					{unavailable.map((session) => {
						const state = session.getSnapshot();
						return (
							<div
								className="flex flex-col gap-1"
								key={JSON.stringify([session.messageId, session.localeId])}
							>
								<p>
									{session.messageId} · {session.localeCode}
								</p>
								<Textarea
									readOnly
									aria-label={`Unsaved ${session.messageId} ${session.localeCode}`}
									value={state.draft.value}
								/>
								{state.isRecordingBlank ? (
									<p>
										Reason for rendering nothing:{" "}
										{state.blankReason || "No reason entered"}
									</p>
								) : null}
								{state.error ? <p>{state.error}</p> : null}
								<Button
									variant="outline"
									size="sm"
									disabled={state.isSaving}
									onClick={() => drafts.discard(session)}
								>
									{state.isSaving ? "Saving…" : "Discard edit"}
								</Button>
							</div>
						);
					})}
				</div>
			</AlertDescription>
		</Alert>
	);
}
