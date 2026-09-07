import type { JsonObject } from "./catalogDocument";

/** The projection deliberately keeps a small, explicit interface for facts
 * that later contract validation needs. The raw ARB metadata is still retained
 * as opaque Catalog Document evidence. */
/**
 * The active working catalog is intentionally bounded to Brickit's measured
 * envelope. Facts beyond this per-value cap remain available in the immutable
 * Catalog Document, while the projection marks them incomplete rather than
 * rejecting a faithful Git snapshot.
 */
export const MAX_STORED_FACT_NAMES = 128;

export type MessageFacts = {
	icuType: "plain" | "icu";
	argumentNames: readonly string[];
};

export type StoredFactNames = {
	names: readonly string[];
	complete: boolean;
	count: number;
};

function skipWhitespace(value: string, start: number): number {
	let index = start;
	while (/\s/.test(value[index] ?? "")) index++;
	return index;
}

function readToken(value: string, start: number): [string, number] {
	let index = start;
	while (index < value.length && !/[\s,{}]/.test(value[index] ?? "")) index++;
	return [value.slice(start, index), index];
}

function consumeApostrophe(
	value: string,
	index: number,
	quoted: boolean,
): [number, boolean] {
	if (value[index + 1] === "'") return [index + 2, quoted];
	if (quoted) return [index + 1, false];
	const next = value[index + 1];
	return [index + 1, next !== undefined && "{}#".includes(next)];
}

type FactCollector = {
	sawOpeningBrace: boolean;
	names: string[];
	seen: Set<string>;
	literalParts?: string[];
};

function addArgument(collector: FactCollector, name: string): void {
	if (name.length === 0 || collector.seen.has(name)) return;
	collector.seen.add(name);
	collector.names.push(name);
}

/**
 * Read an ICU pattern until its enclosing plural/select arm ends, collecting
 * normal arguments along the way. This deliberately stops short of syntax
 * validation: #42 owns validity and transforms. It does understand arm
 * delimiters, however, so literal arm text such as `zero{Scanned}` never
 * becomes a fictional `{Scanned}` placeholder.
 */
function scanPattern(
	value: string,
	start: number,
	collector: FactCollector,
	endsAtClosingBrace: boolean,
	inPlural = false,
): number {
	let index = start;
	let quoted = false;
	let literal = "";
	const flushLiteral = () => {
		if (literal.length > 0) collector.literalParts?.push(literal);
		literal = "";
	};
	while (index < value.length) {
		const char = value[index];
		if (char === "'") {
			const [next, nextQuoted] = consumeApostrophe(value, index, quoted);
			if (
				collector.literalParts &&
				(next === index + 2 || nextQuoted === quoted)
			) {
				literal += "'";
			}
			[index, quoted] = [next, nextQuoted];
			continue;
		}
		if (quoted) {
			if (collector.literalParts) literal += char;
			index++;
			continue;
		}
		if (endsAtClosingBrace && char === "}") {
			flushLiteral();
			return index + 1;
		}
		if (inPlural && char === "#") {
			flushLiteral();
			index++;
			continue;
		}
		if (char !== "{") {
			if (collector.literalParts) literal += char;
			index++;
			continue;
		}
		flushLiteral();
		collector.sawOpeningBrace = true;
		index = scanArgument(value, index + 1, collector, inPlural);
	}
	flushLiteral();
	return index;
}

function scanArgument(
	value: string,
	start: number,
	collector: FactCollector,
	inPlural: boolean,
): number {
	let index = start;
	index = skipWhitespace(value, index);
	const [name, afterName] = readToken(value, index);
	addArgument(collector, name);
	index = skipWhitespace(value, afterName);
	if (value[index] === "}") return index + 1;
	if (value[index] !== ",") return index + 1;

	index = skipWhitespace(value, index + 1);
	const [format, afterFormat] = readToken(value, index);
	index = skipWhitespace(value, afterFormat);
	if (value[index] === "}") return index + 1;
	if (value[index] !== ",") return index + 1;
	index = skipWhitespace(value, index + 1);

	if (
		format !== "plural" &&
		format !== "select" &&
		format !== "selectordinal"
	) {
		// Number/date/time styles have no nested message pattern. Stop at the
		// matching closing brace, tolerating an invalid nested block without
		// claiming its literal style text is an argument.
		let depth = 0;
		let quoted = false;
		while (index < value.length) {
			const char = value[index];
			if (char === "'") {
				[index, quoted] = consumeApostrophe(value, index, quoted);
				continue;
			}
			if (!quoted && char === "{") depth++;
			if (!quoted && char === "}") {
				if (depth === 0) return index + 1;
				depth--;
			}
			index++;
		}
		return index;
	}

	while (index < value.length) {
		index = skipWhitespace(value, index);
		if (value[index] === "}") return index + 1;
		const [selector, afterSelector] = readToken(value, index);
		if (selector.length === 0) return index + 1;
		index = skipWhitespace(value, afterSelector);
		if (value[index] !== "{") {
			// `offset:1` is legal before the arms; malformed selectors are simply
			// skipped until the next token because this module does not validate.
			continue;
		}
		index = scanPattern(
			value,
			index + 1,
			collector,
			true,
			inPlural || format === "plural" || format === "selectordinal",
		);
	}
	return index;
}

/**
 * Collect argument references without validating an ICU message. Validation is
 * a later contract concern; projection only needs the names that the submitted
 * text already exposes. Quoted ICU syntax and plural/select arm delimiters are
 * understood so the facts remain useful even before full contract validation.
 */
export function messageFacts(value: string): MessageFacts {
	const collector: FactCollector = {
		sawOpeningBrace: false,
		names: [],
		seen: new Set<string>(),
	};
	scanPattern(value, 0, collector, false);
	return {
		icuType: collector.sawOpeningBrace ? "icu" : "plain",
		argumentNames: collector.names,
	};
}

/** Literal runs use the same ICU traversal as argument facts. They exclude
 * argument names, selectors, format styles and plural counts, and never join
 * words across a placeholder or across alternative plural/select arms. */
export function messageLiteralParts(value: string): readonly string[] {
	const literalParts: string[] = [];
	scanPattern(
		value,
		0,
		{
			sawOpeningBrace: false,
			names: [],
			seen: new Set(),
			literalParts,
		},
		false,
	);
	return literalParts;
}

/** Source metadata supplies the declared half of a Message Signature. */
export function declaredPlaceholderNames(
	metadata: JsonObject | undefined,
): readonly string[] {
	const placeholders = metadata?.placeholders;
	if (
		placeholders === null ||
		typeof placeholders !== "object" ||
		Array.isArray(placeholders)
	) {
		return [];
	}
	return Object.keys(placeholders);
}

/**
 * Keep the active-query payload bounded without treating a representable
 * Git-authored contract defect as an ingestion failure. A later validator can
 * follow the value's Snapshot provenance back to its full Catalog Document.
 */
export function storedFactNames(names: readonly string[]): StoredFactNames {
	return {
		names: names.slice(0, MAX_STORED_FACT_NAMES),
		complete: names.length <= MAX_STORED_FACT_NAMES,
		count: names.length,
	};
}
