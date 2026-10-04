import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type {
	CatalogDocument,
	CatalogMessage,
	JsonObject,
} from "./catalogDocument";
import type { ProjectedMessage } from "./catalogProjection";
import { messageFacts, storedFactNames } from "./messageFacts";

/**
 * Contract Transforms are deliberately a pure module. The projection adapter
 * supplies immutable Catalog Documents and current projected rows; this module
 * returns the mechanically repaired rows, compact metadata operations, and
 * per-Locale Translation Residue. It never reads or writes Convex directly.
 */

export const MAX_METADATA_TRANSFORMS_PER_VALUE = 128;
export const MAX_METADATA_TRANSFORM_BYTES = 32 * 1024;
export const MAX_CONTRACT_CONSEQUENCE_PLACEHOLDER_NAMES = 128;
export const MAX_CONTRACT_CONSEQUENCE_PLACEHOLDER_BYTES = 32 * 1024;

export type PlaceholderDefinition =
	| { type: "present"; value: string }
	| { type: "absent" };

export type MetadataTransform =
	| {
			kind: "rename_placeholder";
			from: string;
			to: string;
	  }
	| {
			kind: "retype_placeholder";
			name: string;
			/** The target declaration this operation was derived from. */
			from: PlaceholderDefinition;
			to: PlaceholderDefinition;
	  };

export type ContractTransformCode =
	| "renamed_placeholder"
	| "retyped_placeholder"
	| "wrapped_plural"
	| "unwrapped_plural";

export type TranslationResidueCode =
	| "removed_placeholder"
	| "target_argument_not_in_source"
	| "placeholder_rename_conflict"
	| "plural_to_plain_requires_translation";

export type ContractConsequence = {
	localeId: Id<"locales">;
	localeCode: string;
	catalogPath: string;
	catalogIndex: number;
	messageId: string;
	kind: "transform" | "residue";
	code: ContractTransformCode | TranslationResidueCode;
	/** A bounded prefix of affected placeholders, with completeness explicit. */
	placeholderNames?: string[];
	placeholderNameCount?: number;
	placeholderNamesComplete?: boolean;
};

export type ContractReconciliation = {
	messages: ProjectedMessage[];
	consequences: ContractConsequence[];
};

export type SubmittedTargetFingerprint = {
	value: string;
};

export type ContractReconciliationInput = {
	previousMessages: readonly ProjectedMessage[];
	currentMessages: readonly ProjectedMessage[];
	previousSourceDocument: CatalogDocument | null;
	currentSourceDocument: CatalogDocument;
	targetMetadataByValue: ReadonlyMap<string, JsonObject | undefined>;
	/** Compatibility evidence for projections accepted before raw Git fingerprints
	 * were persisted on each target value. */
	previousSubmittedTargetFingerprintsByValue: ReadonlyMap<
		string,
		SubmittedTargetFingerprint
	>;
};

type IcuArm = {
	selector: string;
	contentStart: number;
	contentEnd: number;
	argumentNames: string[];
};

type IcuArgument = {
	name: string;
	nameStart: number;
	nameEnd: number;
	/** The first character after this complete ICU argument. */
	end: number;
	format: string | null;
	arms: IcuArm[];
};

type IcuInspection = {
	arguments: IcuArgument[];
	rootPlural: IcuArgument | null;
	missingOther: boolean;
};

class IcuSyntaxError extends Error {}

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function contractValueIdentity(value: {
	localeId: Id<"locales">;
	messageId: string;
}): string {
	return JSON.stringify([value.localeId, value.messageId]);
}

function sourceMessages(
	document: CatalogDocument,
): Map<string, CatalogMessage> {
	return new Map(document.messages.map((message) => [message.id, message]));
}

function isPlainObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function placeholderDefinitions(
	metadata: JsonObject | undefined,
): Map<string, PlaceholderDefinition> {
	const placeholders = metadata?.placeholders;
	if (!isPlainObject(placeholders)) return new Map();
	return new Map(
		Object.entries(placeholders).map(([name, definition]) => {
			const type = isPlainObject(definition) ? definition.type : undefined;
			return [
				name,
				typeof type === "string"
					? ({ type: "present", value: type } as const)
					: ({ type: "absent" } as const),
			];
		}),
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Explicit authorship reuse requires exact text and all captured metadata,
 * including descriptions, examples and unknown attributes. Object key order
 * carries no meaning; array order and absent metadata remain significant. */
export function completeSourceContractsMatch(
	left: Pick<CatalogMessage, "value" | "metadata">,
	right: Pick<CatalogMessage, "value" | "metadata">,
): boolean {
	return (
		left.value === right.value &&
		stableJson(left.metadata) === stableJson(right.metadata)
	);
}

/** Compare the executable portion of two source messages. Source text owns ICU
 * shape; Flutter's placeholder declaration owns runtime type and formatting.
 * Human-facing examples and descriptions do not invalidate reviewed work. */
export function sourceContractsMatch(
	left: Pick<CatalogMessage, "value" | "metadata">,
	right: Pick<CatalogMessage, "value" | "metadata">,
): boolean {
	if (left.value !== right.value) return false;
	const executablePlaceholders = (metadata: JsonObject | undefined) => {
		const placeholders = metadata?.placeholders;
		if (!isPlainObject(placeholders)) return null;
		return Object.fromEntries(
			Object.entries(placeholders).map(([name, definition]) => {
				if (!isPlainObject(definition)) return [name, definition];
				return [
					name,
					Object.fromEntries(
						[
							"type",
							"format",
							"optionalParameters",
							"isCustomDateFormat",
						].flatMap((key) =>
							definition[key] === undefined ? [] : [[key, definition[key]]],
						),
					),
				];
			}),
		);
	};
	return (
		stableJson(executablePlaceholders(left.metadata)) ===
		stableJson(executablePlaceholders(right.metadata))
	);
}

function placeholderDefinitionEqual(
	left: PlaceholderDefinition,
	right: PlaceholderDefinition,
): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "absent") return true;
	return right.type === "present" && left.value === right.value;
}

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

