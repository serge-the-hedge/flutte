import { ConvexError, type Infer, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { encodedSize } from "./catalogWorkspaceView";
import {
	type GuidanceScope,
	guidanceEntries,
	guidanceEntry,
	guidanceState,
	projectDictionaryConnection,
	resolveDictionaryWrite,
} from "./dictionaryAccess";
import { normalizeLocaleCode } from "./lib";
import { introductionTargetFor } from "./localeIntroductionTargets";
import { messageLiteralParts } from "./messageFacts";
import {
	assertProjectExists,
	requireEditor,
	requireViewer,
} from "./permissions";
import {
	dictionaryTermValidator,
	type guidanceAuthorValidator,
	type guidanceContentValidator,
	type guidanceContextValidator,
	guidanceListValidator,
	projectVoiceGuideFields,
	retainedGuidanceRevisionValidator,
	voiceGuideFields,
} from "./translationGuidanceModel";

export {
	guidanceContextValidator,
	retainedGuidanceRevisionValidator,
} from "./translationGuidanceModel";

export const MAX_DICTIONARY_TERMS = 256;
export const MAX_VOICE_GUIDES = 128;
export const MAX_DICTIONARY_TERM_BYTES = 16 * 1024;
export const MAX_VOICE_GUIDE_BYTES = 8 * 1024;
export const MAX_GUIDANCE_BYTES = 512 * 1024;
export const MAX_GUIDANCE_TEXTS = 50;
export const MAX_GUIDANCE_LOCALES = 20;
export const MAX_DICTIONARY_RENDERINGS = 128;

type GuidanceContent = Infer<typeof guidanceContentValidator>;
type GuidanceAuthor = Infer<typeof guidanceAuthorValidator>;
type DictionaryTerm = Infer<typeof dictionaryTermValidator>;
type ReadCtx = QueryCtx | MutationCtx;

function requireEnvelope(condition: boolean, message: string) {
	if (!condition) throw new ConvexError({ code: "LIMIT_EXCEEDED", message });
}

function requireNonblank(value: string, label: string) {
	if (value.trim().length === 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `${label} cannot be blank.`,
		});
	}
}

function validateRevision(revision: number) {
	if (!Number.isSafeInteger(revision) || revision < 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Guidance revision must be a nonnegative integer.",
		});
	}
}

/** Guidance can prepare configured targets before they have a Catalog Binding. */
async function validateLocales(
	ctx: ReadCtx,
	projectId: Id<"projects"> | undefined,
	localeCodes: readonly string[],
	options: {
		allowArchived?: boolean;
		preservedRenderingLocales?: ReadonlySet<string>;
	} = {},
) {
	requireEnvelope(
		localeCodes.length <= MAX_DICTIONARY_RENDERINGS,
		"Guidance supports at most 128 authored Locales.",
	);
	const seen = new Set<string>();
	for (const localeCode of localeCodes) {
		if (
			localeCode.length === 0 ||
			normalizeLocaleCode(localeCode) !== localeCode ||
			seen.has(localeCode)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Guidance Locale codes must be canonical and unique.",
			});
		}
		seen.add(localeCode);
		if (!projectId) continue;
		const locale = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", projectId).eq("code", localeCode),
			)
			.unique();
		const configured = await introductionTargetFor(ctx, projectId, localeCode);
		if (
			(locale &&
				(locale.isSource ||
					(!options.allowArchived &&
						!options.preservedRenderingLocales?.has(localeCode) &&
						locale.archivedAt !== undefined &&
						!configured))) ||
			(!locale &&
				!configured &&
				!options.allowArchived &&
				!options.preservedRenderingLocales?.has(localeCode))
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `Guidance Locale ${localeCode} is not an active target or supported New Locale.`,
			});
		}
	}
}

function termKey(sourceTerm: string) {
	return `term:${sourceTerm}`;
}

function guideKey(localeCode: string) {
	return `voice:${localeCode}`;
}

function citation(entry: Doc<"translationGuidanceEntries">) {
	return {
		revisionId: entry.revisionId,
		revision: entry.revision,
		authoredBy: entry.authoredBy,
		authoredAt: entry.authoredAt,
	};
}

