import { ConvexError } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { pendingIntroductionLocaleIds } from "./catalogIntroductionReviews";

export const ORDINARY_IMPORT_CONFIRMATION_POLICY = "ordinary-v1" as const;
export const MAX_ORDINARY_CONFIRMATIONS_PER_MUTATION = 256;

export type OrdinaryImportConfirmationCandidate = {
	messageId: string;
	localeId: Id<"locales">;
	sourceFingerprint: string;
	valueFingerprint: string;
};

export type OrdinaryImportConfirmationCounts = {
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
};

type ConfirmationRow = Pick<
	Doc<"catalogProjectionMessages">,
	| "messageId"
	| "localeId"
	| "localeCode"
	| "isSource"
	| "value"
	| "sourceFingerprint"
	| "gitValueFingerprint"
	| "gitValueRevision"
	| "introducedAt"
	| "introductionLocaleIds"
> & { valueFingerprint: string };

type ConfirmationHead = Pick<
	Doc<"catalogWorkspaceValueHeads">,
	| "messageId"
	| "localeId"
	| "basisGitValueFingerprint"
	| "basisGitValueRevision"
>;

type ConfirmationDecision = Pick<
	Doc<"catalogWorkspaceDecisionRecords">,
	| "kind"
	| "messageId"
	| "localeId"
	| "sourceFingerprint"
	| "valueFingerprint"
	| "recordedAt"
	| "recordedBy"
>;

function valueIdentity(input: {
	messageId: string;
	localeId: Id<"locales">;
}): string {
	return JSON.stringify([input.messageId, input.localeId]);
}

function decisionIdentity(input: OrdinaryImportConfirmationCandidate): string {
	return JSON.stringify([
		input.messageId,
		input.localeId,
		input.sourceFingerprint,
		input.valueFingerprint,
	]);
}

function confirmationValueIdentity(input: {
	messageId: string;
	localeId: Id<"locales">;
	valueFingerprint: string;
}): string {
	return JSON.stringify([
		input.messageId,
		input.localeId,
		input.valueFingerprint,
	]);
}

function messageValueIdentity(input: {
	messageId: string;
	value: string;
}): string {
	return JSON.stringify([input.messageId, input.value]);
}

/**
 * Derive the exact conservative import set used by both the human preview and
 * the batch mutation. A value qualifies only while it is untouched Baseline
 * content, non-empty, different from Source, not duplicated across another
 * target Locale of the same key, and has no stale or current human decision.
 * Reuse by unrelated keys is ordinary catalog content, not review state. The
 * categories are mutually exclusive so the preview explains every target once.
 */
