import { ConvexError } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { readActiveCatalog } from "./catalogProjection";
import { messageFacts, storedFactNames } from "./messageFacts";
import {
	isCurrentSourceProposalHeadForSource,
	type PublishedSourceProposalResolution,
} from "./sourceProposals";

/** The pure Catalog Workspace view semantics shared by the complete read, the
 * Navigation Index projector, and the bounded Window read. Moving them here
 * keeps one definition of current values, value states, and decision identity
 * so the read paths cannot drift from each other or from the writers. */

export type CatalogWorkspaceDecisionRecord =
	Doc<"catalogWorkspaceDecisionRecords">;

export type CatalogWorkspaceValueState =
	| "waiting"
	| "unconfirmedImport"
	| "stale"
	| "settled";

export type CatalogWorkspaceSourceChangeKind = "semantic" | "cosmetic";

export function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function valueIdentity(input: {
	messageId: string;
	localeId: Id<"locales">;
}): string {
	return JSON.stringify([input.messageId, input.localeId]);
}

export function decisionIdentity(input: {
	messageId: string;
	localeId: Id<"locales">;
	sourceFingerprint: string;
	valueFingerprint: string;
}): string {
	return JSON.stringify([
		input.messageId,
		input.localeId,
		input.sourceFingerprint,
		input.valueFingerprint,
	]);
}

export function confirmationValueIdentity(input: {
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

export function decisionRecordMap(
	records: readonly CatalogWorkspaceDecisionRecord[],
): Map<string, CatalogWorkspaceDecisionRecord> {
	const result = new Map<string, CatalogWorkspaceDecisionRecord>();
	for (const record of records) {
		const identity = decisionIdentity(record);
		if (result.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace contains duplicate decision records.",
			});
		}
		result.set(identity, record);
	}
	return result;
}

export function translatorConfirmationMap(
	records: readonly CatalogWorkspaceDecisionRecord[],
): Map<string, CatalogWorkspaceDecisionRecord> {
	const result = new Map<string, CatalogWorkspaceDecisionRecord>();
	for (const record of records) {
		if (record.kind !== "translatorConfirmation") continue;
		const identity = confirmationValueIdentity(record);
		const latest = result.get(identity);
		if (
			latest === undefined ||
			record.recordedAt > latest.recordedAt ||
			(record.recordedAt === latest.recordedAt &&
				record._creationTime > latest._creationTime)
		) {
			result.set(identity, record);
		}
	}
	return result;
}

export function currentHeadForRow(
	row: Doc<"catalogProjectionMessages">,
	headByValue: ReadonlyMap<string, Doc<"catalogWorkspaceValueHeads">>,
): Doc<"catalogWorkspaceValueHeads"> | undefined {
	if (row.isSource || row.gitValueFingerprint === undefined) return undefined;
	const head = headByValue.get(valueIdentity(row));
	return head?.basisGitValueFingerprint === row.gitValueFingerprint &&
		head.basisGitValueRevision === (row.gitValueRevision ?? 0)
		? head
		: undefined;
}

export function isCurrentHeadForRow(
	row: Doc<"catalogProjectionMessages">,
	head: Doc<"catalogWorkspaceValueHeads"> | null | undefined,
): head is Doc<"catalogWorkspaceValueHeads"> {
	return (
		!row.isSource &&
		row.gitValueFingerprint !== undefined &&
		head !== null &&
		head !== undefined &&
		head.basisGitValueFingerprint === row.gitValueFingerprint &&
		head.basisGitValueRevision === (row.gitValueRevision ?? 0)
	);
}

export function currentWorkspaceRows(
	rows: readonly Doc<"catalogProjectionMessages">[],
	headByValue: ReadonlyMap<string, Doc<"catalogWorkspaceValueHeads">>,
): Doc<"catalogProjectionMessages">[] {
	return rows.map((row) => {
		const head = currentHeadForRow(row, headByValue);
		if (!head) return row;
		const message = messageFacts(head.value);
		const facts = storedFactNames(message.argumentNames);
		return {
			...row,
			value: head.value,
			// Older heads predate stored hashes. Their readers must fingerprint
			// the visible value rather than inherit the underlying Git hash.
			valueFingerprint: head.valueFingerprint,
			icuType: message.icuType,
			argumentNames: [...facts.names],
			argumentNamesComplete: facts.complete,
			argumentNameCount: facts.count,
			sourceFingerprint: head.sourceFingerprint,
			materialized: false,
		};
	});
}

