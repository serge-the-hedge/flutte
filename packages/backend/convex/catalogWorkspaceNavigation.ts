import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { hasMinimumRole } from "./accessControl";
import { isHumanOrAuthorizedReview } from "./agentReviewModel";
import { pendingIntroductionLocaleIds } from "./catalogIntroductionReviews";
import {
	activeProjectionFor,
	MAX_PROJECTED_LOCALES,
	MAX_WORKING_CATALOG_KEYS,
	readActiveCatalog,
} from "./catalogProjection";
import {
	decisionForIdentity,
	latestDecisionForValue,
	visibleDecisionRecords,
} from "./catalogWorkspaceDecisionQueries";
import {
	type CatalogWorkspaceDecisionRecord,
	type CatalogWorkspaceValueState,
	composeWorkspaceKeyCards,
	currentDecisionForValue,
	currentHeadForRow,
	currentSourceProposalRows,
	currentWorkspaceRows,
	decisionIdentity,
	decisionRecordMap,
	decisionSourceFingerprintFor,
	encodedSize,
	sourceChangeMap,
	translatorConfirmationMap,
	valueIdentity,
	valueStateFor,
} from "./catalogWorkspaceView";
import { now, sha256Hex } from "./lib";
import { readCharacterLimit } from "./messageConstraints";
import type { OrdinaryImportConfirmationCounts } from "./ordinaryImportConfirmations";
import { ORDINARY_IMPORT_CONFIRMATION_POLICY } from "./ordinaryImportConfirmations";
import { requireEditor, requireViewer } from "./permissions";
import {
	isCurrentSourceProposalHeadForSource,
	publishedResolutionFor,
	sourceProposalHeadMap,
	sourceProposalStatusesFor,
} from "./sourceProposals";

/** The Catalog Navigation Index is the disposable read model behind the
 * windowed Catalog Workspace Browse seam. One bounded row per active key is
 * derived entirely from canonical evidence by the internal projector below;
 * callers never assemble or patch digest fields. The stored index is bounded
 * at eight MiB so a Baseline-sized catalog stays inside the documented
 * uncached-open budget for the measured ten-Locale working catalog. */
export const MAX_CATALOG_WORKSPACE_NAVIGATION_ROWS = MAX_WORKING_CATALOG_KEYS;
export const MAX_CATALOG_WORKSPACE_NAVIGATION_BYTES = 8 * 1024 * 1024;
/** The public Navigation response is intentionally kept below the measured
 * uncached-open budget. Search remains local because the compact corpus is
 * carried with every digest; larger catalogs must use a smaller projection or
 * a future paged Navigation contract rather than silently returning a giant
 * response. */
export const MAX_CATALOG_WORKSPACE_NAVIGATION_RETURN_BYTES = 8 * 1024 * 1024;
const MAX_NAVIGATION_RESET_ROWS_PER_MUTATION = 256;
// Repair derivation reads every Locale row and current decision for each key.
// Keep its transactions comfortably below Convex's system-operation ceiling.
const MAX_NAVIGATION_KEYS_PER_STAGE_STEP = 32;
const MAX_NAVIGATION_VERIFY_ROWS_PER_MUTATION = 256;
const NAVIGATION_BACKFILL_STEP_LEASE_MS = 60_000;
/** Step budget for the ingest action's staging loop; 32 keys per step over
 * the working-catalog key envelope leaves a generous safety margin. */
export const MAX_NAVIGATION_STAGE_STEPS = MAX_WORKING_CATALOG_KEYS + 1;

const ordinaryImportCountsValidatorFields = {
	total: v.number(),
	eligible: v.number(),
	empty: v.number(),
	sourceIdentical: v.number(),
	repeated: v.number(),
	modified: v.number(),
	stale: v.number(),
	alreadyConfirmed: v.number(),
	pendingSourceProposal: v.number(),
	introduced: v.number(),
};

export type CatalogWorkspaceNavigationTargetDigest = {
	localeId: Id<"locales">;
	localeCode: string;
	valueState: CatalogWorkspaceValueState;
	/** A current Workspace value head exists, so the target no longer holds
	 * untouched Baseline content. */
	touched: boolean;
	/** An exact decision covers the target's Git content. */
	confirmedGitContent: boolean;
	/** An earlier Translator Confirmation covered the Git content and its
	 * Source Contract has since changed. */
	confirmedContentPreviously: boolean;
	/** Legacy projection-stable repetition fact. Current classification compares
	 * the target value identities carried by one key and never compares unrelated
	 * keys. */
	repeatedGitContent?: boolean;
	/** Fingerprint of the visible value after Workspace composition. It keeps
	 * legacy digest summaries exact without carrying the value itself. */
	valueFingerprint?: string;
	gitValueFingerprint?: string;
	/** This Locale is still inside the key's post-bootstrap First Review. */
	firstReviewPending: boolean;
};

export type CatalogWorkspaceNavigationDigest = {
	firstSeenProjectionId?: Id<"catalogProjections">;
	projectId: Id<"projects">;
	projectionId: Id<"catalogProjections">;
	messageId: string;
	catalogIndex: number;
	/** The case-folded message identifier and every current effective
	 * Source/target value, so local substring search keeps exact semantics. */
	searchCorpus: string[];
	pendingSourceProposal: boolean;
	introductionReviewPending: number;
	source: {
		localeId: Id<"locales">;
		gitValueFingerprint: string;
	};
	targets: CatalogWorkspaceNavigationTargetDigest[];
};

type SourceProposalResolution = { status: "landed" | "superseded" };

export function navigationDigestByteLength(
	digest: CatalogWorkspaceNavigationDigest,
): number {
	return encodedSize(digest);
}

function foldCase(value: string): string {
	return value.toLowerCase();
}

/** Derive one Navigation digest from one canonical key plus current
 * Workspace evidence. This is the projector's pure half: the same inputs
 * must always yield the same digest, so a rebuild is byte-identical. */
export async function deriveNavigationDigest(input: {
	projectId: Id<"projects">;
	projectionId: Id<"catalogProjections">;
	/** Every Catalog Projection row for one message identifier. */
	rows: readonly Doc<"catalogProjectionMessages">[];
	/** Every current Workspace value head for the same message identifier. */
	heads: readonly Doc<"catalogWorkspaceValueHeads">[];
	/** Every decision record for the same message identifier. */
	decisions: readonly CatalogWorkspaceDecisionRecord[];
	/** Projection-stable target identities whose visible imported content repeats
	 * in a Locale. */
	repeatedValueIdentities?: ReadonlySet<string>;
	/** Public search reads current values separately; production digests store IDs only. */
	compactSearchCorpus?: boolean;
	sourceProposalHead: Doc<"catalogWorkspaceSourceProposalHeads"> | null;
	sourceProposalResolution: SourceProposalResolution | null;
}): Promise<CatalogWorkspaceNavigationDigest> {
	const sourceRows = input.rows.filter((row) => row.isSource);
	if (sourceRows.length !== 1 || !sourceRows[0]) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace navigation requires exactly one Source value per key.",
		});
	}
	const sourceRow = sourceRows[0];
	const headByValue = new Map(
		input.heads.map(
			(head) =>
				[JSON.stringify([head.messageId, head.localeId]), head] as const,
		),
	);
	const decisionsByIdentity = decisionRecordMap(input.decisions);
	const confirmationsByValue = translatorConfirmationMap(input.decisions);
	const pendingIntroductionLocales = pendingIntroductionLocaleIds({
		source: sourceRow,
		activeTargetLocaleIds: new Set(
			input.rows.flatMap((row) => (row.isSource ? [] : [row.localeId])),
		),
		decisions: input.decisions,
	});
	const headByMessageId = input.sourceProposalHead
		? new Map([[input.sourceProposalHead.messageId, input.sourceProposalHead]])
		: new Map<string, Doc<"catalogWorkspaceSourceProposalHeads">>();
	const resolutionsByProposal =
		input.sourceProposalHead && input.sourceProposalResolution
			? new Map([
					[input.sourceProposalHead.proposalId, input.sourceProposalResolution],
				])
			: new Map<Id<"sourceProposals">, SourceProposalResolution>();
	// The same composition order as the complete read: the Source Proposal
	// overlay applies to Git source rows first, then current value heads
	// overlay target rows.
	const effectiveRows = currentWorkspaceRows(
		currentSourceProposalRows(
			input.rows,
			headByMessageId,
			resolutionsByProposal,
		),
		headByValue,
	);
	const sourceEffective = effectiveRows.find((row) => row.isSource);
	if (!sourceEffective) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Catalog Workspace navigation lost the effective Source value for a key.",
		});
	}
	const pendingSourceProposalFingerprint =
		isCurrentSourceProposalHeadForSource(sourceRow, input.sourceProposalHead) &&
		!input.sourceProposalResolution
			? input.sourceProposalHead?.sourceFingerprint
			: undefined;
	const gitSourceValueFingerprint =
		sourceRow.valueFingerprint ?? (await sha256Hex(sourceRow.value));
	const targetRows = input.rows
		.filter((row) => !row.isSource)
		.sort((a, b) => a.localeCode.localeCompare(b.localeCode));
	const targets: CatalogWorkspaceNavigationTargetDigest[] = [];
	const searchCorpus = new Set([
		foldCase(sourceRow.messageId),
		...(input.compactSearchCorpus ? [] : [foldCase(sourceEffective.value)]),
	]);

	for (const targetRow of targetRows) {
		const effective = effectiveRows.find(
			(row) =>
				!row.isSource &&
				row.messageId === targetRow.messageId &&
				row.localeId === targetRow.localeId,
		);
		if (!effective) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Catalog Workspace navigation lost an effective Locale value for a key.",
			});
		}
		const head = currentHeadForRow(targetRow, headByValue);
		const valueFingerprint =
			effective.valueFingerprint ?? (await sha256Hex(effective.value));
		const gitValueFingerprint =
			targetRow.valueFingerprint ?? (await sha256Hex(targetRow.value));
		// The same source-fingerprint rule as the complete read: a pending
		// Source Proposal leaves Git-settled targets alone, keeps same-pass
		// work current, and makes work against an older candidate stale.
		const decisionSourceFingerprint = decisionSourceFingerprintFor({
			gitSourceFingerprint: sourceRow.sourceFingerprint,
			currentSourceFingerprint: sourceEffective.sourceFingerprint,
			valueSourceFingerprint: effective.sourceFingerprint,
			pendingSourceProposalFingerprint,
		});
		const decision = currentDecisionForValue({
			row: targetRow,
			sourceFingerprint: decisionSourceFingerprint,
			value: effective.value,
			valueFingerprint,
			decisionsByIdentity,
		});
		const previousConfirmation =
			pendingSourceProposalFingerprint === undefined
				? confirmationsByValue.get(
						JSON.stringify([
							targetRow.messageId,
							targetRow.localeId,
							valueFingerprint,
						]),
					)
				: undefined;
		const valueState = valueStateFor({
			value: effective.value,
			decision,
			previousConfirmation,
			currentSourceFingerprint: decisionSourceFingerprint,
		});
		const exactGitDecision =
			targetRow.gitValueFingerprint !== undefined &&
			decisionsByIdentity.has(
				decisionIdentity({
					messageId: targetRow.messageId,
					localeId: targetRow.localeId,
					sourceFingerprint: sourceRow.sourceFingerprint,
					valueFingerprint: gitValueFingerprint,
				}),
			);
		const repeatedGitContent =
			targetRow.repeatedGitContentVersion === 2
				? targetRow.repeatedGitContent
				: input.repeatedValueIdentities === undefined
					? undefined
					: input.repeatedValueIdentities.has(valueIdentity(targetRow));
		targets.push({
			localeId: targetRow.localeId,
			localeCode: targetRow.localeCode,
			valueState: valueState.valueState,
			touched: head !== undefined,
			confirmedGitContent: exactGitDecision,
			// Only a prior confirmation whose Source Contract has since changed:
			// the summary reads this fact after the exact-content check.
			confirmedContentPreviously:
				!exactGitDecision &&
				confirmationsByValue.has(
					JSON.stringify([
						targetRow.messageId,
						targetRow.localeId,
						gitValueFingerprint,
					]),
				),
			...(repeatedGitContent === undefined ? {} : { repeatedGitContent }),
			valueFingerprint,
			...(targetRow.gitValueFingerprint === undefined
				? {}
				: { gitValueFingerprint: targetRow.gitValueFingerprint }),
			firstReviewPending: pendingIntroductionLocales.has(targetRow.localeId),
		});
		if (!input.compactSearchCorpus) searchCorpus.add(foldCase(effective.value));
	}

	return {
		projectId: input.projectId,
		projectionId: input.projectionId,
		...(sourceRow.firstSeenProjectionId
			? { firstSeenProjectionId: sourceRow.firstSeenProjectionId }
			: {}),
		messageId: sourceRow.messageId,
		catalogIndex: sourceRow.catalogIndex,
		searchCorpus: [...searchCorpus],
		pendingSourceProposal: pendingSourceProposalFingerprint !== undefined,
		introductionReviewPending: pendingIntroductionLocales.size,
		source: {
			localeId: sourceRow.localeId,
			gitValueFingerprint: gitSourceValueFingerprint,
		},
		targets,
	};
}

