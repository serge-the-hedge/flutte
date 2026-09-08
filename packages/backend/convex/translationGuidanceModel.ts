import { v } from "convex/values";

const termFields = {
	sourceTerm: v.string(),
	definition: v.string(),
};

export const dictionaryTermValidator = v.union(
	v.object({ ...termFields, kind: v.literal("untranslatable") }),
	v.object({
		...termFields,
		kind: v.literal("translated"),
		renderings: v.array(
			v.object({ localeCode: v.string(), value: v.string() }),
		),
	}),
);

export const projectVoiceGuideFields = {
	text: v.string(),
	examples: v.array(v.object({ source: v.string(), target: v.string() })),
};

export const voiceGuideFields = {
	localeCode: v.string(),
	...projectVoiceGuideFields,
};

export const guidanceContentValidator = v.union(
	v.object({ kind: v.literal("term"), term: dictionaryTermValidator }),
	v.object({ kind: v.literal("voiceGuide"), ...voiceGuideFields }),
	v.object({
		kind: v.literal("projectVoiceGuide"),
		...projectVoiceGuideFields,
	}),
);

export const guidanceAuthorValidator = v.union(
	v.object({ kind: v.literal("user"), id: v.string() }),
	v.object({ kind: v.literal("agent"), id: v.string() }),
);

export const guidanceAuthorshipFields = {
	revision: v.number(),
	authoredBy: guidanceAuthorValidator,
	authoredAt: v.number(),
};

const guidanceCitationFields = {
	...guidanceAuthorshipFields,
	revisionId: v.id("translationGuidanceRevisions"),
};

export const dictionaryTermEvidenceFields = {
	term: dictionaryTermValidator,
	...guidanceCitationFields,
};

export const voiceGuideEvidenceValidator = v.object({
	...voiceGuideFields,
	...guidanceCitationFields,
});

export const projectVoiceGuideEvidenceValidator = v.object({
	...projectVoiceGuideFields,
	...guidanceCitationFields,
});

export const dictionaryContextValidator = v.object({
	id: v.id("dictionaries"),
	revision: v.number(),
	connectionRevision: v.number(),
});
export const guidanceListValidator = v.object({
	dictionary: v.optional(dictionaryContextValidator),
	revision: v.number(),
	terms: v.array(v.object(dictionaryTermEvidenceFields)),
	guides: v.array(voiceGuideEvidenceValidator),
	projectGuide: v.union(projectVoiceGuideEvidenceValidator, v.null()),
});

export const guidanceContextValidator = v.object({
	dictionary: v.optional(dictionaryContextValidator),
	revision: v.number(),
	terms: v.array(
		v.object({
			...dictionaryTermEvidenceFields,
			matchedTextIndexes: v.array(v.number()),
		}),
	),
	guides: v.array(voiceGuideEvidenceValidator),
	projectGuide: v.union(projectVoiceGuideEvidenceValidator, v.null()),
});

export const retainedGuidanceRevisionValidator = v.object({
	projectId: v.id("projects"),
	key: v.string(),
	content: v.union(guidanceContentValidator, v.null()),
	...guidanceCitationFields,
});
