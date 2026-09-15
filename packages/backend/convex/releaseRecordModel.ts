import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";

const releaseStatusValidator = v.union(
	v.literal("preparing"),
	v.literal("ready"),
	v.literal("superseded"),
	v.literal("failed"),
);
const releasePostureValidator = v.union(
	v.literal("blocked"),
	v.literal("needsDecisions"),
	v.literal("ready"),
);
const releaseFailureValidator = v.object({
	code: v.optional(v.string()),
	message: v.string(),
	failedAt: v.number(),
});
export const localeSummaryValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	scopeValueCount: v.number(),
	blockedCount: v.number(),
	needsDecisionCount: v.number(),
	intentionalBlankCount: v.number(),
	sourceIdenticalCount: v.number(),
	unconfirmedImportCount: v.number(),
});
export const releaseAssessmentFields = {
	deltaKeyCount: v.number(),
	scopeValueCount: v.number(),
	blockedCount: v.number(),
	needsDecisionCount: v.number(),
	intentionalBlankCount: v.number(),
	sourceIdenticalCount: v.number(),
	unconfirmedImportCount: v.number(),
	localeSummaries: v.array(localeSummaryValidator),
};

export const releaseSummaryValidator = v.object({
	recordId: v.id("releaseRecords"),
	projectionId: v.id("catalogProjections"),
	snapshotId: v.id("sourceSnapshots"),
	commit: v.string(),
	navigationRevision: v.number(),
	status: releaseStatusValidator,
	posture: v.union(releasePostureValidator, v.null()),
	progress: v.object({ cursor: v.number(), expectedKeyCount: v.number() }),
	...releaseAssessmentFields,
	sourceLocaleCode: v.optional(v.string()),
	changedKeyCount: v.optional(v.number()),
	changedValueCount: v.optional(v.number()),
	failure: v.union(releaseFailureValidator, v.null()),
	createdAt: v.number(),
	completedAt: v.union(v.number(), v.null()),
});

export const findingValidator = v.object({
	_id: v.id("releaseFindings"),
	catalogIndex: v.number(),
	messageId: v.string(),
	localeId: v.id("locales"),
	localeCode: v.string(),
	kind: v.union(
		v.literal("contract_invalid"),
		v.literal("missing_value"),
		v.literal("semantic_source_change"),
		v.literal("introduction_review"),
	),
	reasonCodes: v.optional(
		v.array(
			v.union(
				v.literal("removed_placeholder"),
				v.literal("target_argument_not_in_source"),
				v.literal("placeholder_rename_conflict"),
				v.literal("plural_to_plain_requires_translation"),
			),
		),
	),
});

export const evidenceValidator = v.union(
	v.object({
		_id: v.id("releaseEvidence"),
		catalogIndex: v.number(),
		messageId: v.string(),
		localeId: v.id("locales"),
		localeCode: v.string(),
		kind: v.literal("intentional_blank"),
		reason: v.string(),
	}),
	v.object({
		_id: v.id("releaseEvidence"),
		catalogIndex: v.number(),
		messageId: v.string(),
		localeId: v.id("locales"),
		localeCode: v.string(),
		kind: v.literal("source_identical"),
	}),
);

export type LocaleSummary = Doc<"releaseRecords">["localeSummaries"][number];
type ReleaseAssessment = Pick<
	Doc<"releaseRecords">,
	| "deltaKeyCount"
	| "scopeValueCount"
	| "blockedCount"
	| "needsDecisionCount"
	| "intentionalBlankCount"
	| "sourceIdenticalCount"
	| "unconfirmedImportCount"
	| "localeSummaries"
>;

export function releaseAssessmentFrom(
	input: ReleaseAssessment,
): ReleaseAssessment {
	return {
		deltaKeyCount: input.deltaKeyCount,
		scopeValueCount: input.scopeValueCount,
		blockedCount: input.blockedCount,
		needsDecisionCount: input.needsDecisionCount,
		intentionalBlankCount: input.intentionalBlankCount,
		sourceIdenticalCount: input.sourceIdenticalCount,
		unconfirmedImportCount: input.unconfirmedImportCount,
		localeSummaries: input.localeSummaries,
	};
}

export function emptyReleaseAssessment(): ReleaseAssessment {
	return {
		deltaKeyCount: 0,
		scopeValueCount: 0,
		blockedCount: 0,
		needsDecisionCount: 0,
		intentionalBlankCount: 0,
		sourceIdenticalCount: 0,
		unconfirmedImportCount: 0,
		localeSummaries: [],
	};
}