function consumeQuoted(value: string, start: number): number | null {
	if (value[start + 1] === "'") return start + 2;
	if (!"{}#".includes(value[start + 1] ?? "")) return start + 1;
	let index = start + 1;
	while (index < value.length) {
		if (value[index] !== "'") {
			index++;
			continue;
		}
		if (value[index + 1] === "'") {
			index += 2;
			continue;
		}
		return index + 1;
	}
	return null;
}

type ParsedMessage = {
	next: number;
	directArguments: IcuArgument[];
	hasNonWhitespaceLiteral: boolean;
};

class IcuParser {
	readonly arguments: IcuArgument[] = [];

	constructor(private readonly value: string) {}

	parse(): IcuInspection {
		const message = this.parseMessage(0, false);
		if (message.next !== this.value.length) {
			throw new IcuSyntaxError("Unexpected trailing ICU input.");
		}
		const plural =
			message.directArguments.length === 1 &&
			!message.hasNonWhitespaceLiteral &&
			message.directArguments[0]?.format === "plural"
				? message.directArguments[0]
				: null;
		return {
			arguments: this.arguments,
			rootPlural: plural,
			missingOther: this.arguments.some(
				(argument) =>
					(argument.format === "plural" ||
						argument.format === "select" ||
						argument.format === "selectordinal") &&
					!argument.arms.some((arm) => arm.selector === "other"),
			),
		};
	}

	private parseMessage(
		start: number,
		stopsAtClosingBrace: boolean,
	): ParsedMessage {
		let index = start;
		const directArguments: IcuArgument[] = [];
		let hasNonWhitespaceLiteral = false;
		while (index < this.value.length) {
			const char = this.value[index];
			if (char === "'") {
				const next = consumeQuoted(this.value, index);
				if (next === null) {
					throw new IcuSyntaxError("An ICU apostrophe escape is not closed.");
				}
				if (/\S/.test(this.value.slice(index, next))) {
					hasNonWhitespaceLiteral = true;
				}
				index = next;
				continue;
			}
			if (char === "{") {
				const parsed = this.parseArgument(index);
				directArguments.push(parsed.argument);
				index = parsed.next;
				continue;
			}
			if (char === "}") {
				if (!stopsAtClosingBrace) {
					throw new IcuSyntaxError(
						"An ICU closing brace has no opening brace.",
					);
				}
				return { next: index + 1, directArguments, hasNonWhitespaceLiteral };
			}
			if (/\S/.test(char ?? "")) hasNonWhitespaceLiteral = true;
			index++;
		}
		if (stopsAtClosingBrace) {
			throw new IcuSyntaxError("An ICU plural or select arm is not closed.");
		}
		return { next: index, directArguments, hasNonWhitespaceLiteral };
	}

	private parseArgument(start: number): {
		argument: IcuArgument;
		next: number;
	} {
		let index = skipWhitespace(this.value, start + 1);
		const nameStart = index;
		const [name, afterName] = readToken(this.value, index);
		if (name.length === 0) {
			throw new IcuSyntaxError("An ICU argument has no name.");
		}
		index = skipWhitespace(this.value, afterName);
		if (this.value[index] === "}") {
			const argument: IcuArgument = {
				name,
				nameStart,
				nameEnd: afterName,
				end: index + 1,
				format: null,
				arms: [],
			};
			this.arguments.push(argument);
			return { argument, next: index + 1 };
		}
		if (this.value[index] !== ",") {
			throw new IcuSyntaxError("An ICU argument must end or name a format.");
		}
		index = skipWhitespace(this.value, index + 1);
		const [format, afterFormat] = readToken(this.value, index);
		if (format.length === 0) {
			throw new IcuSyntaxError("An ICU argument has no format name.");
		}
		index = skipWhitespace(this.value, afterFormat);
		const argument: IcuArgument = {
			name,
			nameStart,
			nameEnd: afterName,
			end: 0,
			format,
			arms: [],
		};
		this.arguments.push(argument);
		if (this.value[index] === "}") {
			argument.end = index + 1;
			return { argument, next: argument.end };
		}
		if (this.value[index] !== ",") {
			throw new IcuSyntaxError("An ICU format must end or include a style.");
		}
		index = skipWhitespace(this.value, index + 1);
		if (
			format !== "plural" &&
			format !== "select" &&
			format !== "selectordinal"
		) {
			argument.end = this.skipStyle(index);
			return { argument, next: argument.end };
		}
		for (;;) {
			index = skipWhitespace(this.value, index);
			if (this.value[index] === "}") {
				argument.end = index + 1;
				return { argument, next: argument.end };
			}
			const [selector, afterSelector] = readToken(this.value, index);
			if (selector.length === 0) {
				throw new IcuSyntaxError(
					"An ICU plural or select arm has no selector.",
				);
			}
			index = skipWhitespace(this.value, afterSelector);
			if (selector.startsWith("offset:")) continue;
			if (this.value[index] !== "{") {
				throw new IcuSyntaxError(
					"An ICU plural or select arm must contain a message.",
				);
			}
			const contentStart = index + 1;
			const armStart = this.arguments.length;
			const parsed = this.parseMessage(contentStart, true);
			const argumentNames = this.arguments
				.slice(armStart)
				.map((nested) => nested.name);
			argument.arms.push({
				selector,
				contentStart,
				contentEnd: parsed.next - 1,
				argumentNames,
			});
			index = parsed.next;
		}
	}