export async function localGuidance(
	ctx: ReadCtx,
	projectId: Id<"projects"> | undefined,
	dictionaryId?: Id<"dictionaries">,
): Promise<Infer<typeof guidanceListValidator>> {
	const scope = { projectId, dictionaryId };
	const [state, entries] = await Promise.all([
		guidanceState(ctx, scope),
		guidanceEntries(ctx, scope).take(
			MAX_DICTIONARY_TERMS + MAX_VOICE_GUIDES + 2,
		),
	]);
	if (
		entries.length > MAX_DICTIONARY_TERMS + MAX_VOICE_GUIDES + 1 ||
		(!state && entries.length > 0)
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Translation guidance has no valid current-state envelope.",
		});
	}
	const projectGuide = entries.find(
		(entry) => entry.content.kind === "projectVoiceGuide",
	);
	return {
		revision: state?.revision ?? 0,
		projectGuide:
			projectGuide?.content.kind === "projectVoiceGuide"
				? {
						text: projectGuide.content.text,
						examples: projectGuide.content.examples,
						...citation(projectGuide),
					}
				: null,
		terms: entries.flatMap((entry) =>
			entry.content.kind === "term"
				? [{ term: entry.content.term, ...citation(entry) }]
				: [],
		),
		guides: entries.flatMap((entry) =>
			entry.content.kind === "voiceGuide"
				? [
						{
							localeCode: entry.content.localeCode,
							text: entry.content.text,
							examples: entry.content.examples,
							...citation(entry),
						},
					]
				: [],
		),
	};
}

export async function currentGuidance(
	ctx: ReadCtx,
	projectId: Id<"projects">,
): Promise<Infer<typeof guidanceListValidator>> {
	const local = await localGuidance(ctx, projectId);
	const link = await projectDictionaryConnection(ctx, projectId);
	if (!link?.dictionaryId) return local;
	const shared = await localGuidance(ctx, undefined, link.dictionaryId);
	return {
		...local,
		terms: shared.terms,
		dictionary: {
			id: link.dictionaryId,
			revision: shared.revision,
			connectionRevision: link.revision,
		},
	};
}

/** One revision per deliberate authorized change, with an immutable copy small
 * enough to retrieve by citation. Unchanged writes do not grow history. */
export async function writeEntry(
	ctx: MutationCtx,
	input: {
		projectId?: Id<"projects">;
		dictionaryId?: Id<"dictionaries">;
		expectedRevision: number;
		key: string;
		content: GuidanceContent | null;
		authoredBy: GuidanceAuthor;
	},
) {
	if (Boolean(input.projectId) === Boolean(input.dictionaryId))
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Guidance must belong to exactly one project or Dictionary.",
		});
	if (
		input.dictionaryId &&
		(!input.key.startsWith("term:") ||
			(input.content && input.content.kind !== "term"))
	)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Voice guidance belongs to a project.",
		});
	validateRevision(input.expectedRevision);
	if (input.content) {
		const dictionaryEntry = input.content.kind === "term";
		requireEnvelope(
			encodedSize(input.content) <=
				(dictionaryEntry ? MAX_DICTIONARY_TERM_BYTES : MAX_VOICE_GUIDE_BYTES),
			dictionaryEntry
				? "A Dictionary entry supports at most 16 KiB."
				: "A voice guide supports at most 8 KiB.",
		);
	}
	const scope: GuidanceScope = input.dictionaryId
		? { dictionaryId: input.dictionaryId }
		: { projectId: input.projectId };
	const [state, previous] = await Promise.all([
		guidanceState(ctx, scope),
		guidanceEntry(ctx, scope, input.key),
	]);
	if ((state?.revision ?? 0) !== input.expectedRevision) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "Translation guidance changed. Refresh it before saving.",
		});
	}
	if (
		JSON.stringify(previous?.content ?? null) === JSON.stringify(input.content)
	) {
		return {
			revision: state?.revision ?? 0,
			revisionId: previous?.revisionId ?? null,
		};
	}
	const revision = (state?.revision ?? 0) + 1;
	const termCount =
		(state?.termCount ?? 0) +
		Number(input.content?.kind === "term") -
		Number(previous?.content.kind === "term");
	const guideCount =
		(state?.guideCount ?? 0) +
		Number(input.content?.kind === "voiceGuide") -
		Number(previous?.content.kind === "voiceGuide");
	const byteLength =
		(state?.byteLength ?? 0) +
		(input.content ? encodedSize(input.content) : 0) -
		(previous ? encodedSize(previous.content) : 0);
	requireEnvelope(
		termCount <= MAX_DICTIONARY_TERMS,
		"Guidance supports at most 256 Dictionary terms.",
	);
	requireEnvelope(
		guideCount <= MAX_VOICE_GUIDES,
		"A project supports at most 128 Locale voice add-ons.",
	);
	// Keep room for citations and matched-text indexes in the bounded read.
	requireEnvelope(
		byteLength <= MAX_GUIDANCE_BYTES - 64 * 1024,
		"Translation guidance exceeds its owner byte envelope.",
	);
	const authoredBy = input.authoredBy;
	const authoredAt = Date.now();
	const revisionId = await ctx.db.insert("translationGuidanceRevisions", {
		...scope,
		key: input.key,
		content: input.content,
		revision,
		authoredBy,
		authoredAt,
	});
	if (input.content === null) {
		if (previous) await ctx.db.delete(previous._id);
	} else {
		const next = {
			...scope,
			key: input.key,
			content: input.content,
			revisionId,
			revision,
			authoredBy,
			authoredAt,
		};
		if (previous) await ctx.db.replace(previous._id, next);
		else await ctx.db.insert("translationGuidanceEntries", next);
	}
	const nextState = {
		...scope,
		revision,
		termCount,
		guideCount,
		byteLength,
	};
	if (state) await ctx.db.replace(state._id, nextState);
	else await ctx.db.insert("translationGuidanceStates", nextState);
	return { revision, revisionId };
}

