import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "./_generated/server";
import type { ArchiveReconciliation } from "./archiveReconciliation";
import type {
	AutomaticRestoration,
	GitAuthoredChange,
	ProjectedMessage,
} from "./catalogProjection";
import {
	MAX_PROJECTED_LOCALES,
	MAX_WORKING_CATALOG_KEYS,
	MAX_WORKING_CATALOG_ROWS,
} from "./catalogProjection";
import type {
	ContractConsequence,
	ContractTransformCode,
	TranslationResidueCode,
} from "./contractTransforms";
import { now } from "./lib";
import type { RepositoryAdapterActor } from "./permissions";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
	requireEditor,
	requireViewer,
} from "./permissions";
import type { TranslationResidue } from "./translationResidue";

function humanActor(actor: { kind: string; id: string }) {
	if (actor.kind === "repositoryAdapter") {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A report fact cannot be dispositioned by a Repository Adapter.",
		});
	}
	return actor as { kind: "user" | "agent" | "system"; id: string };
}

/**
 * The Reconciliation Report is a transition record, not a second working
 * catalog. It stores only consequence identity and provenance; catalog values
 * remain in the projection and immutable Source Snapshot evidence.
 */

export const RECONCILIATION_REPORT_GROUPS = [
	"locale_setup",
	"broken_by_source_change",
	"changed_in_git",
	"archived_by_sync",
	"to_review",
	"to_translate",
] as const;

export type ReconciliationReportGroup =
	(typeof RECONCILIATION_REPORT_GROUPS)[number];

type ReconciliationReportSubject = "key" | "locale" | "file";

export type ReconciliationReportFactKind =
	| "unbound_locale_file"
	| "source_change_broke_target"
	| "git_value_changed"
	| "key_archived"
	| "locale_archived"
	| "automatic_restore"
	| "source_translation_stale"
	| "automatic_contract_transform"
	| "new_target_value"
	| "translation_residue";

export type UnboundLocaleFile = {
	catalogPath: string;
	declaredLocaleCode?: string;
	messageCount?: number;
};

export type ReconciliationReportFact = {
	localeId?: Id<"locales">;
	localeCode?: string;
	catalogPath?: string;
	kind: ReconciliationReportFactKind;
	reasonCodes?: TranslationResidueCode[];
	transformCode?: ContractTransformCode;
	relatedSnapshotId?: Id<"sourceSnapshots">;
	declaredLocaleCode?: string;
	messageCount?: number;
};

export type ReconciliationReportRow = {
	group: ReconciliationReportGroup;
	groupOrder: number;
	subject: ReconciliationReportSubject;
	subjectKey: string;
	catalogIndex: number;
	messageId?: string;
	catalogPath?: string;
	facts: ReconciliationReportFact[];
};

export type ReconciliationReportDraft = {
	rows: ReconciliationReportRow[];
	handoffKeys: { catalogIndex: number; messageId: string }[];
};

const GROUP_ORDER: Record<ReconciliationReportGroup, number> = {
	locale_setup: 0,
	broken_by_source_change: 1,
	changed_in_git: 2,
	archived_by_sync: 3,
	to_review: 4,
	to_translate: 5,
};

const MAX_RECONCILIATION_REPORT_ROWS =
	MAX_WORKING_CATALOG_KEYS * 2 + MAX_PROJECTED_LOCALES;
const MAX_RECONCILIATION_REPORT_FACTS =
	MAX_WORKING_CATALOG_ROWS * 2 + MAX_PROJECTED_LOCALES;
// Total stored facts are paged on every read; this is not a response budget.
const MAX_RECONCILIATION_REPORT_BYTES = MAX_RECONCILIATION_REPORT_FACTS * 1024;
const MAX_RECONCILIATION_REPORT_FACTS_PER_ROW = MAX_PROJECTED_LOCALES * 5;
const MAX_RECONCILIATION_REPORT_STAGE_ROWS = 64;
const MAX_RECONCILIATION_REPORT_STAGE_BYTES = 512_000;
const MAX_RECONCILIATION_REPORT_PAGE_ROWS = 16;
const MAX_WORK_HANDOFF_BYTES = 8 * 1024 * 1024;

const reportGroupValidator = v.union(
	v.literal("locale_setup"),
	v.literal("broken_by_source_change"),
	v.literal("changed_in_git"),
	v.literal("archived_by_sync"),
	v.literal("to_review"),
	v.literal("to_translate"),
);
const reportSubjectValidator = v.union(
	v.literal("key"),
	v.literal("locale"),
	v.literal("file"),
);
const reportFactKindValidator = v.union(
	v.literal("unbound_locale_file"),
	v.literal("source_change_broke_target"),
	v.literal("git_value_changed"),
	v.literal("key_archived"),
	v.literal("locale_archived"),
	v.literal("automatic_restore"),
	v.literal("source_translation_stale"),
	v.literal("automatic_contract_transform"),
	v.literal("new_target_value"),
	v.literal("translation_residue"),
);
const residueCodeValidator = v.union(
	v.literal("removed_placeholder"),
	v.literal("target_argument_not_in_source"),
	v.literal("placeholder_rename_conflict"),
	v.literal("plural_to_plain_requires_translation"),
);
const transformCodeValidator = v.union(
	v.literal("renamed_placeholder"),
	v.literal("retyped_placeholder"),
	v.literal("wrapped_plural"),
	v.literal("unwrapped_plural"),
);
const reportFactValidator = v.object({
	localeId: v.optional(v.id("locales")),
	localeCode: v.optional(v.string()),
	catalogPath: v.optional(v.string()),
	kind: reportFactKindValidator,
	reasonCodes: v.optional(v.array(residueCodeValidator)),
	transformCode: v.optional(transformCodeValidator),
	relatedSnapshotId: v.optional(v.id("sourceSnapshots")),
	declaredLocaleCode: v.optional(v.string()),
	messageCount: v.optional(v.number()),
});
const reportRowValidator = v.object({
	group: reportGroupValidator,
	groupOrder: v.number(),
	subject: reportSubjectValidator,
	subjectKey: v.string(),
	catalogIndex: v.number(),
	messageId: v.optional(v.string()),
	catalogPath: v.optional(v.string()),
	facts: v.array(reportFactValidator),
});

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function rowByteLength(row: ReconciliationReportRow): number {
	return encodedSize(row);
}

