import { Button } from "@blabla/ui/components/button";
import { Textarea } from "@blabla/ui/components/textarea";
import { cn } from "@blabla/ui/lib/utils";
import {
	type FocusEventHandler,
	type KeyboardEventHandler,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	addPluralArm,
	availablePluralArms,
	type MessageArm,
	type MessageSegment,
	type PluralArm,
	type PluralArmSelector,
	type RepresentativeArmHighlight,
	readMessageSegments,
	removeMessageArm,
	representativeArmHighlights,
	writeMessageArm,
	writePluralRepresentativeArm,
	writeTextSegment,
} from "@/lib/icu-message-segments";

type EditableFieldElement = HTMLInputElement | HTMLTextAreaElement;
type EditorKeyboardEventHandler = KeyboardEventHandler<EditableFieldElement>;
type EditorFocusEventHandler = FocusEventHandler<HTMLElement>;

type IcuMessageSegmentEditorProps = {
	format?: "icu" | "plain";
	messageId: string;
	messageLabel?: string;
	localeId: string;
	localeCode: string;
	sourceValue?: string;
	value: string;
	disabled: boolean;
	canChangeStructure: boolean;
	onValueChange: (value: string) => void;
	onKeyDown: EditorKeyboardEventHandler;
	onFocus?: EditorFocusEventHandler;
	onBlur?: EditorFocusEventHandler;
	/** Strings renders values borderless at rest; the shared Textarea defaults
	 * are wrong for a page that has to read as text rather than as a form. */
	fieldClassName?: string;
	/** The raw-ICU escape stays available on every value, but a settled value
	 * offers no control at all, so its caller decides when it is on screen. */
	showRawToggle?: boolean;
};

type FieldProps = Pick<
	IcuMessageSegmentEditorProps,
	| "messageId"
	| "messageLabel"
	| "localeId"
	| "disabled"
	| "onKeyDown"
	| "onFocus"
	| "onBlur"
>;

const MONO = "font-mono text-[11px]";
const INLINE_FIELD =
	"field-sizing-content min-w-1 max-w-full rounded border-0 bg-transparent px-0.5 text-[13px] leading-relaxed shadow-none outline-none transition-colors hover:bg-muted/40 focus:bg-muted/60 focus-visible:ring-0";
const ARM_FIELD =
	"field-sizing-content min-h-0 w-full resize-none border-0 bg-transparent px-2 py-1 text-[13px] leading-relaxed shadow-none outline-none transition-colors hover:bg-muted/40 focus:bg-muted/60 focus-visible:border-0 focus-visible:ring-0 md:text-[13px] dark:bg-transparent dark:hover:bg-muted/30 dark:focus:bg-muted/50";

/** Segment order is part of the immutable ICU shape. The ordinal disambiguates
 * repeated arguments while preserving a field's identity through text edits. */
function messageSegmentKey(segment: MessageSegment, index: number): string {
	return segment.kind === "text"
		? `text-${index}`
		: `${segment.kind}-${segment.argument}-${index}`;
}

function fieldProps(input: FieldProps, label: string) {
	return {
		disabled: input.disabled,
		onKeyDown: input.onKeyDown,
		onFocus: input.onFocus,
		onBlur: input.onBlur,
		"aria-label": label,
		"aria-keyshortcuts": "Meta+Enter Control+Enter Escape Tab",
		"data-workspace-message-id": input.messageId,
		"data-workspace-locale-id": input.localeId,
	};
}

/** Arm fields are a small, local editing surface. Tab should move through the
 * visible cases; sentence fields keep the catalog-level Tab behavior. */
function armFieldProps(input: FieldProps, label: string) {
	const props = fieldProps(input, label);
	return {
		...props,
		onKeyDown: (event: React.KeyboardEvent<EditableFieldElement>) => {
			if (event.key !== "Tab") input.onKeyDown(event);
		},
	};
}

function armLabel(arm: MessageArm | PluralArm): string {
	return "label" in arm ? arm.label : arm.selector;
}

function isMissingArm(arm: MessageArm | PluralArm): boolean {
	return "present" in arm && arm.present === false;
}

function isExactPluralArm(arm: PluralArm): boolean {
	return arm.label.startsWith("=");
}

