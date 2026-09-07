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

export const voiceGuideFields = {
	localeCode: v.string(),
	text: v.string(),
	examples: v.array(v.object({ source: v.string(), target: v.string() })),
};

export const guidanceContentValidator = v.union(
	v.object({ kind: v.literal("term"), term: dictionaryTermValidator }),
	v.object({ kind: v.literal("voiceGuide"), ...voiceGuideFields }),
);

export const guidanceAuthorshipFields = {
	revision: v.number(),
	authoredBy: v.object({ kind: v.literal("user"), id: v.string() }),
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

export const guidanceListValidator = v.object({
	revision: v.number(),
	terms: v.array(v.object(dictionaryTermEvidenceFields)),
	guides: v.array(voiceGuideEvidenceValidator),
});

export const guidanceContextValidator = v.object({
	revision: v.number(),
	terms: v.array(
		v.object({
			...dictionaryTermEvidenceFields,
			matchedTextIndexes: v.array(v.number()),
		}),
	),
	guides: v.array(voiceGuideEvidenceValidator),
});

export const retainedGuidanceRevisionValidator = v.object({
	projectId: v.id("projects"),
	key: v.string(),
	content: v.union(guidanceContentValidator, v.null()),
	...guidanceCitationFields,
});