const ORDINARY_IMPORT_COUNT_FIELDS = [
	"total",
	"eligible",
	"empty",
	"sourceIdentical",
	"repeated",
	"modified",
	"stale",
	"alreadyConfirmed",
	"pendingSourceProposal",
	"introduced",
] as const satisfies readonly (keyof OrdinaryImportConfirmationCounts)[];

/** Bump when the meaning of persisted ordinary-import categories changes. */
export const ORDINARY_IMPORT_POLICY_VERSION = 3;

export function backfillStepIsPending(
	state: Pick<
		Doc<"catalogWorkspaceNavigationStates">,
		"backfillStepPending" | "backfillStepPendingAt"
	>,
) {
	return (
		state.backfillStepPending === true &&
		state.backfillStepPendingAt !== undefined &&
		state.backfillStepPendingAt > now() - NAVIGATION_BACKFILL_STEP_LEASE_MS
	);
}

function pendingBackfillStepPatch() {
	return { backfillStepPending: true as const, backfillStepPendingAt: now() };
}

const IDLE_BACKFILL_STEP_PATCH = {
	backfillStepPending: false as const,
	backfillStepPendingAt: undefined,
};

function emptyOrdinaryImportCounts(): OrdinaryImportConfirmationCounts {
	return {
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
}

function combineOrdinaryImportCounts(
	base: OrdinaryImportConfirmationCounts,
	delta: OrdinaryImportConfirmationCounts,
	factor: 1 | -1,
): OrdinaryImportConfirmationCounts {
	const next = { ...base };
	for (const field of ORDINARY_IMPORT_COUNT_FIELDS) {
		next[field] += factor * delta[field];
		if (next[field] < 0) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Workspace ordinary-import counts went negative.",
			});
		}
	}
	return next;
}

function repeatsAcrossTargetLocales(
	digest: CatalogWorkspaceNavigationDigest,
	target: CatalogWorkspaceNavigationTargetDigest,
): boolean {
	return (
		target.valueFingerprint !== undefined &&
		digest.targets.some(
			(other) =>
				other.localeId !== target.localeId &&
				other.valueFingerprint === target.valueFingerprint,
		)
	);
}

/** Count one digest independently. Suspicious repetition is local to one key:
 * two target Locales carrying the same visible text merit deliberate review,
 * while unrelated keys are free to reuse ordinary words and labels. */
export function ordinaryImportCountsForDigest(
	digest: CatalogWorkspaceNavigationDigest,
): OrdinaryImportConfirmationCounts {
	const counts = emptyOrdinaryImportCounts();
	for (const target of digest.targets) {
		counts.total++;
		if (target.confirmedGitContent) {
			counts.alreadyConfirmed++;
			continue;
		}
		if (target.confirmedContentPreviously) {
			counts.stale++;
			continue;
		}
		if (target.touched) {
			counts.modified++;
			continue;
		}
		if (digest.pendingSourceProposal) {
			counts.pendingSourceProposal++;
			continue;
		}
		if (digest.introductionReviewPending > 0) {
			counts.introduced++;
			continue;
		}
		if (target.valueState === "waiting") {
			counts.empty++;
			continue;
		}
		if (
			target.gitValueFingerprint !== undefined &&
			target.gitValueFingerprint === digest.source.gitValueFingerprint
		) {
			counts.sourceIdentical++;
			continue;
		}
		if (repeatsAcrossTargetLocales(digest, target)) {
			counts.repeated++;
			continue;
		}
		counts.eligible++;
	}
	return counts;
}

/** Derive the whole-catalog ordinary-confirmation summary from Navigation
 * digests alone. Every repetition decision stays inside one key digest, so the
 * summary remains additive and never scans unrelated keys for equal text. */
export function ordinaryImportSummaryFromDigests(
	digests: readonly CatalogWorkspaceNavigationDigest[],
): OrdinaryImportConfirmationCounts {
	const counts = emptyOrdinaryImportCounts();
	for (const digest of digests) {
		const digestCounts = ordinaryImportCountsForDigest(digest);
		for (const field of ORDINARY_IMPORT_COUNT_FIELDS) {
			counts[field] += digestCounts[field];
		}
	}
	return counts;
}

function navigationRowFor(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
	messageId: string,
): Promise<Doc<"catalogWorkspaceNavigationRows"> | null> {
	return ctx.db
		.query("catalogWorkspaceNavigationRows")
		.withIndex("by_project_and_projection_and_messageId", (q) =>
			q
				.eq("projectId", projectId)
				.eq("projectionId", projectionId)
				.eq("messageId", messageId),
		)
		.unique();
}

/** Old Locale heads can await reconciliation after an archive or replacement.
 * Only heads addressed by this projection's target rows belong in its view. */
async function workspaceHeadsForRows(
	ctx: MutationCtx | QueryCtx,
	projectId: Id<"projects">,
	rows: readonly Doc<"catalogProjectionMessages">[],
): Promise<Doc<"catalogWorkspaceValueHeads">[]> {
	const first = rows[0];
	if (!first) return [];
	const existing = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q.eq("projectId", projectId).eq("messageId", first.messageId),
		)
		.first();
	if (!existing) return [];
	const heads = await Promise.all(
		rows
			.filter((row) => !row.isSource)
			.map((row) =>
				ctx.db
					.query("catalogWorkspaceValueHeads")
					.withIndex("by_project_and_messageId_and_localeId", (q) =>
						q
							.eq("projectId", projectId)
							.eq("messageId", row.messageId)
							.eq("localeId", row.localeId),
					)
					.unique(),
			),
	);
	return heads.filter(
		(head): head is Doc<"catalogWorkspaceValueHeads"> => head !== null,
	);
}

/** Bound staging by complete keys and actual catalog/head bytes. The paged
 * read is byte-limited; a single large key is completed by an indexed lookup. */
async function navigationKeyBatchForProjection(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		afterCatalogIndex: number;
		maxKeys: number;
	},
) {
	// Each Locale can require several indexed decision and provenance lookups.
	// Limit total Locale rows as well as bytes to stay below transaction range limits.
	const projection = await ctx.db.get(input.projectionId);
	if (!projection)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Catalog projection not found.",
		});
	const localeCount = Math.max(
		1,
		Math.ceil(
			projection.expectedMessageCount /
				Math.max(1, projection.expectedKeyCount),
		),
	);
	const maxKeys = Math.min(
		input.maxKeys,
		Math.max(1, Math.floor(128 / localeCount)),
	);
	const page = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection_and_catalogIndex", (q) =>
			q
				.eq("projectionId", input.projectionId)
				.gt("catalogIndex", input.afterCatalogIndex),
		)
		.paginate({
			cursor: null,
			numItems: (maxKeys + 1) * localeCount,
			maximumBytesRead: 2 * 1024 * 1024,
		});
	const last = page.page[page.page.length - 1];
	let completeRows = page.isDone
		? page.page
		: page.page.filter((row) => row.messageId !== last?.messageId);
	if (!page.isDone && completeRows.length === 0) {
		const first = page.page[0];
		if (!first)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Navigation page made no progress.",
			});
		completeRows = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId", (q) =>
				q
					.eq("projectionId", input.projectionId)
					.eq("messageId", first.messageId),
			)
			.take(MAX_PROJECTED_LOCALES + 1);
	}
	const grouped = new Map<string, Doc<"catalogProjectionMessages">[]>();
	for (const row of completeRows) {
		const group = grouped.get(row.messageId) ?? [];
		group.push(row);
		if (group.length > MAX_PROJECTED_LOCALES)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A Navigation key has too many Locale rows.",
			});
		grouped.set(row.messageId, group);
	}
	const rows: Doc<"catalogProjectionMessages">[] = [];
	const heads: Doc<"catalogWorkspaceValueHeads">[] = [];
	const messageIds: string[] = [];
	let lastCatalogIndex = input.afterCatalogIndex;
	let byteLength = 0;
	for (const [messageId, keyRows] of grouped) {
		const keyHeads = await workspaceHeadsForRows(ctx, input.projectId, keyRows);
		const keyBytes = encodedSize(keyRows) + encodedSize(keyHeads);
		if (keyBytes > 6 * 1024 * 1024)
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A key's catalog and working values exceed the 6 MiB processing budget.",
			});
		if (messageIds.length > 0 && byteLength + keyBytes > 2 * 1024 * 1024) break;
		rows.push(...keyRows);
		heads.push(...keyHeads);
		byteLength += keyBytes;
		messageIds.push(messageId);
		// catalogIndex is the Source key ordinal, shared by every Locale row.
		// Resuming strictly after it skips the whole completed key.
		lastCatalogIndex = keyRows[0]?.catalogIndex ?? lastCatalogIndex;
		if (messageIds.length >= maxKeys || byteLength >= 2 * 1024 * 1024) break;
	}
	return {
		rows,
		heads,
		messageIds,
		lastCatalogIndex,
		moreRemaining: !page.isDone || rows.length < page.page.length,
	};
}