/** A pending Source Proposal changes only the source value presented by the
 * Workspace. Its immutable Source Contract facts remain the active projection's
 * facts, and a published observation stops the overlay immediately. */
export function currentSourceProposalRows(
	rows: readonly Doc<"catalogProjectionMessages">[],
	headByMessageId: ReadonlyMap<
		string,
		Doc<"catalogWorkspaceSourceProposalHeads">
	>,
	resolutionsByProposal: ReadonlyMap<
		Id<"sourceProposals">,
		{ status: "landed" | "superseded" }
	>,
): Doc<"catalogProjectionMessages">[] {
	return rows.map((row) => {
		if (!row.isSource) return row;
		const head = headByMessageId.get(row.messageId);
		if (
			!isCurrentSourceProposalHeadForSource(row, head) ||
			resolutionsByProposal.has(head.proposalId)
		) {
			return row;
		}
		return {
			...row,
			value: head.sourceValue,
			valueFingerprint: head.sourceFingerprint,
			sourceFingerprint: head.sourceFingerprint,
		};
	});
}

/** Pending English copy does not invalidate a target confirmed against Git,
 * but a target authored for an older proposal must answer the latest wording. */
export function decisionSourceFingerprintFor(input: {
	gitSourceFingerprint: string;
	currentSourceFingerprint: string;
	valueSourceFingerprint: string;
	pendingSourceProposalFingerprint?: string;
}): string {
	if (input.pendingSourceProposalFingerprint === undefined) {
		return input.currentSourceFingerprint;
	}
	return input.valueSourceFingerprint === input.gitSourceFingerprint ||
		input.valueSourceFingerprint === input.pendingSourceProposalFingerprint
		? input.valueSourceFingerprint
		: input.pendingSourceProposalFingerprint;
}

export function currentDecisionForValue(input: {
	row: Doc<"catalogProjectionMessages">;
	sourceFingerprint: string;
	value: string;
	valueFingerprint: string;
	decisionsByIdentity: ReadonlyMap<string, CatalogWorkspaceDecisionRecord>;
}): CatalogWorkspaceDecisionRecord | undefined {
	const {
		row,
		sourceFingerprint,
		value,
		valueFingerprint,
		decisionsByIdentity,
	} = input;
	if (row.isSource || row.gitValueFingerprint === undefined) {
		return undefined;
	}
	const decision = decisionsByIdentity.get(
		decisionIdentity({
			messageId: row.messageId,
			localeId: row.localeId,
			sourceFingerprint,
			valueFingerprint,
		}),
	);
	if (!decision) return undefined;
	if (decision.kind === "intentionalBlank" && value.length !== 0) {
		return undefined;
	}
	return decision;
}

export function sourceChangeKindFor(input: {
	previousValue: string;
	currentValue: string;
}): CatalogWorkspaceSourceChangeKind {
	// ICU punctuation is contract syntax, not editorial punctuation. Treating a
	// shape change as cosmetic could let a target fly past a release blocker, so
	// only plain messages qualify for the quiet classification.
	if (
		messageFacts(input.previousValue).icuType !== "plain" ||
		messageFacts(input.currentValue).icuType !== "plain"
	) {
		return "semantic";
	}
	const withoutWhitespaceAndPunctuation = (value: string) =>
		value.replace(/[\s\p{P}]/gu, "");
	return withoutWhitespaceAndPunctuation(input.previousValue) ===
		withoutWhitespaceAndPunctuation(input.currentValue)
		? "cosmetic"
		: "semantic";
}

export function sourceChangeKindForConfirmation(input: {
	messageId: string;
	confirmedSourceFingerprint: string;
	currentSourceFingerprint: string;
	sourceChangesByIdentity: ReadonlyMap<
		string,
		Doc<"catalogProjectionGitChanges">
	>;
}): CatalogWorkspaceSourceChangeKind {
	const sourceChange = input.sourceChangesByIdentity.get(
		JSON.stringify([
			input.messageId,
			input.confirmedSourceFingerprint,
			input.currentSourceFingerprint,
		]),
	);
	return sourceChange
		? sourceChangeKindFor({
				previousValue: sourceChange.previousValue,
				currentValue: sourceChange.value,
			})
		: "semantic";
}

