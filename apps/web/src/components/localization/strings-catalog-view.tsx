import { characterCount } from "@blabla/backend/convex/characterLimits";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@blabla/ui/components/alert-dialog";
import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import { Checkbox } from "@blabla/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { cn } from "@blabla/ui/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	BookOpen,
	Check,
	CheckCheck,
	Copy,
	GitBranch,
	Info,
	Languages,
	Link2,
	ListChecks,
	LoaderCircle,
	Search,
	X,
} from "lucide-react";
import {
	createContext,
	type KeyboardEventHandler,
	memo,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import { IcuMessageSegmentEditor } from "@/components/localization/icu-message-segment-editor";
import { readMessageSegments } from "@/lib/icu-message-segments";
import type {
	CatalogWorkspaceCommit,
	CatalogWorkspaceCommitReceipt,
	CatalogWorkspaceDraftSource,
	CatalogWorkspaceValue,
	StringsCatalogKey,
} from "@/lib/strings-catalog";
import {
	catalogValueEditBasis,
	createCatalogWorkspaceDraft,
	editCatalogWorkspaceDraft,
	refreshCatalogWorkspaceDraft,
	stringDisplayName,
} from "@/lib/strings-catalog";
import {
	CatalogEditorDrafts,
	sameDraftSource,
} from "@/lib/strings-catalog-drafts";
import {
	type CatalogValueScope,
	type CatalogWorkspaceFocusIntent,
	type CatalogWorkspaceFocusTarget,
	navigateStringsDigests,
	nextCatalogWorkspaceFocusTarget,
	type StringsCatalogNavigationState,
	type StringsNavigationDigest,
	type StringsNavigationRead,
	translationTaskLocales,
} from "@/lib/strings-catalog-navigation";
import {
	catalogWorkspaceCommitShortcut,
	presentCatalogKey,
	presentCatalogWorkspaceValue,
	type ValuePhrase,
	type ValueTone,
} from "@/lib/strings-catalog-presentation";
import {
	collectStringsWindowMessageIds,
	estimateStringsCardHeight,
	isCatalogWorkspaceFieldVisible,
	quantizeStringsWindowBounds,
	StringsCardMeasurementCache,
	type StringsWindowCards,
	sameStringsWindowMessageIds,
	stringsWindowKeyCap,
} from "@/lib/strings-window";
import {
	CatalogAdvancedView,
	type CatalogLocale,
} from "./catalog-advanced-view";
import { CatalogDraftRecovery } from "./catalog-draft-recovery";
import { CatalogLongValue } from "./catalog-long-value";
import { CatalogValueRow, QUIET_CATALOG_FIELD } from "./catalog-value-row";
import { CharacterCount } from "./character-limit";
import { TranslationHistoryRow } from "./translation-history";

/**
 * The reading measure. Wide enough that a 300-character paragraph is
 * comfortable, capped short of the line lengths that lose the eye on the
 * return sweep.
 */

/**
 * A value's height is its content's height. The shared Textarea ships
 * `min-h-16` and `md:text-xs`, which would give a one-word value four lines
 * and shrink every paragraph back to 12px at the only breakpoint that matters
 * here; both are overridden deliberately.
 */
/** The viewport assumed before the window is measured, so the first paint
 * carries rows rather than an empty scroller. */
const INITIAL_CATALOG_RECT = { width: 0, height: 1024 };
const NUMBER_FORMAT = new Intl.NumberFormat();
const CATALOG_LOADING_ROW_KEYS = [
	"catalog-loading-row-1",
	"catalog-loading-row-2",
	"catalog-loading-row-3",
] as const;

export type CommitCatalogValue = (
	input: CatalogWorkspaceCommit,
) => Promise<CatalogWorkspaceCommitReceipt>;

export type CreateTranslationTask = (input: {
	title: string;
	localeId: string;
	messageIds: readonly string[];
}) => Promise<void>;

/** The compact ordinary-import summary the Navigation read carries: the
 * policy, the conservative category counts, and the current server-owned
 * run. Candidate arrays never cross the browser. */
export type StringsOrdinaryImportsSummary = {
	policy: "ordinary-v1";
	total: number;
	eligible: number;
	empty: number;
	sourceIdentical: number;
	repeated: number;
	modified: number;
	stale: number;
	alreadyConfirmed: number;
	pendingSourceProposal: number;
	introduced: number;
	run: {
		status: "running" | "done" | "superseded" | "failed";
		confirmed: number;
		skipped: number;
		failure: {
			code?: string;
			message: string;
			failedAt: number;
		} | null;
	} | null;
};

type WorkspaceFocusRequest = {
	messageId: string;
	localeId: string;
} & CatalogWorkspaceFocusIntent;
type MoveCatalogWorkspaceFocus = (request: WorkspaceFocusRequest) => boolean;

type EditableCatalogWorkspaceValue = CatalogWorkspaceValue & {
	localeId: string;
};

type CatalogWorkspaceEditorInput = {
	value: CatalogWorkspaceValue;
	canEdit: boolean;
	onCommitValue: CommitCatalogValue | undefined;
};

type CatalogControls = {
	historyProjectId?: string;
	searchPlaceholder?: string;
	/** Only offer Focus when the caller filters the complete result set by scope. */
	showFocusControls?: boolean;
	availableLocales?: CatalogLocale[];
	sourceLocaleId?: string;
	renderProperties?: (
		key: StringsCatalogKey,
		close: () => void,
	) => React.ReactNode;
	renderAdvancedValue?: (
		key: StringsCatalogKey,
		localeId: string,
	) => React.ReactNode;
	onBeforeCloseAdvanced?: () => boolean;
	onOpenAdvanced?: (key: StringsCatalogKey, localeId?: string) => void;
	tagNamesByMessage?: ReadonlyMap<string, readonly string[]>;
	selectedMessageIds?: readonly string[];
	onSelectionChange?: (ids: readonly string[]) => void;
};
const CatalogControlsContext = createContext<CatalogControls>({});

const CatalogDraftsContext = createContext<CatalogEditorDrafts | null>(null);

function isEditableCatalogWorkspaceValue(
	input: CatalogWorkspaceEditorInput,
): input is CatalogWorkspaceEditorInput & {
	value: EditableCatalogWorkspaceValue;
	canEdit: true;
	onCommitValue: CommitCatalogValue;
} {
	const { value } = input;
	return (
		input.canEdit &&
		input.onCommitValue !== undefined &&
		value.localeId !== undefined &&
		catalogValueEditBasis(value) !== undefined
	);
}

/** The one line allowed under a value, and only when it has something to say. */
function ValuePhraseLine({
	phrase,
	tone,
}: {
	phrase?: ValuePhrase;
	tone: ValueTone;
}) {
	if (!phrase) return null;
	return (
		<p
			className={cn(
				"px-2 pb-0.5 text-[11px]",
				tone === "attention"
					? "text-amber-600 dark:text-amber-500"
					: "text-muted-foreground/70",
			)}
		>
			{phrase}
		</p>
	);
}

function CatalogValue({
	value,
	sourceValue,
	characterLimit,
	onOpen,
}: {
	value: CatalogWorkspaceValue;
	sourceValue?: string;
	characterLimit?: number;
	onOpen?: () => void;
}) {
	const isEmpty = value.value.length === 0;
	const presentation = presentCatalogWorkspaceValue({
		value,
		sourceValue,
		isFocused: false,
		isDirty: false,
		draftValue: value.value,
	});
	const visibleValue = value.intentionalBlankReason
		? `Renders nothing — ${value.intentionalBlankReason}`
		: isEmpty
			? value.materialized
				? "No target value"
				: "Empty value"
			: value.value;
	return (
		<CatalogValueRow localeCode={value.localeCode} tone={presentation.tone}>
			<CatalogLongValue
				value={value.value}
				label={value.localeCode}
				onOpen={onOpen}
			>
				<p
					dir="auto"
					className={cn(
						"px-2 py-1 text-[13px] leading-relaxed",
						isEmpty
							? "text-muted-foreground/70 italic"
							: "whitespace-pre-wrap break-words",
					)}
				>
					{visibleValue}
				</p>
			</CatalogLongValue>
			<CharacterCount value={value.value} limit={characterLimit} />
			<ValuePhraseLine phrase={presentation.phrase} tone={presentation.tone} />
		</CatalogValueRow>
	);
}

function EditableCatalogValue({
	messageId,
	messageLabel,
	value,
	sourceValue,
	characterLimit,
	onCommitValue,
	onMoveFocus,
	onOpen,
}: {
	messageId: string;
	messageLabel?: string;
	value: EditableCatalogWorkspaceValue;
	sourceValue?: string;
	characterLimit?: number;
	onCommitValue: CommitCatalogValue;
	onMoveFocus: MoveCatalogWorkspaceFocus;
	onOpen?: () => void;
}) {
	const currentDraftSource = useMemo<CatalogWorkspaceDraftSource>(() => {
		const basis = catalogValueEditBasis(value);
		if (!basis) throw new Error("Editable value has no concurrency basis.");
		return { value: value.value, basis };
	}, [value]);
	const basis = currentDraftSource.basis;
	const drafts = useContext(CatalogDraftsContext);
	if (!drafts) throw new Error("Catalog editors require a draft owner.");
	const session = drafts.get(
		messageId,
		value.localeId,
		value.localeCode,
		currentDraftSource,
	);
	const {
		draft,
		optimisticSource,
		isSaving,
		error,
		isRecordingBlank,
		blankReason,
	} = useSyncExternalStore(
		session.subscribe,
		session.getSnapshot,
		session.getSnapshot,
	);
	const [isFocused, setIsFocused] = useState(false);
	const editedHere = useRef(false);
	const renderedValueRef = useRef(currentDraftSource.value);
	const draftSource = optimisticSource?.committed ?? currentDraftSource;
	const isDirty = draft.isDirty;
	const isEmptyDraft = draft.value.length === 0;
	useEffect(() => {
		if (!optimisticSource) return;
		if (
			sameDraftSource(currentDraftSource, optimisticSource.committed) ||
			!optimisticSource.known.some((source) =>
				sameDraftSource(currentDraftSource, source),
			)
		) {
			session.set("optimisticSource", null);
		}
	}, [currentDraftSource, optimisticSource, session]);
	useEffect(() => {
		session.set("draft", (currentDraft) =>
			currentDraft.isDirty ||
			isRecordingBlank ||
			sameDraftSource(currentDraft, draftSource)
				? currentDraft
				: refreshCatalogWorkspaceDraft(currentDraft, draftSource),
		);
		if (
			renderedValueRef.current !== currentDraftSource.value &&
			!session.getSnapshot().isRecordingBlank &&
			!session.getSnapshot().draft.isDirty
		) {
			renderedValueRef.current = currentDraftSource.value;
			session.set("error", null);
			session.set("isRecordingBlank", false);
			session.set("blankReason", "");
		}
	}, [currentDraftSource, draftSource, isRecordingBlank, session]);

	const revert = useCallback(() => {
		session.set("draft", createCatalogWorkspaceDraft(draftSource));
		session.set("error", null);
		session.set("isRecordingBlank", false);
		session.set("blankReason", "");
		session.set("blankSource", null);
	}, [draftSource, session]);

	const updateDraft = useCallback(
		(nextValue: string) => {
			session.set("draft", (currentDraft) =>
				editCatalogWorkspaceDraft({
					draft: currentDraft,
					source: draftSource,
					value: nextValue,
				}),
			);
		},
		[draftSource, session],
	);

	const commit = useCallback(
		async (
			intent: CatalogWorkspaceCommit["intent"],
			focus: "next" | "preserve" = "next",
		) => {
			if (session.getSnapshot().isSaving) return false;
			if (
				intent.kind !== "intentionalBlank" &&
				characterLimit !== undefined &&
				characterCount(intent.kind === "save" ? intent.value : value.value) >
					characterLimit
			)
				return false;
			const blankSource = session.getSnapshot().blankSource;
			const commitDraft =
				intent.kind === "intentionalBlank" && blankSource
					? blankSource
					: refreshCatalogWorkspaceDraft(
							session.getSnapshot().draft,
							draftSource,
						);
			// Moving focus disables this field before the server snapshot returns;
			// clear the local focus chrome now so the refresh cannot cause a second,
			// surprising collapse later.
			setIsFocused(false);
			session.set("isSaving", true);
			session.set("error", null);
			try {
				const request = onCommitValue({
					messageId,
					localeId: value.localeId,
					intent,
					basis: commitDraft.basis,
				});
				// Start the write before moving focus. The current editor is the only
				// disabled field; the rest of the catalog remains available while the
				// mutation makes its round trip.
				if (focus === "next") {
					onMoveFocus({
						messageId,
						localeId: value.localeId,
						kind: "next",
					});
				}
				const receipt = await request;
				const nextSource: CatalogWorkspaceDraftSource = {
					...commitDraft,
					value: intent.kind === "intentionalBlank" ? "" : commitDraft.value,
					basis: receipt.basis,
				};
				session.set("optimisticSource", (current) => {
					const known = current?.known ?? [];
					return {
						known: known.some((source) => sameDraftSource(source, draftSource))
							? known
							: [...known, draftSource],
						committed: nextSource,
					};
				});
				session.set("draft", { ...nextSource, isDirty: false });
				return true;
			} catch (cause) {
				session.set("draft", commitDraft);
				session.set("optimisticSource", (current) =>
					current ? { ...current, committed: draftSource } : null,
				);
				session.set(
					"error",
					cause instanceof Error ? cause.message : "Could not save value.",
				);
				return false;
			} finally {
				session.set("isSaving", false);
			}
		},
		[
			characterLimit,
			value.value,
			messageId,
			onCommitValue,
			onMoveFocus,
			draftSource,
			session,
			value.localeId,
		],
	);

	const save = useCallback(
		async (focus: "next" | "preserve" = "next") => {
			// Focus can leave in the same event as Escape or a manual commit. Read
			// the live session so a discarded or already saving draft is not sent.
			const current = session.getSnapshot();
			if (
				!current.draft.isDirty ||
				current.isSaving ||
				current.isRecordingBlank
			)
				return;
			if (!value.isSource && current.draft.value.length === 0) {
				session.set(
					"error",
					"Choose “deliberately empty” and give a reason to record an Intentional Blank.",
				);
				return;
			}
			await commit({ kind: "save", value: current.draft.value }, focus);
		},
		[commit, value.isSource, session],
	);

	const confirm = useCallback(async () => {
		await commit({ kind: "confirm" });
	}, [commit]);

	const recordBlank = useCallback(async () => {
		const committed = await commit({
			kind: "intentionalBlank",
			reason: blankReason,
		});
		if (committed) {
			session.set("isRecordingBlank", false);
			session.set("blankReason", "");
			session.set("blankSource", null);
		}
	}, [blankReason, commit, session]);

	const onEditorKeyDown = useCallback<
		KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
	>(
		(event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				revert();
				return;
			}
			if (event.key === "Tab" && value.localeId !== undefined) {
				const moved = onMoveFocus({
					messageId,
					localeId: value.localeId,
					kind: "adjacent",
					direction: event.shiftKey ? -1 : 1,
				});
				if (moved) event.preventDefault();
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				event.preventDefault();
				const action = catalogWorkspaceCommitShortcut({
					isDirty,
					valueState: value.valueState,
					sourceChangeKind: value.sourceChangeKind,
				});
				if (action === "save") {
					void save();
				} else if (action === "confirm") {
					void confirm();
				}
			}
		},
		[
			confirm,
			isDirty,
			messageId,
			onMoveFocus,
			revert,
			save,
			value.localeId,
			value.sourceChangeKind,
			value.valueState,
		],
	);

	const isOptimisticallySettled = optimisticSource !== null && !isDirty;
	const presentationValue =
		value.isSource || (!isSaving && !isOptimisticallySettled)
			? value
			: { ...value, valueState: "settled" as const };
	const presentation = presentCatalogWorkspaceValue({
		value: presentationValue,
		sourceValue,
		isFocused,
		// Keep the draft dirty for reactive-conflict safety while the write is
		// in flight, but do not keep its editing controls in the layout. The
		// save handoff owns that transition; the refreshed snapshot must not
		// unexpectedly collapse the row later.
		isDirty: isDirty && !isSaving,
		draftValue: draft.value,
	});
	// A draft typed empty is undecided until a reason is recorded, so it says
	// what a Waiting value says rather than staying silent.
	const phrase =
		!isSaving && !value.isSource && isDirty && isEmptyDraft
			? ("needs a value" as const)
			: isSaving
				? undefined
				: presentation.phrase;
	const copyKind = isDirty
		? "draft"
		: value.isSource
			? "source"
			: value.valueState === "settled"
				? "reviewed"
				: value.valueState === "stale"
					? "stale"
					: "draft";
	const canCopy =
		basis.kind !== "repository" &&
		(isFocused || isDirty) &&
		draft.value.length > 0 &&
		!isSaving;
	const speaks =
		presentation.affordances.length > 0 || error !== null || canCopy;
	const blankReasonId = `${messageId}-${value.localeId}-blank-reason`;
	const showsBlankReason =
		value.intentionalBlankReason !== undefined && !isDirty && !isRecordingBlank;

	return (
		<CatalogValueRow
			localeCode={value.localeCode}
			tone={presentation.tone}
			onBlur={(event) => {
				// A structured message's arms, raw toggle, and actions are one editor.
				if (
					event.relatedTarget instanceof Node &&
					event.currentTarget.contains(event.relatedTarget)
				)
					return;
				setIsFocused(false);
				void save("preserve");
			}}
		>
			{isSaving ? (
				<span
					role="status"
					aria-live="polite"
					className="pointer-events-none absolute top-1 right-0 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground"
				>
					saving…
				</span>
			) : null}
			{showsBlankReason ? (
				<button
					type="button"
					className="w-full px-2 py-1 text-left text-[13px] text-muted-foreground/70 italic leading-relaxed hover:bg-muted/40"
					onClick={() => updateDraft(" ")}
					title="Write a value instead"
				>
					Renders nothing — {value.intentionalBlankReason}
				</button>
			) : (
				<CatalogLongValue
					value={draft.value}
					label={`${messageLabel ?? messageId} ${value.localeCode}`}
					onOpen={onOpen}
					editing={isFocused || (isDirty && editedHere.current)}
					messageId={messageId}
					localeId={value.localeId}
				>
					<IcuMessageSegmentEditor
						format={basis.kind === "repository" ? "icu" : "plain"}
						messageId={messageId}
						messageLabel={messageLabel}
						localeId={value.localeId}
						localeCode={value.localeCode}
						sourceValue={value.isSource ? undefined : sourceValue}
						value={draft.value}
						disabled={isSaving}
						canChangeStructure={!value.isSource}
						onValueChange={updateDraft}
						onKeyDown={onEditorKeyDown}
						onFocus={() => {
							editedHere.current = true;
							setIsFocused(true);
						}}
						fieldClassName={QUIET_CATALOG_FIELD}
						showRawToggle={isFocused || (isDirty && !isSaving)}
					/>
				</CatalogLongValue>
			)}

			<CharacterCount value={draft.value} limit={characterLimit} />
			{isRecordingBlank && !isSaving ? (
				<div className="flex flex-col gap-1.5 px-2 py-1.5">
					<label className="sr-only" htmlFor={blankReasonId}>
						Why should this render nothing?
					</label>
					<Input
						id={blankReasonId}
						className="h-7 text-[13px]"
						value={blankReason}
						onChange={(event) => session.set("blankReason", event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								session.set("isRecordingBlank", false);
								session.set("blankReason", "");
								session.set("blankSource", null);
								return;
							}
							if (event.key === "Enter" && blankReason.trim().length > 0) {
								event.preventDefault();
								void recordBlank();
							}
						}}
						placeholder="Why should this render nothing?"
						aria-keyshortcuts="Enter"
					/>
					<p className="text-[11px] text-muted-foreground/70">
						Enter to save · Esc to cancel
					</p>
				</div>
			) : null}

			{speaks ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pb-0.5 text-[11px] text-muted-foreground/70">
					{presentation.commitHint ? (
						<span>⌘↵ {presentation.commitHint}</span>
					) : null}
					{value.isSource && isDirty && basis.kind === "repository" ? (
						<span>saves a source proposal for Git</span>
					) : null}
					{presentation.echoesSource ? (
						<span>matches source · saving confirms this wording</span>
					) : null}
					{canCopy ? (
						<IconButton
							label={`Copy ${copyKind} text`}
							icon={Copy}
							size="icon-xs"
							onMouseDown={(event) => event.preventDefault()}
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(draft.value);
									toast.success(
										`${copyKind[0]?.toUpperCase()}${copyKind.slice(1)} text copied`,
									);
								} catch {
									toast.error(
										"Could not copy text. Select the value and copy it manually.",
									);
								}
							}}
						/>
					) : null}
					{presentation.affordances.includes("confirm") ? (
						<Button
							type="button"
							size="xs"
							variant="ghost"
							className="ml-auto h-6 px-1.5 text-[11px]"
							disabled={
								characterLimit !== undefined &&
								characterCount(draft.value) > characterLimit
							}
							onClick={() => void confirm()}
						>
							<Check aria-hidden="true" />
							Approve
						</Button>
					) : null}
					{presentation.affordances.includes("intentionalBlank") ? (
						<button
							type="button"
							className="underline underline-offset-2 hover:text-foreground"
							// mousedown, not click: blur must not beat the press.
							onMouseDown={(event) => {
								event.preventDefault();
								session.set(
									"blankSource",
									refreshCatalogWorkspaceDraft(draft, draftSource),
								);
								session.set("isRecordingBlank", true);
							}}
						>
							deliberately empty
						</button>
					) : null}
					{error ? (
						<span className="w-full text-destructive" role="alert">
							{error}
						</span>
					) : null}
				</div>
			) : null}

			<ValuePhraseLine phrase={phrase} tone={presentation.tone} />
		</CatalogValueRow>
	);
}