export function navigationStateFor(
	ctx: MutationCtx | QueryCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogWorkspaceNavigationStates"> | null> {
	return ctx.db
		.query("catalogWorkspaceNavigationStates")
		.withIndex("by_project", (q) => q.eq("projectId", projectId))
		.unique();
}

/** Ordinary confirmation is a derived batch over the Navigation Index, not a
 * fallback scan. Keep its preview and its mutating run behind the same
 * completeness gate so neither can start from a legacy or partially rebuilt
 * generation. */
type ReadyNavigationState = Omit<
	Doc<"catalogWorkspaceNavigationStates">,
	"ordinaryImportCounts"
> & {
	status: "ready";
	expectedRowCount: number;
	ordinaryImportCounts: OrdinaryImportConfirmationCounts;
};

export function normalizedOrdinaryImportCounts(
	counts: NonNullable<
		Doc<"catalogWorkspaceNavigationStates">["ordinaryImportCounts"]
	>,
): OrdinaryImportConfirmationCounts {
	return { ...counts, introduced: counts.introduced ?? 0 };
}

export async function readyNavigationStateFor(
	ctx: MutationCtx | QueryCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		expectedRowCount: number;
	},
): Promise<ReadyNavigationState> {
	const state = await navigationStateFor(ctx, input.projectId);
	if (
		!state ||
		state.projectionId !== input.projectionId ||
		state.status !== "ready" ||
		state.ordinaryImportCounts === undefined ||
		state.ordinaryImportPolicyVersion !== ORDINARY_IMPORT_POLICY_VERSION ||
		state.rowCount !== input.expectedRowCount ||
		state.expectedRowCount !== input.expectedRowCount
	) {
		throw new ConvexError({
			code: "INCOMPLETE",
			message:
				"Ordinary-import candidates are unavailable until the Navigation Index backfill completes.",
		});
	}
	return {
		...state,
		status: "ready",
		expectedRowCount: state.expectedRowCount,
		ordinaryImportCounts: normalizedOrdinaryImportCounts(
			state.ordinaryImportCounts,
		),
	};
}

function navigationStagingFor(
	ctx: MutationCtx | QueryCtx,
	projectionId: Id<"catalogProjections">,
): Promise<Doc<"catalogWorkspaceNavigationStaging"> | null> {
	return ctx.db
		.query("catalogWorkspaceNavigationStaging")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.unique();
}

function navigationRowToDigest(
	row: Doc<"catalogWorkspaceNavigationRows">,
): CatalogWorkspaceNavigationDigest {
	return {
		projectId: row.projectId,
		projectionId: row.projectionId,
		...(row.firstSeenProjectionId
			? { firstSeenProjectionId: row.firstSeenProjectionId }
			: {}),
		messageId: row.messageId,
		catalogIndex: row.catalogIndex,
		searchCorpus: [...row.searchCorpus],
		pendingSourceProposal: row.pendingSourceProposal,
		introductionReviewPending: row.introductionReviewPending ?? 0,
		source: { ...row.source },
		targets: row.targets.map((target) => ({
			...target,
			firstReviewPending: target.firstReviewPending ?? false,
		})),
	};
}

function navigationRowMatchesDigest(
	row: Doc<"catalogWorkspaceNavigationRows">,
	digest: CatalogWorkspaceNavigationDigest,
): boolean {
	// Field-wise comparison: Convex does not preserve object key order through
	// storage round-trips, so a serialized comparison would always differ.
	const current = navigationRowToDigest(row);
	return (
		current.projectId === digest.projectId &&
		current.projectionId === digest.projectionId &&
		current.messageId === digest.messageId &&
		current.firstSeenProjectionId === digest.firstSeenProjectionId &&
		current.catalogIndex === digest.catalogIndex &&
		current.pendingSourceProposal === digest.pendingSourceProposal &&
		current.introductionReviewPending === digest.introductionReviewPending &&
		JSON.stringify(current.searchCorpus) ===
			JSON.stringify(digest.searchCorpus) &&
		current.source.localeId === digest.source.localeId &&
		current.source.gitValueFingerprint === digest.source.gitValueFingerprint &&
		current.targets.length === digest.targets.length &&
		current.targets.every((target, index) => {
			const next = digest.targets[index];
			if (!next) return false;
			return (
				target.localeId === next.localeId &&
				target.localeCode === next.localeCode &&
				target.valueState === next.valueState &&
				target.touched === next.touched &&
				target.confirmedGitContent === next.confirmedGitContent &&
				target.confirmedContentPreviously === next.confirmedContentPreviously &&
				target.firstReviewPending === next.firstReviewPending &&
				target.repeatedGitContent === next.repeatedGitContent &&
				target.valueFingerprint === next.valueFingerprint &&
				target.gitValueFingerprint === next.gitValueFingerprint
			);
		})
	);
}

/** The envelope a digest row is accounted against: the active generation's
 * state document, or a staging envelope for a generation that is not visible
 * yet. Rows of a different projection are uncounted garbage: they are deleted
 * without touching the envelope. */
type NavigationEnvelope =
	| { kind: "active"; state: Doc<"catalogWorkspaceNavigationStates"> }
	| { kind: "staging"; staging: Doc<"catalogWorkspaceNavigationStaging"> };

function envelopeProjectionId(
	envelope: NavigationEnvelope,
): Id<"catalogProjections"> {
	return envelope.kind === "active"
		? envelope.state.projectionId
		: envelope.staging.projectionId;
}

async function patchEnvelopeCounts(
	ctx: MutationCtx,
	envelope: NavigationEnvelope,
	counts: {
		rowCount: number;
		byteLength: number;
		ordinaryImportCounts?: OrdinaryImportConfirmationCounts;
	},
): Promise<void> {
	// Keep the caller's envelope object current so sequential upserts inside
	// one transaction account against the fresh counts, not a stale snapshot.
	const patch = {
		rowCount: counts.rowCount,
		byteLength: counts.byteLength,
		...(counts.ordinaryImportCounts === undefined
			? {}
			: { ordinaryImportCounts: counts.ordinaryImportCounts }),
	};
	if (envelope.kind === "active") {
		const revision = (envelope.state.revision ?? 0) + 1;
		envelope.state.rowCount = patch.rowCount;
		envelope.state.byteLength = patch.byteLength;
		envelope.state.revision = revision;
		if (patch.ordinaryImportCounts) {
			envelope.state.ordinaryImportCounts = patch.ordinaryImportCounts;
		}
		await ctx.db.patch(envelope.state._id, { ...patch, revision });
		return;
	}
	envelope.staging.rowCount = patch.rowCount;
	envelope.staging.byteLength = patch.byteLength;
	if (patch.ordinaryImportCounts) {
		envelope.staging.ordinaryImportCounts = patch.ordinaryImportCounts;
	}
	await ctx.db.patch(envelope.staging._id, patch);
}

/** Replace one digest row while keeping its generation envelope exact. */
async function upsertNavigationRow(
	ctx: MutationCtx,
	input: {
		envelope: NavigationEnvelope;
		digest: CatalogWorkspaceNavigationDigest;
	},
): Promise<boolean> {
	const existing = await navigationRowFor(
		ctx,
		input.digest.projectId,
		envelopeProjectionId(input.envelope),
		input.digest.messageId,
	);
	if (!input.digest.firstSeenProjectionId) {
		input.digest.firstSeenProjectionId =
			existing?.firstSeenProjectionId ??
			(
				await ctx.db
					.query("catalogMessageOrigins")
					.withIndex("by_project_and_messageId", (q) =>
						q
							.eq("projectId", input.digest.projectId)
							.eq("messageId", input.digest.messageId),
					)
					.unique()
			)?.firstSeenProjectionId;
		if (!input.digest.firstSeenProjectionId)
			delete input.digest.firstSeenProjectionId;
	}
	const nextByteLength = navigationDigestByteLength(input.digest);
	if (nextByteLength > 512 * 1024)
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Navigation digest exceeds the 512 KiB document budget.",
		});
	const rowCount =
		input.envelope.kind === "active"
			? input.envelope.state.rowCount
			: input.envelope.staging.rowCount;
	const byteLength =
		input.envelope.kind === "active"
			? input.envelope.state.byteLength
			: input.envelope.staging.byteLength;
	if (existing && navigationRowMatchesDigest(existing, input.digest)) {
		return false;
	}
	const storedExistingCounts =
		input.envelope.kind === "active"
			? input.envelope.state.ordinaryImportCounts
			: input.envelope.staging.ordinaryImportCounts;
	const existingCounts = storedExistingCounts
		? normalizedOrdinaryImportCounts(storedExistingCounts)
		: undefined;
	let nextOrdinaryImportCounts = existingCounts;
	if (existingCounts) {
		if (existing) {
			nextOrdinaryImportCounts = combineOrdinaryImportCounts(
				combineOrdinaryImportCounts(
					existingCounts,
					ordinaryImportCountsForDigest(navigationRowToDigest(existing)),
					-1,
				),
				ordinaryImportCountsForDigest(input.digest),
				1,
			);
		} else {
			nextOrdinaryImportCounts = combineOrdinaryImportCounts(
				existingCounts,
				ordinaryImportCountsForDigest(input.digest),
				1,
			);
		}
	}
	if (existing) {
		const replacedByteLength =
			byteLength -
			navigationDigestByteLength(navigationRowToDigest(existing)) +
			nextByteLength;
		if (replacedByteLength > MAX_CATALOG_WORKSPACE_NAVIGATION_BYTES) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"Catalog Workspace exceeds its supported Navigation Index envelope.",
			});
		}
		await ctx.db.delete(existing._id);
		await ctx.db.insert("catalogWorkspaceNavigationRows", input.digest);
		await patchEnvelopeCounts(ctx, input.envelope, {
			rowCount,
			byteLength: replacedByteLength,
			ordinaryImportCounts: nextOrdinaryImportCounts,
		});
		return true;
	}
	const nextRowCount = rowCount + 1;
	const nextTotalByteLength = byteLength + nextByteLength;
	if (
		nextRowCount > MAX_CATALOG_WORKSPACE_NAVIGATION_ROWS ||
		nextTotalByteLength > MAX_CATALOG_WORKSPACE_NAVIGATION_BYTES
	) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message:
				"Catalog Workspace exceeds its supported Navigation Index envelope.",
		});
	}
	await ctx.db.insert("catalogWorkspaceNavigationRows", input.digest);
	await patchEnvelopeCounts(ctx, input.envelope, {
		rowCount: nextRowCount,
		byteLength: nextTotalByteLength,
		ordinaryImportCounts: nextOrdinaryImportCounts,
	});
	return true;
}