export function sourceChangeMap(
	gitChanges: readonly Doc<"catalogProjectionGitChanges">[],
): Map<string, Doc<"catalogProjectionGitChanges">> {
	const result = new Map<string, Doc<"catalogProjectionGitChanges">>();
	for (const change of gitChanges) {
		if (!change.isSource) continue;
		const identity = JSON.stringify([
			change.messageId,
			change.previousSourceFingerprint,
			change.sourceFingerprint,
		]);
		if (result.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Catalog Workspace found duplicate Git source-change evidence.",
			});
		}
		result.set(identity, change);
	}
	return result;
}

/** The canonical evidence the key-card composer reads per key. The
 * complete read builds it project-wide; the Window read builds it from
 * bounded point reads for the requested keys only. */

export type CatalogWorkspaceCardEvidence = {
	rowsByValue: Map<string, Doc<"catalogProjectionMessages">>;
	sourceByMessageId: Map<string, Doc<"catalogProjectionMessages">>;
	headsByValue: Map<string, Doc<"catalogWorkspaceValueHeads">>;
	decisionsByIdentity: Map<string, Doc<"catalogWorkspaceDecisionRecords">>;
	translatorConfirmationsByValue: Map<
		string,
		Doc<"catalogWorkspaceDecisionRecords">
	>;
	sourceChangesByIdentity: Map<string, Doc<"catalogProjectionGitChanges">>;
	sourceProposalHeadsByMessageId: Map<
		string,
		Doc<"catalogWorkspaceSourceProposalHeads">
	>;
	sourceProposalResolutions: Map<
		Id<"sourceProposals">,
		PublishedSourceProposalResolution
	>;
	visibleValueFingerprintsByValue: Map<string, string>;
};

/** Compose the exact Catalog Workspace key cards from the active catalog's
 * key structure plus canonical evidence. This is the one shared composer
 * behind the complete read and the Window read, so a requested window always
 * equals the same keys' cards in the complete read. */