function handoffKeyByteLength(key: {
	catalogIndex: number;
	messageId: string;
}): number {
	return encodedSize(key);
}

function reportFactIdentity(fact: ReconciliationReportFact): string {
	return JSON.stringify([
		fact.localeId,
		fact.localeCode,
		fact.catalogPath,
		fact.kind,
		fact.reasonCodes,
		fact.transformCode,
		fact.relatedSnapshotId,
		fact.declaredLocaleCode,
		fact.messageCount,
	]);
}

function reportRowIdentity(
	row: Pick<ReconciliationReportRow, "group" | "subject" | "subjectKey">,
): string {
	return JSON.stringify([row.group, row.subject, row.subjectKey]);
}

function sourceByMessageId(
	messages: readonly ProjectedMessage[],
): Map<string, ProjectedMessage> {
	const source = new Map<string, ProjectedMessage>();
	for (const message of messages) {
		if (!message.isSource) continue;
		if (source.has(message.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A catalog projection has duplicate source message identities.",
			});
		}
		source.set(message.messageId, message);
	}
	return source;
}

function valueIdentity(value: {
	localeId: Id<"locales">;
	messageId: string;
}): string {
	return JSON.stringify([value.localeId, value.messageId]);
}

function isTransformCode(
	code: ContractConsequence["code"],
): code is ContractTransformCode {
	return (
		code === "renamed_placeholder" ||
		code === "retyped_placeholder" ||
		code === "wrapped_plural" ||
		code === "unwrapped_plural"
	);
}

function rowForKey(
	rows: Map<string, ReconciliationReportRow>,
	group: ReconciliationReportGroup,
	catalogIndex: number,
	messageId: string,
): ReconciliationReportRow {
	const candidate: ReconciliationReportRow = {
		group,
		groupOrder: GROUP_ORDER[group],
		subject: "key",
		subjectKey: messageId,
		catalogIndex,
		messageId,
		facts: [],
	};
	const identity = `key:${messageId}`;
	const existing = rows.get(identity);
	if (existing) {
		if (
			existing.subject !== "key" ||
			existing.catalogIndex !== catalogIndex ||
			existing.messageId !== messageId
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report key row has conflicting provenance.",
			});
		}
		if (candidate.groupOrder < existing.groupOrder) {
			existing.group = candidate.group;
			existing.groupOrder = candidate.groupOrder;
		}
		return existing;
	}
	rows.set(identity, candidate);
	return candidate;
}

function rowForLocale(
	rows: Map<string, ReconciliationReportRow>,
	localeId: Id<"locales">,
	catalogPath: string,
): ReconciliationReportRow {
	const group: ReconciliationReportGroup = "archived_by_sync";
	const candidate: ReconciliationReportRow = {
		group,
		groupOrder: GROUP_ORDER[group],
		subject: "locale",
		subjectKey: String(localeId),
		catalogIndex: -1,
		catalogPath,
		facts: [],
	};
	const identity = `locale:${String(localeId)}`;
	const existing = rows.get(identity);
	if (existing) {
		if (existing.subject !== "locale" || existing.catalogPath !== catalogPath) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A Reconciliation Report Locale row has conflicting provenance.",
			});
		}
		return existing;
	}
	rows.set(identity, candidate);
	return candidate;
}

function rowForFile(
	rows: Map<string, ReconciliationReportRow>,
	catalogPath: string,
): ReconciliationReportRow {
	const group: ReconciliationReportGroup = "locale_setup";
	const candidate: ReconciliationReportRow = {
		group,
		groupOrder: GROUP_ORDER[group],
		subject: "file",
		subjectKey: catalogPath,
		catalogIndex: -1,
		catalogPath,
		facts: [],
	};
	const identity = `file:${catalogPath}`;
	const existing = rows.get(identity);
	if (existing) {
		if (existing.subject !== "file" || existing.catalogPath !== catalogPath) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report file row has conflicting provenance.",
			});
		}
		return existing;
	}
	rows.set(identity, candidate);
	return candidate;
}

function addFact(
	row: ReconciliationReportRow,
	fact: ReconciliationReportFact,
): void {
	if (
		!row.facts.some(
			(existing) => reportFactIdentity(existing) === reportFactIdentity(fact),
		)
	) {
		row.facts.push(fact);
	}
}

function targetFact(
	message: Pick<ProjectedMessage, "localeId" | "localeCode" | "catalogPath">,
	kind: ReconciliationReportFactKind,
	extra: Omit<
		ReconciliationReportFact,
		"localeId" | "localeCode" | "catalogPath" | "kind"
	> = {},
): ReconciliationReportFact {
	return {
		localeId: message.localeId,
		localeCode: message.localeCode,
		catalogPath: message.catalogPath,
		kind,
		...extra,
	};
}

function sourceChangeResidue(code: TranslationResidueCode): boolean {
	return (
		code === "removed_placeholder" ||
		code === "plural_to_plain_requires_translation"
	);
}

/**
 * Derive only this accepted transition's report rows. A separate Work Hand-off
 * points at all currently visible attention without copying older report facts
 * into the next snapshot's durable record.
 */