export function ordinaryImportConfirmationPlan(input: {
	rows: readonly ConfirmationRow[];
	heads: readonly ConfirmationHead[];
	decisions: readonly ConfirmationDecision[];
	pendingSourceMessageIds: ReadonlySet<string>;
}): {
	policy: typeof ORDINARY_IMPORT_CONFIRMATION_POLICY;
	counts: OrdinaryImportConfirmationCounts;
	candidates: OrdinaryImportConfirmationCandidate[];
} {
	const sourceByMessageId = new Map<string, ConfirmationRow>();
	const targetByIdentity = new Map<string, ConfirmationRow>();
	const messageValueCounts = new Map<string, number>();
	const targetLocaleIdsByMessage = new Map<string, Set<Id<"locales">>>();
	for (const row of input.rows) {
		if (row.isSource) {
			if (sourceByMessageId.has(row.messageId)) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Ordinary import confirmation found more than one Source value for a message.",
				});
			}
			sourceByMessageId.set(row.messageId, row);
			continue;
		}
		targetByIdentity.set(valueIdentity(row), row);
		const localeIds =
			targetLocaleIdsByMessage.get(row.messageId) ?? new Set<Id<"locales">>();
		localeIds.add(row.localeId);
		targetLocaleIdsByMessage.set(row.messageId, localeIds);
		const identity = messageValueIdentity(row);
		messageValueCounts.set(
			identity,
			(messageValueCounts.get(identity) ?? 0) + 1,
		);
	}

	const currentHeadIdentities = new Set(
		input.heads.flatMap((head) => {
			const row = targetByIdentity.get(valueIdentity(head));
			return row?.gitValueFingerprint === head.basisGitValueFingerprint &&
				(row.gitValueRevision ?? 0) === head.basisGitValueRevision
				? [valueIdentity(head)]
				: [];
		}),
	);
	const exactDecisionIdentities = new Set(
		input.decisions.map(decisionIdentity),
	);
	const priorConfirmationIdentities = new Set(
		input.decisions.flatMap((decision) =>
			decision.kind === "translatorConfirmation"
				? [confirmationValueIdentity(decision)]
				: [],
		),
	);
	const decisionsByMessage = new Map<string, ConfirmationDecision[]>();
	for (const decision of input.decisions) {
		const decisions = decisionsByMessage.get(decision.messageId) ?? [];
		decisions.push(decision);
		decisionsByMessage.set(decision.messageId, decisions);
	}
	const introducedMessageIds = new Set(
		[...sourceByMessageId.values()].flatMap((source) => {
			const pending = pendingIntroductionLocaleIds({
				source,
				activeTargetLocaleIds:
					targetLocaleIdsByMessage.get(source.messageId) ?? new Set(),
				decisions: decisionsByMessage.get(source.messageId) ?? [],
			});
			return pending.size > 0 ? [source.messageId] : [];
		}),
	);
	const counts: OrdinaryImportConfirmationCounts = {
		total: 0,
		eligible: 0,
		empty: 0,
		sourceIdentical: 0,
		repeated: 0,
		modified: 0,
		stale: 0,
		alreadyConfirmed: 0,
		pendingSourceProposal: 0,
		introduced: 0,
	};
	const candidates: OrdinaryImportConfirmationCandidate[] = [];

	for (const row of input.rows) {
		if (row.isSource) continue;
		counts.total++;
		const source = sourceByMessageId.get(row.messageId);
		if (!source || row.gitValueFingerprint === undefined) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Ordinary import confirmation requires complete Source and Git identity.",
			});
		}
		const candidate = {
			messageId: row.messageId,
			localeId: row.localeId,
			sourceFingerprint: source.sourceFingerprint,
			valueFingerprint: row.valueFingerprint,
		};
		if (exactDecisionIdentities.has(decisionIdentity(candidate))) {
			counts.alreadyConfirmed++;
			continue;
		}
		if (priorConfirmationIdentities.has(confirmationValueIdentity(candidate))) {
			counts.stale++;
			continue;
		}
		if (currentHeadIdentities.has(valueIdentity(row))) {
			counts.modified++;
			continue;
		}
		if (input.pendingSourceMessageIds.has(row.messageId)) {
			counts.pendingSourceProposal++;
			continue;
		}
		if (
			row.value.length > 0 &&
			row.sourceFingerprint !== source.sourceFingerprint
		) {
			counts.stale++;
			continue;
		}
		if (introducedMessageIds.has(row.messageId)) {
			counts.introduced++;
			continue;
		}
		if (row.value.length === 0) {
			counts.empty++;
			continue;
		}
		if (row.value === source.value) {
			counts.sourceIdentical++;
			continue;
		}
		if ((messageValueCounts.get(messageValueIdentity(row)) ?? 0) > 1) {
			counts.repeated++;
			continue;
		}
		counts.eligible++;
		candidates.push(candidate);
	}

	return {
		policy: ORDINARY_IMPORT_CONFIRMATION_POLICY,
		counts,
		candidates,
	};
}

export function ordinaryImportConfirmationCandidateIdentity(
	candidate: OrdinaryImportConfirmationCandidate,
): string {
	return decisionIdentity(candidate);
}