/** Stamp derived provenance without changing values, review state, or envelope accounting. */
export async function stampNavigationOrigin(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		messageId: string;
		originProjectionId: Id<"catalogProjections">;
		accountRead?: (value: unknown) => void;
	},
) {
	const state = await navigationStateFor(ctx, input.projectId);
	if (
		!state ||
		state.projectionId !== input.projectionId ||
		state.status !== "ready"
	)
		return;
	const row = await navigationRowFor(
		ctx,
		input.projectId,
		input.projectionId,
		input.messageId,
	);
	input.accountRead?.(row);
	if (!row || row.firstSeenProjectionId === input.originProjectionId) return;
	if (row.firstSeenProjectionId)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Conflicting snapshot introduction evidence.",
		});
	// The upsert point-reads the same row to maintain its envelope.
	input.accountRead?.(row);
	await upsertNavigationRow(ctx, {
		envelope: { kind: "active", state },
		digest: {
			...navigationRowToDigest(row),
			firstSeenProjectionId: input.originProjectionId,
		},
	});
}

async function removeNavigationRow(
	ctx: MutationCtx,
	input: {
		envelope: NavigationEnvelope;
		existing: Doc<"catalogWorkspaceNavigationRows">;
	},
): Promise<void> {
	if (input.existing.projectionId !== envelopeProjectionId(input.envelope)) {
		await ctx.db.delete(input.existing._id);
		return;
	}
	const rowCount =
		input.envelope.kind === "active"
			? input.envelope.state.rowCount
			: input.envelope.staging.rowCount;
	const byteLength =
		input.envelope.kind === "active"
			? input.envelope.state.byteLength
			: input.envelope.staging.byteLength;
	const nextRowCount = rowCount - 1;
	const nextByteLength =
		byteLength -
		navigationDigestByteLength(navigationRowToDigest(input.existing));
	if (nextRowCount < 0 || nextByteLength < 0) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace Navigation Index envelope went negative.",
		});
	}
	const storedOrdinaryImportCounts =
		input.envelope.kind === "active"
			? input.envelope.state.ordinaryImportCounts
			: input.envelope.staging.ordinaryImportCounts;
	const ordinaryImportCounts = storedOrdinaryImportCounts
		? normalizedOrdinaryImportCounts(storedOrdinaryImportCounts)
		: undefined;
	const nextOrdinaryImportCounts = ordinaryImportCounts
		? combineOrdinaryImportCounts(
				ordinaryImportCounts,
				ordinaryImportCountsForDigest(navigationRowToDigest(input.existing)),
				-1,
			)
		: undefined;
	await ctx.db.delete(input.existing._id);
	await patchEnvelopeCounts(ctx, input.envelope, {
		rowCount: nextRowCount,
		byteLength: nextByteLength,
		ordinaryImportCounts: nextOrdinaryImportCounts,
	});
}

/** Read only the identities needed by current cards and First Review. Review
 * history can grow without making every navigation rebuild scan that history. */
async function decisionRecordsForNavigationRows(
	ctx: MutationCtx | QueryCtx,
	input: {
		projectId: Id<"projects">;
		rows: readonly Doc<"catalogProjectionMessages">[];
		visibleRows: readonly Doc<"catalogProjectionMessages">[];
	},
) {
	// Most keys can remain unreviewed while a few accumulate history. Probe
	// each requested key once before issuing Source/value identity lookups.
	const messageIds = [
		...new Set(
			input.rows.filter((row) => !row.isSource).map((row) => row.messageId),
		),
	];
	const historyMessages = new Set(
		(
			await Promise.all(
				messageIds.map(async (messageId) => {
					const first = await ctx.db
						.query("catalogWorkspaceDecisionRecords")
						.withIndex("by_value_identity", (q) =>
							q.eq("projectId", input.projectId).eq("messageId", messageId),
						)
						.first();
					return first ? messageId : null;
				}),
			)
		).filter((messageId): messageId is string => messageId !== null),
	);
	if (historyMessages.size === 0) return [];
	const sourceByMessage = new Map(
		input.rows.filter((row) => row.isSource).map((row) => [row.messageId, row]),
	);
	const visibleByIdentity = new Map(
		input.visibleRows.map((row) => [valueIdentity(row), row]),
	);
	const effectiveSource = new Map(
		input.visibleRows
			.filter((row) => row.isSource)
			.map((row) => [row.messageId, row]),
	);
	const records: Doc<"catalogWorkspaceDecisionRecords">[] = [];
	for (const target of input.rows) {
		if (target.isSource || !historyMessages.has(target.messageId)) continue;
		const source = sourceByMessage.get(target.messageId);
		const currentSource = effectiveSource.get(target.messageId);
		const current = visibleByIdentity.get(valueIdentity(target));
		if (!source || !currentSource || !current)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Navigation decision lookup lost its Source or target.",
			});
		const identity = {
			projectId: input.projectId,
			messageId: target.messageId,
			localeId: target.localeId,
		};
		const fingerprints = new Set([
			target.valueFingerprint ?? (await sha256Hex(target.value)),
			current.valueFingerprint ?? (await sha256Hex(current.value)),
		]);
		const sources = new Set([
			source.sourceFingerprint,
			currentSource.sourceFingerprint,
		]);
		for (const valueFingerprint of fingerprints) {
			for (const sourceFingerprint of sources) {
				const record = await decisionForIdentity(
					ctx,
					{ ...identity, valueFingerprint, sourceFingerprint },
					target.projectionId,
				);
				if (record) records.push(record);
			}
			const latest = await latestDecisionForValue(ctx, {
				...identity,
				valueFingerprint,
			});
			if (latest) records.push(latest);
		}
		const introducedAt = source.introducedAt;
		if (
			introducedAt !== undefined &&
			source.introductionLocaleIds?.includes(target.localeId)
		) {
			for (const actor of ["user", "agent"] as const) {
				const history = ctx.db
					.query("catalogWorkspaceDecisionRecords")
					.withIndex(
						"by_project_and_messageId_and_localeId_and_actor_and_recordedAt",
						(q) =>
							q
								.eq("projectId", input.projectId)
								.eq("messageId", target.messageId)
								.eq("localeId", target.localeId)
								.eq("recordedBy.kind", actor)
								.gte("recordedAt", introducedAt),
					)
					.order("desc");
				let scanned = 0;
				for await (const record of history) {
					if (++scanned > 64)
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message:
								"Private First Review attempts exceed their lookup envelope.",
						});
					const [visible] = await visibleDecisionRecords(
						ctx,
						[record],
						target.projectionId,
					);
					if (
						visible &&
						isHumanOrAuthorizedReview(
							visible.recordedBy,
							visible.reviewAuthorization,
						)
					) {
						records.push(visible);
						break;
					}
				}
			}
		}
	}
	return await visibleDecisionRecords(
		ctx,
		records,
		input.rows[0]?.projectionId,
	);
}

async function repeatedValueIdentitiesForRows(
	ctx: MutationCtx,
	projectionId: Id<"catalogProjections">,
	rows: readonly Doc<"catalogProjectionMessages">[],
): Promise<Set<string>> {
	const identities = await Promise.all(
		rows
			.filter(
				(row) =>
					!row.isSource &&
					row.gitValueFingerprint !== undefined &&
					row.repeatedGitContentVersion !== 2,
			)
			.map(async (row) => {
				if (row.valueFingerprint === undefined) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"A Navigation backfill requires visible value fingerprints on every target.",
					});
				}
				const matches = await ctx.db
					.query("catalogProjectionMessages")
					.withIndex("by_projection_and_localeId_and_valueFingerprint", (q) =>
						q
							.eq("projectionId", projectionId)
							.eq("localeId", row.localeId)
							.eq("valueFingerprint", row.valueFingerprint),
					)
					.take(2);
				return matches.length > 1 ? valueIdentity(row) : null;
			}),
	);
	return new Set(
		identities.filter((identity): identity is string => identity !== null),
	);
}

async function deriveDigestForMessage(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		messageId: string;
		rows?: Doc<"catalogProjectionMessages">[];
		heads?: Doc<"catalogWorkspaceValueHeads">[];
	},
): Promise<CatalogWorkspaceNavigationDigest | null> {
	const rows =
		input.rows ??
		(await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId", (q) =>
				q
					.eq("projectionId", input.projectionId)
					.eq("messageId", input.messageId),
			)
			.take(MAX_PROJECTED_LOCALES + 1));
	if (rows.length > MAX_PROJECTED_LOCALES) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace found too many Locale rows for one key.",
		});
	}
	if (rows.length === 0) return null;
	const [heads, proposalHead] = await Promise.all([
		input.heads ?? workspaceHeadsForRows(ctx, input.projectId, rows),
		ctx.db
			.query("catalogWorkspaceSourceProposalHeads")
			.withIndex("by_project_and_messageId", (q) =>
				q.eq("projectId", input.projectId).eq("messageId", input.messageId),
			)
			.unique(),
	]);
	if (heads.length > MAX_PROJECTED_LOCALES) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog Workspace found too many value heads for one key.",
		});
	}
	if (encodedSize(rows) + encodedSize(heads) > 6 * 1024 * 1024) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"A key's catalog and working values exceed the 6 MiB processing budget.",
		});
	}
	const sourceProposalResolution = proposalHead
		? await publishedResolutionFor(ctx, {
				_id: proposalHead.proposalId,
				projectId: input.projectId,
				messageId: input.messageId,
			})
		: null;
	const [decisions, repeatedValueIdentities] = await Promise.all([
		decisionRecordsForNavigationRows(ctx, {
			projectId: input.projectId,
			rows,
			visibleRows: currentWorkspaceRows(
				currentSourceProposalRows(
					rows,
					proposalHead
						? new Map([[proposalHead.messageId, proposalHead]])
						: new Map(),
					proposalHead && sourceProposalResolution
						? new Map([[proposalHead.proposalId, sourceProposalResolution]])
						: new Map(),
				),
				new Map(heads.map((head) => [valueIdentity(head), head])),
			),
		}),
		repeatedValueIdentitiesForRows(ctx, input.projectionId, rows),
	]);
	return await deriveNavigationDigest({
		compactSearchCorpus: true,
		projectId: input.projectId,
		projectionId: input.projectionId,
		rows,
		heads,
		decisions,
		repeatedValueIdentities,
		sourceProposalHead: proposalHead,
		sourceProposalResolution,
	});
}

async function recomputeNavigationRowForMessage(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		envelope: NavigationEnvelope;
		projection: Doc<"catalogProjections">;
		messageId: string;
	},
): Promise<void> {
	const existing = await navigationRowFor(
		ctx,
		input.projectId,
		envelopeProjectionId(input.envelope),
		input.messageId,
	);
	const digest = await deriveDigestForMessage(ctx, {
		projectId: input.projectId,
		projectionId: input.projection._id,
		messageId: input.messageId,
	});
	if (!digest) {
		if (existing) {
			await removeNavigationRow(ctx, { envelope: input.envelope, existing });
		}
		return;
	}
	await upsertNavigationRow(ctx, { envelope: input.envelope, digest });
}

/** Recompute the Navigation digests of the given keys from canonical
 * evidence inside the caller's transaction. Writers call this with the keys
 * they touched so the index advances atomically with the canonical write. */