export function reconciliationReportDraft(input: {
	hadPreviousBaseline?: boolean;
	previousMessages: readonly ProjectedMessage[];
	currentMessages: readonly ProjectedMessage[];
	gitChanges: readonly GitAuthoredChange[];
	archives: ArchiveReconciliation;
	restorations: readonly AutomaticRestoration[];
	residues: readonly TranslationResidue[];
	contractConsequences: readonly ContractConsequence[];
	unboundLocaleFiles?: readonly UnboundLocaleFile[];
	previousUnboundLocaleFiles?: readonly Pick<
		UnboundLocaleFile,
		"catalogPath"
	>[];
}): ReconciliationReportDraft | null {
	const rows = new Map<string, ReconciliationReportRow>();
	const previousSource = sourceByMessageId(input.previousMessages);
	const currentSource = sourceByMessageId(input.currentMessages);
	const residueValues = new Set<string>();

	const previousUnboundCatalogPaths = new Set(
		(input.previousUnboundLocaleFiles ?? []).map((file) => file.catalogPath),
	);
	for (const file of input.unboundLocaleFiles ?? []) {
		if (previousUnboundCatalogPaths.has(file.catalogPath)) continue;
		const row = rowForFile(rows, file.catalogPath);
		addFact(row, {
			catalogPath: file.catalogPath,
			kind: "unbound_locale_file",
			...(file.declaredLocaleCode === undefined
				? {}
				: { declaredLocaleCode: file.declaredLocaleCode }),
			...(file.messageCount === undefined
				? {}
				: { messageCount: file.messageCount }),
		});
	}

	for (const residue of input.residues) {
		residueValues.add(valueIdentity(residue));
		for (const reason of residue.reasons) {
			const group: ReconciliationReportGroup = sourceChangeResidue(reason.code)
				? "broken_by_source_change"
				: "to_translate";
			const row = rowForKey(
				rows,
				group,
				residue.catalogIndex,
				residue.messageId,
			);
			addFact(
				row,
				targetFact(
					residue,
					sourceChangeResidue(reason.code)
						? "source_change_broke_target"
						: "translation_residue",
					{ reasonCodes: [reason.code] },
				),
			);
		}
	}

	for (const change of input.gitChanges) {
		if (change.isSource) continue;
		const row = rowForKey(
			rows,
			"changed_in_git",
			change.catalogIndex,
			change.messageId,
		);
		addFact(row, targetFact(change, "git_value_changed"));
	}

	for (const key of input.archives.keys) {
		const row = rowForKey(
			rows,
			"archived_by_sync",
			key.catalogIndex,
			key.messageId,
		);
		for (const value of input.archives.values) {
			if (!value.keyArchived || value.messageId !== key.messageId) continue;
			addFact(
				row,
				targetFact(value, "key_archived", {
					relatedSnapshotId: value.evidenceSnapshotId,
				}),
			);
		}
	}

	for (const locale of input.archives.locales) {
		const row = rowForLocale(rows, locale.localeId, locale.catalogPath);
		addFact(row, {
			localeId: locale.localeId,
			localeCode: locale.localeCode,
			catalogPath: locale.catalogPath,
			kind: "locale_archived",
		});
	}

	for (const restoration of input.restorations) {
		const row = rowForKey(
			rows,
			"archived_by_sync",
			restoration.catalogIndex,
			restoration.messageId,
		);
		addFact(
			row,
			targetFact(restoration, "automatic_restore", {
				relatedSnapshotId: restoration.restoredFromSnapshotId,
			}),
		);
	}

	for (const consequence of input.contractConsequences) {
		if (consequence.kind !== "transform" || !isTransformCode(consequence.code))
			continue;
		const row = rowForKey(
			rows,
			"to_review",
			consequence.catalogIndex,
			consequence.messageId,
		);
		addFact(row, {
			localeId: consequence.localeId,
			localeCode: consequence.localeCode,
			catalogPath: consequence.catalogPath,
			kind: "automatic_contract_transform",
			transformCode: consequence.code,
		});
	}

	if (input.hadPreviousBaseline ?? previousSource.size > 0) {
		for (const message of input.currentMessages) {
			if (message.isSource) continue;
			const source = currentSource.get(message.messageId);
			if (!source || !previousSource.has(message.messageId)) {
				// Every target on a post-bootstrap key is new review work. A value
				// already present in Git may be a placeholder just as easily as a
				// materialized empty slot, so the report must not equate population
				// with prior review.
				if (source) {
					const row = rowForKey(
						rows,
						"to_translate",
						message.catalogIndex,
						message.messageId,
					);
					addFact(row, targetFact(message, "new_target_value"));
				}
				continue;
			}
			const previousSourceMessage = previousSource.get(message.messageId);
			if (
				previousSourceMessage?.sourceFingerprint !== source.sourceFingerprint &&
				message.sourceFingerprint !== source.sourceFingerprint &&
				!residueValues.has(valueIdentity(message))
			) {
				const row = rowForKey(
					rows,
					"to_review",
					message.catalogIndex,
					message.messageId,
				);
				addFact(row, targetFact(message, "source_translation_stale"));
			}
		}
	}

	const orderedRows = [...rows.values()]
		.filter((row) => row.facts.length > 0)
		.map((row) => ({
			...row,
			facts: [...row.facts].sort(
				(left, right) =>
					(left.localeCode ?? "").localeCompare(right.localeCode ?? "") ||
					left.kind.localeCompare(right.kind),
			),
		}))
		.sort(
			(left, right) =>
				left.groupOrder - right.groupOrder ||
				left.catalogIndex - right.catalogIndex ||
				(left.messageId ?? left.catalogPath ?? "").localeCompare(
					right.messageId ?? right.catalogPath ?? "",
				),
		);
	if (orderedRows.length === 0) return null;

	const handoff = new Map<
		string,
		{ catalogIndex: number; messageId: string }
	>();
	for (const row of orderedRows) {
		if (
			row.messageId !== undefined &&
			row.facts.some(
				(fact) =>
					fact.kind !== "key_archived" &&
					fact.kind !== "locale_archived" &&
					fact.kind !== "automatic_restore" &&
					fact.kind !== "unbound_locale_file",
			)
		) {
			handoff.set(row.messageId, {
				catalogIndex: row.catalogIndex,
				messageId: row.messageId,
			});
		}
	}
	for (const message of input.currentMessages) {
		if (message.isSource) continue;
		const source = currentSource.get(message.messageId);
		if (
			source &&
			(message.value.length === 0 ||
				message.sourceFingerprint !== source.sourceFingerprint)
		) {
			handoff.set(message.messageId, {
				catalogIndex: source.catalogIndex,
				messageId: message.messageId,
			});
		}
	}
	const handoffKeys = [...handoff.values()].sort(
		(left, right) =>
			left.catalogIndex - right.catalogIndex ||
			left.messageId.localeCompare(right.messageId),
	);

	assertDraft({ rows: orderedRows, handoffKeys });
	return { rows: orderedRows, handoffKeys };
}