	private skipStyle(start: number): number {
		let index = start;
		let depth = 0;
		while (index < this.value.length) {
			const char = this.value[index];
			if (char === "'") {
				const next = consumeQuoted(this.value, index);
				if (next === null) {
					throw new IcuSyntaxError("An ICU apostrophe escape is not closed.");
				}
				index = next;
				continue;
			}
			if (char === "{") depth++;
			if (char === "}") {
				if (depth === 0) return index + 1;
				depth--;
			}
			index++;
		}
		throw new IcuSyntaxError("An ICU format style is not closed.");
	}
}

function inspectIcu(value: string): IcuInspection {
	try {
		return new IcuParser(value).parse();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ConvexError({
			code: "VALIDATION",
			message: `Contract Validity failed: ${reason}`,
		});
	}
}

/** Validate one translator-authored target value against the active Source
 * Contract. Snapshot reconciliation and the Catalog Workspace share this
 * parser so an editor save cannot accept a weaker ICU shape than publication. */
export function assertTargetValueContract(input: {
	messageId: string;
	localeCode: string;
	value: string;
	source: Pick<
		ProjectedMessage,
		| "argumentNames"
		| "argumentNamesComplete"
		| "declaredPlaceholderNames"
		| "declaredPlaceholderNamesComplete"
	>;
}): void {
	if (
		!input.source.argumentNamesComplete ||
		input.source.declaredPlaceholderNamesComplete === false
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Contract Validity cannot validate ${input.localeCode}.${input.messageId} within the stored Source Contract envelope.`,
		});
	}
	const inspection = inspectIcu(input.value);
	if (inspection.missingOther) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Contract Validity failed: ${input.localeCode}.${input.messageId} has no other arm.`,
		});
	}
	const allowedArguments = new Set([
		...input.source.argumentNames,
		...(input.source.declaredPlaceholderNames ?? []),
	]);
	for (const argument of inspection.arguments) {
		if (allowedArguments.has(argument.name)) continue;
		throw new ConvexError({
			code: "VALIDATION",
			message: `Contract Validity failed: ${input.localeCode}.${input.messageId} introduces argument "${argument.name}" outside the Source Contract.`,
		});
	}
}

type IcuShape = {
	name: string;
	format: string | null;
	armSelectors: readonly string[];
};

function icuShape(inspection: IcuInspection): readonly IcuShape[] {
	return inspection.arguments.map((argument) => ({
		name: argument.name,
		format: argument.format,
		armSelectors: argument.arms.map((arm) => arm.selector),
	}));
}

function sameIcuShape(
	left: readonly IcuShape[],
	right: readonly IcuShape[],
): boolean {
	return (
		left.length === right.length &&
		left.every((shape, index) => {
			const candidate = right[index];
			return (
				candidate !== undefined &&
				shape.name === candidate.name &&
				shape.format === candidate.format &&
				shape.armSelectors.length === candidate.armSelectors.length &&
				shape.armSelectors.every(
					(selector, armIndex) => selector === candidate.armSelectors[armIndex],
				)
			);
		})
	);
}

/** A Source Proposal changes English wording only. It is deliberately stricter
 * than a target save: its placeholders and ICU form are part of the immutable
 * Source Contract, so a candidate can change literal copy but not its public
 * message interface. */
export function assertSourceProposalValueContract(input: {
	messageId: string;
	localeCode: string;
	value: string;
	source: Pick<ProjectedMessage, "value">;
}): void {
	const sourceInspection = inspectIcu(input.source.value);
	const candidateInspection = inspectIcu(input.value);
	if (candidateInspection.missingOther) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Source Proposal failed: ${input.localeCode}.${input.messageId} has no other ICU arm.`,
		});
	}
	if (
		!sameIcuShape(icuShape(sourceInspection), icuShape(candidateInspection))
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Source Proposal failed: ${input.localeCode}.${input.messageId} cannot alter Source Contract placeholders or ICU shape.`,
		});
	}
}