/** Carry current authored guidance with a pre-Snapshot Locale code correction.
 * Called inside the setup mutation: conflicting destination content rolls back
 * the whole correction, and each changed entry retains its old citation. */
export async function correctGuidanceLocaleCode(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		fromCode: string;
		toCode: string;
		isSource: boolean;
		userId: string;
	},
) {
	if (input.fromCode === input.toCode) return;
	const guidance = await localGuidance(ctx, input.projectId);
	const changes: Array<{ key: string; content: GuidanceContent | null }> = [];
	const fromGuide = guidance.guides.find(
		(guide) => guide.localeCode === input.fromCode,
	);
	const toGuide = guidance.guides.find(
		(guide) => guide.localeCode === input.toCode,
	);
	if (
		input.isSource &&
		(toGuide ||
			guidance.terms.some(
				(entry) =>
					entry.term.kind === "translated" &&
					entry.term.renderings.some(
						(rendering) => rendering.localeCode === input.toCode,
					),
			))
	) {
		throw new ConvexError({
			code: "CONFLICT",
			message: `The proposed Source Locale ${input.toCode} has target translation guidance. Remove that target guidance before correcting the Source Locale.`,
		});
	}
	if (fromGuide) {
		if (
			toGuide &&
			(fromGuide.text !== toGuide.text ||
				JSON.stringify(fromGuide.examples) !== JSON.stringify(toGuide.examples))
		) {
			throw new ConvexError({
				code: "CONFLICT",
				message: `Locale correction would replace different ${input.toCode} voice guidance. Resolve the guidance before correcting the Locale.`,
			});
		}
		// Remove the old head first so moving a guide at the project limit does
		// not temporarily exceed its count or byte envelope inside the mutation.
		changes.push({ key: guideKey(input.fromCode), content: null });
		if (!toGuide)
			changes.push({
				key: guideKey(input.toCode),
				content: {
					kind: "voiceGuide",
					localeCode: input.toCode,
					text: fromGuide.text,
					examples: fromGuide.examples,
				},
			});
	}
	for (const entry of guidance.terms) {
		if (entry.term.kind !== "translated") continue;
		const from = entry.term.renderings.find(
			(rendering) => rendering.localeCode === input.fromCode,
		);
		if (!from) continue;
		const to = entry.term.renderings.find(
			(rendering) => rendering.localeCode === input.toCode,
		);
		if (to && to.value !== from.value) {
			throw new ConvexError({
				code: "CONFLICT",
				message: `Locale correction would replace the ${input.toCode} rendering of “${entry.term.sourceTerm}”. Resolve the Dictionary entry before correcting the Locale.`,
			});
		}
		const renderings = entry.term.renderings.filter(
			(rendering) => rendering.localeCode !== input.fromCode,
		);
		if (!to) renderings.push({ localeCode: input.toCode, value: from.value });
		renderings.sort((left, right) =>
			left.localeCode.localeCompare(right.localeCode),
		);
		changes.push({
			key: termKey(entry.term.sourceTerm),
			content: { kind: "term", term: { ...entry.term, renderings } },
		});
	}
	let revision = guidance.revision;
	for (const change of changes) {
		const saved = await writeEntry(ctx, {
			...change,
			projectId: input.projectId,
			expectedRevision: revision,
			authoredBy: { kind: "user", id: input.userId },
		});
		revision = saved.revision;
	}
}