/** The Catalog Workspace supplies the full optimistic-concurrency token for
 * either a Source Proposal or target edit. Strings only decides whether that
 * opaque value is editable and renders the shared field shape. */
const KEEP_CATALOG_FOCUS: MoveCatalogWorkspaceFocus = () => false;

export function CatalogWorkspaceValueField({
	messageId,
	messageLabel,
	value,
	sourceValue,
	characterLimit,
	canEdit,
	onCommitValue,
	onMoveFocus = KEEP_CATALOG_FOCUS,
	onOpen,
	advanced = false,
}: {
	messageId: string;
	messageLabel?: string;
	value: CatalogWorkspaceValue;
	sourceValue?: string;
	characterLimit?: number;
	canEdit: boolean;
	onCommitValue?: CommitCatalogValue;
	onMoveFocus?: MoveCatalogWorkspaceFocus;
	onOpen?: () => void;
	advanced?: boolean;
}) {
	const { historyProjectId } = useContext(CatalogControlsContext);
	const editor = { value, canEdit, onCommitValue };
	const field = isEditableCatalogWorkspaceValue(editor) ? (
		<EditableCatalogValue
			messageId={messageId}
			messageLabel={messageLabel}
			value={editor.value}
			sourceValue={sourceValue}
			characterLimit={characterLimit}
			onCommitValue={editor.onCommitValue}
			onMoveFocus={onMoveFocus}
			onOpen={advanced ? undefined : onOpen}
		/>
	) : (
		<CatalogValue
			onOpen={advanced ? undefined : onOpen}
			value={value}
			sourceValue={sourceValue}
			characterLimit={characterLimit}
		/>
	);
	return historyProjectId && !value.isSource && value.localeId ? (
		<TranslationHistoryRow
			projectId={historyProjectId}
			messageId={messageId}
			messageLabel={messageLabel ?? messageId}
			localeId={value.localeId}
			localeCode={value.localeCode}
		>
			{field}
		</TranslationHistoryRow>
	) : (
		field
	);
}