function assertFact(fact: ReconciliationReportFact): void {
	if (
		(fact.localeId === undefined) !== (fact.localeCode === undefined) ||
		(fact.localeCode !== undefined && fact.localeCode.length === 0) ||
		(fact.catalogPath !== undefined && fact.catalogPath.length === 0) ||
		(fact.reasonCodes !== undefined &&
			(fact.reasonCodes.length === 0 ||
				fact.reasonCodes.length > 4 ||
				new Set(fact.reasonCodes).size !== fact.reasonCodes.length)) ||
		(fact.reasonCodes !== undefined &&
			fact.kind !== "source_change_broke_target" &&
			fact.kind !== "translation_residue") ||
		(fact.transformCode !== undefined &&
			fact.kind !== "automatic_contract_transform") ||
		(fact.messageCount !== undefined &&
			(!Number.isInteger(fact.messageCount) || fact.messageCount < 0)) ||
		(fact.kind === "unbound_locale_file" && fact.catalogPath === undefined)
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Reconciliation Report fact is invalid.",
		});
	}
}

function assertRow(row: ReconciliationReportRow): void {
	if (
		GROUP_ORDER[row.group] !== row.groupOrder ||
		row.subjectKey.length === 0 ||
		!Number.isInteger(row.catalogIndex) ||
		row.facts.length === 0 ||
		row.facts.length > MAX_RECONCILIATION_REPORT_FACTS_PER_ROW ||
		(row.subject === "key" &&
			(row.messageId === undefined ||
				row.messageId.length === 0 ||
				row.catalogIndex < 0)) ||
		(row.subject !== "key" && row.catalogIndex !== -1) ||
		(row.subject === "file" &&
			(row.catalogPath === undefined || row.catalogPath.length === 0)) ||
		rowByteLength(row) > MAX_RECONCILIATION_REPORT_STAGE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Reconciliation Report row exceeds the supported envelope.",
		});
	}
	for (const fact of row.facts) assertFact(fact);
}

function assertDraft(draft: ReconciliationReportDraft): void {
	const rowIds = new Set<string>();
	let factCount = 0;
	let byteLength = 0;
	for (const row of draft.rows) {
		assertRow(row);
		const identity = reportRowIdentity(row);
		if (rowIds.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report has duplicate consequence rows.",
			});
		}
		rowIds.add(identity);
		factCount += row.facts.length;
		byteLength += rowByteLength(row);
	}
	if (
		draft.rows.length === 0 ||
		draft.rows.length > MAX_RECONCILIATION_REPORT_ROWS ||
		factCount > MAX_RECONCILIATION_REPORT_FACTS ||
		byteLength > MAX_RECONCILIATION_REPORT_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Reconciliation Report exceeds the supported envelope.",
		});
	}
	const handoffIds = new Set<string>();
	let handoffBytes = 0;
	for (const key of draft.handoffKeys) {
		if (
			!Number.isInteger(key.catalogIndex) ||
			key.catalogIndex < 0 ||
			key.messageId.length === 0 ||
			handoffKeyByteLength(key) > MAX_RECONCILIATION_REPORT_STAGE_BYTES ||
			handoffIds.has(key.messageId)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A Reconciliation Report Work Hand-off is invalid.",
			});
		}
		handoffIds.add(key.messageId);
		handoffBytes += handoffKeyByteLength(key);
	}
	if (
		draft.handoffKeys.length > MAX_WORKING_CATALOG_KEYS ||
		handoffBytes > MAX_WORK_HANDOFF_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Reconciliation Report Work Hand-off exceeds its envelope.",
		});
	}
}

function draftEnvelope(draft: ReconciliationReportDraft): {
	rowCount: number;
	factCount: number;
	byteLength: number;
	handoffKeyCount: number;
	handoffByteLength: number;
} {
	assertDraft(draft);
	return {
		rowCount: draft.rows.length,
		factCount: draft.rows.reduce((total, row) => total + row.facts.length, 0),
		byteLength: draft.rows.reduce(
			(total, row) => total + rowByteLength(row),
			0,
		),
		handoffKeyCount: draft.handoffKeys.length,
		handoffByteLength: draft.handoffKeys.reduce(
			(total, key) => total + handoffKeyByteLength(key),
			0,
		),
	};
}

export function reconciliationReportEnvelope(
	draft: ReconciliationReportDraft | null,
): {
	rowCount: number;
	factCount: number;
	byteLength: number;
	handoffKeyCount: number;
	handoffByteLength: number;
} {
	return draft
		? draftEnvelope(draft)
		: {
				rowCount: 0,
				factCount: 0,
				byteLength: 0,
				handoffKeyCount: 0,
				handoffByteLength: 0,
			};
}