function selectorLabel(selector: PluralArmSelector): string {
	switch (selector) {
		case "zero":
			return "= 0";
		case "one":
			return "= 1";
		case "two":
			return "= 2";
		case "few":
			return "Few";
		case "many":
			return "Many";
		case "other":
			return "Other";
	}
}

function selectorDescription(selector: PluralArmSelector): string {
	switch (selector) {
		case "zero":
		case "one":
		case "two":
			return "exact count";
		case "other":
			return "fallback case";
		default:
			return "language category";
	}
}

function sameTextForEveryArm(arms: readonly PluralArm[]): boolean {
	const presentArms = arms.filter((arm) => !isMissingArm(arm));
	const first = presentArms[0]?.value;
	return (
		presentArms.length > 1 &&
		first !== undefined &&
		presentArms.every((arm) => arm.value === first)
	);
}

function ArmStripLine({
	arm,
	representative,
	selection,
	onChange,
	onRemove,
	onSelectionChange,
	field,
}: {
	arm: MessageArm | PluralArm;
	representative: boolean;
	selection: RepresentativeArmHighlight | undefined;
	onChange: (value: string) => void;
	onRemove?: () => void;
	onSelectionChange: () => void;
	field: FieldProps;
}) {
	const missing = isMissingArm(arm);
	const highlighted =
		selection !== undefined && selection.end > selection.start;
	return (
		<div className="group flex items-start gap-2">
			<span
				className={cn(
					MONO,
					"w-12 shrink-0 pt-1.5 text-right",
					representative
						? "text-foreground"
						: "label" in arm && isExactPluralArm(arm)
							? "text-amber-600/80 dark:text-amber-500/80"
							: missing
								? "text-muted-foreground/40"
								: "text-muted-foreground/65",
				)}
				title={missing ? "Not present yet; writing adds this case" : undefined}
			>
				{armLabel(arm)}
			</span>
			<div className="relative min-w-0 flex-1">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 whitespace-pre-wrap px-2 py-1 text-[13px] text-transparent leading-relaxed"
				>
					{highlighted && selection ? (
						<>
							{arm.value.slice(0, selection.start)}
							<mark className="rounded-[2px] bg-amber-300/50 text-transparent dark:bg-amber-500/40">
								{arm.value.slice(selection.start, selection.end)}
							</mark>
							{arm.value.slice(selection.end)}
						</>
					) : (
						arm.value
					)}
				</div>
				<Textarea
					{...armFieldProps(field, `${armLabel(arm)} arm`)}
					value={arm.value}
					placeholder={missing ? `Add ${armLabel(arm)}…` : undefined}
					onSelect={onSelectionChange}
					onChange={(event) => onChange(event.target.value)}
					className={cn(
						ARM_FIELD,
						missing &&
							"text-muted-foreground/65 placeholder:text-muted-foreground/35",
					)}
				/>
			</div>
			{onRemove ? (
				<button
					type="button"
					disabled={field.disabled}
					className="shrink-0 px-1 pt-1.5 font-mono text-[13px] text-muted-foreground/0 transition-colors hover:text-destructive focus-visible:text-foreground group-hover:text-muted-foreground/55"
					onClick={onRemove}
					aria-label={`Remove ${armLabel(arm)} arm`}
					title={`Remove ${armLabel(arm)} arm`}
				>
					×
				</button>
			) : null}
		</div>
	);
}