export async function recomputeNavigationRows(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		messageIds: readonly string[];
	},
): Promise<void> {
	if (input.messageIds.length === 0) return;
	const projection = await activeProjectionFor(ctx, input.projectId);
	if (!projection) return;
	let state = await navigationStateFor(ctx, input.projectId);
	if (state === null) {
		await ctx.db.insert("catalogWorkspaceNavigationStates", {
			projectId: input.projectId,
			projectionId: projection._id,
			revision: 0,
			rowCount: 0,
			byteLength: 0,
			status: "staging",
			expectedRowCount: projection.expectedKeyCount,
			ordinaryImportCounts: emptyOrdinaryImportCounts(),
			ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
		});
		const created = await navigationStateFor(ctx, input.projectId);
		if (!created) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Catalog Workspace Navigation Index is missing its project envelope.",
			});
		}
		state = created;
	} else if (state.projectionId !== projection._id) {
		// The Baseline advanced outside staged publication (a safety net for
		// direct projector runs): rows of the earlier projection are garbage
		// that the reset worker reclaims, and the envelope restarts incomplete
		// for the active projection until a backfill verifies it.
		await ctx.scheduler.runAfter(
			0,
			internal.catalogWorkspaceNavigation.resetNavigationIndex,
			{ projectId: input.projectId, projectionId: state.projectionId },
		);
		await ctx.db.delete(state._id);
		await ctx.db.insert("catalogWorkspaceNavigationStates", {
			projectId: input.projectId,
			projectionId: projection._id,
			revision: 0,
			rowCount: 0,
			byteLength: 0,
			status: "staging",
			expectedRowCount: projection.expectedKeyCount,
			ordinaryImportCounts: emptyOrdinaryImportCounts(),
			ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
		});
		state = (await navigationStateFor(ctx, input.projectId)) ?? state;
	}
	const envelope: NavigationEnvelope = { kind: "active", state };
	for (const messageId of input.messageIds) {
		await recomputeNavigationRowForMessage(ctx, {
			projectId: input.projectId,
			envelope,
			projection,
			messageId,
		});
	}
}

export const recomputeNavigationRowsMutation = internalMutation({
	args: {
		projectId: v.id("projects"),
		messageIds: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await recomputeNavigationRows(ctx, args);
		return null;
	},
});

export const resetNavigationIndex = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await navigationStateFor(ctx, args.projectId);
		if (state && state.projectionId === args.projectionId) {
			// The envelope still counts these rows; a reset that targeted the
			// active generation must never reclaim them.
			return null;
		}
		const rows = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q.eq("projectId", args.projectId).eq("projectionId", args.projectionId),
			)
			.take(MAX_NAVIGATION_RESET_ROWS_PER_MUTATION + 1);
		for (const row of rows.slice(0, MAX_NAVIGATION_RESET_ROWS_PER_MUTATION)) {
			await ctx.db.delete(row._id);
		}
		if (rows.length > MAX_NAVIGATION_RESET_ROWS_PER_MUTATION) {
			await ctx.scheduler.runAfter(
				0,
				internal.catalogWorkspaceNavigation.resetNavigationIndex,
				args,
			);
		}
		return null;
	},
});

/** One staging step derives and upserts a bounded Catalog Order range of
 * keys for a not-yet-visible projection. The ingest action drives steps to
 * completion before it is allowed to publish, so a generation never becomes
 * visible with a partial Navigation Index. */
export const stageNavigationIndexStep = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
	},
	returns: v.object({
		status: v.union(v.literal("staging"), v.literal("ready")),
		stagedKeys: v.number(),
	}),
	handler: async (ctx, args) => {
		const projection = await ctx.db.get(args.projectionId);
		if (!projection || projection.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Navigation staging needs its Catalog Projection.",
			});
		}
		let staging = await navigationStagingFor(ctx, args.projectionId);
		if (!staging) {
			await ctx.db.insert("catalogWorkspaceNavigationStaging", {
				projectId: args.projectId,
				projectionId: args.projectionId,
				status: "staging",
				lastCatalogIndex: -1,
				rowCount: 0,
				byteLength: 0,
				expectedRowCount: projection.expectedKeyCount,
				ordinaryImportCounts: emptyOrdinaryImportCounts(),
			});
			staging = await navigationStagingFor(ctx, args.projectionId);
			if (!staging) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Navigation staging is missing its envelope.",
				});
			}
		}
		if (staging.status === "ready") {
			return { status: "ready" as const, stagedKeys: 0 };
		}
		const envelope: NavigationEnvelope = { kind: "staging", staging };
		const batch = await navigationKeyBatchForProjection(ctx, {
			projectId: args.projectId,
			projectionId: args.projectionId,
			afterCatalogIndex: staging.lastCatalogIndex,
			maxKeys: MAX_NAVIGATION_KEYS_PER_STAGE_STEP,
		});
		for (const messageId of batch.messageIds) {
			const rows = batch.rows.filter((row) => row.messageId === messageId);
			const digest = await deriveDigestForMessage(ctx, {
				projectId: args.projectId,
				projectionId: args.projectionId,
				messageId,
				rows,
				heads: batch.heads.filter((head) => head.messageId === messageId),
			});
			if (!digest) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Navigation staging batch lost its Catalog rows.",
				});
			}
			await upsertNavigationRow(ctx, { envelope, digest });
		}
		const counts = envelope.staging;
		if (
			!batch.moreRemaining &&
			counts.rowCount !== projection.expectedKeyCount
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Navigation staging did not cover every Catalog key.",
			});
		}
		const status = batch.moreRemaining
			? ("staging" as const)
			: ("ready" as const);
		await ctx.db.patch(staging._id, {
			lastCatalogIndex: batch.lastCatalogIndex,
			status,
			...(status === "ready"
				? {
						expectedRowCount: projection.expectedKeyCount,
						expectedByteLength: counts.byteLength,
					}
				: {}),
		});
		return { status, stagedKeys: batch.messageIds.length };
	},
});

const navigationBackfillStatusValidator = v.object({
	projectionId: v.id("catalogProjections"),
	status: v.union(
		v.literal("missing"),
		v.literal("staging"),
		v.literal("verifying"),
		v.literal("ready"),
		v.literal("failed"),
	),
	rowCount: v.number(),
	byteLength: v.number(),
	expectedRowCount: v.union(v.number(), v.null()),
	expectedByteLength: v.union(v.number(), v.null()),
	ordinaryImportCounts: v.union(
		v.object(ordinaryImportCountsValidatorFields),
		v.null(),
	),
	stepPending: v.boolean(),
	forceRebuild: v.boolean(),
	failure: v.union(
		v.object({
			code: v.optional(v.string()),
			message: v.string(),
			failedAt: v.number(),
		}),
		v.null(),
	),
});

type NavigationBackfillStatus = {
	projectionId: Id<"catalogProjections">;
	status: "missing" | "staging" | "verifying" | "ready" | "failed";
	rowCount: number;
	byteLength: number;
	expectedRowCount: number | null;
	expectedByteLength: number | null;
	ordinaryImportCounts: OrdinaryImportConfirmationCounts | null;
	stepPending: boolean;
	forceRebuild: boolean;
	failure: {
		code?: string;
		message: string;
		failedAt: number;
	} | null;
};

type PublicNavigationTargetDigest = Omit<
	CatalogWorkspaceNavigationTargetDigest,
	"valueFingerprint"
>;

type PublicNavigationDigest = Omit<
	CatalogWorkspaceNavigationDigest,
	"projectId" | "projectionId" | "targets"
> & {
	targets: PublicNavigationTargetDigest[];
};

async function navigationBackfillStatusFor(
	ctx: MutationCtx | QueryCtx,
	projectId: Id<"projects">,
): Promise<NavigationBackfillStatus | null> {
	const projection = await activeProjectionFor(ctx, projectId);
	if (!projection) return null;
	const state = await navigationStateFor(ctx, projectId);
	if (!state || state.projectionId !== projection._id) {
		return {
			projectionId: projection._id,
			status: "missing",
			rowCount: 0,
			byteLength: 0,
			expectedRowCount: null,
			expectedByteLength: null,
			ordinaryImportCounts: null,
			stepPending: false,
			forceRebuild: false,
			failure: null,
		};
	}
	return {
		projectionId: state.projectionId,
		status: state.status ?? "staging",
		rowCount: state.rowCount,
		byteLength: state.byteLength,
		expectedRowCount: state.expectedRowCount ?? null,
		expectedByteLength: state.expectedByteLength ?? null,
		ordinaryImportCounts: state.ordinaryImportCounts
			? normalizedOrdinaryImportCounts(state.ordinaryImportCounts)
			: null,
		stepPending: backfillStepIsPending(state),
		forceRebuild: state.backfillForceRebuild ?? false,
		failure: state.backfillFailure ?? null,
	};
}

function backfillFailureFor(error: unknown) {
	const data =
		error instanceof ConvexError &&
		typeof error.data === "object" &&
		error.data !== null
			? error.data
			: null;
	const code =
		data && "code" in data && typeof data.code === "string"
			? data.code
			: undefined;
	return {
		...(code === undefined ? {} : { code }),
		message:
			error instanceof Error ? error.message : "Navigation backfill failed.",
		failedAt: now(),
	};
}

/** A human explicitly starts a resumable repair for the active Navigation
 * generation. The worker may continue in bounded scheduled steps, but it is
 * never created by the server without this command. Legacy states are rebuilt
 * from an empty envelope so additive ordinary-import counts stay exact. */
export const startNavigationIndexBackfill = mutation({
	args: { projectId: v.id("projects") },
	returns: navigationBackfillStatusValidator,
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Navigation backfill needs an active Baseline Catalog.",
			});
		}
		let state = await navigationStateFor(ctx, args.projectId);
		if (!state || state.projectionId !== projection._id) {
			if (state) {
				await ctx.scheduler.runAfter(
					0,
					internal.catalogWorkspaceNavigation.resetNavigationIndex,
					{
						projectId: args.projectId,
						projectionId: state.projectionId,
					},
				);
				await ctx.db.delete(state._id);
			}
			await ctx.db.insert("catalogWorkspaceNavigationStates", {
				projectId: args.projectId,
				projectionId: projection._id,
				revision: 0,
				rowCount: 0,
				byteLength: 0,
				status: "staging",
				expectedRowCount: projection.expectedKeyCount,
				ordinaryImportCounts: emptyOrdinaryImportCounts(),
				ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
				backfillForceRebuild: true,
				backfillFailure: undefined,
			});
			state = await navigationStateFor(ctx, args.projectId);
			if (!state) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Navigation backfill is missing its project envelope.",
				});
			}
		} else if (
			state.ordinaryImportCounts === undefined ||
			state.ordinaryImportPolicyVersion !== ORDINARY_IMPORT_POLICY_VERSION
		) {
			// A state from before materialized ordinary-import counts cannot be
			// repaired by replacing rows in place: its envelope has no trustworthy
			// additive baseline. Clear the generation first, then refill it.
			await ctx.db.patch(state._id, {
				rowCount: 0,
				byteLength: 0,
				status: "staging",
				expectedRowCount: projection.expectedKeyCount,
				expectedByteLength: undefined,
				ordinaryImportCounts: emptyOrdinaryImportCounts(),
				ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
				backfillLastCatalogIndex: -1,
				verificationLastCatalogIndex: undefined,
				verifiedRowCount: undefined,
				verifiedByteLength: undefined,
				backfillForceRebuild: true,
				backfillFailure: undefined,
			});
			state = (await navigationStateFor(ctx, args.projectId)) ?? state;
		} else if (state.status === "ready") {
			await ctx.db.patch(state._id, {
				status: "staging",
				backfillLastCatalogIndex: -1,
				expectedByteLength: undefined,
				verificationLastCatalogIndex: undefined,
				verifiedRowCount: undefined,
				verifiedByteLength: undefined,
				backfillForceRebuild: undefined,
				backfillFailure: undefined,
			});
			state = (await navigationStateFor(ctx, args.projectId)) ?? state;
		} else if (state.status === "failed") {
			// An explicit retry resumes from the last durable cursor. The failed
			// transaction rolled back atomically, so no partially applied step needs
			// special repair; the command only clears the terminal diagnostic and
			// re-arms the worker below.
			await ctx.db.patch(state._id, {
				status: "staging",
				backfillFailure: undefined,
			});
			state = (await navigationStateFor(ctx, args.projectId)) ?? state;
		}
		if (!backfillStepIsPending(state)) {
			await ctx.db.patch(state._id, pendingBackfillStepPatch());
			await ctx.scheduler.runAfter(
				0,
				internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
				{ projectId: args.projectId },
			);
		}
		const result = await navigationBackfillStatusFor(ctx, args.projectId);
		if (!result) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Navigation backfill lost its active Baseline.",
			});
		}
		return result;
	},
});