function stagingBatches<T>(
	items: readonly T[],
	byteLength: (item: T) => number,
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let bytes = 2;
	for (const item of items) {
		const itemBytes = byteLength(item);
		const separatorBytes = batch.length === 0 ? 0 : 1;
		if (
			batch.length > 0 &&
			(batch.length === MAX_RECONCILIATION_REPORT_STAGE_ROWS ||
				bytes + separatorBytes + itemBytes >
					MAX_RECONCILIATION_REPORT_STAGE_BYTES)
		) {
			batches.push(batch);
			batch = [];
			bytes = 2;
		}
		batch.push(item);
		bytes += separatorBytes + itemBytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/** Append a disjoint set of message/file rows to an already declared report. */
export async function stageReconciliationReportChunk(
	ctx: ActionCtx,
	args: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		draft: ReconciliationReportDraft | null;
		actor?: RepositoryAdapterActor;
	},
): Promise<void> {
	if (!args.draft) return;
	for (const rows of stagingBatches(args.draft.rows, rowByteLength)) {
		await ctx.runMutation(internal.reconciliationReports.stageRows, {
			projectId: args.projectId,
			projectionId: args.projectionId,
			rows,
			actor: args.actor,
		});
	}
	for (const keys of stagingBatches(
		args.draft.handoffKeys,
		handoffKeyByteLength,
	)) {
		await ctx.runMutation(internal.reconciliationReports.stageHandoffKeys, {
			projectId: args.projectId,
			projectionId: args.projectionId,
			keys,
			actor: args.actor,
		});
	}
}

/** Stage one report beside a private catalog projection. Callers provide the
 * already-derived transition draft; this module owns its envelope, batching,
 * and completion protocol so that protocol never leaks into snapshot ingest. */
export async function stageReconciliationReport(
	ctx: ActionCtx,
	args: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		draft: ReconciliationReportDraft | null;
		actor?: RepositoryAdapterActor;
	},
): Promise<void> {
	const totals = reconciliationReportEnvelope(args.draft);
	await ctx.runMutation(internal.reconciliationReports.declare, {
		projectId: args.projectId,
		projectionId: args.projectionId,
		expectedRowCount: totals.rowCount,
		expectedFactCount: totals.factCount,
		expectedByteLength: totals.byteLength,
		expectedHandoffKeyCount: totals.handoffKeyCount,
		expectedHandoffByteLength: totals.handoffByteLength,
		actor: args.actor,
	});
	if (!args.draft) return;
	for (const rows of stagingBatches(args.draft.rows, rowByteLength)) {
		await ctx.runMutation(internal.reconciliationReports.stageRows, {
			projectId: args.projectId,
			projectionId: args.projectionId,
			rows,
			actor: args.actor,
		});
	}
	for (const keys of stagingBatches(
		args.draft.handoffKeys,
		handoffKeyByteLength,
	)) {
		await ctx.runMutation(internal.reconciliationReports.stageHandoffKeys, {
			projectId: args.projectId,
			projectionId: args.projectionId,
			keys,
			actor: args.actor,
		});
	}
	await ctx.runMutation(internal.reconciliationReports.complete, {
		projectId: args.projectId,
		projectionId: args.projectionId,
		actor: args.actor,
	});
}

function reportFromProjection(
	projection: Doc<"catalogProjections">,
): Id<"reconciliationReports"> | null {
	if (projection.reconciliationReportStatus === "quiet") {
		if (projection.reconciliationReportId !== undefined) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A quiet Baseline transition points to a Reconciliation Report.",
			});
		}
		return null;
	}
	if (
		projection.reconciliationReportStatus !== "staging" &&
		projection.reconciliationReportStatus !== "staged"
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"A catalog projection is missing its Reconciliation Report state.",
		});
	}
	if (!projection.reconciliationReportId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A catalog projection is missing its Reconciliation Report.",
		});
	}
	return projection.reconciliationReportId;
}

async function stagingReportFor(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
): Promise<{
	projection: Doc<"catalogProjections">;
	report: Doc<"reconciliationReports">;
	handoff: Doc<"reconciliationWorkHandoffs">;
}> {
	const projection = await ctx.db.get(projectionId);
	if (
		!projection ||
		projection.projectId !== projectId ||
		projection.status !== "staging" ||
		projection.snapshotId !== undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "A staging Reconciliation Report was not found.",
		});
	}
	const reportId = reportFromProjection(projection);
	if (!reportId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "This quiet transition has no Reconciliation Report to stage.",
		});
	}
	const report = await ctx.db.get(reportId);
	if (
		!report ||
		report.projectId !== projectId ||
		report.projectionId !== projectionId ||
		report.status !== "staging" ||
		report.snapshotId !== undefined ||
		!report.workHandoffId
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A staging Reconciliation Report has invalid provenance.",
		});
	}
	const handoff = await ctx.db.get(report.workHandoffId);
	if (
		!handoff ||
		handoff.projectId !== projectId ||
		handoff.reportId !== report._id ||
		handoff.status !== "staging"
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A staging Work Hand-off has invalid provenance.",
		});
	}
	return { projection, report, handoff };
}