function hasMultipleIcuArms(catalogKey: StringsCatalogKey): boolean {
	if (
		catalogKey.source.editBasis &&
		catalogKey.source.editBasis.kind !== "repository"
	)
		return false;
	const message = readMessageSegments({
		value: catalogKey.source.value,
		localeCode: catalogKey.source.localeCode,
	});
	return (
		message.kind === "structured" &&
		message.segments.some(
			(segment) => segment.kind !== "text" && segment.arms.length > 1,
		)
	);
}

const CatalogKeyCard = memo(function CatalogKeyCard({
	catalogKey,
	introductionReviewPending,
	highlighted,
	onNavigationChange,
	onCommitValue,
	onMoveFocus,
	canEdit,
	selected,
	onSelectedChange,
}: {
	catalogKey: StringsCatalogKey;
	introductionReviewPending: number;
	highlighted: boolean;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	onCommitValue?: CommitCatalogValue;
	onMoveFocus: MoveCatalogWorkspaceFocus;
	canEdit: boolean;
	selected: boolean;
	onSelectedChange: (messageId: string, selected: boolean) => void;
}) {
	// The key's own facts, said once. The change that left five Locales waiting
	// is one fact, and repeating it under every value was the noise the
	// prototype's second round was rejected for.
	const controls = useContext(CatalogControlsContext);
	const keyPresentation = presentCatalogKey(catalogKey.targets);
	const hasMultiArmIcu = hasMultipleIcuArms(catalogKey);
	const { title, label: accessibleTitle } = stringDisplayName({
		id: catalogKey.id,
		name: catalogKey.name,
		sourceValue: catalogKey.source.value,
	});
	return (
		<section
			data-highlighted={highlighted || undefined}
			style={
				{
					"--locale-gutter": `${Math.max(3, catalogKey.source.localeCode.length, ...catalogKey.targets.map((target) => target.localeCode.length))}ch`,
				} as React.CSSProperties
			}
			className={cn(
				"group/key flex flex-col gap-1 border-b py-6",
				selected && "-mx-2 bg-muted/25 px-2",
				highlighted && "-mx-3 bg-muted/40 px-3",
			)}
		>
			<header className="flex flex-wrap items-baseline gap-2">
				{canEdit || controls.onSelectionChange ? (
					<Checkbox
						checked={selected}
						onCheckedChange={(checked) =>
							onSelectedChange(catalogKey.id, checked === true)
						}
						aria-label={`${selected ? "Remove" : "Add"} ${accessibleTitle} ${selected ? "from" : "to"} Translation Task`}
						className={cn(
							"translate-y-0.5 transition-opacity",
							selected
								? "opacity-100"
								: "opacity-35 focus-visible:opacity-100 group-hover/key:opacity-100",
						)}
					/>
				) : null}
				{title !== null ? (
					<button
						type="button"
						onClick={() => controls.onOpenAdvanced?.(catalogKey)}
						className={cn(
							"min-w-0 rounded-sm text-left text-[13px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							catalogKey.name === undefined
								? "truncate font-mono text-foreground/90"
								: "break-words font-medium",
						)}
						aria-label={`Properties for ${accessibleTitle}`}
					>
						{title}
					</button>
				) : null}
				<IconButton
					label="Properties"
					icon={Info}
					onClick={() => controls.onOpenAdvanced?.(catalogKey)}
					aria-label={`Properties for ${accessibleTitle}`}
				/>
				<IconButton
					label="Permalink"
					icon={Link2}
					size="icon-xs"
					onClick={() => onNavigationChange({ query: "", key: catalogKey.id })}
					aria-label={`Open ${accessibleTitle} permalink`}
				/>
				{controls.tagNamesByMessage?.get(catalogKey.id)?.map((name) => (
					<Badge key={name} variant="secondary">
						{name}
					</Badge>
				))}
				{hasMultiArmIcu ? (
					<span
						role="img"
						aria-label="Multi-arm ICU string"
						title="Multi-arm ICU string"
						className="inline-flex shrink-0 text-muted-foreground/45"
					>
						<GitBranch aria-hidden="true" className="size-3.5" />
					</span>
				) : null}
				{introductionReviewPending > 0 ? (
					<span
						title="Imported after this project's initial Baseline and awaiting its first review"
						className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 font-medium text-[10px] text-sky-700 dark:text-sky-300"
					>
						New from Git · {introductionReviewPending}
					</span>
				) : null}
				{/* Only work that is waiting on someone earns a word in the header.
				    An Unconfirmed Import keeps its mark on the value's own rule
				    (#28) rather than a count here: until a catalog has been swept
				    once, every key carries one, and a caption that fires on all
				    1,549 keys is the noise round two was rejected for. Finding
				    them is a Catalog Scope's job. */}
				{keyPresentation.waiting ? (
					<span className="ml-auto shrink-0 text-[11px] text-amber-600 tabular-nums dark:text-amber-500">
						{keyPresentation.waiting} waiting
					</span>
				) : null}
			</header>
			{catalogKey.context ? (
				<p className="text-muted-foreground text-xs">{catalogKey.context}</p>
			) : null}
			<div className="-ml-0.5 flex flex-col">
				<CatalogWorkspaceValueField
					messageId={catalogKey.id}
					messageLabel={accessibleTitle}
					onOpen={() =>
						controls.onOpenAdvanced?.(
							catalogKey,
							catalogKey.source.localeId ?? catalogKey.source.localeCode,
						)
					}
					value={catalogKey.source}
					sourceValue={catalogKey.source.value}
					characterLimit={catalogKey.characterLimit}
					canEdit={canEdit}
					onCommitValue={onCommitValue}
					onMoveFocus={onMoveFocus}
				/>
				{catalogKey.targets.map((value) => {
					return (
						<CatalogWorkspaceValueField
							key={value.localeId ?? value.localeCode}
							messageId={catalogKey.id}
							messageLabel={accessibleTitle}
							onOpen={() =>
								controls.onOpenAdvanced?.(
									catalogKey,
									value.localeId ?? value.localeCode,
								)
							}
							value={value}
							sourceValue={catalogKey.source.value}
							characterLimit={catalogKey.characterLimit}
							canEdit={canEdit}
							onCommitValue={onCommitValue}
							onMoveFocus={onMoveFocus}
						/>
					);
				})}
			</div>
		</section>
	);
});