export function releasePostureFor(input: {
	blockedCount: number;
	needsDecisionCount: number;
}): "blocked" | "needsDecisions" | "ready" {
	if (input.blockedCount > 0) return "blocked";
	if (input.needsDecisionCount > 0) return "needsDecisions";
	return "ready";
}

export function isReleaseDelta(input: {
	pendingSourceProposal: boolean;
	introductionReviewPending?: number;
	targets: readonly { touched: boolean }[];
}) {
	return (
		input.pendingSourceProposal ||
		(input.introductionReviewPending ?? 0) > 0 ||
		input.targets.some((target) => target.touched)
	);
}

export function deliberateEvidenceFor(input: {
	decision:
		| { kind: "intentionalBlank"; reason: string }
		| { kind: "translatorConfirmation" }
		| null;
	targetValueFingerprint: string;
	sourceValueFingerprint: string;
}) {
	if (input.decision?.kind === "intentionalBlank") {
		return {
			kind: "intentional_blank" as const,
			reason: input.decision.reason,
		};
	}
	if (
		input.decision?.kind === "translatorConfirmation" &&
		input.targetValueFingerprint === input.sourceValueFingerprint
	) {
		return { kind: "source_identical" as const };
	}
	return null;
}

export function releaseTargetContribution(input: {
	findings: readonly {
		kind:
			| "contract_invalid"
			| "missing_value"
			| "semantic_source_change"
			| "introduction_review";
	}[];
	evidence: { kind: "intentional_blank" } | { kind: "source_identical" } | null;
	unconfirmedImport: boolean;
}) {
	return {
		scopeValueCount: 1,
		blockedCount: input.findings.filter(
			(finding) => finding.kind === "contract_invalid",
		).length,
		needsDecisionCount: input.findings.filter(
			(finding) => finding.kind !== "contract_invalid",
		).length,
		intentionalBlankCount: input.evidence?.kind === "intentional_blank" ? 1 : 0,
		sourceIdenticalCount: input.evidence?.kind === "source_identical" ? 1 : 0,
		unconfirmedImportCount: input.unconfirmedImport ? 1 : 0,
	};
}

export function releaseSummary(
	record: Doc<"releaseRecords">,
	preparation?: Doc<"releaseRecordPreparations"> | null,
) {
	const working = preparation ?? record;
	return {
		recordId: record._id,
		...(record.sourceLocaleCode === undefined
			? {}
			: { sourceLocaleCode: record.sourceLocaleCode }),
		projectionId: record.projectionId,
		snapshotId: record.snapshotId,
		commit: record.commit,
		navigationRevision: record.navigationRevision,
		status: record.status,
		posture: record.posture ?? null,
		progress: {
			cursor:
				preparation?.cursor ??
				(record.status === "ready" ? record.expectedKeyCount - 1 : -1),
			expectedKeyCount: record.expectedKeyCount,
		},
		...releaseAssessmentFrom(working),
		...(working.changedKeyCount === undefined
			? {}
			: {
					changedKeyCount: working.changedKeyCount,
					changedValueCount: working.changedValueCount,
				}),
		failure: record.failure ?? null,
		createdAt: record.createdAt,
		completedAt: record.completedAt ?? null,
	};
}

export function evidenceSummary(row: Doc<"releaseEvidence">) {
	return row.kind === "intentional_blank"
		? {
				_id: row._id,
				catalogIndex: row.catalogIndex,
				messageId: row.messageId,
				localeId: row.localeId,
				localeCode: row.localeCode,
				kind: row.kind,
				reason: row.reason,
			}
		: {
				_id: row._id,
				catalogIndex: row.catalogIndex,
				messageId: row.messageId,
				localeId: row.localeId,
				localeCode: row.localeCode,
				kind: row.kind,
			};
}

export function emptyLocaleSummary(
	localeId: Id<"locales">,
	localeCode: string,
): LocaleSummary {
	return {
		localeId,
		localeCode,
		scopeValueCount: 0,
		blockedCount: 0,
		needsDecisionCount: 0,
		intentionalBlankCount: 0,
		sourceIdenticalCount: 0,
		unconfirmedImportCount: 0,
	};
}

export function localeSummaryMap(summaries: readonly LocaleSummary[]) {
	return new Map(
		summaries.map((summary) => [summary.localeId, { ...summary }]),
	);
}

export function sortedLocaleSummaries(
	summaries: Map<Id<"locales">, LocaleSummary>,
) {
	return [...summaries.values()].sort((a, b) =>
		a.localeCode.localeCompare(b.localeCode),
	);
}