function AddPluralArmMenu({
	choices,
	disabled,
	onAdd,
	onEditorBlur,
}: {
	choices: readonly PluralArmSelector[];
	disabled: boolean;
	onAdd: (selector: PluralArmSelector) => void;
	onEditorBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const normalizedQuery = query.trim().toLowerCase();
	const shown = choices.filter((selector) => {
		return (
			normalizedQuery.length === 0 ||
			selector.includes(normalizedQuery) ||
			selectorLabel(selector).toLowerCase().includes(normalizedQuery)
		);
	});

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	if (choices.length === 0) return null;
	if (!open) {
		return (
			<button
				type="button"
				disabled={disabled}
				className={cn(
					MONO,
					"ml-14 rounded px-2 py-1 text-left text-muted-foreground/45 transition-colors hover:bg-muted/50 hover:text-muted-foreground disabled:opacity-50",
				)}
				onClick={() => {
					setOpen(true);
					setQuery("");
					setCursor(0);
				}}
			>
				+ add a case
			</button>
		);
	}

	return (
		<div className="relative ml-14 max-w-[28rem] rounded-md border bg-popover p-1 shadow-md">
			<input
				ref={inputRef}
				disabled={disabled}
				className={cn(
					MONO,
					"w-full bg-transparent px-2 py-1 outline-none placeholder:text-muted-foreground/40",
				)}
				placeholder="add a case…"
				value={query}
				onChange={(event) => {
					setQuery(event.target.value);
					setCursor(0);
				}}
				onBlur={(event) => {
					setOpen(false);
					onEditorBlur(event);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						setOpen(false);
						return;
					}
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setCursor((current) => Math.min(current + 1, shown.length - 1));
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setCursor((current) => Math.max(current - 1, 0));
						return;
					}
					if (event.key === "Enter") {
						const selector = shown[cursor];
						if (!selector) return;
						event.preventDefault();
						onAdd(selector);
						setOpen(false);
					}
				}}
			/>
			{shown.length > 0 ? (
				shown.map((selector, index) => (
					<button
						key={selector}
						type="button"
						disabled={disabled}
						className={cn(
							"flex w-full items-baseline gap-2 rounded px-2 py-1 text-left",
							index === cursor && "bg-muted",
						)}
						onMouseDown={(event) => {
							event.preventDefault();
							onAdd(selector);
							setOpen(false);
						}}
						onMouseEnter={() => setCursor(index)}
					>
						<span className={cn(MONO, "w-12 shrink-0 text-right")}>
							{selectorLabel(selector)}
						</span>
						<span className="text-[12px] text-muted-foreground">
							{selectorDescription(selector)}
						</span>
					</button>
				))
			) : (
				<p className="px-2 py-1 text-[12px] text-muted-foreground">
					No matching cases
				</p>
			)}
		</div>
	);
}

function ArmStrip({
	kind,
	argument,
	segmentIndex,
	arms,
	value,
	field,
	canChangeStructure,
	representativeSelector,
	highlights,
	onValueChange,
	onSelectionChange,
	onEditorBlur,
}: {
	kind: "plural" | "select";
	argument: string;
	segmentIndex: number;
	arms: readonly (MessageArm | PluralArm)[];
	value: string;
	field: FieldProps;
	canChangeStructure: boolean;
	representativeSelector?: string;
	highlights: readonly RepresentativeArmHighlight[];
	onValueChange: (value: string) => void;
	onSelectionChange: () => void;
	onEditorBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
}) {
	const representative = representativeSelector
		? arms.find((arm) => arm.selector === representativeSelector)
		: undefined;
	const highlightBySelector = new Map(
		highlights.map((highlight) => [highlight.selector, highlight]),
	);
	const choices = useMemo(() => {
		if (kind !== "plural") return [] as readonly PluralArmSelector[];
		try {
			return availablePluralArms({ value, segmentIndex });
		} catch {
			return [] as readonly PluralArmSelector[];
		}
	}, [kind, segmentIndex, value]);

	return (
		<div className="ml-2 flex flex-col border-muted-foreground/20 border-l pl-2">
			<div className="flex flex-wrap items-baseline gap-x-2 px-2 pt-1 pb-0.5">
				<span className={cn(MONO, "text-foreground/75")}>{argument}</span>
				<span className={cn(MONO, "text-muted-foreground/45")}>
					{kind === "plural"
						? representative
							? "editing above changes every case"
							: "edit one case at a time"
						: "edit one case at a time"}
				</span>
			</div>
			<div className="flex flex-col gap-0.5">
				{arms.map((arm) => (
					<ArmStripLine
						key={arm.selector}
						arm={arm}
						representative={arm.selector === representativeSelector}
						selection={highlightBySelector.get(arm.selector)}
						field={field}
						onSelectionChange={onSelectionChange}
						onChange={(armValue) => {
							onSelectionChange();
							onValueChange(
								writeMessageArm({
									value,
									segmentIndex,
									selector: arm.selector,
									armValue,
								}),
							);
						}}
						onRemove={
							canChangeStructure &&
							!isMissingArm(arm) &&
							!(arm.selector === "other" || ("required" in arm && arm.required))
								? () => {
										onSelectionChange();
										onValueChange(
											removeMessageArm({
												value,
												segmentIndex,
												selector: arm.selector,
											}),
										);
									}
								: undefined
						}
					/>
				))}
			</div>
			{kind === "plural" && canChangeStructure ? (
				<AddPluralArmMenu
					choices={choices}
					disabled={field.disabled}
					onEditorBlur={onEditorBlur}
					onAdd={(selector) => {
						onSelectionChange();
						onValueChange(
							addPluralArm({
								value,
								segmentIndex,
								selector,
								armValue: representative?.value ?? "",
							}),
						);
					}}
				/>
			) : null}
		</div>
	);
}