function withValue(message: ProjectedMessage, value: string): ProjectedMessage {
	const facts = messageFacts(value);
	const argumentNames = storedFactNames(facts.argumentNames);
	return {
		...message,
		value,
		icuType: facts.icuType,
		argumentNames: [...argumentNames.names],
		argumentNamesComplete: argumentNames.complete,
		argumentNameCount: argumentNames.count,
	};
}

function renameArgumentTokens(
	value: string,
	inspection: IcuInspection,
	from: string,
	to: string,
): string {
	return renameArgumentTokensByMap(value, inspection, new Map([[from, to]]));
}

/** Replace names by their original token spans, so simultaneous source
 * renames cannot accidentally feed one replacement into the next. */
function renameArgumentTokensByMap(
	value: string,
	inspection: IcuInspection,
	renames: ReadonlyMap<string, string>,
): string {
	const replacements = inspection.arguments.flatMap((argument) => {
		const replacement = renames.get(argument.name);
		return replacement === undefined
			? []
			: [
					{
						start: argument.nameStart,
						end: argument.nameEnd,
						value: replacement,
					},
				];
	});
	if (replacements.length === 0) return value;
	let transformed = value;
	for (const replacement of [...replacements].reverse()) {
		transformed = `${transformed.slice(0, replacement.start)}${replacement.value}${transformed.slice(replacement.end)}`;
	}
	return transformed;
}

function isPluralFormat(format: string | null): boolean {
	return format === "plural" || format === "selectordinal";
}

function positionIsInPluralArm(
	inspection: IcuInspection,
	position: number,
): boolean {
	return inspection.arguments.some(
		(argument) =>
			isPluralFormat(argument.format) &&
			argument.arms.some(
				(arm) => position >= arm.contentStart && position < arm.contentEnd,
			),
	);
}

function positionIsInStyleArgument(
	inspection: IcuInspection,
	position: number,
): boolean {
	return inspection.arguments.some(
		(argument) =>
			argument.format !== null &&
			argument.format !== "plural" &&
			argument.format !== "select" &&
			argument.format !== "selectordinal" &&
			position > argument.nameEnd &&
			position < argument.end,
	);
}

/** A `#` becomes the outer plural's count only where the original message
 * did not already give it plural semantics (or a number-format style). Quote
 * precisely those literal hashes before wrapping so the rendered target stays
 * byte-for-byte meaningful. */
function quoteLiteralPoundsForOuterPlural(
	value: string,
	inspection: IcuInspection,
): string {
	let next = "";
	let index = 0;
	while (index < value.length) {
		if (value[index] === "'") {
			const afterQuote = consumeQuoted(value, index);
			if (afterQuote === null) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"Contract Validity failed: an ICU apostrophe escape is not closed.",
				});
			}
			next += value.slice(index, afterQuote);
			index = afterQuote;
			continue;
		}
		if (
			value[index] === "#" &&
			!positionIsInPluralArm(inspection, index) &&
			!positionIsInStyleArgument(inspection, index)
		) {
			next += "'#'";
			index++;
			continue;
		}
		next += value[index];
		index++;
	}
	return next;
}

function armHasUnquotedPound(value: string, arm: IcuArm): boolean {
	for (let index = arm.contentStart; index < arm.contentEnd; index++) {
		if (value[index] === "'") {
			const afterQuote = consumeQuoted(value, index);
			if (afterQuote === null) {
				throw new ConvexError({
					code: "VALIDATION",
					message:
						"Contract Validity failed: an ICU apostrophe escape is not closed.",
				});
			}
			index = afterQuote - 1;
			continue;
		}
		if (value[index] === "#") return true;
	}
	return false;
}

/** Apply the compact metadata operations to opaque snapshot-bound metadata.
 * Projection readers keep the original Catalog Document lossless; adapters
 * that need effective metadata use this deterministic operation list. */
export function applyMetadataTransforms(
	metadata: JsonObject | undefined,
	operations: readonly MetadataTransform[],
): JsonObject | undefined {
	if (metadata === undefined || operations.length === 0) return metadata;
	const placeholders = metadata.placeholders;
	if (!isPlainObject(placeholders)) return metadata;
	let nextMetadata: JsonObject = metadata;
	let nextPlaceholders: JsonObject = placeholders;
	for (const operation of operations) {
		if (operation.kind === "rename_placeholder") {
			if (!(operation.from in nextPlaceholders)) continue;
			if (operation.to in nextPlaceholders) {
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"A Contract Transform would merge two target metadata placeholders.",
				});
			}
			const { [operation.from]: moved, ...remaining } = nextPlaceholders;
			nextPlaceholders = { ...remaining, [operation.to]: moved };
			nextMetadata = { ...nextMetadata, placeholders: nextPlaceholders };
			continue;
		}
		const existing = nextPlaceholders[operation.name];
		if (!isPlainObject(existing)) continue;
		const { type: _previousType, ...withoutType } = existing;
		const nextDefinition =
			operation.to.type === "present"
				? { ...withoutType, type: operation.to.value }
				: withoutType;
		nextPlaceholders = {
			...nextPlaceholders,
			[operation.name]: nextDefinition,
		};
		nextMetadata = { ...nextMetadata, placeholders: nextPlaceholders };
	}
	return nextMetadata;
}