export const navigationIndexBackfillStatus = query({
	args: { projectId: v.id("projects") },
	returns: v.union(v.null(), navigationBackfillStatusValidator),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		return navigationBackfillStatusFor(ctx, args.projectId);
	},
});

/** One backfill step fills or verifies the active generation's index in
 * bounded, resumable Catalog Order passes. Steps are idempotent: each key is
 * re-derived and upserted, so a racing writer either wins by landing its own
 * recompute first or is overwritten with an equal digest. Verification
 * recounts the stored rows and fails closed on any envelope drift. */
export const backfillNavigationIndexStep = internalMutation({
	args: { projectId: v.id("projects") },
	returns: v.object({
		phase: v.union(
			v.literal("clearing"),
			v.literal("filling"),
			v.literal("verifying"),
			v.literal("drift"),
			v.literal("ready"),
			v.literal("failed"),
		),
	}),
	handler: async (ctx, args) => {
		try {
			const projection = await activeProjectionFor(ctx, args.projectId);
			if (!projection) {
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Navigation backfill needs an active Baseline Catalog.",
				});
			}
			let state = await navigationStateFor(ctx, args.projectId);
			if (!state || state.projectionId !== projection._id) {
				if (state) {
					await ctx.scheduler.runAfter(
						0,
						internal.catalogWorkspaceNavigation.resetNavigationIndex,
						{
							projectId: args.projectId,
							projectionId: state.projectionId,
						},
					);
					await ctx.db.delete(state._id);
				}
				await ctx.db.insert("catalogWorkspaceNavigationStates", {
					projectId: args.projectId,
					projectionId: projection._id,
					revision: 0,
					rowCount: 0,
					byteLength: 0,
					status: "staging",
					expectedRowCount: projection.expectedKeyCount,
					ordinaryImportCounts: emptyOrdinaryImportCounts(),
					ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
					backfillForceRebuild: true,
				});
				state = await navigationStateFor(ctx, args.projectId);
				if (!state) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Navigation backfill is missing its project envelope.",
					});
				}
			}
			if (state.status === "failed") {
				return { phase: "failed" as const };
			}
			if (state.backfillStepPending) {
				await ctx.db.patch(state._id, IDLE_BACKFILL_STEP_PATCH);
			}
			if (state.backfillForceRebuild) {
				const rowsToClear = await ctx.db
					.query("catalogWorkspaceNavigationRows")
					.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
						q
							.eq("projectId", args.projectId)
							.eq("projectionId", projection._id),
					)
					.take(MAX_NAVIGATION_RESET_ROWS_PER_MUTATION + 1);
				for (const row of rowsToClear.slice(
					0,
					MAX_NAVIGATION_RESET_ROWS_PER_MUTATION,
				)) {
					await ctx.db.delete(row._id);
				}
				if (rowsToClear.length > 0) {
					const clearedGeneration =
						rowsToClear.length <= MAX_NAVIGATION_RESET_ROWS_PER_MUTATION;
					await ctx.db.patch(state._id, {
						...pendingBackfillStepPatch(),
						...(clearedGeneration
							? {
									rowCount: 0,
									byteLength: 0,
									ordinaryImportCounts: emptyOrdinaryImportCounts(),
									backfillLastCatalogIndex: -1,
									backfillForceRebuild: undefined,
								}
							: {}),
					});
					await ctx.scheduler.runAfter(
						0,
						internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
						{ projectId: args.projectId },
					);
					return { phase: "clearing" as const };
				}
				// Empty legacy generations can advance directly to filling. A non-empty
				// generation always yields above, keeping deletion and derivation in
				// separate transactions with predictable system-operation budgets.
				await ctx.db.patch(state._id, {
					rowCount: 0,
					byteLength: 0,
					ordinaryImportCounts: emptyOrdinaryImportCounts(),
					backfillLastCatalogIndex: -1,
					backfillForceRebuild: undefined,
				});
				state = (await navigationStateFor(ctx, args.projectId)) ?? state;
			}
			if (state.status !== "ready" && state.status !== "verifying") {
				const envelope: NavigationEnvelope = { kind: "active", state };
				const batch = await navigationKeyBatchForProjection(ctx, {
					projectId: args.projectId,
					projectionId: projection._id,
					afterCatalogIndex: state.backfillLastCatalogIndex ?? -1,
					maxKeys: MAX_NAVIGATION_KEYS_PER_STAGE_STEP,
				});
				for (const messageId of batch.messageIds) {
					const rows = batch.rows.filter((row) => row.messageId === messageId);
					const digest = await deriveDigestForMessage(ctx, {
						projectId: args.projectId,
						projectionId: projection._id,
						messageId,
						rows,
						heads: batch.heads.filter((head) => head.messageId === messageId),
					});
					if (!digest) {
						throw new ConvexError({
							code: "INTEGRITY",
							message: "A Navigation backfill batch lost its Catalog rows.",
						});
					}
					await upsertNavigationRow(ctx, { envelope, digest });
				}
				const done = !batch.moreRemaining;
				await ctx.db.patch(state._id, {
					backfillLastCatalogIndex: batch.lastCatalogIndex,
					...pendingBackfillStepPatch(),
					...(done
						? {
								status: "verifying" as const,
								expectedRowCount: projection.expectedKeyCount,
								expectedByteLength: envelope.state.byteLength,
							}
						: {}),
				});
				await ctx.scheduler.runAfter(
					0,
					internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
					{ projectId: args.projectId },
				);
				return { phase: done ? ("verifying" as const) : ("filling" as const) };
			}
			const after = state.verificationLastCatalogIndex ?? -1;
			const rows = await ctx.db
				.query("catalogWorkspaceNavigationRows")
				.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
					q
						.eq("projectId", args.projectId)
						.eq("projectionId", projection._id)
						.gt("catalogIndex", after),
				)
				.take(MAX_NAVIGATION_VERIFY_ROWS_PER_MUTATION + 1);
			const page = rows.slice(0, MAX_NAVIGATION_VERIFY_ROWS_PER_MUTATION);
			let pageBytes = 0;
			for (const row of page) {
				pageBytes += navigationDigestByteLength(navigationRowToDigest(row));
			}
			const verifiedRowCount = (state.verifiedRowCount ?? 0) + page.length;
			const verifiedByteLength = (state.verifiedByteLength ?? 0) + pageBytes;
			const done = rows.length <= MAX_NAVIGATION_VERIFY_ROWS_PER_MUTATION;
			const lastCatalogIndex =
				page.length > 0
					? (page[page.length - 1]?.catalogIndex ?? after)
					: after;
			await ctx.db.patch(state._id, {
				verificationLastCatalogIndex: lastCatalogIndex,
				verifiedRowCount,
				verifiedByteLength,
			});
			if (!done) {
				await ctx.db.patch(state._id, pendingBackfillStepPatch());
				await ctx.scheduler.runAfter(
					0,
					internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
					{ projectId: args.projectId },
				);
				return { phase: "verifying" as const };
			}
			if (
				verifiedRowCount !== state.rowCount ||
				verifiedByteLength !== state.byteLength ||
				state.expectedRowCount === undefined ||
				state.expectedByteLength === undefined ||
				verifiedRowCount !== state.expectedRowCount ||
				verifiedByteLength !== state.expectedByteLength
			) {
				// Fail closed: drop the completeness claim and all progress so the
				// next run re-derives every key. Re-seed the envelope with the just
				// recounted stored-row totals, so the re-fill's replace accounting
				// starts from the bytes the rows actually occupy. The reset must
				// land, so this reports drift rather than throwing inside the same
				// transaction.
				await ctx.db.replace(state._id, {
					projectId: state.projectId,
					projectionId: state.projectionId,
					rowCount: 0,
					byteLength: 0,
					status: "staging",
					expectedRowCount: projection.expectedKeyCount,
					ordinaryImportCounts: emptyOrdinaryImportCounts(),
					ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
					backfillForceRebuild: true,
					...pendingBackfillStepPatch(),
				});
				await ctx.scheduler.runAfter(
					0,
					internal.catalogWorkspaceNavigation.backfillNavigationIndexStep,
					{ projectId: args.projectId },
				);
				return { phase: "drift" as const };
			}
			await ctx.db.patch(state._id, {
				status: "ready",
				ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
				verificationLastCatalogIndex: undefined,
				verifiedRowCount: undefined,
				verifiedByteLength: undefined,
				...IDLE_BACKFILL_STEP_PATCH,
			});
			return { phase: "ready" as const };
		} catch (error) {
			const state = await navigationStateFor(ctx, args.projectId);
			if (!state) throw error;
			await ctx.db.patch(state._id, {
				status: "failed",
				...IDLE_BACKFILL_STEP_PATCH,
				backfillFailure: backfillFailureFor(error),
			});
			return { phase: "failed" as const };
		}
	},
});

/** Dry-run summary for the backfill command: what a run would touch and
 * how complete the active generation currently is, without writing. */