export const guidanceSaveResultValidator = v.object({
	revision: v.number(),
	revisionId: v.union(v.id("translationGuidanceRevisions"), v.null()),
});

/** The authenticated adapter supplies authorship; human and agent writes share
 * normalization, Locale validation, revision checks, and immutable citations. */
export async function saveDictionaryTerm(
	ctx: MutationCtx,
	args: {
		projectId?: Id<"projects">;
		dictionaryId?: Id<"dictionaries">;
		expectedDictionaryId?: Id<"dictionaries">;
		expectedConnectionRevision?: number;
		expectedRevision: number;
		term: DictionaryTerm;
		authoredBy: GuidanceAuthor;
	},
) {
	const scope = await resolveDictionaryWrite(ctx, args);
	requireNonblank(args.term.sourceTerm, "Source term");
	requireNonblank(args.term.definition, "Term definition");
	const sourceTerm = args.term.sourceTerm.trim();
	requireEnvelope(
		new TextEncoder().encode(sourceTerm).byteLength <= 256,
		"A source term supports at most 256 UTF-8 bytes.",
	);
	let term: DictionaryTerm;
	if (args.term.kind === "translated") {
		if (args.term.renderings.length === 0)
			throw new ConvexError({
				code: "VALIDATION",
				message: "A translated term needs at least one Locale rendering.",
			});
		const previous = await guidanceEntry(ctx, scope, termKey(sourceTerm));
		const previousRenderings = new Map(
			previous?.content.kind === "term" &&
				previous.content.term.kind === "translated"
				? previous.content.term.renderings.map((rendering) => [
						rendering.localeCode,
						rendering.value,
					])
				: [],
		);
		await validateLocales(
			ctx,
			scope.projectId,
			args.term.renderings.map((rendering) => rendering.localeCode),
			{
				preservedRenderingLocales: new Set(
					args.term.renderings.flatMap((rendering) =>
						previousRenderings.get(rendering.localeCode) === rendering.value
							? [rendering.localeCode]
							: [],
					),
				),
			},
		);
		for (const rendering of args.term.renderings)
			requireNonblank(rendering.value, "Term rendering");
		term = {
			...args.term,
			sourceTerm,
			definition: args.term.definition.trim(),
			renderings: [...args.term.renderings].sort((left, right) =>
				left.localeCode.localeCompare(right.localeCode),
			),
		};
	} else {
		term = {
			...args.term,
			sourceTerm,
			definition: args.term.definition.trim(),
		};
	}
	const content = { kind: "term" as const, term };
	return await writeEntry(ctx, {
		...args,
		...scope,
		projectId: scope.projectId,
		dictionaryId: scope.dictionaryId,
		key: termKey(sourceTerm),
		content,
		authoredBy: args.authoredBy,
	});
}

export const saveTerm = mutation({
	args: {
		projectId: v.id("projects"),
		expectedRevision: v.number(),
		expectedDictionaryId: v.optional(v.id("dictionaries")),
		expectedConnectionRevision: v.optional(v.number()),
		term: dictionaryTermValidator,
	},
	returns: guidanceSaveResultValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		return await saveDictionaryTerm(ctx, {
			...args,
			authoredBy: { kind: "user", id: userId },
		});
	},
});