function StructuredMessageEditor({
	message,
	localeCode,
	field,
	fieldClassName,
	canChangeStructure,
	onValueChange,
}: {
	message: Extract<
		ReturnType<typeof readMessageSegments>,
		{ kind: "structured" }
	>;
	localeCode: string;
	field: FieldProps;
	fieldClassName?: string;
	canChangeStructure: boolean;
	onValueChange: (value: string) => void;
}) {
	const hasControl = message.segments.some(
		(segment) => segment.kind !== "text",
	);
	const [activeSegment, setActiveSegment] = useState<number | null>(null);
	const [expandedPluralSegments, setExpandedPluralSegments] = useState<
		ReadonlySet<number>
	>(new Set());
	const [selection, setSelection] = useState<{
		segmentIndex: number;
		start: number;
		end: number;
	} | null>(null);
	const [effect, setEffect] = useState<{
		value: string;
		segmentIndex: number;
		highlights: readonly RepresentativeArmHighlight[];
	} | null>(null);
	const structuredEditorRef = useRef<HTMLDivElement>(null);

	const toggleExpanded = (segmentIndex: number) => {
		setExpandedPluralSegments((current) => {
			const next = new Set(current);
			if (next.has(segmentIndex)) next.delete(segmentIndex);
			else next.add(segmentIndex);
			return next;
		});
	};

	const clearSelection = () => {
		setSelection(null);
		setEffect(null);
	};
	const isFocusInsideEditor = (target: EventTarget | null) =>
		target instanceof Node &&
		structuredEditorRef.current?.contains(target) === true;
	const closeActiveBlock = () => {
		setActiveSegment(null);
		clearSelection();
	};
	useLayoutEffect(() => {
		if (!field.disabled) return;
		// A disabled field does not reliably emit blur in every browser. Close
		// the compound surface as part of the save handoff instead of leaving
		// its transient layout behind until the reactive snapshot arrives.
		setActiveSegment(null);
		setSelection(null);
		setEffect(null);
	}, [field.disabled]);
	const structuredField: FieldProps = {
		...field,
		onBlur: (event) => {
			if (!isFocusInsideEditor(event.relatedTarget)) {
				field.onBlur?.(event);
				closeActiveBlock();
			}
		},
	};
	const handleInteractiveBlur = (
		event: React.FocusEvent<HTMLButtonElement>,
	) => {
		if (!isFocusInsideEditor(event.relatedTarget)) {
			field.onBlur?.(event);
		}
	};
	const handleMenuBlur = (event: React.FocusEvent<HTMLInputElement>) => {
		if (!isFocusInsideEditor(event.relatedTarget)) {
			field.onBlur?.(event);
		}
	};

	if (!hasControl) {
		return (
			<Textarea
				{...fieldProps(
					field,
					`Edit ${localeCode} value for ${field.messageLabel ?? field.messageId}`,
				)}
				value={message.value}
				onChange={(event) => onValueChange(event.target.value)}
				className={cn("min-h-20", fieldClassName)}
			/>
		);
	}

	const openBlock =
		activeSegment === null ? undefined : message.segments[activeSegment];
	const openControl = openBlock?.kind !== "text" ? openBlock : undefined;
	const openPlural = openControl?.kind === "plural" ? openControl : undefined;
	const openRepresentative = openPlural?.arms.find(
		(arm) => arm.selector === "other" && !isMissingArm(arm),
	);
	const openIsCollapsed =
		openPlural !== undefined &&
		sameTextForEveryArm(openPlural.arms) &&
		!expandedPluralSegments.has(activeSegment ?? -1);

	let openHighlights: readonly RepresentativeArmHighlight[] = [];
	if (openPlural && openRepresentative) {
		if (
			effect?.value === message.value &&
			effect.segmentIndex === activeSegment
		) {
			openHighlights = effect.highlights;
		} else if (selection?.segmentIndex === activeSegment) {
			try {
				openHighlights = representativeArmHighlights({
					value: message.value,
					segmentIndex: activeSegment ?? 0,
					selectionStart: selection.start,
					selectionEnd: selection.end,
				});
			} catch {
				openHighlights = [];
			}
		}
	}

	return (
		<div
			ref={structuredEditorRef}
			onBlurCapture={(event) => {
				if (!isFocusInsideEditor(event.relatedTarget)) closeActiveBlock();
			}}
			className="flex flex-col gap-1"
		>
			<div className="flex flex-wrap items-baseline gap-y-0.5 px-2 py-1 text-[13px] leading-relaxed">
				{message.segments.map((segment, segmentIndex) => {
					if (segment.kind === "text") {
						return (
							<input
								key={messageSegmentKey(segment, segmentIndex)}
								{...fieldProps(structuredField, `Edit ${localeCode} text`)}
								className={cn(
									INLINE_FIELD,
									segment.value.length === 0 && "min-w-1",
								)}
								dir="auto"
								value={segment.value}
								onFocus={(event) => {
									structuredField.onFocus?.(event);
									setActiveSegment(null);
									clearSelection();
								}}
								onChange={(event) =>
									onValueChange(
										writeTextSegment({
											value: message.value,
											segmentIndex,
											text: event.target.value,
										}),
									)
								}
							/>
						);
					}

					if (segment.kind === "plural") {
						const representative = segment.arms.find(
							(arm) => arm.selector === "other" && !isMissingArm(arm),
						);
						if (!representative) {
							return (
								<button
									key={messageSegmentKey(segment, segmentIndex)}
									type="button"
									disabled={field.disabled}
									className={cn(
										"mx-0.5 rounded border border-amber-500/35 border-dashed px-1.5 py-0.5 align-baseline text-[12px] text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-400",
										activeSegment === segmentIndex && "bg-muted",
									)}
									aria-expanded={activeSegment === segmentIndex}
									aria-label={`Open plural ${segment.argument} to add Other`}
									onBlur={handleInteractiveBlur}
									onClick={() => {
										setActiveSegment(segmentIndex);
										clearSelection();
									}}
								>
									{segment.argument} · add Other
								</button>
							);
						}

						const collapsed =
							sameTextForEveryArm(segment.arms) &&
							!expandedPluralSegments.has(segmentIndex);
						return (
							<span
								key={messageSegmentKey(segment, segmentIndex)}
								className="inline-flex max-w-full items-baseline"
							>
								<input
									{...fieldProps(
										structuredField,
										`${localeCode} representative for ${segment.argument}`,
									)}
									className={cn(
										INLINE_FIELD,
										"underline decoration-amber-500/45 decoration-dotted underline-offset-4",
										activeSegment === segmentIndex && "bg-muted/60",
									)}
									dir="auto"
									value={representative.value}
									onFocus={(event) => {
										structuredField.onFocus?.(event);
										setActiveSegment(segmentIndex);
									}}
									onSelect={(event) => {
										setActiveSegment(segmentIndex);
										setEffect(null);
										setSelection({
											segmentIndex,
											start: event.currentTarget.selectionStart ?? 0,
											end: event.currentTarget.selectionEnd ?? 0,
										});
									}}
									onChange={(event) => {
										const next = writePluralRepresentativeArm({
											value: message.value,
											segmentIndex,
											valueForRepresentativeArm: event.target.value,
										});
										setEffect({
											value: next.value,
											segmentIndex,
											highlights: next.highlights,
										});
										onValueChange(next.value);
									}}
								/>
								{collapsed ? (
									<button
										type="button"
										disabled={field.disabled}
										className={cn(
											MONO,
											"ml-1 rounded px-1 py-0.5 text-muted-foreground/45 transition-colors hover:bg-muted/50 hover:text-muted-foreground",
										)}
										onClick={() => {
											setActiveSegment(segmentIndex);
											toggleExpanded(segmentIndex);
										}}
										aria-label={`Expand ${segment.argument}; same for every case`}
										onBlur={handleInteractiveBlur}
									>
										same for every case
									</button>
								) : null}
							</span>
						);
					}

					const preview =
						segment.arms.find((arm) => arm.selector === "other")?.value ??
						segment.arms[0]?.value ??
						`{${segment.argument}}`;
					return (
						<button
							key={messageSegmentKey(segment, segmentIndex)}
							type="button"
							disabled={field.disabled}
							className={cn(
								"mx-0.5 rounded border px-1.5 py-0.5 align-baseline text-[12px] transition-colors",
								activeSegment === segmentIndex
									? "border-foreground/40 bg-muted"
									: "border-muted-foreground/30 border-dashed hover:bg-muted/60",
							)}
							aria-expanded={activeSegment === segmentIndex}
							aria-label={`Open select ${segment.argument} with ${segment.arms.length} cases`}
							onBlur={handleInteractiveBlur}
							onClick={() => {
								setActiveSegment(
									activeSegment === segmentIndex ? null : segmentIndex,
								);
								clearSelection();
							}}
						>
							{preview || `{${segment.argument}}`}
							<span className="pl-1 text-muted-foreground/50">
								{segment.arms.length}
							</span>
						</button>
					);
				})}
			</div>

			{openControl &&
			activeSegment !== null &&
			(openControl.kind === "select" || !openIsCollapsed) ? (
				<ArmStrip
					kind={openControl.kind}
					argument={openControl.argument}
					segmentIndex={activeSegment}
					arms={openControl.arms}
					value={message.value}
					field={structuredField}
					canChangeStructure={canChangeStructure}
					representativeSelector={
						openControl.kind === "plural"
							? openRepresentative?.selector
							: undefined
					}
					highlights={openHighlights}
					onSelectionChange={clearSelection}
					onValueChange={onValueChange}
					onEditorBlur={handleMenuBlur}
				/>
			) : null}
		</div>
	);
}