export const describeNavigationIndexBackfill = internalQuery({
	args: { projectId: v.id("projects") },
	returns: v.union(
		v.null(),
		v.object({
			projectionId: v.id("catalogProjections"),
			status: v.union(
				v.literal("missing"),
				v.literal("staging"),
				v.literal("verifying"),
				v.literal("ready"),
				v.literal("failed"),
			),
			rowCount: v.number(),
			byteLength: v.number(),
			expectedRowCount: v.union(v.number(), v.null()),
			expectedByteLength: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const status = await navigationBackfillStatusFor(ctx, args.projectId);
		if (!status) return null;
		return {
			projectionId: status.projectionId,
			status: status.status,
			rowCount: status.rowCount,
			byteLength: status.byteLength,
			expectedRowCount: status.expectedRowCount,
			expectedByteLength: status.expectedByteLength,
		};
	},
});

/** The publication gate: a Baseline may only become visible once its
 * generation staged a complete Navigation Index whose envelope matches the
 * projection's declared key count and its own derived byte total. */
export async function assertNavigationIndexStagedForPublication(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
	},
): Promise<void> {
	const staging = await navigationStagingFor(ctx, input.projectionId);
	if (
		!staging ||
		staging.projectId !== input.projectId ||
		staging.status !== "ready" ||
		staging.expectedByteLength === undefined
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Baseline publication requires a complete staged Navigation Index; re-run the ingestion.",
		});
	}
	if (
		staging.rowCount !== staging.expectedRowCount ||
		staging.byteLength !== staging.expectedByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"The staged Navigation Index envelope does not match its declaration.",
		});
	}
}

/** Swap the active Navigation generation to the freshly published
 * projection inside the publication transaction. Source Proposal
 * resolutions become visible with the accepted Baseline, so their keys are
 * refreshed here, and the previous generation's rows are scheduled for
 * reclamation. */
export async function activateNavigationGeneration(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		projectionId: Id<"catalogProjections">;
		previousProjectionId?: Id<"catalogProjections">;
	},
): Promise<void> {
	const staging = await navigationStagingFor(ctx, input.projectionId);
	if (
		!staging ||
		staging.projectId !== input.projectId ||
		staging.status !== "ready" ||
		staging.expectedByteLength === undefined
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Navigation activation needs a complete staged generation.",
		});
	}
	const state = await navigationStateFor(ctx, input.projectId);
	if (state && state.projectionId === input.projectionId) {
		await ctx.db.patch(state._id, {
			revision: (state.revision ?? 0) + 1,
			rowCount: staging.rowCount,
			byteLength: staging.byteLength,
			status: "ready",
			expectedRowCount: staging.expectedRowCount,
			expectedByteLength: staging.expectedByteLength,
			ordinaryImportCounts:
				staging.ordinaryImportCounts ?? emptyOrdinaryImportCounts(),
			ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
			backfillLastCatalogIndex: undefined,
			backfillForceRebuild: undefined,
			backfillStepPending: undefined,
			backfillStepPendingAt: undefined,
			verificationLastCatalogIndex: undefined,
			verifiedRowCount: undefined,
			verifiedByteLength: undefined,
		});
	} else {
		if (state) {
			await ctx.db.delete(state._id);
		}
		await ctx.db.insert("catalogWorkspaceNavigationStates", {
			projectId: input.projectId,
			projectionId: input.projectionId,
			revision: 0,
			rowCount: staging.rowCount,
			byteLength: staging.byteLength,
			status: "ready",
			expectedRowCount: staging.expectedRowCount,
			expectedByteLength: staging.expectedByteLength,
			ordinaryImportCounts:
				staging.ordinaryImportCounts ?? emptyOrdinaryImportCounts(),
			ordinaryImportPolicyVersion: ORDINARY_IMPORT_POLICY_VERSION,
		});
	}
	await ctx.db.delete(staging._id);
	const projection = await ctx.db.get(input.projectionId);
	if (!projection || projection.projectId !== input.projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Navigation activation lost its Catalog Projection.",
		});
	}
	const resolutions = await ctx.db
		.query("restoreProposalResolutionHeads")
		.withIndex("by_projection", (q) => q.eq("projectionId", input.projectionId))
		.take(MAX_WORKING_CATALOG_KEYS + 1);
	if (resolutions.length > MAX_WORKING_CATALOG_KEYS) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Navigation activation found too many restoration resolutions.",
		});
	}
	const messageIds = [...new Set(resolutions.map((head) => head.messageId))];
	if (messageIds.length > 0) {
		const fresh = await navigationStateFor(ctx, input.projectId);
		if (!fresh || fresh.projectionId !== input.projectionId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Navigation activation lost its project envelope.",
			});
		}
		const envelope: NavigationEnvelope = { kind: "active", state: fresh };
		for (const messageId of messageIds) {
			await recomputeNavigationRowForMessage(ctx, {
				projectId: input.projectId,
				envelope,
				projection,
				messageId,
			});
		}
	}
	if (
		input.previousProjectionId &&
		input.previousProjectionId !== input.projectionId
	) {
		await ctx.scheduler.runAfter(
			0,
			internal.catalogWorkspaceNavigation.resetNavigationIndex,
			{
				projectId: input.projectId,
				projectionId: input.previousProjectionId,
			},
		);
	}
}

const navigationTargetDigestValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	valueState: v.union(
		v.literal("waiting"),
		v.literal("unconfirmedImport"),
		v.literal("stale"),
		v.literal("settled"),
	),
	touched: v.boolean(),
	confirmedGitContent: v.boolean(),
	confirmedContentPreviously: v.boolean(),
	firstReviewPending: v.boolean(),
	repeatedGitContent: v.optional(v.boolean()),
	gitValueFingerprint: v.optional(v.string()),
});

const navigationDigestValidator = v.object({
	firstSeenProjectionId: v.optional(v.id("catalogProjections")),
	messageId: v.string(),
	catalogIndex: v.number(),
	searchCorpus: v.array(v.string()),
	pendingSourceProposal: v.boolean(),
	introductionReviewPending: v.number(),
	source: v.object({
		localeId: v.id("locales"),
		gitValueFingerprint: v.string(),
	}),
	targets: v.array(navigationTargetDigestValidator),
});

const navigationValueStateCountsValidator = v.object({
	waiting: v.number(),
	unconfirmedImport: v.number(),
	stale: v.number(),
	settled: v.number(),
});

const navigationOrdinaryImportsValidator = v.object({
	policy: v.literal(ORDINARY_IMPORT_CONFIRMATION_POLICY),
	...ordinaryImportCountsValidatorFields,
	// The current server-owned confirmation run, whatever its outcome. A
	// project that never started one reads null.
	run: v.union(
		v.null(),
		v.object({
			status: v.union(
				v.literal("running"),
				v.literal("done"),
				v.literal("superseded"),
				v.literal("failed"),
			),
			confirmed: v.number(),
			skipped: v.number(),
			failure: v.union(
				v.object({
					code: v.optional(v.string()),
					message: v.string(),
					failedAt: v.number(),
				}),
				v.null(),
			),
		}),
	),
});

/** The public Catalog Workspace Browse Navigation read. Every variant is an
 * explicit, distinguishable result: a project without a Baseline, a
 * Baseline whose Navigation Index is still building, and a ready index that
 * carries exactly one ordered key digest per active key plus the
 * whole-workspace facts derived from those digests alone. The result never
 * carries full values, ARB metadata, decision history, or concurrency
 * tokens. */
export const navigationReadValidator = v.union(
	v.object({ kind: v.literal("noBaseline") }),
	v.object({
		kind: v.literal("incomplete"),
		projectionId: v.id("catalogProjections"),
		repository: v.string(),
		commit: v.string(),
		snapshotId: v.union(v.null(), v.id("sourceSnapshots")),
		canEdit: v.boolean(),
		stepPending: v.boolean(),
		status: v.union(
			v.literal("missing"),
			v.literal("staging"),
			v.literal("verifying"),
			v.literal("ready"),
			v.literal("failed"),
		),
		failure: v.union(
			v.object({
				code: v.optional(v.string()),
				message: v.string(),
				failedAt: v.number(),
			}),
			v.null(),
		),
		progress: v.object({
			rowCount: v.number(),
			expectedRowCount: v.number(),
			byteLength: v.number(),
		}),
	}),
	v.object({
		kind: v.literal("ready"),
		projectionId: v.id("catalogProjections"),
		repository: v.string(),
		commit: v.string(),
		snapshotId: v.union(v.null(), v.id("sourceSnapshots")),
		canEdit: v.boolean(),
		valueStateCounts: navigationValueStateCountsValidator,
		ordinaryImports: navigationOrdinaryImportsValidator,
		envelope: v.object({ rowCount: v.number(), byteLength: v.number() }),
		keys: v.array(navigationDigestValidator),
	}),
);

export type CatalogWorkspaceNavigationRead =
	| {
			kind: "noBaseline";
	  }
	| {
			kind: "incomplete";
			projectionId: Id<"catalogProjections">;
			repository: string;
			commit: string;
			snapshotId: Id<"sourceSnapshots"> | null;
			canEdit: boolean;
			stepPending: boolean;
			status: "missing" | "staging" | "verifying" | "ready" | "failed";
			failure: {
				code?: string;
				message: string;
				failedAt: number;
			} | null;
			progress: {
				rowCount: number;
				expectedRowCount: number;
				byteLength: number;
			};
	  }
	| {
			kind: "ready";
			projectionId: Id<"catalogProjections">;
			repository: string;
			commit: string;
			snapshotId: Id<"sourceSnapshots"> | null;
			canEdit: boolean;
			valueStateCounts: Record<CatalogWorkspaceValueState, number>;
			ordinaryImports: OrdinaryImportConfirmationCounts & {
				policy: typeof ORDINARY_IMPORT_CONFIRMATION_POLICY;
				run: {
					status: "running" | "done" | "superseded" | "failed";
					confirmed: number;
					skipped: number;
					failure: {
						code?: string;
						message: string;
						failedAt: number;
					} | null;
				} | null;
			};
			envelope: { rowCount: number; byteLength: number };
			keys: PublicNavigationDigest[];
	  };

export function navigationReadIdentity(projection: Doc<"catalogProjections">) {
	return {
		projectionId: projection._id,
		repository: projection.repository,
		commit: projection.commit,
		snapshotId: projection.snapshotId ?? null,
	};
}