export const declare = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedRowCount: v.number(),
		expectedFactCount: v.number(),
		expectedByteLength: v.number(),
		expectedHandoffKeyCount: v.number(),
		expectedHandoffByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const quiet =
			args.expectedRowCount === 0 &&
			args.expectedFactCount === 0 &&
			args.expectedByteLength === 0 &&
			args.expectedHandoffKeyCount === 0 &&
			args.expectedHandoffByteLength === 0;
		if (
			!Number.isInteger(args.expectedRowCount) ||
			!Number.isInteger(args.expectedFactCount) ||
			!Number.isInteger(args.expectedByteLength) ||
			!Number.isInteger(args.expectedHandoffKeyCount) ||
			!Number.isInteger(args.expectedHandoffByteLength) ||
			args.expectedRowCount < 0 ||
			args.expectedRowCount > MAX_RECONCILIATION_REPORT_ROWS ||
			args.expectedFactCount < 0 ||
			args.expectedFactCount > MAX_RECONCILIATION_REPORT_FACTS ||
			args.expectedByteLength < 0 ||
			args.expectedByteLength > MAX_RECONCILIATION_REPORT_BYTES ||
			args.expectedHandoffKeyCount < 0 ||
			args.expectedHandoffKeyCount > MAX_WORKING_CATALOG_KEYS ||
			args.expectedHandoffByteLength < 0 ||
			args.expectedHandoffByteLength > MAX_WORK_HANDOFF_BYTES ||
			(!quiet && (args.expectedRowCount === 0 || args.expectedFactCount === 0))
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A Reconciliation Report declaration exceeds its envelope.",
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.reconciliationReportStatus !== "pending" ||
			projection.reconciliationReportId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A pending Reconciliation Report was not found.",
			});
		}
		if (quiet) {
			await ctx.db.patch(projection._id, {
				reconciliationReportStatus: "quiet",
			});
			return null;
		}
		const reportId = await ctx.db.insert("reconciliationReports", {
			projectId: args.projectId,
			projectionId: args.projectionId,
			...(projection.previousBaselineSnapshotId === undefined
				? {}
				: { previousSnapshotId: projection.previousBaselineSnapshotId }),
			status: "staging",
			expectedRowCount: args.expectedRowCount,
			expectedFactCount: args.expectedFactCount,
			expectedByteLength: args.expectedByteLength,
			stagedRowCount: 0,
			stagedFactCount: 0,
			stagedByteLength: 0,
			createdAt: now(),
		});
		const handoffId = await ctx.db.insert("reconciliationWorkHandoffs", {
			projectId: args.projectId,
			reportId,
			status: "staging",
			expectedKeyCount: args.expectedHandoffKeyCount,
			expectedByteLength: args.expectedHandoffByteLength,
			stagedKeyCount: 0,
			stagedByteLength: 0,
		});
		await ctx.db.patch(reportId, { workHandoffId: handoffId });
		await ctx.db.patch(projection._id, {
			reconciliationReportId: reportId,
			reconciliationReportStatus: "staging",
		});
		return { reportId, handoffId };
	},
});

export const stageRows = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		rows: v.array(reportRowValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			args.rows.length === 0 ||
			args.rows.length > MAX_RECONCILIATION_REPORT_STAGE_ROWS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Reconciliation Report staging batch has an invalid row count.",
			});
		}
		const rows = args.rows.map((row) => ({
			...row,
			facts: row.facts.map((fact) => ({
				...fact,
				...(fact.reasonCodes === undefined
					? {}
					: { reasonCodes: [...fact.reasonCodes] }),
			})),
		}));
		for (const row of rows) assertRow(row);
		if (
			new Set(rows.map(reportRowIdentity)).size !== rows.length ||
			rows.reduce((total, row) => total + rowByteLength(row), 0) >
				MAX_RECONCILIATION_REPORT_STAGE_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A Reconciliation Report staging batch exceeds its envelope.",
			});
		}
		const { report } = await stagingReportFor(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const nextRowCount = report.stagedRowCount + rows.length;
		const nextFactCount =
			report.stagedFactCount +
			rows.reduce((total, row) => total + row.facts.length, 0);
		const nextByteLength =
			report.stagedByteLength +
			rows.reduce((total, row) => total + rowByteLength(row), 0);
		if (
			nextRowCount > report.expectedRowCount ||
			nextFactCount > report.expectedFactCount ||
			nextByteLength > report.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Reconciliation Report staging exceeded its declared envelope.",
			});
		}
		for (const row of rows) {
			const existing = await ctx.db
				.query("reconciliationReportRows")
				.withIndex("by_report_and_groupOrder_and_subject_and_subjectKey", (q) =>
					q
						.eq("reportId", report._id)
						.eq("groupOrder", row.groupOrder)
						.eq("subject", row.subject)
						.eq("subjectKey", row.subjectKey),
				)
				.unique();
			if (existing) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Reconciliation Report row was staged twice.",
				});
			}
			const rowId = await ctx.db.insert("reconciliationReportRows", {
				projectId: args.projectId,
				reportId: report._id,
				group: row.group,
				groupOrder: row.groupOrder,
				subject: row.subject,
				subjectKey: row.subjectKey,
				catalogIndex: row.catalogIndex,
				...(row.messageId === undefined ? {} : { messageId: row.messageId }),
				...(row.catalogPath === undefined
					? {}
					: { catalogPath: row.catalogPath }),
			});
			for (const fact of row.facts) {
				await ctx.db.insert("reconciliationReportFacts", {
					projectId: args.projectId,
					reportId: report._id,
					rowId,
					...fact,
					...(fact.reasonCodes === undefined
						? {}
						: { reasonCodes: [...fact.reasonCodes] }),
				});
			}
		}
		await ctx.db.patch(report._id, {
			stagedRowCount: nextRowCount,
			stagedFactCount: nextFactCount,
			stagedByteLength: nextByteLength,
		});
		return null;
	},
});

export const stageHandoffKeys = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		keys: v.array(
			v.object({ catalogIndex: v.number(), messageId: v.string() }),
		),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			args.keys.length === 0 ||
			args.keys.length > MAX_RECONCILIATION_REPORT_STAGE_ROWS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A Work Hand-off staging batch has an invalid key count.",
			});
		}
		const keyIds = new Set<string>();
		let batchBytes = 0;
		for (const key of args.keys) {
			if (
				!Number.isInteger(key.catalogIndex) ||
				key.catalogIndex < 0 ||
				key.messageId.length === 0 ||
				keyIds.has(key.messageId)
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "A Work Hand-off key is invalid.",
				});
			}
			keyIds.add(key.messageId);
			batchBytes += handoffKeyByteLength(key);
		}
		if (batchBytes > MAX_RECONCILIATION_REPORT_STAGE_BYTES) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A Work Hand-off staging batch exceeds its byte budget.",
			});
		}
		const { handoff } = await stagingReportFor(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const nextKeyCount = handoff.stagedKeyCount + args.keys.length;
		const nextByteLength = handoff.stagedByteLength + batchBytes;
		if (
			nextKeyCount > handoff.expectedKeyCount ||
			nextByteLength > handoff.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Work Hand-off staging exceeded its declared envelope.",
			});
		}
		for (const key of args.keys) {
			await ctx.db.insert("reconciliationWorkHandoffKeys", {
				projectId: args.projectId,
				handoffId: handoff._id,
				catalogIndex: key.catalogIndex,
				messageId: key.messageId,
			});
		}
		await ctx.db.patch(handoff._id, {
			stagedKeyCount: nextKeyCount,
			stagedByteLength: nextByteLength,
		});
		return null;
	},
});