function composeMetadataTransforms(
	previous: readonly MetadataTransform[],
	next: readonly MetadataTransform[],
): MetadataTransform[] {
	let operations = previous.map((operation) => ({ ...operation }));
	for (const operation of next) {
		if (operation.kind === "rename_placeholder") {
			if (operation.from === operation.to) continue;
			let composedIntoExistingRename = false;
			for (let index = 0; index < operations.length; index++) {
				const current = operations[index];
				if (!current) continue;
				if (
					current.kind === "rename_placeholder" &&
					current.to === operation.from
				) {
					operations[index] = { ...current, to: operation.to };
					composedIntoExistingRename = true;
				}
				if (
					current.kind === "retype_placeholder" &&
					current.name === operation.from
				) {
					operations[index] = { ...current, name: operation.to };
				}
			}
			const matching = operations.findIndex(
				(current) =>
					current.kind === "rename_placeholder" &&
					current.from === operation.from,
			);
			if (matching >= 0) {
				operations[matching] = operation;
			} else if (!composedIntoExistingRename) {
				operations.push(operation);
			}
			// A -> B followed by B -> A restores the raw metadata name. Keep the
			// compact operation list canonical instead of persisting A -> A, which
			// would later look like an illegal metadata collision.
			operations = operations.filter(
				(current) =>
					current.kind !== "rename_placeholder" || current.from !== current.to,
			);
			continue;
		}
		const matching = operations.findIndex(
			(current) =>
				current.kind === "retype_placeholder" &&
				current.name === operation.name,
		);
		if (matching >= 0) {
			const existing = operations[matching];
			if (existing?.kind !== "retype_placeholder") {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A metadata retype operation has an invalid identity.",
				});
			}
			// Metadata operations replay from immutable, raw Git metadata. Keep the
			// first declaration as the anchor while advancing to the newest Source
			// Contract declaration (String -> int -> double is String -> double).
			const composed = { ...operation, from: existing.from };
			if (placeholderDefinitionEqual(composed.from, composed.to)) {
				operations.splice(matching, 1);
			} else {
				operations[matching] = composed;
			}
		} else {
			operations.push(operation);
		}
	}
	if (
		operations.length > MAX_METADATA_TRANSFORMS_PER_VALUE ||
		encodedSize(operations) > MAX_METADATA_TRANSFORM_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Target metadata transforms exceed the supported envelope.",
		});
	}
	return operations;
}

function retypeOperation(
	name: string,
	from: PlaceholderDefinition,
	to: PlaceholderDefinition,
): MetadataTransform {
	return { kind: "retype_placeholder", name, from, to };
}

function candidatePlaceholderRenames(
	previous: Map<string, PlaceholderDefinition>,
	current: Map<string, PlaceholderDefinition>,
): Map<string, string> {
	const removed = [...previous.keys()].filter((name) => !current.has(name));
	const added = [...current.keys()].filter((name) => !previous.has(name));
	if (removed.length === 1 && added.length === 1) {
		const [from] = removed;
		const [to] = added;
		if (from && to) return new Map([[from, to]]);
	}
	// Multiple simultaneous placeholder changes are only safe when their
	// definitions identify one pairing each. Equal types are intentionally
	// ambiguous: guessing would relabel a translator's argument.
	const renames = new Map<string, string>();
	for (const from of removed) {
		const source = previous.get(from);
		if (!source) continue;
		const matches = added.filter((to) => {
			const candidate = current.get(to);
			return (
				candidate !== undefined && placeholderDefinitionEqual(source, candidate)
			);
		});
		if (matches.length === 1 && matches[0]) renames.set(from, matches[0]);
	}
	if (new Set(renames.values()).size !== renames.size) return new Map();
	return renames;
}

/** A declaration add/remove is not by itself a rename: `{name}` becoming
 * `{count} items` could be two independent contract changes. Prove the
 * mechanical correspondence by requiring the old source pattern, with the
 * candidate token substitutions applied by original spans, to equal the new
 * source pattern exactly. */
function provenPlaceholderRenames(
	previousSource: CatalogMessage,
	currentSource: CatalogMessage,
	previousInspection: IcuInspection,
	previousDefinitions: Map<string, PlaceholderDefinition>,
	currentDefinitions: Map<string, PlaceholderDefinition>,
): Map<string, string> {
	const candidates = candidatePlaceholderRenames(
		previousDefinitions,
		currentDefinitions,
	);
	if (candidates.size === 0) return candidates;
	return renameArgumentTokensByMap(
		previousSource.value,
		previousInspection,
		candidates,
	) === currentSource.value
		? candidates
		: new Map();
}

function addedMetadataTransform(
	metadata: JsonObject | undefined,
	operations: readonly MetadataTransform[],
	operation: MetadataTransform,
): MetadataTransform[] {
	const effective = applyMetadataTransforms(metadata, operations);
	const placeholders = effective?.placeholders;
	if (!isPlainObject(placeholders)) return [];
	if (operation.kind === "rename_placeholder") {
		if (!(operation.from in placeholders)) return [];
		if (operation.to in placeholders) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"A Contract Transform would merge two target metadata placeholders.",
			});
		}
		return [operation];
	}
	const currentDefinition = placeholderDefinitions(effective).get(
		operation.name,
	);
	if (
		currentDefinition === undefined ||
		placeholderDefinitionEqual(currentDefinition, operation.to) ||
		!placeholderDefinitionEqual(currentDefinition, operation.from)
	) {
		return [];
	}
	return [operation];
}