export async function removeDictionaryTerm(
	ctx: MutationCtx,
	args: {
		projectId?: Id<"projects">;
		dictionaryId?: Id<"dictionaries">;
		expectedDictionaryId?: Id<"dictionaries">;
		expectedConnectionRevision?: number;
		expectedRevision: number;
		sourceTerm: string;
		authoredBy: GuidanceAuthor;
	},
) {
	const scope = await resolveDictionaryWrite(ctx, args);
	requireNonblank(args.sourceTerm, "Source term");
	return await writeEntry(ctx, {
		...args,
		projectId: scope.projectId,
		dictionaryId: scope.dictionaryId,
		key: termKey(args.sourceTerm.trim()),
		content: null,
		authoredBy: args.authoredBy,
	});
}

export const removeTerm = mutation({
	args: {
		projectId: v.id("projects"),
		expectedRevision: v.number(),
		expectedDictionaryId: v.optional(v.id("dictionaries")),
		expectedConnectionRevision: v.optional(v.number()),
		sourceTerm: v.string(),
	},
	returns: guidanceSaveResultValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		return await removeDictionaryTerm(ctx, {
			...args,
			authoredBy: { kind: "user", id: userId },
		});
	},
});

function validateVoiceExamples(
	examples: Infer<typeof projectVoiceGuideFields.examples>,
) {
	requireEnvelope(
		examples.length <= 5,
		"A voice guide supports at most five curated examples.",
	);
	for (const example of examples) {
		requireNonblank(example.source, "Voice example source");
		requireNonblank(example.target, "Voice example target");
	}
}

export const saveProjectVoiceGuide = mutation({
	args: {
		projectId: v.id("projects"),
		expectedRevision: v.number(),
		...projectVoiceGuideFields,
	},
	returns: guidanceSaveResultValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		validateVoiceExamples(args.examples);
		const removing =
			args.text.trim().length === 0 && args.examples.length === 0;
		return await writeEntry(ctx, {
			projectId: args.projectId,
			expectedRevision: args.expectedRevision,
			key: "projectVoiceGuide",
			content: removing
				? null
				: {
						kind: "projectVoiceGuide",
						text: args.text,
						examples: args.examples,
					},
			authoredBy: { kind: "user", id: userId },
		});
	},
});

export const saveVoiceGuide = mutation({
	args: {
		projectId: v.id("projects"),
		expectedRevision: v.number(),
		...voiceGuideFields,
	},
	returns: guidanceSaveResultValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const removing =
			args.text.trim().length === 0 && args.examples.length === 0;
		await validateLocales(ctx, args.projectId, [args.localeCode], {
			allowArchived: removing,
		});
		validateVoiceExamples(args.examples);
		const content = removing
			? null
			: {
					kind: "voiceGuide" as const,
					localeCode: args.localeCode,
					text: args.text,
					examples: args.examples,
				};
		return await writeEntry(ctx, {
			...args,
			key: guideKey(args.localeCode),
			content,
			authoredBy: { kind: "user", id: userId },
		});
	},
});

export const list = query({
	args: { projectId: v.id("projects") },
	returns: guidanceListValidator,
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return await currentGuidance(ctx, args.projectId);
	},
});

/** Word boundaries must not require spaces in scripts that omit them. */
function joinsSpacedWord(character: string): boolean {
	return (
		/[\p{L}\p{N}\p{M}_]/u.test(character) &&
		!/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u.test(
			character,
		)
	);
}

/** Exact case-sensitive terms match literal words or phrases, excluding ICU
 * syntax and substrings within longer words in scripts that separate words. */
function literalContainsTerm(literal: string, sourceTerm: string): boolean {
	const termCharacters = Array.from(sourceTerm);
	const startsWithWord = joinsSpacedWord(termCharacters[0] ?? "");
	const endsWithWord = joinsSpacedWord(
		termCharacters[termCharacters.length - 1] ?? "",
	);
	for (
		let index = literal.indexOf(sourceTerm);
		index !== -1;
		index = literal.indexOf(sourceTerm, index + 1)
	) {
		const beforeCharacters = Array.from(
			literal.slice(Math.max(0, index - 2), index),
		);
		const before = beforeCharacters[beforeCharacters.length - 1] ?? "";
		const after =
			Array.from(
				literal.slice(index + sourceTerm.length, index + sourceTerm.length + 2),
			)[0] ?? "";
		if (
			(!startsWithWord || !joinsSpacedWord(before)) &&
			(!endsWithWord || !joinsSpacedWord(after))
		)
			return true;
	}
	return false;
}