export const complete = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const { projection, report, handoff } = await stagingReportFor(
			ctx,
			args.projectId,
			args.projectionId,
		);
		if (
			report.stagedRowCount !== report.expectedRowCount ||
			report.stagedFactCount !== report.expectedFactCount ||
			report.stagedByteLength !== report.expectedByteLength ||
			handoff.stagedKeyCount !== handoff.expectedKeyCount ||
			handoff.stagedByteLength !== handoff.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report is incomplete.",
			});
		}
		await ctx.db.patch(report._id, { status: "staged" });
		await ctx.db.patch(handoff._id, { status: "staged" });
		await ctx.db.patch(projection._id, {
			reconciliationReportStatus: "staged",
		});
		return null;
	},
});

/** Ensure report staging is complete before a projection becomes visible. */
export async function assertStagedReconciliationReport(
	ctx: MutationCtx,
	projection: Doc<"catalogProjections">,
): Promise<Doc<"reconciliationReports"> | null> {
	const reportId = reportFromProjection(projection);
	if (!reportId) return null;
	if (projection.reconciliationReportStatus !== "staged") {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A Reconciliation Report was not fully staged.",
		});
	}
	const report = await ctx.db.get(reportId);
	if (
		!report ||
		report.projectId !== projection.projectId ||
		report.projectionId !== projection._id ||
		report.status !== "staged" ||
		report.snapshotId !== undefined ||
		report.stagedRowCount !== report.expectedRowCount ||
		report.stagedFactCount !== report.expectedFactCount ||
		report.stagedByteLength !== report.expectedByteLength ||
		!report.workHandoffId
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"A Reconciliation Report has an incomplete publication envelope.",
		});
	}
	const handoff = await ctx.db.get(report.workHandoffId);
	if (
		!handoff ||
		handoff.projectId !== projection.projectId ||
		handoff.reportId !== report._id ||
		handoff.status !== "staged" ||
		handoff.stagedKeyCount !== handoff.expectedKeyCount ||
		handoff.stagedByteLength !== handoff.expectedByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A Reconciliation Report Work Hand-off is incomplete.",
		});
	}
	return report;
}

/** Publish the report in the same transaction as its Baseline projection. */
export async function publishStagedReconciliationReport(
	ctx: MutationCtx,
	projection: Doc<"catalogProjections">,
	snapshotId: Id<"sourceSnapshots">,
): Promise<void> {
	const report = await assertStagedReconciliationReport(ctx, projection);
	if (!report) return;
	if (!report.workHandoffId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A Reconciliation Report is missing its Work Hand-off.",
		});
	}
	await ctx.db.patch(report._id, { snapshotId, status: "published" });
	await ctx.db.patch(report.workHandoffId, { status: "published" });
}

function assertPublishedReport(
	report: Doc<"reconciliationReports"> | null,
): asserts report is Doc<"reconciliationReports"> & {
	snapshotId: Id<"sourceSnapshots">;
	workHandoffId: Id<"reconciliationWorkHandoffs">;
} {
	if (
		report?.status !== "published" ||
		report?.snapshotId === undefined ||
		report?.workHandoffId === undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Reconciliation Report not found.",
		});
	}
}

function reportHeader(report: Doc<"reconciliationReports">) {
	assertPublishedReport(report);
	return {
		_id: report._id,
		projectionId: report.projectionId,
		snapshotId: report.snapshotId,
		previousSnapshotId: report.previousSnapshotId ?? null,
		workHandoffId: report.workHandoffId,
		createdAt: report.createdAt,
	};
}