export function composeWorkspaceKeyCards(
	evidence: CatalogWorkspaceCardEvidence,
	catalog: ReturnType<typeof readActiveCatalog>,
) {
	return catalog.keys.map((key) => ({
		...key,
		values: key.values.map((value) => {
			if (value.isSource) {
				const row = evidence.rowsByValue.get(
					valueIdentity({ messageId: key.id, localeId: value.localeId }),
				);
				if (!row?.isSource) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"Catalog Workspace lost an active source value while composing the catalog.",
					});
				}
				const sourceProposalHead = evidence.sourceProposalHeadsByMessageId.get(
					key.id,
				);
				const sourceProposalResolution = sourceProposalHead
					? evidence.sourceProposalResolutions.get(
							sourceProposalHead.proposalId,
						)
					: undefined;
				const currentSourceProposal =
					isCurrentSourceProposalHeadForSource(row, sourceProposalHead) &&
					!sourceProposalResolution;
				return {
					...value,
					gitValueFingerprint: row.gitValueFingerprint ?? row.sourceFingerprint,
					gitValueRevision: row.gitValueRevision ?? 0,
					workspaceRevision: currentSourceProposal
						? sourceProposalHead.revision
						: 0,
					expectedSourceFingerprint: value.sourceFingerprint,
					...(sourceProposalHead === undefined
						? {}
						: {
								sourceProposalStatus: (sourceProposalResolution?.status ??
									"pending") as "pending" | "landed" | "superseded",
							}),
				};
			}
			if (value.gitValueFingerprint === undefined) {
				return {
					...value,
					gitValueRevision: 0,
					workspaceRevision: 0,
					expectedSourceFingerprint: value.sourceFingerprint,
				};
			}
			const row = evidence.rowsByValue.get(
				valueIdentity({ messageId: key.id, localeId: value.localeId }),
			);
			if (!row) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Catalog Workspace lost an active Locale value while composing the catalog.",
				});
			}
			const head = currentHeadForRow(row, evidence.headsByValue);
			const source = evidence.sourceByMessageId.get(key.id);
			if (!source) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Catalog Workspace lost the source value for an active message.",
				});
			}
			const sourceRow = evidence.rowsByValue.get(
				valueIdentity({ messageId: key.id, localeId: source.localeId }),
			);
			if (!sourceRow?.isSource) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Catalog Workspace lost the Git source value for an active message.",
				});
			}
			const sourceProposalHead = evidence.sourceProposalHeadsByMessageId.get(
				key.id,
			);
			const sourceProposalResolution = sourceProposalHead
				? evidence.sourceProposalResolutions.get(sourceProposalHead.proposalId)
				: undefined;
			const pendingSourceProposalFingerprint =
				isCurrentSourceProposalHeadForSource(sourceRow, sourceProposalHead) &&
				!sourceProposalResolution
					? sourceProposalHead.sourceFingerprint
					: undefined;
			const valueFingerprint = evidence.visibleValueFingerprintsByValue.get(
				valueIdentity(row),
			);
			if (!valueFingerprint) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Catalog Workspace could not fingerprint an active Locale value.",
				});
			}
			const decisionSourceFingerprint = decisionSourceFingerprintFor({
				gitSourceFingerprint: sourceRow.sourceFingerprint,
				currentSourceFingerprint: source.sourceFingerprint,
				valueSourceFingerprint: value.sourceFingerprint,
				pendingSourceProposalFingerprint,
			});
			const decision = currentDecisionForValue({
				row,
				sourceFingerprint: decisionSourceFingerprint,
				value: value.value,
				valueFingerprint,
				decisionsByIdentity: evidence.decisionsByIdentity,
			});
			const previousConfirmation = evidence.translatorConfirmationsByValue.get(
				confirmationValueIdentity({
					messageId: row.messageId,
					localeId: row.localeId,
					valueFingerprint,
				}),
			);
			const sourceChangeKind =
				pendingSourceProposalFingerprint === undefined &&
				previousConfirmation !== undefined &&
				previousConfirmation.sourceFingerprint !== decisionSourceFingerprint
					? sourceChangeKindForConfirmation({
							messageId: row.messageId,
							confirmedSourceFingerprint:
								previousConfirmation.sourceFingerprint,
							currentSourceFingerprint: decisionSourceFingerprint,
							sourceChangesByIdentity: evidence.sourceChangesByIdentity,
						})
					: undefined;
			const valueState = valueStateFor({
				value: value.value,
				decision,
				// A pending Source Proposal is a translator-authored candidate,
				// not a Git source transition. Its revisions remain ordinary
				// Unconfirmed Imports until the candidate lands.
				previousConfirmation:
					pendingSourceProposalFingerprint === undefined
						? previousConfirmation
						: undefined,
				currentSourceFingerprint: decisionSourceFingerprint,
				sourceChangeKind,
			});
			return {
				...value,
				gitValueFingerprint: value.gitValueFingerprint,
				gitValueRevision: row.gitValueRevision ?? 0,
				workspaceRevision: head?.revision ?? 0,
				// This captures the English wording visible when the target
				// editor opened. The mutation rejects a save if another
				// Source Proposal changes it before the target is committed.
				expectedSourceFingerprint: source.sourceFingerprint,
				...valueState,
			};
		}),
	}));
}

export function valueStateFor(input: {
	value: string;
	decision: CatalogWorkspaceDecisionRecord | undefined;
	previousConfirmation?: CatalogWorkspaceDecisionRecord;
	currentSourceFingerprint?: string;
	sourceChangeKind?: CatalogWorkspaceSourceChangeKind;
}): {
	valueState: CatalogWorkspaceValueState;
	intentionalBlankReason?: string;
	sourceChangeKind?: CatalogWorkspaceSourceChangeKind;
} {
	if (input.decision?.kind === "intentionalBlank") {
		return {
			valueState: "settled",
			intentionalBlankReason: input.decision.reason,
		};
	}
	if (input.value.length === 0) return { valueState: "waiting" };
	if (
		input.decision?.kind !== "translatorConfirmation" &&
		input.previousConfirmation !== undefined &&
		input.currentSourceFingerprint !== undefined &&
		input.previousConfirmation.sourceFingerprint !==
			input.currentSourceFingerprint
	) {
		return {
			valueState: "stale",
			sourceChangeKind: input.sourceChangeKind ?? "semantic",
		};
	}
	return {
		valueState:
			input.decision?.kind === "translatorConfirmation"
				? "settled"
				: "unconfirmedImport",
	};
}
