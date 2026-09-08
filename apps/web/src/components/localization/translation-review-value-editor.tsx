import { Button } from "@blabla/ui/components/button";
import { cn } from "@blabla/ui/lib/utils";
import { Check, Undo2 } from "lucide-react";
import {
	createContext,
	type KeyboardEventHandler,
	type ReactNode,
	use,
	useState,
} from "react";

import { IcuMessageSegmentEditor } from "@/components/localization/icu-message-segment-editor";
import { WhitespaceFacts } from "@/components/localization/whitespace-facts";

type ReviewEditorState = {
	draftValue: string;
	savedValue: string;
	phase: "needsReview" | "saved";
	disabled: boolean;
	isSaving: boolean;
};

type ReviewEditorActions = {
	update: (value: string) => void;
	save: () => void | Promise<void>;
};

type ReviewEditorMeta = {
	format?: "icu" | "plain";
	messageId: string;
	messageLabel?: string;
	localeId: string;
	localeCode: string;
	sourceValue: string;
};

type ReviewEditorContextValue = {
	state: ReviewEditorState;
	actions: ReviewEditorActions;
	meta: ReviewEditorMeta;
};

const ReviewEditorContext = createContext<ReviewEditorContextValue | null>(
	null,
);

function useReviewEditor() {
	const context = use(ReviewEditorContext);
	if (!context) {
		throw new Error("TranslationReviewEditor must be inside its Provider.");
	}
	return context;
}

export function translationReviewDraftState(input: ReviewEditorState) {
	const dirty = input.draftValue !== input.savedValue;
	const canSave =
		!input.disabled &&
		!input.isSaving &&
		input.draftValue.length > 0 &&
		(dirty || input.phase === "needsReview");
	const status = input.isSaving
		? ("saving" as const)
		: dirty
			? ("unsaved" as const)
			: input.phase === "needsReview"
				? ("needsReview" as const)
				: ("saved" as const);
	return { dirty, canSave, status };
}

function Provider({
	state,
	actions,
	meta,
	children,
}: ReviewEditorContextValue & { children: ReactNode }) {
	return (
		<ReviewEditorContext value={{ state, actions, meta }}>
			{children}
		</ReviewEditorContext>
	);
}

function Field() {
	const { state, actions, meta } = useReviewEditor();
	const [isFocused, setIsFocused] = useState(false);
	const presentation = translationReviewDraftState(state);
	const revert = () => actions.update(state.savedValue);
	const onKeyDown: KeyboardEventHandler<
		HTMLInputElement | HTMLTextAreaElement
	> = (event) => {
		if (event.key === "Escape" && presentation.dirty) {
			event.preventDefault();
			revert();
			return;
		}
		if (
			(event.metaKey || event.ctrlKey) &&
			event.key === "Enter" &&
			presentation.canSave
		) {
			event.preventDefault();
			void actions.save();
		}
	};
	return (
		<div className="rounded-md border bg-background p-2">
			<IcuMessageSegmentEditor
				format={meta.format}
				messageId={meta.messageId}
				messageLabel={meta.messageLabel}
				localeId={meta.localeId}
				localeCode={meta.localeCode}
				sourceValue={meta.sourceValue}
				value={state.draftValue}
				disabled={state.disabled || state.isSaving}
				canChangeStructure
				onValueChange={actions.update}
				onKeyDown={onKeyDown}
				onFocus={() => setIsFocused(true)}
				onBlur={() => setIsFocused(false)}
				showRawToggle={isFocused || (presentation.dirty && !state.isSaving)}
			/>
			<WhitespaceFacts value={state.draftValue} />
		</div>
	);
}

function Status() {
	const { state } = useReviewEditor();
	const { status } = translationReviewDraftState(state);
	return (
		<p
			aria-live="polite"
			className={cn(
				"text-xs",
				status === "unsaved"
					? "text-amber-600 dark:text-amber-500"
					: "text-muted-foreground",
			)}
		>
			{status === "saving"
				? "Saving review…"
				: status === "unsaved"
					? "Unsaved changes · ⌘↵ to save"
					: status === "needsReview"
						? "Not reviewed yet"
						: "Review saved"}
		</p>
	);
}

function Actions({ children }: { children?: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function SaveReview() {
	const { state, actions } = useReviewEditor();
	const { canSave } = translationReviewDraftState(state);
	return (
		<Button size="sm" disabled={!canSave} onClick={() => void actions.save()}>
			<Check data-icon="inline-start" />
			Save review
		</Button>
	);
}

function RevertChanges() {
	const { state, actions } = useReviewEditor();
	const { dirty } = translationReviewDraftState(state);
	if (!dirty) return null;
	return (
		<Button
			size="sm"
			variant="outline"
			disabled={state.disabled || state.isSaving}
			onClick={() => actions.update(state.savedValue)}
		>
			<Undo2 data-icon="inline-start" />
			Revert changes
		</Button>
	);
}

export const TranslationReviewEditor = {
	Provider,
	Field,
	Status,
	Actions,
	SaveReview,
	RevertChanges,
};