function NoBaselineCatalog({ onConnect }: { onConnect: () => void }) {
	return (
		<Empty className="border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<BookOpen aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle>No catalog yet</EmptyTitle>
				<EmptyDescription>
					Sync your checkout to bring its strings here.
				</EmptyDescription>
				<Button type="button" onClick={onConnect}>
					Connect checkout
				</Button>
			</EmptyHeader>
		</Empty>
	);
}

function EmptyBaselineCatalog() {
	return (
		<Empty className="border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Languages aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle>No strings in this catalog</EmptyTitle>
				<EmptyDescription>
					The synced files contain no strings.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

function EmptySearchResult() {
	return (
		<Empty className="border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Search aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle>No matching strings</EmptyTitle>
				<EmptyDescription>
					Try a name, source text, or translation.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

const CATALOG_SCOPE_DEFINITIONS = [
	{ scope: "introduced", label: "New from Git", countKey: "introduced" },
	{ scope: "waiting", label: "Waiting", countKey: "waiting" },
	{
		scope: "unconfirmedImport",
		label: "Unconfirmed",
		countKey: "unconfirmedImport",
	},
	{ scope: "stale", label: "Source changed", countKey: "stale" },
] as const satisfies ReadonlyArray<{
	scope: CatalogValueScope;
	label: string;
	countKey: "introduced" | "waiting" | "unconfirmedImport" | "stale";
}>;

function BatchImportConfirmation({
	summary,
	projectionId,
	onStart,
}: {
	summary: StringsOrdinaryImportsSummary;
	projectionId: string;
	onStart: (expectedProjectionId: string, policy: "ordinary-v1") => void;
}) {
	const eligible = summary.eligible;

	const skippedFromCounts =
		summary.empty +
		summary.sourceIdentical +
		summary.repeated +
		summary.modified +
		summary.stale +
		summary.pendingSourceProposal +
		summary.introduced;

	if (summary.run?.status === "running") {
		return (
			<Button type="button" size="xs" variant="ghost" disabled>
				<LoaderCircle aria-hidden="true" className="animate-spin" />
				Confirming {NUMBER_FORMAT.format(summary.run.confirmed)} confirmed ·{" "}
				{NUMBER_FORMAT.format(summary.run.skipped)} skipped
			</Button>
		);
	}

	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={<Button type="button" size="xs" variant="outline" />}
			>
				<CheckCheck aria-hidden="true" />
				Confirm ordinary · {NUMBER_FORMAT.format(eligible)}
			</AlertDialogTrigger>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{eligible === 0
							? "No ordinary imports are ready"
							: `Confirm ${NUMBER_FORMAT.format(eligible)} ordinary imports?`}
					</AlertDialogTitle>
					<AlertDialogDescription>
						<span className="block">
							These imported values are non-empty, unedited, and differ from the
							source and every other translation of the same key.
						</span>
						<span className="mt-2 block">
							{NUMBER_FORMAT.format(skippedFromCounts)} suspicious or already
							edited values stay unconfirmed. This checks the whole catalog,
							revalidating each value before confirming it.
						</span>
						{summary.introduced > 0 ? (
							<span className="mt-2 block">
								{NUMBER_FORMAT.format(summary.introduced)} values belong to keys
								newly imported from Git and need a separate first review.
							</span>
						) : null}
						{summary.run?.status === "done" ? (
							<span className="mt-2 block">
								Last run: {NUMBER_FORMAT.format(summary.run.confirmed)}{" "}
								confirmed, {NUMBER_FORMAT.format(summary.run.skipped)} skipped.
							</span>
						) : null}
						{summary.run?.status === "superseded" ? (
							<span className="mt-2 block">
								The previous run stopped early: the Baseline changed. Start it
								again to confirm this catalog.
							</span>
						) : null}
						{summary.run?.status === "failed" ? (
							<span className="mt-2 block text-destructive">
								The previous run failed.{" "}
								{summary.run.failure?.message ?? "Retry it to continue."}
							</span>
						) : null}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						{eligible === 0 ? "Close" : "Cancel"}
					</AlertDialogCancel>
					{eligible > 0 ? (
						<AlertDialogAction
							onClick={() => onStart(projectionId, summary.policy)}
						>
							Confirm ordinary imports
						</AlertDialogAction>
					) : null}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function CatalogScopeStrip({
	counts,
	introducedMessageCount,
	navigationState,
	onNavigationChange,
	ordinaryImports,
	projectionId,
	onStartOrdinaryImportRun,
	workHandoff,
}: {
	counts: StringsNavigationRead["valueStateCounts"];
	introducedMessageCount: number | undefined;
	navigationState: StringsCatalogNavigationState;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	ordinaryImports?: StringsOrdinaryImportsSummary;
	projectionId?: string;
	onStartOrdinaryImportRun?: (
		expectedProjectionId: string,
		policy: "ordinary-v1",
	) => void;
	workHandoff?: { keyCount: number; onClear: () => void };
}) {
	if (useContext(CatalogControlsContext).showFocusControls === false)
		return null;
	return (
		<nav
			className="flex flex-wrap items-center gap-1.5"
			aria-label="Catalog scopes"
			aria-live="polite"
		>
			<span className="mr-1 text-[11px] text-muted-foreground">Focus</span>
			{workHandoff && workHandoff.keyCount > 0 ? (
				<Button
					type="button"
					size="xs"
					variant="secondary"
					onClick={workHandoff.onClear}
					aria-label="Clear Release work hand-off"
				>
					Release work · {NUMBER_FORMAT.format(workHandoff.keyCount)}
					<X aria-hidden="true" />
				</Button>
			) : null}
			{CATALOG_SCOPE_DEFINITIONS.map(({ scope, label, countKey }) => {
				const active = navigationState.scope === scope;
				const count =
					countKey === "introduced"
						? introducedMessageCount
						: counts?.[countKey];
				return (
					<Button
						key={scope}
						type="button"
						size="xs"
						variant={active ? "secondary" : "ghost"}
						aria-pressed={active}
						title={
							countKey === "introduced"
								? "Keys across the selected languages"
								: "Values across the selected languages"
						}
						aria-label={`${active ? "Clear" : "Show"} ${label} scope (${count ?? "counting"})`}
						onClick={() =>
							onNavigationChange({
								...navigationState,
								scope: active ? undefined : scope,
								key: undefined,
							})
						}
					>
						{label} · <span className="tabular-nums">{count ?? "…"}</span>
						{active ? <X aria-hidden="true" /> : null}
					</Button>
				);
			})}
			{ordinaryImports && projectionId && onStartOrdinaryImportRun ? (
				<BatchImportConfirmation
					summary={ordinaryImports}
					projectionId={projectionId}
					onStart={onStartOrdinaryImportRun}
				/>
			) : null}
		</nav>
	);
}

function CatalogSearch({
	query,
	onNavigationChange,
	navigationState,
}: {
	query: string;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	navigationState: StringsCatalogNavigationState;
}) {
	const controls = useContext(CatalogControlsContext);
	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
			<div className="relative min-w-0 flex-1">
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="search"
					value={query}
					onChange={(event) =>
						onNavigationChange({
							...navigationState,
							query: event.target.value,
						})
					}
					placeholder={
						controls.searchPlaceholder ?? "Search keys and translations"
					}
					aria-label="Search strings"
					className="pl-8"
				/>
			</div>
			{query ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => onNavigationChange({ ...navigationState, query: "" })}
					aria-label={`Clear search: ${query}`}
				>
					Search: {query}
					<X aria-hidden="true" />
				</Button>
			) : null}
		</div>
	);
}

/** Last known rendered card heights, keyed by projection and message
 * identifier. Module-level so filter changes and route revisits keep the
 * measurements; cleared when a new Baseline projection invalidates them. */
const cardMeasurementCache = new StringsCardMeasurementCache();

function CatalogKeyPlaceholder({ height }: { height: number }) {
	return (
		<div
			aria-hidden="true"
			data-catalog-placeholder="true"
			className="flex min-h-52 flex-col justify-center gap-5 border-border/40 border-b py-5"
			style={{ height }}
		>
			<Skeleton className="h-2.5 w-44 opacity-40" />
			<div className="grid grid-cols-[1.5rem_minmax(0,36rem)] items-center gap-x-4 gap-y-4">
				{[0, 1, 2, 3].map((index) => (
					<div className="contents" key={index}>
						<Skeleton className="h-2 w-4 opacity-30" />
						<Skeleton
							className={cn(
								"h-2.5 opacity-30",
								index % 2 === 0 ? "w-3/4" : "w-1/2",
							)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

export function StringsCatalogLoadingRows({ rows = 3 }: { rows?: number }) {
	return (
		<div aria-label="Loading catalog" className="flex flex-col" role="status">
			{CATALOG_LOADING_ROW_KEYS.slice(0, rows).map((key) => (
				<CatalogKeyPlaceholder height={208} key={key} />
			))}
		</div>
	);
}

function VirtualizedCatalog({
	digests,
	targetId,
	canEdit,
	projectionId,
	hydratedCards,
	onWindowMessageIdsChange,
	onNavigationChange,
	onCommitValue,
	selectedMessageIds,
	onSelectedMessageChange,
}: {
	digests: readonly StringsNavigationDigest[];
	targetId: string | undefined;
	canEdit: boolean;
	projectionId: string;
	hydratedCards: StringsWindowCards;
	onWindowMessageIdsChange: (messageIds: string[]) => void;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	onCommitValue?: CommitCatalogValue;
	selectedMessageIds: ReadonlySet<string>;
	onSelectedMessageChange: (messageId: string, selected: boolean) => void;
}) {
	const scrollElementRef = useRef<HTMLDivElement>(null);
	const lastTargetRef = useRef<string | undefined>(undefined);
	const lastWindowRequestRef = useRef<{
		projectionId: string;
		messageIds: readonly string[];
	}>({ projectionId: "", messageIds: [] });
	// The project shell is a full-height grid whose content region owns the only
	// scrollbar — the window itself never scrolls. So the catalog virtualizes
	// against that region rather than against the window or a box of its own:
	// a nested scroller would put a second scrollbar inside the first, and
	// window scrolling simply never fires here.
	const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
	const [scrollMargin, setScrollMargin] = useState(0);
	useLayoutEffect(() => {
		const node = scrollElementRef.current;
		if (!node) return;
		let parent = node.parentElement;
		while (parent) {
			const overflowY = getComputedStyle(parent).overflowY;
			if (overflowY === "auto" || overflowY === "scroll") break;
			parent = parent.parentElement;
		}
		setScrollParent(parent);
		const measure = () => {
			const element = scrollElementRef.current;
			if (!element || !parent) {
				setScrollMargin(0);
				return;
			}
			setScrollMargin(
				element.getBoundingClientRect().top -
					parent.getBoundingClientRect().top +
					parent.scrollTop,
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);
	const [pendingWorkspaceFocus, setPendingWorkspaceFocus] =
		useState<CatalogWorkspaceFocusTarget | null>(null);
	// A new Baseline projection invalidates every cached measurement.
	useEffect(() => {
		if (projectionId === "") return;
		cardMeasurementCache.clear();
	}, [projectionId]);

	const getItemKey = useCallback(
		(index: number) => digests[index]?.messageId ?? index,
		[digests],
	);
	// The catalog scrolls with the page. A nested scroll region put the whole
	// catalog inside a fraction of the viewport, which is the single reason a
	// translator saw one key at a time.
	const virtualizer = useVirtualizer({
		count: digests.length,
		getScrollElement: () => scrollParent,
		// Estimate every selected language row until the actual card is measured. A card
		// measured before keeps its last known height instead of collapsing to
		// the stable estimate on re-entry.
		estimateSize: (index) =>
			cardMeasurementCache.estimate(
				`${projectionId}:${digests[index]?.targets.length ?? 0}`,
				digests[index]?.messageId ?? "",
				estimateStringsCardHeight(digests[index]?.targets.length ?? 0),
			),
		initialRect: INITIAL_CATALOG_RECT,
		scrollMargin,
		getItemKey,
		overscan: 2,
		useFlushSync: false,
		// Scroll-only position changes stay off React's render path. Range changes
		// still render normally, while the memoized card editors keep their state.
		directDomUpdates: true,
	});
	// A new search or scope is a new result set: the visible range resets to
	// the first match instead of leaving the viewport wherever clamping lands
	// it. A key permalink navigates instead (handled below).
	const resultSignature = `${digests.length}:${digests[0]?.messageId ?? ""}`;
	// The method is stable in the virtualizer instance; resultSignature is the
	// intentional trigger for resetting the scroll position after filtering.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resultSignature is the deliberate reset trigger.
	useEffect(() => {
		virtualizer.scrollToOffset(0);
	}, [resultSignature]);
	const targetToken = targetId;

	useEffect(() => {
		if (targetId === undefined || targetToken === undefined) {
			lastTargetRef.current = undefined;
			return;
		}

		if (targetToken === lastTargetRef.current) {
			return;
		}

		const targetIndex = digests.findIndex(
			(digest) => digest.messageId === targetId,
		);
		if (targetIndex >= 0) {
			virtualizer.scrollToIndex(targetIndex, { align: "center" });
		}
		lastTargetRef.current = targetToken;
	}, [targetId, targetToken, digests, virtualizer]);

	// Focus targets come from the compact digests, so traversal never needs
	// the hydrated cards of keys outside the window. Source is first because it
	// is an editable value too; a digest target lacks the cosmetic
	// classification, which reads conservatively as semantic.
	const workspaceFocusTargets = useMemo(
		() =>
			canEdit
				? digests.flatMap((digest, keyIndex) => [
						{
							messageId: digest.messageId,
							localeId: digest.source.localeId,
							keyIndex,
						},
						...digest.targets
							.filter((target) => target.gitValueFingerprint !== undefined)
							.map((target) => ({
								messageId: digest.messageId,
								localeId: target.localeId,
								keyIndex,
								valueState: target.valueState,
								sourceChangeKind: undefined,
							})),
					])
				: [],
		[digests, canEdit],
	);
	const onMoveFocus = useCallback(
		(request: WorkspaceFocusRequest) => {
			const { messageId, localeId, ...intent } = request;
			const next = nextCatalogWorkspaceFocusTarget(
				workspaceFocusTargets,
				{ messageId, localeId },
				intent,
			);
			if (!next) return false;

			setPendingWorkspaceFocus(next);
			return true;
		},
		[workspaceFocusTargets],
	);

	// Only the visible rows plus their overscan stay subscribed. The parent
	// owns the Window subscription; this callback fires with a stable,
	// stride-aligned identifier list whenever the desired window changes.
	const virtualItems = virtualizer.getVirtualItems();
	const visibleStart =
		virtualizer.range?.startIndex ?? virtualItems[0]?.index ?? 0;
	const visibleEnd = (virtualizer.range?.endIndex ?? visibleStart) + 1;
	const windowKeyCap = stringsWindowKeyCap(
		Math.max(0, ...digests.map((digest) => digest.targets.length)),
	);
	// Record hydrated rows' measured heights so the cache can seed later
	// estimates. Skeleton rows never write: their height is the estimate.
	useEffect(() => {
		for (const virtualRow of virtualItems) {
			const digest = digests[virtualRow.index];
			if (!digest) continue;
			if (!hydratedCards.has(digest.messageId)) continue;
			cardMeasurementCache.record(
				`${projectionId}:${digest.targets.length}`,
				digest.messageId,
				virtualRow.size,
			);
		}
	}, [virtualItems, digests, hydratedCards, projectionId]);
	useEffect(() => {
		if (virtualItems.length === 0) {
			if (
				lastWindowRequestRef.current.projectionId === projectionId &&
				lastWindowRequestRef.current.messageIds.length === 0
			) {
				return;
			}
			lastWindowRequestRef.current = { projectionId, messageIds: [] };
			onWindowMessageIdsChange([]);
			return;
		}
		const first = visibleStart;
		const last = visibleEnd - 1;
		const bounds = quantizeStringsWindowBounds(
			first,
			last + 1,
			digests.length,
			windowKeyCap,
		);
		const messageIds = collectStringsWindowMessageIds({
			orderedMessageIds: digests.map((digest) => digest.messageId),
			bounds,
			extraMessageIds: [
				...(targetId === undefined ? [] : [targetId]),
				...(pendingWorkspaceFocus === null
					? []
					: [pendingWorkspaceFocus.messageId]),
			],
			cap: windowKeyCap,
			visibleBounds: { start: visibleStart, end: visibleEnd },
		});
		if (
			lastWindowRequestRef.current.projectionId === projectionId &&
			sameStringsWindowMessageIds(
				lastWindowRequestRef.current.messageIds,
				messageIds,
			)
		) {
			return;
		}
		lastWindowRequestRef.current = { projectionId, messageIds };
		onWindowMessageIdsChange(messageIds);
	}, [
		visibleStart,
		visibleEnd,
		windowKeyCap,
		virtualItems,
		digests,
		projectionId,
		targetId,
		pendingWorkspaceFocus,
		onWindowMessageIdsChange,
	]);

	useEffect(() => {
		if (!pendingWorkspaceFocus) return;
		let animationFrame: number | undefined;
		let attempts = 0;
		let requestedScroll = false;
		const focusPendingField = () => {
			const field = Array.from(
				scrollElementRef.current?.querySelectorAll<
					HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
				>("[data-workspace-message-id][data-workspace-locale-id]") ?? [],
			).find(
				(candidate) =>
					candidate.dataset.workspaceMessageId ===
						pendingWorkspaceFocus.messageId &&
					candidate.dataset.workspaceLocaleId ===
						pendingWorkspaceFocus.localeId,
			);
			const viewport = scrollParent?.getBoundingClientRect();
			if (
				field &&
				viewport &&
				isCatalogWorkspaceFieldVisible({
					fieldTop: field.getBoundingClientRect().top,
					fieldBottom: field.getBoundingClientRect().bottom,
					viewportTop: viewport.top,
					viewportBottom: viewport.bottom,
				})
			) {
				field.focus({ preventScroll: true });
				setPendingWorkspaceFocus(null);
				return;
			}
			if (attempts >= 24) {
				const card = hydratedCards.get(pendingWorkspaceFocus.messageId);
				const valueArrived =
					card?.source.localeId === pendingWorkspaceFocus.localeId ||
					card?.targets.some(
						(value) => value.localeId === pendingWorkspaceFocus.localeId,
					);
				// Queued language batches may take longer than a layout retry.
				// Stop polling, but retry when hydration supplies the requested field.
				if (valueArrived) setPendingWorkspaceFocus(null);
				return;
			}
			if (!requestedScroll) {
				virtualizer.scrollToIndex(pendingWorkspaceFocus.keyIndex, {
					align: "auto",
				});
				requestedScroll = true;
			}
			attempts++;
			animationFrame = requestAnimationFrame(focusPendingField);
		};
		const cancelOnOtherFocus = (event: FocusEvent) => {
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.dataset.workspaceMessageId !==
					pendingWorkspaceFocus.messageId ||
					target.dataset.workspaceLocaleId !== pendingWorkspaceFocus.localeId)
			)
				setPendingWorkspaceFocus(null);
		};
		document.addEventListener("focusin", cancelOnOtherFocus);
		focusPendingField();
		return () => {
			document.removeEventListener("focusin", cancelOnOtherFocus);
			if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
		};
	}, [pendingWorkspaceFocus, scrollParent, virtualizer, hydratedCards]);

	if (digests.length === 0) return <EmptySearchResult />;

	return (
		<section ref={scrollElementRef} aria-label="Catalog results">
			<div ref={virtualizer.containerRef} className="relative w-full">
				{virtualItems.map((virtualRow) => {
					const digest = digests[virtualRow.index];
					if (!digest) return null;
					const card = hydratedCards.get(digest.messageId);

					return (
						<div
							key={digest.messageId}
							ref={virtualizer.measureElement}
							data-index={virtualRow.index}
							data-catalog-key={digest.messageId}
							data-hydrated={card ? true : undefined}
							className="absolute top-0 left-0 w-full"
							style={{
								...(card ? {} : { height: `${virtualRow.size}px` }),
							}}
						>
							{card ? (
								<CatalogKeyCard
									catalogKey={card}
									introductionReviewPending={digest.introductionReviewPending}
									highlighted={digest.messageId === targetId}
									onNavigationChange={onNavigationChange}
									onCommitValue={onCommitValue}
									onMoveFocus={onMoveFocus}
									canEdit={canEdit}
									selected={selectedMessageIds.has(digest.messageId)}
									onSelectedChange={onSelectedMessageChange}
								/>
							) : (
								<CatalogKeyPlaceholder height={virtualRow.size} />
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}

const MAX_TRANSLATION_TASK_KEYS = 32;

function TranslationTaskSelection({
	selectedMessageIds,
	locales,
	onClear,
	onCreate,
	showSelectionSummary,
}: {
	selectedMessageIds: readonly string[];
	locales: readonly { localeId: string; localeCode: string }[];
	onClear: () => void;
	onCreate: CreateTranslationTask;
	showSelectionSummary: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [localeId, setLocaleId] = useState(locales[0]?.localeId ?? "");
	const [title, setTitle] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectedLocale =
		locales.find((locale) => locale.localeId === localeId) ?? locales[0];
	const openDialog = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) return;
		const nextLocale = selectedLocale ?? locales[0];
		if (nextLocale) setLocaleId(nextLocale.localeId);
		setTitle(
			`Improve ${nextLocale?.localeCode ?? "translations"} · ${selectedMessageIds.length} ${selectedMessageIds.length === 1 ? "string" : "strings"}`,
		);
		setError(null);
	};
	const create = async () => {
		if (
			!selectedLocale ||
			title.trim().length === 0 ||
			isCreating ||
			selectedMessageIds.length > MAX_TRANSLATION_TASK_KEYS
		)
			return;
		setIsCreating(true);
		setError(null);
		try {
			await onCreate({
				title: title.trim(),
				localeId: selectedLocale.localeId,
				messageIds: selectedMessageIds,
			});
			setOpen(false);
			onClear();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not create the translation task.",
			);
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2",
				showSelectionSummary
					? "sticky top-2 z-20 border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/80"
					: "justify-end",
			)}
		>
			{showSelectionSummary ? (
				<>
					<ListChecks
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					<p className="text-xs">{selectedMessageIds.length} selected</p>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="ml-auto"
						onClick={onClear}
					>
						Clear
					</Button>
				</>
			) : null}
			{selectedMessageIds.length > MAX_TRANSLATION_TASK_KEYS ? (
				<p className="text-muted-foreground text-xs">
					Select up to {MAX_TRANSLATION_TASK_KEYS} strings to start a task.
				</p>
			) : null}
			<AlertDialog open={open} onOpenChange={openDialog}>
				<AlertDialogTrigger
					disabled={selectedMessageIds.length > MAX_TRANSLATION_TASK_KEYS}
					render={<Button type="button" size="xs" variant="default" />}
				>
					Start task
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Start a translation task</AlertDialogTitle>
						<AlertDialogDescription>
							An agent prepares translations for these strings in one language.
							Review them before applying.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="flex flex-col gap-3">
						<fieldset className="flex flex-wrap gap-1.5">
							<legend className="sr-only">Target language</legend>
							{locales.map((locale) => (
								<Button
									key={locale.localeId}
									type="button"
									size="xs"
									variant={
										locale.localeId === selectedLocale?.localeId
											? "secondary"
											: "outline"
									}
									aria-pressed={locale.localeId === selectedLocale?.localeId}
									onClick={() => {
										setLocaleId(locale.localeId);
										setTitle(
											`Improve ${locale.localeCode} · ${selectedMessageIds.length} ${selectedMessageIds.length === 1 ? "string" : "strings"}`,
										);
									}}
								>
									{locale.localeCode}
								</Button>
							))}
						</fieldset>
						<Input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							aria-label="Task title"
							placeholder="Task title"
						/>
						<p className="text-muted-foreground text-xs">
							{selectedMessageIds.length} string
							{selectedMessageIds.length === 1 ? "" : "s"} ·{" "}
							{selectedLocale?.localeCode}
						</p>
						{error ? (
							<p className="text-destructive text-xs" role="alert">
								{error}
							</p>
						) : null}
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isCreating}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={
								isCreating ||
								!selectedLocale ||
								title.trim().length === 0 ||
								selectedMessageIds.length > MAX_TRANSLATION_TASK_KEYS
							}
							onClick={(event) => {
								event.preventDefault();
								void create();
							}}
						>
							{isCreating ? "Creating…" : "Create task"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function StringsCatalogNavigator({
	navigation,
	navigationState,
	onNavigationChange,
	onCommitValue,
	hydratedCards,
	onWindowMessageIdsChange,
	ordinaryImports,
	onStartOrdinaryImportRun,
	onStartNavigationBackfill,
	workHandoff,
	onCreateTranslationTask,
}: {
	navigation: StringsNavigationRead;
	navigationState: StringsCatalogNavigationState;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	onCommitValue?: CommitCatalogValue;
	hydratedCards: StringsWindowCards;
	onWindowMessageIdsChange: (messageIds: string[]) => void;
	ordinaryImports?: StringsOrdinaryImportsSummary;
	onStartOrdinaryImportRun?: (
		expectedProjectionId: string,
		policy: "ordinary-v1",
	) => void;
	onStartNavigationBackfill?: () => void;
	workHandoff?: { keyCount: number; onClear: () => void };
	onCreateTranslationTask?: CreateTranslationTask;
}) {
	const matching = useMemo(
		() =>
			navigateStringsDigests(navigation, {
				key: navigationState.key,
				handoffMessageIds: navigationState.handoffMessageIds,
			}),
		[navigation, navigationState.key, navigationState.handoffMessageIds],
	);
	const projectionId = navigation.projectionId ?? "";
	const introducedMessageCount = navigation.introducedMessageCount;
	const [localSelection, setLocalSelection] = useState<Set<string>>(
		() => new Set(),
	);
	const controls = useContext(CatalogControlsContext);
	const selectedMessageIds = useMemo(
		() =>
			controls.selectedMessageIds === undefined
				? localSelection
				: new Set(controls.selectedMessageIds),
		[controls.selectedMessageIds, localSelection],
	);
	const changeSelection = useCallback(
		(next: Set<string>) => {
			if (controls.selectedMessageIds === undefined) setLocalSelection(next);
			controls.onSelectionChange?.([...next]);
		},
		[controls.selectedMessageIds, controls.onSelectionChange],
	);
	const onSelectedMessageChange = useCallback(
		(messageId: string, selected: boolean) => {
			const next = new Set(selectedMessageIds);
			if (selected) next.add(messageId);
			else next.delete(messageId);
			changeSelection(next);
		},
		[selectedMessageIds, changeSelection],
	);
	const taskLocales = useMemo(() => {
		// Project membership is independent of the current browse page and of
		// the display-language filter. A retained selection can be entirely offscreen.
		const sourceLocaleId =
			controls.sourceLocaleId ?? navigation.keys?.[0]?.source.localeId;
		if (controls.availableLocales && sourceLocaleId) {
			return controls.availableLocales
				.filter((locale) => locale.id !== sourceLocaleId)
				.map((locale) => ({ localeId: locale.id, localeCode: locale.code }));
		}
		return translationTaskLocales(navigation.keys ?? [], selectedMessageIds);
	}, [
		controls.availableLocales,
		controls.sourceLocaleId,
		navigation.keys,
		selectedMessageIds,
	]);

	if (navigation.kind === "incomplete") {
		const failed = navigation.status === "failed";
		const preparing =
			(navigation.status === "staging" || navigation.status === "verifying") &&
			navigation.stepPending === true;
		const progress = navigation.progress;
		const progressLabel = progress
			? `${NUMBER_FORMAT.format(progress.rowCount)} of ${NUMBER_FORMAT.format(progress.expectedRowCount)} keys prepared`
			: undefined;
		return (
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3">
					<div className="flex min-w-0 flex-col gap-1">
						<p
							className="font-medium text-sm"
							role={failed ? "alert" : "status"}
						>
							{failed
								? "Catalog preparation stopped"
								: navigation.status === "missing"
									? "Prepare this catalog for fast browsing"
									: "Catalog preparation is in progress"}
						</p>
						<p className="text-muted-foreground text-xs">
							{progressLabel ??
								"Prepare the catalog once to browse its strings."}
						</p>
					</div>
					{navigation.canEdit && onStartNavigationBackfill ? (
						<Button
							disabled={preparing}
							size="sm"
							onClick={onStartNavigationBackfill}
						>
							{preparing ? (
								<LoaderCircle
									className="animate-spin"
									data-icon="inline-start"
								/>
							) : null}
							{failed
								? "Retry preparation"
								: navigation.status === "missing"
									? "Prepare catalog"
									: preparing
										? "Preparing catalog"
										: "Resume preparation"}
						</Button>
					) : (
						<p className="text-muted-foreground text-xs">
							An editor needs to finish this preparation.
						</p>
					)}
				</div>
				{failed && navigation.failure?.message ? (
					<p className="text-destructive text-xs" role="alert">
						{navigation.failure.message}
					</p>
				) : null}
				<StringsCatalogLoadingRows />
			</div>
		);
	}

	if (projectionId === "") return <EmptyBaselineCatalog />;

	return (
		<div className="flex flex-col gap-3">
			<CatalogScopeStrip
				counts={navigation.valueStateCounts}
				introducedMessageCount={introducedMessageCount}
				navigationState={navigationState}
				onNavigationChange={onNavigationChange}
				ordinaryImports={ordinaryImports}
				projectionId={projectionId}
				onStartOrdinaryImportRun={onStartOrdinaryImportRun}
				workHandoff={workHandoff}
			/>
			<CatalogSearch
				query={navigationState.query}
				navigationState={navigationState}
				onNavigationChange={onNavigationChange}
			/>
			{selectedMessageIds.size > 0 && onCreateTranslationTask ? (
				<TranslationTaskSelection
					selectedMessageIds={[...selectedMessageIds]}
					locales={taskLocales}
					showSelectionSummary={controls.selectedMessageIds === undefined}
					onClear={() => changeSelection(new Set())}
					onCreate={onCreateTranslationTask}
				/>
			) : null}
			<VirtualizedCatalog
				digests={matching.matchingDigests}
				targetId={matching.target?.id}
				canEdit={navigation.canEdit ?? false}
				projectionId={projectionId}
				hydratedCards={hydratedCards}
				onWindowMessageIdsChange={onWindowMessageIdsChange}
				onNavigationChange={onNavigationChange}
				onCommitValue={onCommitValue}
				selectedMessageIds={selectedMessageIds}
				onSelectedMessageChange={onSelectedMessageChange}
			/>
		</div>
	);
}

/** Strings receives a server-filtered browse page and hydrates only its visible
 * card window. The route owns page navigation; the virtualizer limits mounting.
 * The Source Contract stays immutable in its projection; an editor may
 * instead commit a value-only Source Proposal through the same Workspace
 * seam as target work. */
function StringsCatalogContent({
	navigation,
	navigationState,
	onNavigationChange,
	onConnectCheckout,
	onCommitValue,
	hydratedCards,
	onWindowMessageIdsChange,
	ordinaryImports,
	onStartOrdinaryImportRun,
	onStartNavigationBackfill,
	workHandoff,
	onCreateTranslationTask,
	emptyContent,
}: {
	emptyContent?: React.ReactNode;
	navigation: StringsNavigationRead | undefined;
	navigationState: StringsCatalogNavigationState;
	onNavigationChange: (state: StringsCatalogNavigationState) => void;
	onConnectCheckout: () => void;
	onCommitValue?: CommitCatalogValue;
	hydratedCards: StringsWindowCards;
	onWindowMessageIdsChange: (messageIds: string[]) => void;
	ordinaryImports?: StringsOrdinaryImportsSummary;
	onStartOrdinaryImportRun?: (
		expectedProjectionId: string,
		policy: "ordinary-v1",
	) => void;
	onStartNavigationBackfill?: () => void;
	workHandoff?: { keyCount: number; onClear: () => void };
	onCreateTranslationTask?: CreateTranslationTask;
}) {
	if (navigation === undefined) return <StringsCatalogLoadingRows rows={1} />;
	if (navigation.kind === "noBaseline")
		return <NoBaselineCatalog onConnect={onConnectCheckout} />;
	if (
		navigation.kind === "ready" &&
		(navigation.keys?.length ?? 0) === 0 &&
		(navigation.keyCount ?? 0) === 0
	) {
		return emptyContent ?? <EmptyBaselineCatalog />;
	}

	return (
		<StringsCatalogNavigator
			key={navigation.projectionId}
			navigation={navigation}
			navigationState={navigationState}
			onNavigationChange={onNavigationChange}
			onCommitValue={onCommitValue}
			hydratedCards={hydratedCards}
			onWindowMessageIdsChange={onWindowMessageIdsChange}
			ordinaryImports={ordinaryImports}
			onStartOrdinaryImportRun={onStartOrdinaryImportRun}
			onStartNavigationBackfill={onStartNavigationBackfill}
			workHandoff={workHandoff}
			onCreateTranslationTask={onCreateTranslationTask}
		/>
	);
}

/** The route keys this owner by project. A new projection or a filtered-out
 * row must not replace the editing session that holds its concurrency basis. */
export function StringsCatalogView(
	props: React.ComponentProps<typeof StringsCatalogContent> &
		CatalogControls & {
			onUnsavedWorkChange?: (hasUnsavedWork: boolean) => void;
		},
) {
	const [drafts] = useState(() => new CatalogEditorDrafts());
	const [advanced, setAdvanced] = useState<{
		key: StringsCatalogKey;
		localeId?: string;
		returnFocus: HTMLElement | null;
	} | null>(null);
	const openAdvanced = useCallback(
		(key: StringsCatalogKey, localeId?: string) => {
			setAdvanced({
				key,
				localeId,
				returnFocus:
					document.activeElement instanceof HTMLElement
						? document.activeElement
						: null,
			});
		},
		[],
	);
	const closeAdvanced = () => {
		if (props.onBeforeCloseAdvanced?.() === false) return;
		setAdvanced(null);
	};
	const advancedKey = advanced
		? (props.hydratedCards.get(advanced.key.id) ?? advanced.key)
		: null;
	const advancedLocales = advancedKey
		? (props.availableLocales ??
			[advancedKey.source, ...advancedKey.targets].map((value) => ({
				id: value.localeId ?? value.localeCode,
				code: value.localeCode,
			})))
		: [];
	return (
		<CatalogControlsContext value={{ ...props, onOpenAdvanced: openAdvanced }}>
			<CatalogDraftsContext value={drafts}>
				<CatalogDraftRecovery
					drafts={drafts}
					navigation={props.navigation}
					onUnsavedWorkChange={props.onUnsavedWorkChange}
				/>
				<StringsCatalogContent {...props} />
				{advanced && advancedKey ? (
					<CatalogAdvancedView
						key={advancedKey.id}
						title={
							stringDisplayName({
								id: advancedKey.id,
								name: advancedKey.name,
								sourceValue: advancedKey.source.value,
							}).label
						}
						locales={advancedLocales}
						initialLocaleId={
							advanced.localeId ??
							advancedKey.source.localeId ??
							advancedKey.source.localeCode
						}
						initiallyShowProperties={advanced.localeId === undefined}
						properties={props.renderProperties?.(advancedKey, () =>
							setAdvanced(null),
						)}
						onClose={closeAdvanced}
						returnFocus={advanced.returnFocus}
						renderValue={(localeId) => {
							if (props.renderAdvancedValue)
								return props.renderAdvancedValue(advancedKey, localeId);
							const value = [advancedKey.source, ...advancedKey.targets].find(
								(candidate) =>
									(candidate.localeId ?? candidate.localeCode) === localeId,
							);
							return value ? (
								<CatalogWorkspaceValueField
									advanced
									messageId={advancedKey.id}
									value={value}
									sourceValue={advancedKey.source.value}
									characterLimit={advancedKey.characterLimit}
									canEdit={props.onCommitValue !== undefined}
									onCommitValue={props.onCommitValue}
								/>
							) : null;
						}}
					/>
				) : null}
			</CatalogDraftsContext>
		</CatalogControlsContext>
	);
}