/** Authentication belongs to the adapter. Matching returns shared evidence
 * once with source-text indexes, so a batch does not repeat the same guidance
 * for every key and Locale pair. Absence is empty guidance, never a default. */
export async function readGuidance(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	input: {
		texts: readonly string[];
		localeCodes: readonly string[];
		syntax?: "plain" | "icu";
	},
): Promise<Infer<typeof guidanceContextValidator>> {
	await assertProjectExists(ctx, projectId);
	requireEnvelope(
		input.texts.length <= MAX_GUIDANCE_TEXTS,
		"Guidance supports at most 50 source texts.",
	);
	requireEnvelope(
		encodedSize(input.texts) <= MAX_GUIDANCE_BYTES,
		"Guidance source texts exceed the 512 KiB envelope.",
	);
	requireEnvelope(
		input.localeCodes.length <= MAX_GUIDANCE_LOCALES,
		"Guidance context supports at most 20 Locales per request.",
	);
	await validateLocales(ctx, projectId, input.localeCodes);
	const guidance = await currentGuidance(ctx, projectId);
	const literalsByText = input.texts.map((text) =>
		input.syntax === "plain" ? [text] : messageLiteralParts(text),
	);
	const localeCodes = new Set(input.localeCodes);
	const result = {
		revision: guidance.revision,
		dictionary: guidance.dictionary,
		projectGuide: guidance.projectGuide,
		terms: guidance.terms.flatMap((entry) => {
			const matchedTextIndexes = literalsByText.flatMap((literals, index) =>
				literals.some((literal) =>
					literalContainsTerm(literal, entry.term.sourceTerm),
				)
					? [index]
					: [],
			);
			if (matchedTextIndexes.length === 0) return [];
			const term: DictionaryTerm =
				entry.term.kind === "translated"
					? {
							...entry.term,
							renderings: entry.term.renderings.filter((rendering) =>
								localeCodes.has(rendering.localeCode),
							),
						}
					: entry.term;
			return [{ ...entry, term, matchedTextIndexes }];
		}),
		guides: guidance.guides.filter((guide) =>
			localeCodes.has(guide.localeCode),
		),
	};
	requireEnvelope(
		encodedSize(result) <= MAX_GUIDANCE_BYTES,
		"Applicable guidance exceeds the 512 KiB response envelope.",
	);
	return result;
}

/** Removed and superseded entries remain directly retrievable by their
 * immutable revision ID, subject to current project access. */
export async function readGuidanceRevision(
	ctx: ReadCtx,
	projectId: Id<"projects">,
	revisionId: Id<"translationGuidanceRevisions">,
): Promise<Infer<typeof retainedGuidanceRevisionValidator>> {
	await assertProjectExists(ctx, projectId);
	const revision = await ctx.db.get(revisionId);
	const link = await projectDictionaryConnection(ctx, projectId);
	const dictionary = link?.dictionaryId
		? await ctx.db.get(link.dictionaryId)
		: null;
	const sharedAllowed =
		revision &&
		dictionary &&
		revision.key.startsWith("term:") &&
		(revision.dictionaryId === dictionary._id ||
			(dictionary.legacyProjectId !== undefined &&
				revision.projectId === dictionary.legacyProjectId &&
				dictionary.legacyRevision !== undefined &&
				revision.revision <= dictionary.legacyRevision &&
				dictionary.legacyTermKeys?.includes(revision.key) === true));
	if (!revision || (revision.projectId !== projectId && !sharedAllowed))
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Guidance revision not found for this project.",
		});
	return {
		projectId,
		key: revision.key,
		content: revision.content,
		revisionId: revision._id,
		revision: revision.revision,
		authoredBy: revision.authoredBy,
		authoredAt: revision.authoredAt,
	};
}

export const getRevision = query({
	args: {
		projectId: v.id("projects"),
		revisionId: v.id("translationGuidanceRevisions"),
	},
	returns: retainedGuidanceRevisionValidator,
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return await readGuidanceRevision(ctx, args.projectId, args.revisionId);
	},
});