export const list = query({
	args: {
		projectId: v.id("projects"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		if (
			!Number.isInteger(args.paginationOpts.numItems) ||
			args.paginationOpts.numItems < 1 ||
			args.paginationOpts.numItems > 100
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Reconciliation Report page may contain at most 100 reports.",
			});
		}
		const page = await ctx.db
			.query("reconciliationReports")
			.withIndex("by_project_and_status", (q) =>
				q.eq("projectId", args.projectId).eq("status", "published"),
			)
			.order("desc")
			.paginate(args.paginationOpts);
		return {
			page: page.page.map(reportHeader),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

export const get = query({
	args: {
		reportId: v.id("reconciliationReports"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const report = await ctx.db.get(args.reportId);
		assertPublishedReport(report);
		await requireViewer(ctx, report.projectId);
		if (
			!Number.isInteger(args.paginationOpts.numItems) ||
			args.paginationOpts.numItems < 1 ||
			args.paginationOpts.numItems > MAX_RECONCILIATION_REPORT_PAGE_ROWS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `A Reconciliation Report page may contain at most ${MAX_RECONCILIATION_REPORT_PAGE_ROWS} rows.`,
			});
		}
		const handoff = await ctx.db.get(report.workHandoffId);
		if (
			!handoff ||
			handoff.projectId !== report.projectId ||
			handoff.reportId !== report._id ||
			handoff.status !== "published" ||
			handoff.stagedKeyCount !== handoff.expectedKeyCount ||
			handoff.stagedByteLength !== handoff.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report Work Hand-off is incomplete.",
			});
		}
		const page = await ctx.db
			.query("reconciliationReportRows")
			.withIndex("by_report_and_groupOrder_and_catalogIndex", (q) =>
				q.eq("reportId", report._id),
			)
			.paginate(args.paginationOpts);
		const rows = [];
		for (const row of page.page) {
			const facts = await ctx.db
				.query("reconciliationReportFacts")
				.withIndex("by_row", (q) => q.eq("rowId", row._id))
				.take(MAX_RECONCILIATION_REPORT_FACTS_PER_ROW + 1);
			if (
				facts.length > MAX_RECONCILIATION_REPORT_FACTS_PER_ROW ||
				facts.some(
					(fact) =>
						fact.reportId !== report._id || fact.projectId !== report.projectId,
				)
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Reconciliation Report row has an invalid fact envelope.",
				});
			}
			const locales = new Map<
				string,
				{
					localeId: Id<"locales"> | null;
					localeCode: string | null;
					catalogPath: string | null;
					facts: {
						_id: Id<"reconciliationReportFacts">;
						kind: ReconciliationReportFactKind;
						reasonCodes?: TranslationResidueCode[];
						transformCode?: ContractTransformCode;
						relatedSnapshotId?: Id<"sourceSnapshots">;
						declaredLocaleCode?: string;
						messageCount?: number;
						disposition: {
							actor: { kind: "user" | "agent" | "system"; id: string };
							at: number;
						} | null;
					}[];
				}
			>();
			for (const fact of facts) {
				if (
					(fact.disposedBy === undefined) !==
					(fact.disposedAt === undefined)
				) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"A Reconciliation Report fact has an incomplete disposition.",
					});
				}
				const identity = String(fact.localeId ?? fact.catalogPath ?? "report");
				const locale = locales.get(identity) ?? {
					localeId: fact.localeId ?? null,
					localeCode: fact.localeCode ?? null,
					catalogPath: fact.catalogPath ?? null,
					facts: [],
				};
				locale.facts.push({
					_id: fact._id,
					kind: fact.kind,
					...(fact.reasonCodes === undefined
						? {}
						: { reasonCodes: [...fact.reasonCodes] }),
					...(fact.transformCode === undefined
						? {}
						: { transformCode: fact.transformCode }),
					...(fact.relatedSnapshotId === undefined
						? {}
						: { relatedSnapshotId: fact.relatedSnapshotId }),
					...(fact.declaredLocaleCode === undefined
						? {}
						: { declaredLocaleCode: fact.declaredLocaleCode }),
					...(fact.messageCount === undefined
						? {}
						: { messageCount: fact.messageCount }),
					disposition:
						fact.disposedBy === undefined || fact.disposedAt === undefined
							? null
							: { actor: humanActor(fact.disposedBy), at: fact.disposedAt },
				});
				locales.set(identity, locale);
			}
			rows.push({
				group: row.group,
				groupOrder: row.groupOrder,
				subject: row.subject,
				catalogIndex: row.catalogIndex,
				...(row.messageId === undefined ? {} : { messageId: row.messageId }),
				...(row.catalogPath === undefined
					? {}
					: { catalogPath: row.catalogPath }),
				locales: [...locales.values()]
					.map((locale) => ({
						...locale,
						facts: [...locale.facts].sort((left, right) =>
							left.kind.localeCompare(right.kind),
						),
					}))
					.sort((left, right) =>
						(left.localeCode ?? "").localeCompare(right.localeCode ?? ""),
					),
			});
		}
		return {
			...reportHeader(report),
			workHandoff: {
				_id: handoff._id,
				keyCount: handoff.expectedKeyCount,
			},
			rows,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

export const getWorkHandoff = query({
	args: { reportId: v.id("reconciliationReports") },
	handler: async (ctx, args) => {
		const report = await ctx.db.get(args.reportId);
		assertPublishedReport(report);
		await requireViewer(ctx, report.projectId);
		const handoff = await ctx.db.get(report.workHandoffId);
		if (
			!handoff ||
			handoff.projectId !== report.projectId ||
			handoff.reportId !== report._id ||
			handoff.status !== "published" ||
			handoff.expectedKeyCount > MAX_WORKING_CATALOG_KEYS ||
			handoff.expectedByteLength > MAX_WORK_HANDOFF_BYTES ||
			handoff.stagedKeyCount !== handoff.expectedKeyCount ||
			handoff.stagedByteLength !== handoff.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report Work Hand-off is incomplete.",
			});
		}
		const keys = await ctx.db
			.query("reconciliationWorkHandoffKeys")
			.withIndex("by_handoff", (q) => q.eq("handoffId", handoff._id))
			.take(MAX_WORKING_CATALOG_KEYS + 1);
		if (
			keys.length > MAX_WORKING_CATALOG_KEYS ||
			keys.length !== handoff.expectedKeyCount ||
			keys.reduce(
				(total, key) =>
					total +
					handoffKeyByteLength({
						catalogIndex: key.catalogIndex,
						messageId: key.messageId,
					}),
				0,
			) !== handoff.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A Reconciliation Report Work Hand-off does not match its envelope.",
			});
		}
		return {
			reportId: report._id,
			keys: keys
				.map((key) => ({
					catalogIndex: key.catalogIndex,
					messageId: key.messageId,
				}))
				.sort(
					(left, right) =>
						left.catalogIndex - right.catalogIndex ||
						left.messageId.localeCompare(right.messageId),
				),
		};
	},
});

/** Record a human disposition without deleting the transition fact. */
export const dispose = mutation({
	args: { factId: v.id("reconciliationReportFacts") },
	handler: async (ctx, args) => {
		const fact = await ctx.db.get(args.factId);
		if (!fact) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Report fact not found.",
			});
		}
		const { userId } = await requireEditor(ctx, fact.projectId);
		const report = await ctx.db.get(fact.reportId);
		assertPublishedReport(report);
		if (report.projectId !== fact.projectId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Reconciliation Report fact belongs to another project.",
			});
		}
		if (fact.disposedAt !== undefined || fact.disposedBy !== undefined) {
			return null;
		}
		await ctx.db.patch(fact._id, {
			disposedBy: { kind: "user", id: userId },
			disposedAt: now(),
		});
		return null;
	},
});
