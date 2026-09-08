import { canRecordIntentionalBlank } from "./catalog-value-lifecycle";
import type { CatalogWorkspaceValue } from "./strings-catalog";

/**
 * The short lowercase phrase a value says when it is still waiting on someone.
 * A settled value says nothing at all, which is what makes a screen of values
 * readable, so the whole noise budget is spent here.
 */
export type ValuePhrase =
	| "needs a value"
	| "Source changed"
	| "Source, not chosen";

/**
 * How loudly a value speaks. The accent is spent only on what stops a release;
 * a `mark` is visible but greyscale, because an Unconfirmed Import, a Source
 * Echo, and a cosmetic source change all ship and none blocks.
 */
export type ValueTone = "silent" | "mark" | "attention";

/** A control a value offers. Unconfirmed work keeps its approval discoverable;
 * editing-only actions still appear on focus. */
export type ValueAffordance = "commit" | "confirm" | "intentionalBlank";

export type ValuePresentation = {
	phrase?: ValuePhrase;
	tone: ValueTone;
	/** Whether this value stops its Locale from being released. */
	blocks: boolean;
	affordances: readonly ValueAffordance[];
	/** The live commit label: it relabels as the draft becomes dirty. */
	commitHint?: "save" | "still correct";
	/** The draft currently reads exactly as its source, with content in it. */
	echoesSource: boolean;
};

export type ValuePresentationInput = {
	value: CatalogWorkspaceValue;
	/** The effective Source Contract wording this value is measured against. */
	sourceValue?: string;
	isFocused: boolean;
	isDirty: boolean;
	draftValue: string;
};

/** An untouched empty value is Waiting and cannot be confirmed without the
 * separate Intentional Blank reason. An untouched imported value is the one
 * confirmation can affirm with the ordinary shortcut. */
export function catalogWorkspaceCommitShortcut(input: {
	isDirty: boolean;
	valueState?: CatalogWorkspaceValue["valueState"];
	sourceChangeKind?: CatalogWorkspaceValue["sourceChangeKind"];
}): "save" | "confirm" | "none" {
	if (input.isDirty) return "save";
	if (input.valueState === "unconfirmedImport") return "confirm";
	if (input.valueState === "stale" && input.sourceChangeKind !== "cosmetic") {
		return "confirm";
	}
	return "none";
}

/**
 * A value carrying a durable Intentional Blank reason is completed work: it
 * renders nothing on purpose, so it is silent and never counted as waiting.
 */
function isIntentionalBlank(value: CatalogWorkspaceValue) {
	return (value.intentionalBlankReason ?? "").length > 0;
}

/**
 * Git authors the Source Contract, so the source is never Waiting and never an
 * Unconfirmed Import. Making it an editable peer row does not change who
 * writes it in the repository.
 */
function isWaiting(value: CatalogWorkspaceValue) {
	return (
		!value.isSource &&
		!isIntentionalBlank(value) &&
		value.valueState === "waiting"
	);
}

function isUnconfirmedImport(value: CatalogWorkspaceValue) {
	return (
		!value.isSource &&
		!isIntentionalBlank(value) &&
		value.valueState === "unconfirmedImport"
	);
}

function isStale(value: CatalogWorkspaceValue) {
	return !value.isSource && value.valueState === "stale";
}

function isSemanticStale(value: CatalogWorkspaceValue) {
	return isStale(value) && value.sourceChangeKind !== "cosmetic";
}

export function presentCatalogWorkspaceValue(
	input: ValuePresentationInput,
): ValuePresentation {
	const { value, isDirty, isFocused, draftValue } = input;
	const sourceValue = input.sourceValue ?? "";

	// A Source Echo is identity with a source that has content. An empty target
	// against an empty source is an absence, not a decision to keep the source.
	const echoesSource =
		!value.isSource && draftValue.length > 0 && draftValue === sourceValue;

	const waiting = isWaiting(value);
	const unconfirmed = isUnconfirmedImport(value);
	const stale = isStale(value);
	const semanticStale = isSemanticStale(value);

	const phrase: ValuePhrase | undefined = waiting
		? "needs a value"
		: semanticStale
			? "Source changed"
			: unconfirmed && echoesSource
				? "Source, not chosen"
				: undefined;

	const tone: ValueTone = waiting
		? "attention"
		: semanticStale
			? "attention"
			: unconfirmed || stale
				? "mark"
				: "silent";

	const shortcut = catalogWorkspaceCommitShortcut({
		isDirty,
		valueState: value.valueState,
		sourceChangeKind: value.sourceChangeKind,
	});
	const commitHint =
		shortcut === "save"
			? ("save" as const)
			: shortcut === "confirm"
				? ("still correct" as const)
				: undefined;

	// Completed work stays silent, while an unconfirmed or semantically stale
	// value keeps its one useful decision visible without requiring discovery of
	// the keyboard shortcut first.
	const affordances: ValueAffordance[] = [];
	if (shortcut === "confirm") affordances.push("confirm");
	if (isFocused || isDirty) {
		if (shortcut === "save") affordances.push("commit");
		// Clearing a field and walking away must mean undecided, so a deliberate
		// blank stays an explicit act. The decision is useful only for an exactly
		// empty draft; whitespace remains real catalog content.
		if (
			!value.isSource &&
			canRecordIntentionalBlank(draftValue) &&
			!isIntentionalBlank(value)
		) {
			affordances.push("intentionalBlank");
		}
	}

	return {
		phrase,
		tone,
		blocks: waiting || semanticStale,
		affordances,
		commitHint,
		echoesSource,
	};
}

export type KeyPresentation = {
	waiting: number;
	unconfirmed: number;
	stale: number;
	/** Nothing about this key is waiting on anyone, so its header says nothing. */
	silent: boolean;
};

/**
 * What a key says about itself, once in its own header. The change that left
 * five Locales waiting is one fact, and repeating it under every value was
 * most of the noise the prototype's second round was rejected for.
 */
export function presentCatalogKey(
	values: readonly CatalogWorkspaceValue[],
): KeyPresentation {
	const waiting = values.filter(isWaiting).length;
	const unconfirmed = values.filter(isUnconfirmedImport).length;
	const stale = values.filter(isStale).length;
	return {
		waiting,
		unconfirmed,
		stale,
		silent: waiting + unconfirmed + stale === 0,
	};
}