/** Replay only historical operations whose input declaration is still present
 * in this Git @ block. A description edit keeps its transforms; an explicit
 * placeholder type edit supersedes the old retype so Contract Validity sees it
 * instead of silently rewriting it. */
function rebaseMetadataTransforms(
	metadata: JsonObject | undefined,
	operations: readonly MetadataTransform[],
): {
	operations: MetadataTransform[];
	renameConflicts: string[];
} {
	if (metadata === undefined) {
		return { operations: [...operations], renameConflicts: [] };
	}
	let effective: JsonObject | undefined = metadata;
	const retained: MetadataTransform[] = [];
	const renameConflicts: string[] = [];
	for (const operation of operations) {
		const definitions = placeholderDefinitions(effective);
		if (operation.kind === "rename_placeholder") {
			if (!definitions.has(operation.from)) continue;
			if (definitions.has(operation.to)) {
				renameConflicts.push(operation.from);
				continue;
			}
			retained.push(operation);
			effective = applyMetadataTransforms(effective, [operation]);
			continue;
		}
		const currentDefinition = definitions.get(operation.name);
		if (
			currentDefinition === undefined ||
			placeholderDefinitionEqual(currentDefinition, operation.to) ||
			!placeholderDefinitionEqual(currentDefinition, operation.from)
		) {
			continue;
		}
		retained.push(operation);
		effective = applyMetadataTransforms(effective, [operation]);
	}
	return { operations: retained, renameConflicts };
}