/** The UI adapter for the Message Segment module. It controls the structured
 * or raw presentation only; callers retain their Catalog Workspace draft and
 * commit through the existing interface. */
export function IcuMessageSegmentEditor({
	format = "icu",
	...props
}: IcuMessageSegmentEditorProps) {
	if (format === "plain")
		return (
			<Textarea
				{...fieldProps(
					props,
					`Edit ${props.localeCode} value for ${props.messageLabel ?? props.messageId}`,
				)}
				value={props.value}
				onChange={(event) => props.onValueChange(event.target.value)}
				className={cn(
					"field-sizing-content min-h-0 resize-none",
					props.fieldClassName,
				)}
			/>
		);
	return <StructuredIcuEditor {...props} />;
}

function StructuredIcuEditor({
	messageId,
	messageLabel,
	localeId,
	localeCode,
	sourceValue,
	value,
	disabled,
	canChangeStructure,
	onValueChange,
	onKeyDown,
	onFocus,
	onBlur,
	fieldClassName,
	showRawToggle = true,
}: IcuMessageSegmentEditorProps) {
	const [raw, setRaw] = useState(false);
	const message = useMemo(
		() => readMessageSegments({ value, localeCode, sourceValue }),
		[localeCode, sourceValue, value],
	);
	const field = {
		messageId,
		messageLabel,
		localeId,
		disabled,
		onKeyDown,
		onFocus,
		onBlur,
	};
	const rawMode = raw || message.kind === "raw";
	const rawReason =
		message.kind === "raw"
			? message.reason === "nested"
				? "Nested ICU blocks stay in raw ICU."
				: "This ICU syntax needs raw editing."
			: null;

	return (
		<div className="grid gap-1">
			{rawMode ? (
				<>
					{rawReason ? (
						<p className="text-muted-foreground text-xs">{rawReason}</p>
					) : null}
					<Textarea
						{...fieldProps(
							field,
							`Edit ${localeCode} value for ${messageLabel ?? messageId}`,
						)}
						value={value}
						onChange={(event) => onValueChange(event.target.value)}
						className={cn("min-h-24 font-mono text-xs", fieldClassName)}
					/>
				</>
			) : (
				<StructuredMessageEditor
					message={message}
					localeCode={localeCode}
					field={field}
					fieldClassName={fieldClassName}
					canChangeStructure={canChangeStructure}
					onValueChange={onValueChange}
				/>
			)}
			{showRawToggle || rawMode ? (
				<div className="flex justify-end">
					<Button
						type="button"
						size="xs"
						variant="ghost"
						disabled={message.kind === "raw"}
						onClick={() => setRaw((current) => !current)}
					>
						{message.kind === "raw"
							? "Raw ICU"
							: rawMode
								? "Structured editor"
								: "Raw ICU"}
					</Button>
				</div>
			) : null}
		</div>
	);
}