export const navigation = query({
	args: { projectId: v.id("projects") },
	returns: navigationReadValidator,
	handler: async (ctx, args): Promise<CatalogWorkspaceNavigationRead> => {
		const { member } = await requireViewer(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) return { kind: "noBaseline" };
		const state = await navigationStateFor(ctx, args.projectId);
		if (
			!state ||
			state.projectionId !== projection._id ||
			state.status !== "ready" ||
			state.ordinaryImportCounts === undefined ||
			state.ordinaryImportPolicyVersion !== ORDINARY_IMPORT_POLICY_VERSION
		) {
			const counted =
				state && state.projectionId === projection._id ? state : undefined;
			return {
				kind: "incomplete",
				...navigationReadIdentity(projection),
				canEdit: hasMinimumRole(member.role, "editor"),
				stepPending: counted ? backfillStepIsPending(counted) : false,
				progress: {
					rowCount: counted?.rowCount ?? 0,
					expectedRowCount: projection.expectedKeyCount,
					byteLength: counted?.byteLength ?? 0,
				},
				status: counted?.status ?? "missing",
				failure: counted?.backfillFailure ?? null,
			};
		}
		const rows = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q.eq("projectId", args.projectId).eq("projectionId", projection._id),
			)
			.take(MAX_CATALOG_WORKSPACE_NAVIGATION_ROWS + 1);
		if (rows.length > MAX_CATALOG_WORKSPACE_NAVIGATION_ROWS) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Navigation Index exceeds its row envelope.",
			});
		}
		if (
			rows.length !== state.rowCount ||
			state.rowCount !== projection.expectedKeyCount
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog Navigation Index row count contradicts its envelope.",
			});
		}
		const valueStateCounts: Record<CatalogWorkspaceValueState, number> = {
			waiting: 0,
			unconfirmedImport: 0,
			stale: 0,
			settled: 0,
		};
		let previousCatalogIndex = -1;
		const digestRows: CatalogWorkspaceNavigationDigest[] = [];
		for (const row of rows) {
			if (row.catalogIndex <= previousCatalogIndex) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Catalog Navigation Index rows are out of Catalog Order.",
				});
			}
			previousCatalogIndex = row.catalogIndex;
			digestRows.push(navigationRowToDigest(row));
			for (const target of row.targets) {
				valueStateCounts[target.valueState]++;
			}
		}
		const latestRun = await ctx.db
			.query("ordinaryImportRuns")
			.withIndex("by_project_and_projection", (q) =>
				q.eq("projectId", args.projectId).eq("projectionId", projection._id),
			)
			.order("desc")
			.take(1);
		const run = latestRun[0];
		const ordinaryImportCounts = normalizedOrdinaryImportCounts(
			state.ordinaryImportCounts,
		);
		const result: CatalogWorkspaceNavigationRead = {
			kind: "ready",
			...navigationReadIdentity(projection),
			canEdit: hasMinimumRole(member.role, "editor"),
			valueStateCounts,
			ordinaryImports: {
				...ordinaryImportCounts,
				policy: ORDINARY_IMPORT_CONFIRMATION_POLICY,
				run: run
					? {
							status: run.status,
							confirmed: run.confirmed,
							skipped: run.skipped,
							failure: run.failure ?? null,
						}
					: null,
			},
			envelope: { rowCount: state.rowCount, byteLength: state.byteLength },
			keys: digestRows.map(({ projectId, projectionId, ...digest }) => ({
				...digest,
				targets: digest.targets.map(
					({ valueFingerprint: _valueFingerprint, ...target }) => target,
				),
			})),
		};
		if (encodedSize(result) > MAX_CATALOG_WORKSPACE_NAVIGATION_RETURN_BYTES) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"Catalog Navigation exceeds its measured uncached-open response budget.",
			});
		}
		return result;
	},
});

/** The Catalog Workspace Window is capped at 32 complete keys, so one
 * window read stays inside the documented per-query document and byte
 * budgets even at a Brickit-sized catalog. */
export const MAX_CATALOG_WORKSPACE_WINDOW_KEYS = 32;

/** The public Catalog Workspace Browse Window read: compose the exact
 * existing key cards for one bounded, ordered set of message identifiers
 * using indexed point reads only. The requested order is preserved.
 * Duplicate identifiers, oversized windows, and missing keys are rejected;
 * an expected projection that is no longer active fails with STALE_BASIS so
 * callers can re-read the Navigation read and retry. Identical arguments
 * stay natively cacheable: the read is a pure query with no TTL or
 * application cache. */
export const window = query({
	args: {
		projectId: v.id("projects"),
		expectedProjectionId: v.id("catalogProjections"),
		messageIds: v.array(v.string()),
		localeIds: v.optional(v.array(v.id("locales"))),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		if (args.messageIds.length > MAX_CATALOG_WORKSPACE_WINDOW_KEYS) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: "A Catalog Workspace window is capped at 32 keys.",
			});
		}
		const seen = new Set<string>();
		for (const messageId of args.messageIds) {
			if (seen.has(messageId)) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "A Catalog Workspace window repeats a message identifier.",
				});
			}
			seen.add(messageId);
		}
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection || projection._id !== args.expectedProjectionId) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The expected Catalog Projection is no longer the active Baseline.",
			});
		}
		const project = await ctx.db.get(args.projectId);
		const sourceLocaleId = project?.sourceLocaleId;
		if (!sourceLocaleId)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Project Source is missing.",
			});
		if (
			args.localeIds &&
			(args.localeIds.length > 4 ||
				new Set(args.localeIds).size !== args.localeIds.length)
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "A window can compare up to four target languages.",
			});
		for (const localeId of args.localeIds ?? []) {
			const locale = await ctx.db.get(localeId);
			if (
				!locale ||
				locale.projectId !== args.projectId ||
				locale.isSource ||
				locale.archivedAt !== undefined ||
				!locale.catalogPath
			) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Choose active bound target languages for a window.",
				});
			}
		}
		// Point-read every requested key's rows; nothing scans the project.
		// Whole storage envelopes are larger than one interactive read. Stop while
		// enough transaction headroom remains for the last complete key and decisions.
		const readLimit = 6 * 1024 * 1024;
		let readBytes = 0;
		const accountRead = (value: unknown) => {
			readBytes += encodedSize(value);
			if (readBytes > readLimit)
				throw new ConvexError({
					code: "WINDOW_TOO_LARGE",
					message:
						"This Catalog window contains large values. Request fewer keys.",
				});
		};
		const requestedRows: Doc<"catalogProjectionMessages">[] = [];
		let requestedTargetCount = 0;
		for (const messageId of args.messageIds) {
			const rows = args.localeIds
				? (
						await Promise.all(
							[...new Set([sourceLocaleId, ...args.localeIds])].map(
								(localeId) =>
									ctx.db
										.query("catalogProjectionMessages")
										.withIndex(
											"by_projection_and_messageId_and_localeId",
											(q) =>
												q
													.eq("projectionId", projection._id)
													.eq("messageId", messageId)
													.eq("localeId", localeId),
										)
										.unique(),
							),
						)
					).filter(
						(row): row is Doc<"catalogProjectionMessages"> => row !== null,
					)
				: await ctx.db
						.query("catalogProjectionMessages")
						.withIndex("by_projection_and_messageId", (q) =>
							q.eq("projectionId", projection._id).eq("messageId", messageId),
						)
						.take(MAX_PROJECTED_LOCALES + 1);
			if (rows.length > MAX_PROJECTED_LOCALES) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Catalog key exceeds the supported Locale row envelope.",
				});
			}
			if (rows.length === 0) {
				throw new ConvexError({
					code: "NOT_FOUND",
					message: `The window key ${messageId} is not an active Catalog key.`,
				});
			}
			requestedTargetCount += rows.filter((row) => !row.isSource).length;
			// Bound per-target head/decision lookups while preserving the existing
			// 32-key, six-language comparison window.
			if (requestedTargetCount > 256)
				throw new ConvexError({
					code: "WINDOW_TOO_LARGE",
					message:
						"This Catalog window compares too many target values. Request fewer keys or languages.",
				});
			accountRead(rows);
			requestedRows.push(...rows);
		}
		const rowsByValue = new Map(
			requestedRows.map((row) => [valueIdentity(row), row] as const),
		);
		const headsByValue = new Map<string, Doc<"catalogWorkspaceValueHeads">>();
		const proposalHeads: Doc<"catalogWorkspaceSourceProposalHeads">[] = [];
		const gitChanges: Doc<"catalogProjectionGitChanges">[] = [];
		for (const messageId of args.messageIds) {
			for (const row of requestedRows) {
				if (row.messageId !== messageId || row.isSource) continue;
				const head = await ctx.db
					.query("catalogWorkspaceValueHeads")
					.withIndex("by_project_and_messageId_and_localeId", (q) =>
						q
							.eq("projectId", args.projectId)
							.eq("messageId", messageId)
							.eq("localeId", row.localeId),
					)
					.unique();
				accountRead(head);
				if (head) headsByValue.set(valueIdentity(row), head);
			}
			const proposalHead = await ctx.db
				.query("catalogWorkspaceSourceProposalHeads")
				.withIndex("by_project_and_messageId", (q) =>
					q.eq("projectId", args.projectId).eq("messageId", messageId),
				)
				.unique();
			accountRead(proposalHead);
			if (proposalHead) proposalHeads.push(proposalHead);
			const changes = await ctx.db
				.query("catalogProjectionGitChanges")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", messageId)
						.eq("isSource", true),
				)
				.take(2);
			if (changes.length > 1) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "A Catalog key has duplicate source Git changes.",
				});
			}
			accountRead(changes);
			gitChanges.push(...changes);
		}
		const headsForSourceProposals = await sourceProposalStatusesFor(
			ctx,
			proposalHeads,
		);
		const rowsWithCurrentSourceProposal = currentSourceProposalRows(
			requestedRows,
			sourceProposalHeadMap(proposalHeads),
			headsForSourceProposals,
		);
		// The effective source of a key is its current proposal wording when a
		// proposal is current, exactly as the whole-catalog composition did.
		const sourceByMessageId = new Map<
			string,
			Doc<"catalogProjectionMessages">
		>();
		for (const row of rowsWithCurrentSourceProposal) {
			if (!row.isSource) continue;
			if (sourceByMessageId.has(row.messageId)) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Catalog Workspace found more than one source value for a message.",
				});
			}
			sourceByMessageId.set(row.messageId, row);
		}
		const visibleRows = currentWorkspaceRows(
			rowsWithCurrentSourceProposal,
			headsByValue,
		);
		const decisions = await decisionRecordsForNavigationRows(ctx, {
			projectId: args.projectId,
			rows: requestedRows,
			visibleRows,
		});
		const visibleValueFingerprintsByValue = new Map(
			await Promise.all(
				visibleRows.map(
					async (row) =>
						[
							valueIdentity(row),
							row.valueFingerprint ?? (await sha256Hex(row.value)),
						] as const,
				),
			),
		);
		const catalog = readActiveCatalog(projection, visibleRows, {
			includeGitValueFingerprint: true,
		});
		const cards = composeWorkspaceKeyCards(
			{
				rowsByValue,
				sourceByMessageId,
				headsByValue,
				decisionsByIdentity: decisionRecordMap(decisions),
				translatorConfirmationsByValue: translatorConfirmationMap(decisions),
				sourceChangesByIdentity: sourceChangeMap(gitChanges),
				sourceProposalHeadsByMessageId: sourceProposalHeadMap(proposalHeads),
				sourceProposalResolutions: headsForSourceProposals,
				visibleValueFingerprintsByValue,
			},
			catalog,
		);
		// Preserve the requested order; every requested key is present.
		const cardsByMessageId = new Map(
			await Promise.all(
				cards.map(
					async (card) =>
						[
							card.id,
							{
								...card,
								characterLimit: await readCharacterLimit(ctx, {
									projectId: args.projectId,
									messageId: card.id,
								}),
							},
						] as const,
				),
			),
		);
		return args.messageIds.map(
			(messageId) =>
				cardsByMessageId.get(messageId) ??
				(() => {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "The Window read lost a requested Catalog key.",
					});
				})(),
		);
	},
});