function validateTargetMetadata(
	sourceMetadata: JsonObject | undefined,
	targetMetadata: JsonObject | undefined,
	localeCode: string,
	messageId: string,
): void {
	const source = placeholderDefinitions(sourceMetadata);
	const target = placeholderDefinitions(targetMetadata);
	for (const [name, sourceDefinition] of source) {
		const targetDefinition = target.get(name);
		if (
			targetDefinition !== undefined &&
			!placeholderDefinitionEqual(sourceDefinition, targetDefinition)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Contract Validity failed: ${localeCode}.${messageId} declares placeholder "${name}" with a conflicting type.`,
			});
		}
	}
}

function addConsequence(
	consequences: ContractConsequence[],
	consequence: ContractConsequence,
): void {
	const identity = JSON.stringify([
		consequence.localeId,
		consequence.messageId,
		consequence.kind,
		consequence.code,
	]);
	const existing = consequences.find(
		(candidate) =>
			JSON.stringify([
				candidate.localeId,
				candidate.messageId,
				candidate.kind,
				candidate.code,
			]) === identity,
	);
	if (existing) {
		const names = [
			...(existing.placeholderNames ?? []),
			...(consequence.placeholderNames ?? []),
		];
		const bounded = boundedPlaceholderNames(names);
		const placeholderNameCount = Math.max(
			existing.placeholderNameCount ?? 0,
			consequence.placeholderNameCount ?? 0,
			bounded.count,
		);
		existing.placeholderNames = bounded.names;
		existing.placeholderNameCount = placeholderNameCount;
		existing.placeholderNamesComplete =
			bounded.complete &&
			(existing.placeholderNamesComplete ?? true) &&
			(consequence.placeholderNamesComplete ?? true);
		return;
	}
	consequences.push(consequence);
}

function boundedPlaceholderNames(names: readonly string[]): {
	names: string[];
	count: number;
	complete: boolean;
} {
	const unique = [...new Set(names)];
	const stored: string[] = [];
	for (const name of unique) {
		if (
			stored.length === MAX_CONTRACT_CONSEQUENCE_PLACEHOLDER_NAMES ||
			encodedSize([...stored, name]) >
				MAX_CONTRACT_CONSEQUENCE_PLACEHOLDER_BYTES
		) {
			return { names: stored, count: unique.length, complete: false };
		}
		stored.push(name);
	}
	return { names: stored, count: unique.length, complete: true };
}

function consequenceFor(
	message: ProjectedMessage,
	kind: ContractConsequence["kind"],
	code: ContractConsequence["code"],
	placeholderNames?: readonly string[],
): ContractConsequence {
	const names = boundedPlaceholderNames(placeholderNames ?? []);
	return {
		localeId: message.localeId,
		localeCode: message.localeCode,
		catalogPath: message.catalogPath,
		catalogIndex: message.catalogIndex,
		messageId: message.messageId,
		kind,
		code,
		...(placeholderNames === undefined
			? {}
			: {
					placeholderNames: names.names,
					placeholderNameCount: names.count,
					placeholderNamesComplete: names.complete,
				}),
	};
}

function carriedTarget(
	previous: ProjectedMessage | undefined,
	current: ProjectedMessage,
	previousSubmittedFingerprint: SubmittedTargetFingerprint | undefined,
): ProjectedMessage | null {
	const previousValueFingerprint =
		previous?.gitValueFingerprint ??
		previousSubmittedFingerprint?.value ??
		(previous?.materialized && current.materialized
			? current.gitValueFingerprint
			: undefined);
	if (
		!previous ||
		previous.isSource ||
		current.isSource ||
		previousValueFingerprint === undefined ||
		current.gitValueFingerprint === undefined ||
		previousValueFingerprint !== current.gitValueFingerprint ||
		previous.materialized !== current.materialized
	) {
		return null;
	}
	return {
		...current,
		value: previous.value,
		sourceFingerprint: previous.sourceFingerprint,
		icuType: previous.icuType,
		argumentNames: [...previous.argumentNames],
		argumentNamesComplete: previous.argumentNamesComplete,
		argumentNameCount: previous.argumentNameCount,
		...(previous.metadataTransforms === undefined
			? {}
			: { metadataTransforms: [...previous.metadataTransforms] }),
	};
}

/** Reconcile the source's current Contract against one target Locale row at a
 * time. The caller gets one atomic result to stage with its Catalog Projection.
 */
export function reconcileContractTransforms(
	input: ContractReconciliationInput,
): ContractReconciliation {
	const previousByValue = new Map<string, ProjectedMessage>();
	for (const message of input.previousMessages) {
		const identity = contractValueIdentity(message);
		if (previousByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The prior Catalog Projection contains a duplicate Locale value.",
			});
		}
		previousByValue.set(identity, message);
	}
	const previousSource = input.previousSourceDocument
		? sourceMessages(input.previousSourceDocument)
		: new Map<string, CatalogMessage>();
	const currentSource = sourceMessages(input.currentSourceDocument);
	const carriedValueIds = new Set<string>();
	const messages = input.currentMessages.map((current) => {
		if (current.isSource) return current;
		const identity = contractValueIdentity(current);
		const carried = carriedTarget(
			previousByValue.get(identity),
			current,
			input.previousSubmittedTargetFingerprintsByValue.get(identity),
		);
		if (!carried) return current;
		carriedValueIds.add(identity);
		return carried;
	});
	const byMessage = new Map<string, ProjectedMessage[]>();
	const messageIndexByValue = new Map<string, number>();
	for (const [index, message] of messages.entries()) {
		const identity = contractValueIdentity(message);
		if (messageIndexByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The staged Catalog Projection contains a duplicate Locale value.",
			});
		}
		messageIndexByValue.set(identity, index);
		byMessage.set(message.messageId, [
			...(byMessage.get(message.messageId) ?? []),
			message,
		]);
	}
	const consequences: ContractConsequence[] = [];

	for (const [messageId, sourceMessage] of currentSource) {
		const currentInspection = inspectIcu(sourceMessage.value);
		if (currentInspection.missingOther) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Contract Validity failed: source message "${messageId}" has no other arm.`,
			});
		}
		const priorSource = previousSource.get(messageId);
		const priorInspection = priorSource ? inspectIcu(priorSource.value) : null;
		const priorDefinitions = priorSource
			? placeholderDefinitions(priorSource.metadata)
			: new Map<string, PlaceholderDefinition>();
		const currentDefinitions = placeholderDefinitions(sourceMessage.metadata);
		const renames =
			priorSource && priorInspection
				? provenPlaceholderRenames(
						priorSource,
						sourceMessage,
						priorInspection,
						priorDefinitions,
						currentDefinitions,
					)
				: new Map<string, string>();
		const changedTypes = priorSource
			? [...currentDefinitions].flatMap(([name, to]) => {
					const from = priorDefinitions.get(name);
					return from === undefined || placeholderDefinitionEqual(from, to)
						? []
						: [{ name, from, to }];
				})
			: [];
		const allowedArguments = new Set([
			...currentDefinitions.keys(),
			...currentInspection.arguments.map((argument) => argument.name),
		]);
		const removedArguments = new Set(
			[
				...priorDefinitions.keys(),
				...(priorInspection?.arguments.map((argument) => argument.name) ?? []),
			].filter((name) => !allowedArguments.has(name) && !renames.has(name)),
		);
		const rows = byMessage.get(messageId) ?? [];
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			let row = rows[rowIndex];
			if (!row || row.isSource) continue;
			const identity = contractValueIdentity(row);
			const rawMetadata = input.targetMetadataByValue.get(identity);
			const rebased = rebaseMetadataTransforms(
				rawMetadata,
				row.metadataTransforms ?? [],
			);
			let operations = rebased.operations;
			const rowAllowedArguments = new Set(allowedArguments);
			for (const from of rebased.renameConflicts) {
				rowAllowedArguments.add(from);
				addConsequence(
					consequences,
					consequenceFor(row, "residue", "placeholder_rename_conflict", [from]),
				);
			}
			if (carriedValueIds.has(identity) && priorSource) {
				for (const [from, to] of renames) {
					const inspection = inspectIcu(row.value);
					const transformedValue = renameArgumentTokens(
						row.value,
						inspection,
						from,
						to,
					);
					let metadataOperations: MetadataTransform[] = [];
					let canRenameTokens = true;
					try {
						metadataOperations = addedMetadataTransform(
							rawMetadata,
							operations,
							{
								kind: "rename_placeholder",
								from,
								to,
							},
						);
					} catch (error) {
						if (!(error instanceof ConvexError)) throw error;
						canRenameTokens = false;
						rowAllowedArguments.add(from);
						addConsequence(
							consequences,
							consequenceFor(row, "residue", "placeholder_rename_conflict", [
								from,
							]),
						);
					}
					if (canRenameTokens && transformedValue !== row.value) {
						row = withValue(row, transformedValue);
						addConsequence(
							consequences,
							consequenceFor(row, "transform", "renamed_placeholder", [from]),
						);
					}
					if (metadataOperations.length > 0) {
						operations = composeMetadataTransforms(
							operations,
							metadataOperations,
						);
						addConsequence(
							consequences,
							consequenceFor(row, "transform", "renamed_placeholder", [from]),
						);
					}
					const renamedPreviousDefinition = priorDefinitions.get(from);
					const renamedCurrentDefinition = currentDefinitions.get(to);
					if (
						canRenameTokens &&
						renamedPreviousDefinition !== undefined &&
						renamedCurrentDefinition !== undefined &&
						!placeholderDefinitionEqual(
							renamedPreviousDefinition,
							renamedCurrentDefinition,
						)
					) {
						const metadataOperations = addedMetadataTransform(
							rawMetadata,
							operations,
							retypeOperation(
								to,
								renamedPreviousDefinition,
								renamedCurrentDefinition,
							),
						);
						if (metadataOperations.length > 0) {
							operations = composeMetadataTransforms(
								operations,
								metadataOperations,
							);
							addConsequence(
								consequences,
								consequenceFor(row, "transform", "retyped_placeholder", [to]),
							);
						}
					}
				}
				for (const change of changedTypes) {
					const metadataOperations = addedMetadataTransform(
						rawMetadata,
						operations,
						retypeOperation(change.name, change.from, change.to),
					);
					if (metadataOperations.length > 0) {
						operations = composeMetadataTransforms(
							operations,
							metadataOperations,
						);
						addConsequence(
							consequences,
							consequenceFor(row, "transform", "retyped_placeholder", [
								change.name,
							]),
						);
					}
				}
				if (!priorInspection?.rootPlural && currentInspection.rootPlural) {
					const targetInspection = inspectIcu(row.value);
					if (!targetInspection.rootPlural) {
						row = withValue(
							row,
							`{${currentInspection.rootPlural.name}, plural, other{${quoteLiteralPoundsForOuterPlural(row.value, targetInspection)}}}`,
						);
						addConsequence(
							consequences,
							consequenceFor(row, "transform", "wrapped_plural"),
						);
					}
				}
				if (priorInspection?.rootPlural && !currentInspection.rootPlural) {
					const targetInspection = inspectIcu(row.value);
					const targetPlural = targetInspection.rootPlural;
					if (targetPlural) {
						const other = targetPlural.arms.find(
							(arm) => arm.selector === "other",
						);
						if (!other) {
							throw new ConvexError({
								code: "VALIDATION",
								message: `Contract Validity failed: ${row.localeCode}.${messageId} has no other arm.`,
							});
						}
						if (
							other.argumentNames.length === 0 &&
							!armHasUnquotedPound(row.value, other)
						) {
							row = withValue(
								row,
								row.value.slice(other.contentStart, other.contentEnd),
							);
							addConsequence(
								consequences,
								consequenceFor(row, "transform", "unwrapped_plural"),
							);
						} else {
							addConsequence(
								consequences,
								consequenceFor(
									row,
									"residue",
									"plural_to_plain_requires_translation",
								),
							);
						}
					}
				}
			}

			const inspection = inspectIcu(row.value);
			if (inspection.missingOther) {
				throw new ConvexError({
					code: "VALIDATION",
					message: `Contract Validity failed: ${row.localeCode}.${messageId} has no other arm.`,
				});
			}
			for (const argument of new Set(
				inspection.arguments.map((item) => item.name),
			)) {
				if (rowAllowedArguments.has(argument)) continue;
				addConsequence(
					consequences,
					consequenceFor(
						row,
						"residue",
						removedArguments.has(argument)
							? "removed_placeholder"
							: "target_argument_not_in_source",
						[argument],
					),
				);
			}
			const effectiveMetadata = applyMetadataTransforms(
				rawMetadata,
				operations,
			);
			validateTargetMetadata(
				sourceMessage.metadata,
				effectiveMetadata,
				row.localeCode,
				messageId,
			);
			if (operations.length > 0) {
				row = {
					...row,
					metadataTransforms: operations.map((operation) => ({ ...operation })),
				};
			} else if (row.metadataTransforms !== undefined) {
				const {
					metadataTransforms: _metadataTransforms,
					...withoutTransforms
				} = row;
				row = withoutTransforms;
			}
			rows[rowIndex] = row;
			const messageIndex = messageIndexByValue.get(identity);
			if (messageIndex === undefined) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Contract Transform lost its projected target identity.",
				});
			}
			messages[messageIndex] = row;
		}
	}

	return { messages, consequences };
}
