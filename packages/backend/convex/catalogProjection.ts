import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	MAX_METADATA_TRANSFORM_BYTES,
	MAX_METADATA_TRANSFORMS_PER_VALUE,
	type MetadataTransform,
} from "./contractTransforms";
import { now, sha256Hex } from "./lib";
import { MAX_STORED_FACT_NAMES } from "./messageFacts";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
	requireViewer,
} from "./permissions";

/** Storage cardinality guards are independent of transaction read budgets.
 * Processing and public reads page by bytes; no whole-generation response is
 * admitted by these totals. Per-value limits bound the scalar byte counters. */
export const MAX_PROJECTED_LOCALES = 1_000;
export const MAX_WORKING_CATALOG_KEYS = 8_192;
export const MAX_WORKING_CATALOG_ROWS = 1_000_000;
export const MAX_WORKING_CATALOG_BYTES = MAX_WORKING_CATALOG_ROWS * 256 * 1024;
export const MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES = 512;
export const MAX_ARCHIVE_RECONCILIATION_BYTES =
	MAX_WORKING_CATALOG_ROWS * 320 * 1024;
const MAX_MESSAGES_PER_STAGE_BATCH = 500;
const MAX_STAGE_BATCH_BYTES = 512_000;
const MAX_PROJECTED_MESSAGE_BYTES = 256 * 1024;
export const MAX_ARCHIVE_VALUE_BYTES = 320 * 1024;
const MAX_GIT_CHANGES_PER_STAGE_BATCH = 500;
const MAX_GIT_CHANGE_STAGE_BATCH_BYTES = 512_000;
const MAX_GIT_CHANGE_BYTES = 256 * 1024;
const MAX_RESTORATION_VALUES_PER_STAGE_BATCH = 500;
const MAX_RESTORATION_STAGE_BATCH_BYTES = 512_000;
const MAX_RESTORATION_VALUE_BYTES = 320 * 1024;
// A matched proposal can retain a 256 KiB archived source value independent of
// the current source payload. Eight full proposal reads plus the staged
// observations stay comfortably inside Convex's mutation transaction budget.
const MAX_SOURCE_PROPOSAL_OBSERVATIONS_PER_STAGE_BATCH = 8;
const MAX_SOURCE_PROPOSAL_OBSERVATION_STAGE_BATCH_BYTES = 512_000;
const MAX_SOURCE_PROPOSAL_OBSERVATION_BYTES = 256 * 1024;
// A proposal may be observed by a few competing private projections. Refuse
// further staging rather than letting an adversarial number of stale heads turn
// one later `get` into an unbounded read.
export const MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS = 8;
export const MAX_RECONCILIATION_READ_PAGE_ROWS = 500;
const MAX_DELETES_PER_MUTATION = 16;

/** Return the intentionally small visibility record for one projection. This
 * is safe to consult for every competing Source Proposal head, unlike the
 * projection document which retains unbounded identity strings. */
export async function projectionPublicationStateFor(
	ctx: QueryCtx | MutationCtx,
	projectionId: Id<"catalogProjections">,
): Promise<Doc<"catalogProjectionPublicationStates"> | null> {
	return await ctx.db
		.query("catalogProjectionPublicationStates")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.unique();
}

export type ProjectedMessage = {
	localeId: Id<"locales">;
	localeCode: string;
	catalogPath: string;
	isSource: boolean;
	catalogIndex: number;
	messageId: string;
	value: string;
	/** A fingerprint of the visible value after any Contract Transform. */
	valueFingerprint?: string;
	/** The Catalog Document path that owns this value's opaque metadata. */
	metadataCatalogPath?: string;
	/** Present when metadata remains in archived snapshot evidence. */
	metadataSnapshotId?: Id<"sourceSnapshots">;
	/** Present when an automatic restore retained this target's old value. */
	restoredFromSnapshotId?: Id<"sourceSnapshots">;
	/** The submitted Git value, before any Contract Transform reshapes it. */
	gitValueFingerprint?: string;
	/** Increments every time Git changes this Locale value, even if a later
	 * commit returns to identical bytes. Workspace heads use it to prevent a
	 * superseded local value from resurrecting after a Git revert. */
	gitValueRevision?: number;
	/** Whether this target's visible imported content occurs on another key in
	 * the same Locale. Computed after Contract Transforms while the complete
	 * incoming projection is in memory, so Navigation staging does not probe the
	 * projection per target. */
	repeatedGitContent?: boolean;
	/** Version of the visible-content repeat fact. Older projections are
	 * rechecked during the explicit Navigation backfill. */
	repeatedGitContentVersion?: number;
	/** Compact operations over snapshot-bound target metadata. */
	metadataTransforms?: MetadataTransform[];
	sourceFingerprint: string;
	icuType: "plain" | "icu";
	argumentNames: string[];
	argumentNamesComplete: boolean;
	argumentNameCount: number;
	/** Present only on the source value for a Catalog Order entry. */
	declaredPlaceholderNames?: string[];
	declaredPlaceholderNamesComplete?: boolean;
	declaredPlaceholderNameCount?: number;
	/** Post-bootstrap Git introductions carry the time and frozen target-Locale
	 * scope of their First Review on the source row only. The provenance follows
	 * the key through later projections and Archive Reconciliation. */
	introducedAt?: number;
	introductionLocaleIds?: Id<"locales">[];
	materialized: boolean;
};

/** A value Git changed between two accepted Baseline Snapshots. The two
 * snapshots themselves stay on the projection, so no change is attributed to
 * a translator or duplicates immutable evidence. */
export type GitAuthoredChange = {
	localeId: Id<"locales">;
	localeCode: string;
	isSource: boolean;
	catalogIndex: number;
	messageId: string;
	previousCatalogPath: string;
	catalogPath: string;
	previousValue: string;
	value: string;
	previousSourceFingerprint: string;
	sourceFingerprint: string;
	previousMaterialized: boolean;
	materialized: boolean;
};

export type AutomaticRestoration = {
	localeId: Id<"locales">;
	localeCode: string;
	catalogPath: string;
	catalogIndex: number;
	messageId: string;
	value: string;
	metadataCatalogPath?: string;
	metadataSnapshotId?: Id<"sourceSnapshots">;
	sourceFingerprint: string;
	materialized: boolean;
	restoredFromSnapshotId: Id<"sourceSnapshots">;
};

/** A current Source Proposal with a Git outcome in a candidate Baseline is
 * observed while its projection is private. An unchanged Git source leaves the
 * proposal open; the captured proposal-head version makes publication reject
 * if a new candidate arrives after staging begins. */
export type SourceProposalObservation = {
	proposalId: Id<"sourceProposals">;
	messageId: string;
	value: string;
};

const metadataTransformValidator = v.union(
	v.object({
		kind: v.literal("rename_placeholder"),
		from: v.string(),
		to: v.string(),
	}),
	v.object({
		kind: v.literal("retype_placeholder"),
		name: v.string(),
		from: v.union(
			v.object({ type: v.literal("present"), value: v.string() }),
			v.object({ type: v.literal("absent") }),
		),
		to: v.union(
			v.object({ type: v.literal("present"), value: v.string() }),
			v.object({ type: v.literal("absent") }),
		),
	}),
);

export const projectedMessageFields = {
	localeId: v.id("locales"),
	localeCode: v.string(),
	catalogPath: v.string(),
	isSource: v.boolean(),
	catalogIndex: v.number(),
	messageId: v.string(),
	value: v.string(),
	valueFingerprint: v.optional(v.string()),
	metadataCatalogPath: v.optional(v.string()),
	metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
	restoredFromSnapshotId: v.optional(v.id("sourceSnapshots")),
	gitValueFingerprint: v.optional(v.string()),
	gitValueRevision: v.optional(v.number()),
	repeatedGitContent: v.optional(v.boolean()),
	repeatedGitContentVersion: v.optional(v.number()),
	metadataTransforms: v.optional(v.array(metadataTransformValidator)),
	sourceFingerprint: v.string(),
	icuType: v.union(v.literal("plain"), v.literal("icu")),
	argumentNames: v.array(v.string()),
	argumentNamesComplete: v.boolean(),
	argumentNameCount: v.number(),
	declaredPlaceholderNames: v.optional(v.array(v.string())),
	declaredPlaceholderNamesComplete: v.optional(v.boolean()),
	declaredPlaceholderNameCount: v.optional(v.number()),
	introducedAt: v.optional(v.number()),
	introductionLocaleIds: v.optional(v.array(v.id("locales"))),
	materialized: v.boolean(),
} as const;

export const projectedMessageValidator = v.object(projectedMessageFields);

const gitAuthoredChangeValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	isSource: v.boolean(),
	catalogIndex: v.number(),
	messageId: v.string(),
	previousCatalogPath: v.string(),
	catalogPath: v.string(),
	previousValue: v.string(),
	value: v.string(),
	previousSourceFingerprint: v.string(),
	sourceFingerprint: v.string(),
	previousMaterialized: v.boolean(),
	materialized: v.boolean(),
});

const automaticRestorationValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	catalogPath: v.string(),
	catalogIndex: v.number(),
	messageId: v.string(),
	value: v.string(),
	metadataCatalogPath: v.optional(v.string()),
	metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
	sourceFingerprint: v.string(),
	materialized: v.boolean(),
	restoredFromSnapshotId: v.id("sourceSnapshots"),
});

const sourceProposalObservationValidator = v.object({
	proposalId: v.id("sourceProposals"),
	messageId: v.string(),
	value: v.string(),
});

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function projectedMessageByteLength(message: ProjectedMessage): number {
	return encodedSize(message);
}

function assertMetadataTransforms(
	transforms: readonly MetadataTransform[] | undefined,
): void {
	if (transforms === undefined) return;
	if (
		transforms.length > MAX_METADATA_TRANSFORMS_PER_VALUE ||
		encodedSize(transforms) > MAX_METADATA_TRANSFORM_BYTES ||
		transforms.some((transform) => {
			if (transform.kind === "rename_placeholder") {
				return (
					transform.from.length === 0 ||
					transform.to.length === 0 ||
					transform.from === transform.to
				);
			}
			return (
				transform.name.length === 0 ||
				(transform.from.type === "present" &&
					transform.from.value.length === 0) ||
				(transform.to.type === "present" && transform.to.value.length === 0)
			);
		})
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Target metadata transforms exceed the supported envelope.",
		});
	}
}

function projectedMessagesByteLength(
	messages: readonly ProjectedMessage[],
): number {
	return messages.reduce(
		(total, message) => total + projectedMessageByteLength(message),
		0,
	);
}

function gitChangeByteLength(change: GitAuthoredChange): number {
	return encodedSize(change);
}

function gitChangesByteLength(changes: readonly GitAuthoredChange[]): number {
	return changes.reduce(
		(total, change) => total + gitChangeByteLength(change),
		0,
	);
}

function automaticRestorationByteLength(
	restoration: AutomaticRestoration,
): number {
	return encodedSize(restoration);
}

function automaticRestorationsByteLength(
	restorations: readonly AutomaticRestoration[],
): number {
	return restorations.reduce(
		(total, restoration) => total + automaticRestorationByteLength(restoration),
		0,
	);
}

function sourceProposalObservationByteLength(
	observation: SourceProposalObservation,
): number {
	return encodedSize(observation);
}

function sourceProposalObservationsByteLength(
	observations: readonly SourceProposalObservation[],
): number {
	return observations.reduce(
		(total, observation) =>
			total + sourceProposalObservationByteLength(observation),
		0,
	);
}

function assertStoredFactNames(
	names: readonly string[],
	count: number,
	complete: boolean,
	description: string,
): void {
	if (names.length > MAX_STORED_FACT_NAMES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A projected ${description} may contain at most ${MAX_STORED_FACT_NAMES} names.`,
		});
	}
	if (count < names.length || (complete && count !== names.length)) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Projected ${description} facts are inconsistent.`,
		});
	}
}

export function assertProjectedMessage(message: ProjectedMessage): void {
	if (projectedMessageByteLength(message) > MAX_PROJECTED_MESSAGE_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "One catalog message exceeds the working-catalog byte budget.",
		});
	}
	assertStoredFactNames(
		message.argumentNames,
		message.argumentNameCount,
		message.argumentNamesComplete,
		"argument",
	);
	assertMetadataTransforms(message.metadataTransforms);
	if (
		(message.metadataSnapshotId !== undefined &&
			message.metadataCatalogPath === undefined) ||
		(message.restoredFromSnapshotId !== undefined && message.isSource) ||
		(message.metadataTransforms !== undefined && message.isSource) ||
		(message.gitValueFingerprint !== undefined &&
			message.gitValueFingerprint.length === 0) ||
		(message.valueFingerprint !== undefined &&
			message.valueFingerprint.length === 0) ||
		(message.gitValueRevision !== undefined &&
			(!Number.isSafeInteger(message.gitValueRevision) ||
				message.gitValueRevision < 0)) ||
		(message.introducedAt === undefined) !==
			(message.introductionLocaleIds === undefined) ||
		(message.introducedAt !== undefined &&
			message.introductionLocaleIds !== undefined &&
			(!message.isSource ||
				!Number.isSafeInteger(message.introducedAt) ||
				message.introducedAt < 0 ||
				message.introductionLocaleIds.length > MAX_PROJECTED_LOCALES - 1 ||
				new Set(message.introductionLocaleIds).size !==
					message.introductionLocaleIds.length ||
				message.introductionLocaleIds.includes(message.localeId)))
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog restoration provenance is inconsistent.",
		});
	}
	if (message.isSource) {
		if (
			message.declaredPlaceholderNames === undefined ||
			message.declaredPlaceholderNamesComplete === undefined ||
			message.declaredPlaceholderNameCount === undefined
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A source catalog message is missing its declared placeholder facts.",
			});
		}
		assertStoredFactNames(
			message.declaredPlaceholderNames,
			message.declaredPlaceholderNameCount,
			message.declaredPlaceholderNamesComplete,
			"declared placeholder",
		);
	}
}

/** Carry a post-bootstrap key's First Review provenance forward, including
 * through an archive. A source absent from both active and retained evidence is
 * a genuine Git introduction only when a prior Baseline existed; the first
 * Baseline remains the separately approved bootstrap. */
export function attachIntroductionReviews(input: {
	hadPreviousBaseline: boolean;
	previousMessages: readonly ProjectedMessage[];
	retainedMessages: readonly ProjectedMessage[];
	currentMessages: readonly ProjectedMessage[];
	introducedAt: number;
}): ProjectedMessage[] {
	if (!Number.isSafeInteger(input.introducedAt) || input.introducedAt < 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog introduction provenance has an invalid timestamp.",
		});
	}
	const previousSources = new Map(
		input.previousMessages
			.filter((message) => message.isSource)
			.map((message) => [message.messageId, message] as const),
	);
	const retainedSources = new Map(
		input.retainedMessages
			.filter((message) => message.isSource)
			.map((message) => [message.messageId, message] as const),
	);
	const currentTargetsByMessage = new Map<string, Id<"locales">[]>();
	for (const message of input.currentMessages) {
		if (message.isSource) continue;
		const localeIds = currentTargetsByMessage.get(message.messageId) ?? [];
		localeIds.push(message.localeId);
		currentTargetsByMessage.set(message.messageId, localeIds);
	}

	return input.currentMessages.map((message) => {
		if (!message.isSource) {
			const {
				introducedAt: _introducedAt,
				introductionLocaleIds: _introductionLocaleIds,
				...target
			} = message;
			return target;
		}
		const prior =
			previousSources.get(message.messageId) ??
			retainedSources.get(message.messageId);
		const introducedAt = prior?.introducedAt;
		const introductionLocaleIds = prior?.introductionLocaleIds;
		if (introducedAt !== undefined && introductionLocaleIds !== undefined) {
			return {
				...message,
				introducedAt,
				introductionLocaleIds: [...introductionLocaleIds],
			};
		}
		if (prior || !input.hadPreviousBaseline) return message;
		return {
			...message,
			introducedAt: input.introducedAt,
			introductionLocaleIds: [
				...(currentTargetsByMessage.get(message.messageId) ?? []),
			],
		};
	});
}

function assertGitAuthoredChange(change: GitAuthoredChange): void {
	if (
		!Number.isInteger(change.catalogIndex) ||
		change.catalogIndex < 0 ||
		gitChangeByteLength(change) > MAX_GIT_CHANGE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"One Git-authored catalog change exceeds the supported envelope.",
		});
	}
}

function assertAutomaticRestoration(restoration: AutomaticRestoration): void {
	if (
		!Number.isInteger(restoration.catalogIndex) ||
		restoration.catalogIndex < 0 ||
		restoration.messageId.length === 0 ||
		restoration.localeCode.length === 0 ||
		restoration.catalogPath.length === 0 ||
		automaticRestorationByteLength(restoration) > MAX_RESTORATION_VALUE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "One automatic restoration exceeds the supported envelope.",
		});
	}
}

function assertSourceProposalObservation(
	observation: SourceProposalObservation,
): void {
	if (
		observation.messageId.length === 0 ||
		new TextEncoder().encode(observation.messageId).byteLength >
			MAX_RESTORE_PROPOSAL_MESSAGE_ID_BYTES ||
		sourceProposalObservationByteLength(observation) >
			MAX_SOURCE_PROPOSAL_OBSERVATION_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"One Source Proposal observation exceeds the supported envelope.",
		});
	}
}

function projectionValueIdentity(message: {
	localeId: Id<"locales">;
	messageId: string;
}): string {
	return JSON.stringify([message.localeId, message.messageId]);
}

function projectionVisibleValueIdentity(message: {
	localeId: Id<"locales">;
	value: string;
}): string {
	return JSON.stringify([message.localeId, message.value]);
}

/** Materialize the projection-stable repeated-content fact in one in-memory
 * pass over the reconciled incoming catalog. The policy is about visible
 * content, not raw Git bytes: two distinct Git values that a Contract
 * Transform converges to the same target value are repeated too. Navigation
 * and ordinary-import reads then consume a stored boolean instead of scanning
 * or probing the projection once per target. */
export function materializeRepeatedGitContent(
	messages: readonly ProjectedMessage[],
): ProjectedMessage[] {
	const occurrences = new Map<string, number>();
	for (const message of messages) {
		if (message.isSource) continue;
		const identity = projectionVisibleValueIdentity(message);
		occurrences.set(identity, (occurrences.get(identity) ?? 0) + 1);
	}
	return messages.map((message) => {
		if (message.isSource) {
			return message;
		}
		return {
			...message,
			repeatedGitContent:
				(occurrences.get(projectionVisibleValueIdentity(message)) ?? 0) > 1,
			repeatedGitContentVersion: 2,
		};
	});
}

/** Compare the submitted target value when both projections retained its raw
 * fingerprint. Contract Transforms may change the projected value after Git
 * supplied it, and that automatic action must never masquerade as a Git edit.
 * Older projections predate the fingerprint, so their value comparison remains
 * the conservative compatibility path. */
export function gitAuthoredChanges(
	previousMessages: readonly ProjectedMessage[],
	currentMessages: readonly ProjectedMessage[],
): GitAuthoredChange[] {
	const previousByValue = new Map<string, ProjectedMessage>();
	for (const previous of previousMessages) {
		const identity = projectionValueIdentity(previous);
		if (previousByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate Locale value.",
			});
		}
		previousByValue.set(identity, previous);
	}

	const changes: GitAuthoredChange[] = [];
	for (const current of currentMessages) {
		const previous = previousByValue.get(projectionValueIdentity(current));
		const unchangedGitValue =
			previous?.gitValueFingerprint !== undefined &&
			current.gitValueFingerprint !== undefined
				? previous.gitValueFingerprint === current.gitValueFingerprint
				: previous?.value === current.value;
		if (!previous || unchangedGitValue) continue;
		const change: GitAuthoredChange = {
			localeId: current.localeId,
			localeCode: current.localeCode,
			isSource: current.isSource,
			catalogIndex: current.catalogIndex,
			messageId: current.messageId,
			previousCatalogPath: previous.catalogPath,
			catalogPath: current.catalogPath,
			previousValue: previous.value,
			value: current.value,
			previousSourceFingerprint: previous.sourceFingerprint,
			sourceFingerprint: current.sourceFingerprint,
			previousMaterialized: previous.materialized,
			materialized: current.materialized,
		};
		assertGitAuthoredChange(change);
		changes.push(change);
	}
	return changes;
}

/** Carry a per-value Git revision into the private projection. A raw value may
 * return to the same bytes after an intervening Git edit; its revision still
 * advances, so a local head that answered the earlier value cannot revive. */
export function assignGitValueRevisions(
	previousMessages: readonly ProjectedMessage[],
	currentMessages: readonly ProjectedMessage[],
): ProjectedMessage[] {
	const previousByValue = new Map<string, ProjectedMessage>();
	for (const previous of previousMessages) {
		assertProjectedMessage(previous);
		const identity = projectionValueIdentity(previous);
		if (previousByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate Locale value.",
			});
		}
		previousByValue.set(identity, previous);
	}
	return currentMessages.map((current) => {
		assertProjectedMessage(current);
		const previous = previousByValue.get(projectionValueIdentity(current));
		const previousRevision = previous?.gitValueRevision ?? 0;
		const unchangedGitValue =
			previous?.gitValueFingerprint !== undefined &&
			current.gitValueFingerprint !== undefined
				? previous.gitValueFingerprint === current.gitValueFingerprint
				: previous?.value === current.value;
		return {
			...current,
			gitValueRevision:
				previous === undefined || unchangedGitValue
					? previousRevision
					: previousRevision + 1,
		};
	});
}

/** The visible Catalog Workspace value can differ from raw Git after a
 * lossless Contract Transform. Fingerprint the reconciled value only once the
 * full projection has been assembled. */
export async function assignValueFingerprints(
	messages: readonly ProjectedMessage[],
): Promise<ProjectedMessage[]> {
	return await Promise.all(
		messages.map(async (message) => ({
			...message,
			valueFingerprint: await sha256Hex(message.value),
		})),
	);
}

/** A target remains authored against its prior Source Fingerprint when Git
 * keeps its bytes unchanged while English changes. Only a changed target value
 * can claim the newly ingested English as its source contract. */
export function preserveUnchangedTargetSourceFingerprints(
	previousMessages: readonly ProjectedMessage[],
	currentMessages: readonly ProjectedMessage[],
): ProjectedMessage[] {
	const previousByValue = new Map<string, ProjectedMessage>();
	for (const previous of previousMessages) {
		assertProjectedMessage(previous);
		const identity = projectionValueIdentity(previous);
		if (previousByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate Locale value.",
			});
		}
		previousByValue.set(identity, previous);
	}
	return currentMessages.map((current) => {
		assertProjectedMessage(current);
		if (current.isSource) return current;
		const previous = previousByValue.get(projectionValueIdentity(current));
		if (
			!previous ||
			previous.isSource ||
			previous.value !== current.value ||
			previous.sourceFingerprint === current.sourceFingerprint
		) {
			return current;
		}
		return { ...current, sourceFingerprint: previous.sourceFingerprint };
	});
}

/** Select just the automatic target values introduced by this accepted
 * transition. A carried restore has the same provenance and value as its prior
 * projection, so it remains durable active state without becoming a second
 * reconciliation action. */
export function automaticRestorations(
	previousMessages: readonly ProjectedMessage[],
	currentMessages: readonly ProjectedMessage[],
): AutomaticRestoration[] {
	const previousByValue = new Map<string, ProjectedMessage>();
	for (const previous of previousMessages) {
		const identity = projectionValueIdentity(previous);
		if (previousByValue.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate Locale value.",
			});
		}
		previousByValue.set(identity, previous);
	}
	const restorations: AutomaticRestoration[] = [];
	for (const current of currentMessages) {
		if (current.isSource || current.restoredFromSnapshotId === undefined)
			continue;
		const previous = previousByValue.get(projectionValueIdentity(current));
		if (
			previous?.restoredFromSnapshotId === current.restoredFromSnapshotId &&
			previous.value === current.value &&
			previous.sourceFingerprint === current.sourceFingerprint
		) {
			continue;
		}
		const restoration: AutomaticRestoration = {
			localeId: current.localeId,
			localeCode: current.localeCode,
			catalogPath: current.catalogPath,
			catalogIndex: current.catalogIndex,
			messageId: current.messageId,
			value: current.value,
			...(current.metadataCatalogPath === undefined
				? {}
				: { metadataCatalogPath: current.metadataCatalogPath }),
			...(current.metadataSnapshotId === undefined
				? {}
				: { metadataSnapshotId: current.metadataSnapshotId }),
			sourceFingerprint: current.sourceFingerprint,
			materialized: current.materialized,
			restoredFromSnapshotId: current.restoredFromSnapshotId,
		};
		assertAutomaticRestoration(restoration);
		restorations.push(restoration);
	}
	return restorations;
}

export function automaticRestorationEnvelope(
	restorations: readonly AutomaticRestoration[],
): { valueCount: number; byteLength: number } {
	for (const restoration of restorations)
		assertAutomaticRestoration(restoration);
	const byteLength = automaticRestorationsByteLength(restorations);
	if (
		restorations.length > MAX_WORKING_CATALOG_ROWS ||
		byteLength > MAX_WORKING_CATALOG_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Automatic restorations exceed the supported envelope.",
		});
	}
	return { valueCount: restorations.length, byteLength };
}

export function sourceProposalObservationEnvelope(
	observations: readonly SourceProposalObservation[],
): { count: number; byteLength: number } {
	const messageIds = new Set<string>();
	const proposalIds = new Set<Id<"sourceProposals">>();
	for (const observation of observations) {
		assertSourceProposalObservation(observation);
		if (
			messageIds.has(observation.messageId) ||
			proposalIds.has(observation.proposalId)
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A source catalog contains a duplicate proposal observation.",
			});
		}
		messageIds.add(observation.messageId);
		proposalIds.add(observation.proposalId);
	}
	const byteLength = sourceProposalObservationsByteLength(observations);
	if (
		observations.length > MAX_WORKING_CATALOG_KEYS ||
		byteLength > MAX_WORKING_CATALOG_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"Source Proposal observations exceed the working-catalog envelope.",
		});
	}
	return { count: observations.length, byteLength };
}

export function gitChangeEnvelope(changes: readonly GitAuthoredChange[]): {
	changeCount: number;
	byteLength: number;
} {
	for (const change of changes) assertGitAuthoredChange(change);
	const byteLength = gitChangesByteLength(changes);
	if (changes.length > MAX_WORKING_CATALOG_ROWS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A Baseline transition supports at most ${MAX_WORKING_CATALOG_ROWS} Git-authored value changes.`,
		});
	}
	if (byteLength > MAX_WORKING_CATALOG_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"Git-authored catalog changes exceed the supported working-catalog byte envelope.",
		});
	}
	return { changeCount: changes.length, byteLength };
}

export function projectionEnvelope(messages: readonly ProjectedMessage[]): {
	keyCount: number;
	messageCount: number;
	byteLength: number;
} {
	for (const message of messages) assertProjectedMessage(message);
	const keyCount = messages.filter((message) => message.isSource).length;
	const byteLength = projectedMessagesByteLength(messages);
	if (keyCount > MAX_WORKING_CATALOG_KEYS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A working catalog supports at most ${MAX_WORKING_CATALOG_KEYS} keys.`,
		});
	}
	if (messages.length > MAX_WORKING_CATALOG_ROWS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A working catalog supports at most ${MAX_WORKING_CATALOG_ROWS} Locale values.`,
		});
	}
	if (byteLength > MAX_WORKING_CATALOG_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"The working catalog exceeds the supported working-catalog byte envelope.",
		});
	}
	return { keyCount, messageCount: messages.length, byteLength };
}

function assertStageBatch(messages: readonly ProjectedMessage[]): void {
	if (messages.length === 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A catalog projection batch cannot be empty.",
		});
	}
	if (messages.length > MAX_MESSAGES_PER_STAGE_BATCH) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A catalog projection batch may contain at most ${MAX_MESSAGES_PER_STAGE_BATCH} messages.`,
		});
	}
	for (const message of messages) assertProjectedMessage(message);
	if (encodedSize(messages) > MAX_STAGE_BATCH_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A catalog projection batch exceeds the supported byte budget.",
		});
	}
}

function assertGitChangeBatch(changes: readonly GitAuthoredChange[]): void {
	if (changes.length === 0) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Git-authored change batch cannot be empty.",
		});
	}
	if (changes.length > MAX_GIT_CHANGES_PER_STAGE_BATCH) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A Git-authored change batch may contain at most ${MAX_GIT_CHANGES_PER_STAGE_BATCH} values.`,
		});
	}
	for (const change of changes) assertGitAuthoredChange(change);
	if (encodedSize(changes) > MAX_GIT_CHANGE_STAGE_BATCH_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Git-authored change batch exceeds the supported byte budget.",
		});
	}
}

function assertAutomaticRestorationBatch(
	restorations: readonly AutomaticRestoration[],
): void {
	if (
		restorations.length === 0 ||
		restorations.length > MAX_RESTORATION_VALUES_PER_STAGE_BATCH
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An automatic restoration batch has an invalid member count.",
		});
	}
	for (const restoration of restorations)
		assertAutomaticRestoration(restoration);
	if (encodedSize(restorations) > MAX_RESTORATION_STAGE_BATCH_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An automatic restoration batch exceeds its byte budget.",
		});
	}
}

function assertSourceProposalObservationBatch(
	observations: readonly SourceProposalObservation[],
): void {
	if (
		observations.length === 0 ||
		observations.length > MAX_SOURCE_PROPOSAL_OBSERVATIONS_PER_STAGE_BATCH
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"A Source Proposal observation batch has an invalid member count.",
		});
	}
	const messageIds = new Set<string>();
	const proposalIds = new Set<Id<"sourceProposals">>();
	for (const observation of observations) {
		assertSourceProposalObservation(observation);
		if (
			messageIds.has(observation.messageId) ||
			proposalIds.has(observation.proposalId)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Source Proposal observation batch contains a duplicate key.",
			});
		}
		messageIds.add(observation.messageId);
		proposalIds.add(observation.proposalId);
	}
	if (
		encodedSize(observations) >
		MAX_SOURCE_PROPOSAL_OBSERVATION_STAGE_BATCH_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A Source Proposal observation batch exceeds its byte budget.",
		});
	}
}

function batchesWithinEnvelope<T>(
	values: readonly T[],
	maxItems: number,
	maxBytes: number,
	byteLength: (value: T) => number,
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let batchBytes = 2; // JSON array brackets

	for (const value of values) {
		const valueBytes = byteLength(value);
		const separatorBytes = batch.length === 0 ? 0 : 1;
		if (
			batch.length === maxItems ||
			batchBytes + separatorBytes + valueBytes > maxBytes
		) {
			batches.push(batch);
			batch = [];
			batchBytes = 2;
		}
		batch.push(value);
		batchBytes += separatorBytes + valueBytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/** Split rows on both document count and encoded-byte boundaries. */
export function stageBatches(
	messages: readonly ProjectedMessage[],
): ProjectedMessage[][] {
	for (const message of messages) assertProjectedMessage(message);
	return batchesWithinEnvelope(
		messages,
		MAX_MESSAGES_PER_STAGE_BATCH,
		MAX_STAGE_BATCH_BYTES,
		projectedMessageByteLength,
	);
}

/** Split Git-authored replacements on the same transaction-safe boundaries. */
export function gitChangeBatches(
	changes: readonly GitAuthoredChange[],
): GitAuthoredChange[][] {
	for (const change of changes) assertGitAuthoredChange(change);
	return batchesWithinEnvelope(
		changes,
		MAX_GIT_CHANGES_PER_STAGE_BATCH,
		MAX_GIT_CHANGE_STAGE_BATCH_BYTES,
		gitChangeByteLength,
	);
}

export function automaticRestorationBatches(
	restorations: readonly AutomaticRestoration[],
): AutomaticRestoration[][] {
	for (const restoration of restorations)
		assertAutomaticRestoration(restoration);
	return batchesWithinEnvelope(
		restorations,
		MAX_RESTORATION_VALUES_PER_STAGE_BATCH,
		MAX_RESTORATION_STAGE_BATCH_BYTES,
		automaticRestorationByteLength,
	);
}

export function sourceProposalObservationBatches(
	observations: readonly SourceProposalObservation[],
): SourceProposalObservation[][] {
	for (const observation of observations)
		assertSourceProposalObservation(observation);
	return batchesWithinEnvelope(
		observations,
		MAX_SOURCE_PROPOSAL_OBSERVATIONS_PER_STAGE_BATCH,
		MAX_SOURCE_PROPOSAL_OBSERVATION_STAGE_BATCH_BYTES,
		sourceProposalObservationByteLength,
	);
}

export const begin = internalMutation({
	args: {
		projectId: v.id("projects"),
		expectedBindingBasis: v.optional(
			v.object({
				projectionId: v.union(v.id("catalogProjections"), v.null()),
				localeBindingRevision: v.number(),
			}),
		),
		repository: v.string(),
		commit: v.string(),
		manifestHash: v.string(),
		expectedKeyCount: v.number(),
		expectedMessageCount: v.number(),
		expectedByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.expectedKeyCount) ||
			!Number.isInteger(args.expectedMessageCount) ||
			!Number.isInteger(args.expectedByteLength) ||
			args.expectedKeyCount < 0 ||
			args.expectedKeyCount > MAX_WORKING_CATALOG_KEYS ||
			args.expectedMessageCount < 0 ||
			args.expectedMessageCount > MAX_WORKING_CATALOG_ROWS ||
			args.expectedByteLength < 0 ||
			args.expectedByteLength > MAX_WORKING_CATALOG_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Catalog projection exceeds the supported working-catalog envelope.",
			});
		}
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		if (
			args.expectedBindingBasis &&
			(args.expectedBindingBasis.projectionId !==
				(project.activeCatalogProjectionId ?? null) ||
				args.expectedBindingBasis.localeBindingRevision !==
					(project.localeBindingRevision ?? 0))
		)
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"Locale bindings or the active projection changed while Snapshot files were read. Retry the operation.",
			});
		const sourceProposalHeadVersion = project.sourceProposalHeadVersion ?? 0;
		if (
			!Number.isSafeInteger(sourceProposalHeadVersion) ||
			sourceProposalHeadVersion < 0
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal head version is invalid.",
			});
		}
		const previousBaselineSnapshotId = project.baselineSnapshotId;
		let previousCatalogProjectionId: Id<"catalogProjections"> | undefined;
		if (project.activeCatalogProjectionId) {
			const previousProjection = await ctx.db.get(
				project.activeCatalogProjectionId,
			);
			if (
				!previousProjection ||
				previousProjection.projectId !== args.projectId ||
				previousProjection.status !== "published" ||
				previousProjection.snapshotId !== previousBaselineSnapshotId
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"The active working catalog does not match its Baseline Snapshot.",
				});
			}
			previousCatalogProjectionId = previousProjection._id;
		}
		const projectionId = await ctx.db.insert("catalogProjections", {
			localeBindingRevision: project.localeBindingRevision ?? 0,
			projectId: args.projectId,
			repository: args.repository,
			commit: args.commit,
			manifestHash: args.manifestHash,
			expectedKeyCount: args.expectedKeyCount,
			expectedMessageCount: args.expectedMessageCount,
			expectedByteLength: args.expectedByteLength,
			stagedKeyCount: 0,
			stagedMessageCount: 0,
			stagedByteLength: 0,
			...(previousBaselineSnapshotId === undefined
				? {}
				: { previousBaselineSnapshotId }),
			...(previousCatalogProjectionId === undefined
				? {}
				: { previousCatalogProjectionId }),
			sourceProposalHeadVersion,
			expectedGitChangeCount: 0,
			expectedGitChangeByteLength: 0,
			stagedGitChangeCount: 0,
			stagedGitChangeByteLength: 0,
			gitChangesStatus: "pending",
			expectedTranslationResidueCount: 0,
			expectedTranslationResidueByteLength: 0,
			stagedTranslationResidueCount: 0,
			stagedTranslationResidueByteLength: 0,
			translationResidueStatus: "pending",
			expectedArchiveKeyCount: 0,
			expectedArchiveLocaleCount: 0,
			expectedArchiveValueCount: 0,
			expectedArchiveByteLength: 0,
			stagedArchiveKeyCount: 0,
			stagedArchiveLocaleCount: 0,
			stagedArchiveValueCount: 0,
			stagedArchiveByteLength: 0,
			archiveStatus: "pending",
			expectedArchiveStateValueCount: 0,
			expectedArchiveStateByteLength: 0,
			stagedArchiveStateValueCount: 0,
			stagedArchiveStateByteLength: 0,
			archiveStateStatus: "pending",
			expectedRestoreValueCount: 0,
			expectedRestoreByteLength: 0,
			stagedRestoreValueCount: 0,
			stagedRestoreByteLength: 0,
			restoreStatus: "pending",
			expectedSourceProposalObservationCount: 0,
			expectedSourceProposalObservationByteLength: 0,
			stagedSourceProposalObservationCount: 0,
			stagedSourceProposalObservationByteLength: 0,
			sourceProposalObservationsStatus: "pending",
			reconciliationReportStatus: "pending",
			status: "staging",
			createdAt: now(),
		});
		await ctx.db.insert("catalogProjectionPublicationStates", {
			projectId: args.projectId,
			projectionId,
			status: "staging",
		});
		// A terminated action cannot execute its catch block. Expire private
		// generations as well; publication makes this cleanup a no-op.
		await ctx.scheduler.runAfter(
			24 * 60 * 60 * 1000,
			internal.catalogProjection.continueDiscard,
			{ projectionId },
		);
		return projectionId;
	},
});

/** The Source Snapshot's raw rows establish a staging claim first; contract
 * reconciliation then replaces this envelope with the exact effective rows
 * before a single value can be written. This preserves the base capture while
 * allowing a lossless Contract Transform to change a value's byte length. */
export const setWorkingCatalogEnvelope = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedKeyCount: v.number(),
		expectedMessageCount: v.number(),
		expectedByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.expectedKeyCount) ||
			!Number.isInteger(args.expectedMessageCount) ||
			!Number.isInteger(args.expectedByteLength) ||
			args.expectedKeyCount < 0 ||
			args.expectedKeyCount > MAX_WORKING_CATALOG_KEYS ||
			args.expectedMessageCount < 0 ||
			args.expectedMessageCount > MAX_WORKING_CATALOG_ROWS ||
			args.expectedByteLength < 0 ||
			args.expectedByteLength > MAX_WORKING_CATALOG_BYTES
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Catalog projection exceeds the supported working-catalog envelope.",
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.stagedKeyCount !== 0 ||
			projection.stagedMessageCount !== 0 ||
			projection.stagedByteLength !== 0 ||
			projection.gitChangesStatus !== "pending" ||
			projection.translationResidueStatus !== "pending" ||
			projection.archiveStatus !== "pending" ||
			projection.archiveStateStatus !== "pending" ||
			projection.restoreStatus !== "pending" ||
			projection.sourceProposalObservationsStatus !== "pending" ||
			projection.reconciliationReportStatus !== "pending" ||
			projection.reconciliationReportId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message:
					"An untouched staging catalog projection for this project was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedKeyCount: args.expectedKeyCount,
			expectedMessageCount: args.expectedMessageCount,
			expectedByteLength: args.expectedByteLength,
		});
		return null;
	},
});

export const stageBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		messages: v.array(projectedMessageValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertStageBatch(args.messages);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A staging catalog projection for this project was not found.",
			});
		}
		const batchByteLength = projectedMessagesByteLength(args.messages);
		const batchKeyCount = args.messages.filter(
			(message) => message.isSource,
		).length;
		if (
			projection.stagedKeyCount + batchKeyCount > projection.expectedKeyCount ||
			projection.stagedMessageCount + args.messages.length >
				projection.expectedMessageCount ||
			projection.stagedByteLength + batchByteLength >
				projection.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog projection staging exceeded its declared envelope.",
			});
		}
		for (const message of args.messages) {
			await ctx.db.insert("catalogProjectionMessages", {
				projectionId: args.projectionId,
				...message,
				argumentNames: [...message.argumentNames],
				...(message.metadataTransforms === undefined
					? {}
					: { metadataTransforms: [...message.metadataTransforms] }),
				...(message.declaredPlaceholderNames === undefined
					? {}
					: {
							declaredPlaceholderNames: [...message.declaredPlaceholderNames],
						}),
			});
		}
		await ctx.db.patch(args.projectionId, {
			stagedKeyCount: projection.stagedKeyCount + batchKeyCount,
			stagedMessageCount: projection.stagedMessageCount + args.messages.length,
			stagedByteLength: projection.stagedByteLength + batchByteLength,
		});
		return null;
	},
});

export function projectedMessageFromRow(
	row: Doc<"catalogProjectionMessages">,
): ProjectedMessage {
	return {
		localeId: row.localeId,
		localeCode: row.localeCode,
		catalogPath: row.catalogPath,
		isSource: row.isSource,
		catalogIndex: row.catalogIndex,
		messageId: row.messageId,
		value: row.value,
		...(row.valueFingerprint === undefined
			? {}
			: { valueFingerprint: row.valueFingerprint }),
		...(row.metadataCatalogPath === undefined
			? {}
			: { metadataCatalogPath: row.metadataCatalogPath }),
		...(row.metadataSnapshotId === undefined
			? {}
			: { metadataSnapshotId: row.metadataSnapshotId }),
		...(row.restoredFromSnapshotId === undefined
			? {}
			: { restoredFromSnapshotId: row.restoredFromSnapshotId }),
		...(row.gitValueFingerprint === undefined
			? {}
			: { gitValueFingerprint: row.gitValueFingerprint }),
		...(row.gitValueRevision === undefined
			? {}
			: { gitValueRevision: row.gitValueRevision }),
		...(row.repeatedGitContent === undefined
			? {}
			: { repeatedGitContent: row.repeatedGitContent }),
		...(row.repeatedGitContentVersion === undefined
			? {}
			: { repeatedGitContentVersion: row.repeatedGitContentVersion }),
		...(row.metadataTransforms === undefined
			? {}
			: { metadataTransforms: [...row.metadataTransforms] }),
		sourceFingerprint: row.sourceFingerprint,
		icuType: row.icuType,
		argumentNames: [...row.argumentNames],
		argumentNamesComplete: row.argumentNamesComplete,
		argumentNameCount: row.argumentNameCount,
		...(row.declaredPlaceholderNames === undefined
			? {}
			: { declaredPlaceholderNames: [...row.declaredPlaceholderNames] }),
		...(row.declaredPlaceholderNamesComplete === undefined
			? {}
			: {
					declaredPlaceholderNamesComplete:
						row.declaredPlaceholderNamesComplete,
				}),
		...(row.declaredPlaceholderNameCount === undefined
			? {}
			: {
					declaredPlaceholderNameCount: row.declaredPlaceholderNameCount,
				}),
		...(row.introducedAt === undefined
			? {}
			: {
					introducedAt: row.introducedAt,
					introductionLocaleIds: [...(row.introductionLocaleIds ?? [])],
				}),
		materialized: row.materialized,
	};
}

/** Read the immutable Baseline projection captured when staging began. The
 * publication mutation compares that capture to the then-current project,
 * so a racing baseline can never publish a diff against the wrong evidence. */
export const reconciliationBasePage = internalQuery({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		paginationOpts: paginationOptsValidator,
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.paginationOpts.numItems) ||
			args.paginationOpts.numItems < 1 ||
			args.paginationOpts.numItems > MAX_RECONCILIATION_READ_PAGE_ROWS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `A reconciliation read page may contain at most ${MAX_RECONCILIATION_READ_PAGE_ROWS} values.`,
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A staging catalog projection for this project was not found.",
			});
		}
		if (!projection.previousCatalogProjectionId) {
			return {
				totalMessageCount: 0,
				previousSnapshotId: null,
				previousProjectionId: null,
				page: [],
				isDone: true,
				continueCursor: "",
			};
		}
		if (!projection.previousBaselineSnapshotId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A previous catalog projection is missing its Baseline Snapshot provenance.",
			});
		}
		const previousProjection = await ctx.db.get(
			projection.previousCatalogProjectionId,
		);
		if (
			!previousProjection ||
			previousProjection.projectId !== args.projectId ||
			previousProjection.status !== "published" ||
			previousProjection.snapshotId !== projection.previousBaselineSnapshotId ||
			previousProjection.expectedKeyCount > MAX_WORKING_CATALOG_KEYS ||
			previousProjection.expectedMessageCount > MAX_WORKING_CATALOG_ROWS ||
			previousProjection.expectedByteLength > MAX_WORKING_CATALOG_BYTES ||
			previousProjection.stagedKeyCount !==
				previousProjection.expectedKeyCount ||
			previousProjection.stagedMessageCount !==
				previousProjection.expectedMessageCount ||
			previousProjection.stagedByteLength !==
				previousProjection.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The prior Baseline catalog projection is incomplete.",
			});
		}
		const page = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection", (q) =>
				q.eq("projectionId", previousProjection._id),
			)
			.paginate(args.paginationOpts);
		return {
			totalMessageCount: previousProjection.expectedMessageCount,
			previousSnapshotId: projection.previousBaselineSnapshotId,
			previousProjectionId: previousProjection._id,
			page: page.page.map(projectedMessageFromRow),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

/** Declare the complete Git-change envelope before writing any consequence.
 * An empty declaration is a deliberate quiet transition, not an omitted step. */
export const declareGitChanges = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedGitChangeCount: v.number(),
		expectedGitChangeByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.expectedGitChangeCount) ||
			!Number.isInteger(args.expectedGitChangeByteLength) ||
			args.expectedGitChangeCount < 0 ||
			args.expectedGitChangeCount > MAX_WORKING_CATALOG_ROWS ||
			args.expectedGitChangeByteLength < 0 ||
			args.expectedGitChangeByteLength > MAX_WORKING_CATALOG_BYTES ||
			(args.expectedGitChangeCount === 0) !==
				(args.expectedGitChangeByteLength === 0)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Git-authored changes exceed the supported reconciliation envelope.",
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.gitChangesStatus !== "pending"
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message:
					"A pending catalog reconciliation for this project was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedGitChangeCount: args.expectedGitChangeCount,
			expectedGitChangeByteLength: args.expectedGitChangeByteLength,
			gitChangesStatus:
				args.expectedGitChangeCount === 0 ? "staged" : "staging",
		});
		return null;
	},
});

export const stageGitChangeBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		changes: v.array(gitAuthoredChangeValidator),
		isFinal: v.boolean(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertGitChangeBatch(args.changes);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.gitChangesStatus !== "staging" ||
			projection.expectedGitChangeCount === undefined ||
			projection.expectedGitChangeByteLength === undefined ||
			projection.stagedGitChangeCount === undefined ||
			projection.stagedGitChangeByteLength === undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message:
					"A staging catalog reconciliation for this project was not found.",
			});
		}
		const batchByteLength = gitChangesByteLength(args.changes);
		const nextCount = projection.stagedGitChangeCount + args.changes.length;
		const nextByteLength =
			projection.stagedGitChangeByteLength + batchByteLength;
		if (
			nextCount > projection.expectedGitChangeCount ||
			nextByteLength > projection.expectedGitChangeByteLength ||
			(args.isFinal &&
				(nextCount !== projection.expectedGitChangeCount ||
					nextByteLength !== projection.expectedGitChangeByteLength))
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Catalog reconciliation staging exceeded its declared envelope.",
			});
		}
		for (const change of args.changes) {
			await ctx.db.insert("catalogProjectionGitChanges", {
				projectionId: projection._id,
				...change,
			});
		}
		await ctx.db.patch(projection._id, {
			stagedGitChangeCount: nextCount,
			stagedGitChangeByteLength: nextByteLength,
			...(args.isFinal ? { gitChangesStatus: "staged" } : {}),
		});
		return null;
	},
});

function restorationStagingCounters(projection: Doc<"catalogProjections">): {
	expectedValueCount: number;
	expectedByteLength: number;
	stagedValueCount: number;
	stagedByteLength: number;
} {
	if (
		projection.restoreStatus !== "staging" ||
		projection.expectedRestoreValueCount === undefined ||
		projection.expectedRestoreByteLength === undefined ||
		projection.stagedRestoreValueCount === undefined ||
		projection.stagedRestoreByteLength === undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "A staging automatic restoration set was not found.",
		});
	}
	return {
		expectedValueCount: projection.expectedRestoreValueCount,
		expectedByteLength: projection.expectedRestoreByteLength,
		stagedValueCount: projection.stagedRestoreValueCount,
		stagedByteLength: projection.stagedRestoreByteLength,
	};
}

/** Declare the full automatic restoration action set before rows are staged. */
export const declareRestorations = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedRestoreValueCount: v.number(),
		expectedRestoreByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.expectedRestoreValueCount) ||
			!Number.isInteger(args.expectedRestoreByteLength) ||
			args.expectedRestoreValueCount < 0 ||
			args.expectedRestoreValueCount > MAX_WORKING_CATALOG_ROWS ||
			args.expectedRestoreByteLength < 0 ||
			args.expectedRestoreByteLength > MAX_WORKING_CATALOG_BYTES ||
			(args.expectedRestoreValueCount === 0) !==
				(args.expectedRestoreByteLength === 0)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Automatic restorations exceed the supported staging envelope.",
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.restoreStatus !== "pending"
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A pending automatic restoration set was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedRestoreValueCount: args.expectedRestoreValueCount,
			expectedRestoreByteLength: args.expectedRestoreByteLength,
			restoreStatus:
				args.expectedRestoreValueCount === 0 ? "staged" : "staging",
		});
		return null;
	},
});

export const stageRestorationBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		restorations: v.array(automaticRestorationValidator),
		isFinal: v.boolean(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertAutomaticRestorationBatch(args.restorations);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A staging automatic restoration set was not found.",
			});
		}
		const counters = restorationStagingCounters(projection);
		const batchByteLength = automaticRestorationsByteLength(args.restorations);
		const nextCount = counters.stagedValueCount + args.restorations.length;
		const nextByteLength = counters.stagedByteLength + batchByteLength;
		if (
			nextCount > counters.expectedValueCount ||
			nextByteLength > counters.expectedByteLength ||
			(args.isFinal &&
				(nextCount !== counters.expectedValueCount ||
					nextByteLength !== counters.expectedByteLength))
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Automatic restoration staging exceeded its declared envelope.",
			});
		}
		for (const restoration of args.restorations) {
			await ctx.db.insert("catalogProjectionRestorations", {
				projectId: args.projectId,
				projectionId: projection._id,
				...restoration,
			});
		}
		await ctx.db.patch(projection._id, {
			stagedRestoreValueCount: nextCount,
			stagedRestoreByteLength: nextByteLength,
			...(args.isFinal ? { restoreStatus: "staged" } : {}),
		});
		return null;
	},
});

function sourceProposalObservationStagingCounters(
	projection: Doc<"catalogProjections">,
): {
	expectedCount: number;
	expectedByteLength: number;
	stagedCount: number;
	stagedByteLength: number;
} {
	if (
		projection.sourceProposalObservationsStatus !== "staging" ||
		projection.expectedSourceProposalObservationCount === undefined ||
		projection.expectedSourceProposalObservationByteLength === undefined ||
		projection.stagedSourceProposalObservationCount === undefined ||
		projection.stagedSourceProposalObservationByteLength === undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "A staging Source Proposal observation set was not found.",
		});
	}
	return {
		expectedCount: projection.expectedSourceProposalObservationCount,
		expectedByteLength: projection.expectedSourceProposalObservationByteLength,
		stagedCount: projection.stagedSourceProposalObservationCount,
		stagedByteLength: projection.stagedSourceProposalObservationByteLength,
	};
}

/** Declare every source value that will be checked against open Source
 * Proposals. This makes a complete, bounded observation set part of the same
 * private projection that will later become the Baseline. */
export const declareSourceProposalObservations = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedSourceProposalObservationCount: v.number(),
		expectedSourceProposalObservationByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		if (
			!Number.isInteger(args.expectedSourceProposalObservationCount) ||
			!Number.isInteger(args.expectedSourceProposalObservationByteLength) ||
			args.expectedSourceProposalObservationCount < 0 ||
			args.expectedSourceProposalObservationCount > MAX_WORKING_CATALOG_KEYS ||
			args.expectedSourceProposalObservationByteLength < 0 ||
			args.expectedSourceProposalObservationByteLength >
				MAX_WORKING_CATALOG_BYTES ||
			(args.expectedSourceProposalObservationCount === 0) !==
				(args.expectedSourceProposalObservationByteLength === 0)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Source Proposal observations exceed the staging envelope.",
			});
		}
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined ||
			projection.sourceProposalObservationsStatus !== "pending"
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A pending Source Proposal observation set was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedSourceProposalObservationCount:
				args.expectedSourceProposalObservationCount,
			expectedSourceProposalObservationByteLength:
				args.expectedSourceProposalObservationByteLength,
			sourceProposalObservationsStatus:
				args.expectedSourceProposalObservationCount === 0
					? "staged"
					: "staging",
		});
		return null;
	},
});

/** Check a bounded batch of source values. A matching open proposal gets one
 * normalized head tied to this private projection; publication later exposes
 * all such heads by flipping only the projection's visibility. */
export const stageSourceProposalObservationBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		observations: v.array(sourceProposalObservationValidator),
		isFinal: v.boolean(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertSourceProposalObservationBatch(args.observations);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A staging Source Proposal observation set was not found.",
			});
		}
		const counters = sourceProposalObservationStagingCounters(projection);
		const batchByteLength = sourceProposalObservationsByteLength(
			args.observations,
		);
		const nextCount = counters.stagedCount + args.observations.length;
		const nextByteLength = counters.stagedByteLength + batchByteLength;
		if (
			nextCount > counters.expectedCount ||
			nextByteLength > counters.expectedByteLength ||
			(args.isFinal &&
				(nextCount !== counters.expectedCount ||
					nextByteLength !== counters.expectedByteLength))
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Proposal observation staging exceeded its envelope.",
			});
		}
		for (const observation of args.observations) {
			const proposal = await ctx.db.get(observation.proposalId);
			if (
				!proposal ||
				proposal.projectId !== args.projectId ||
				proposal.messageId !== observation.messageId ||
				proposal.status !== "open"
			) {
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"A Source Proposal changed while its source observation was staged.",
				});
			}
			if (proposal.kind === "restore") {
				const openHead = await ctx.db
					.query("sourceProposalOpenHeads")
					.withIndex("by_project_and_messageId", (q) =>
						q
							.eq("projectId", args.projectId)
							.eq("messageId", proposal.messageId),
					)
					.unique();
				if (
					!openHead ||
					openHead.projectId !== args.projectId ||
					openHead.messageId !== proposal.messageId ||
					openHead.proposalId !== proposal._id
				) {
					throw new ConvexError({
						code: "CONFLICT",
						message:
							"The current Restore Proposal changed while its source observation was staged.",
					});
				}
			} else {
				const openHead = await ctx.db
					.query("catalogWorkspaceSourceProposalHeads")
					.withIndex("by_project_and_messageId", (q) =>
						q
							.eq("projectId", args.projectId)
							.eq("messageId", proposal.messageId),
					)
					.unique();
				if (
					!openHead ||
					openHead.projectId !== args.projectId ||
					openHead.messageId !== proposal.messageId ||
					openHead.proposalId !== proposal._id ||
					openHead.sourceValue !== proposal.sourceValue ||
					openHead.sourceFingerprint !== proposal.sourceFingerprint ||
					openHead.basisGitValueFingerprint !==
						proposal.basisGitValueFingerprint ||
					openHead.basisGitValueRevision !== proposal.basisGitValueRevision
				) {
					throw new ConvexError({
						code: "CONFLICT",
						message:
							"The current Source Proposal changed while its source observation was staged.",
					});
				}
			}
			const existingHeads = await ctx.db
				.query("restoreProposalResolutionHeads")
				.withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
				.take(MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS + 1);
			if (
				existingHeads.length > MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS ||
				existingHeads.some(
					(head) =>
						head.projectId !== args.projectId ||
						head.messageId !== proposal.messageId,
				)
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Source Proposal observations exceed their supported envelope.",
				});
			}
			for (const head of existingHeads) {
				const observedProjection = await projectionPublicationStateFor(
					ctx,
					head.projectionId,
				);
				if (
					!observedProjection ||
					observedProjection.projectionId !== head.projectionId ||
					observedProjection.projectId !== args.projectId
				) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"Source Proposal observation points to a missing projection.",
					});
				}
				if (observedProjection.status === "published") {
					throw new ConvexError({
						code: "CONFLICT",
						message:
							"A Source Proposal was already resolved by an accepted Baseline.",
					});
				}
			}
			if (existingHeads.length === MAX_RESTORE_PROPOSAL_RESOLUTION_HEADS) {
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"Source Proposal observation is contended; retry the ingestion after competing staging completes.",
				});
			}
			await ctx.db.insert("restoreProposalResolutionHeads", {
				projectId: args.projectId,
				proposalId: proposal._id,
				projectionId: projection._id,
				messageId: observation.messageId,
				status:
					observation.value === proposal.sourceValue ? "landed" : "superseded",
			});
		}
		await ctx.db.patch(projection._id, {
			stagedSourceProposalObservationCount: nextCount,
			stagedSourceProposalObservationByteLength: nextByteLength,
			...(args.isFinal ? { sourceProposalObservationsStatus: "staged" } : {}),
		});
		return null;
	},
});

async function discardBatch(
	ctx: MutationCtx,
	projectionId: Id<"catalogProjections">,
): Promise<boolean> {
	const projection = await ctx.db.get(projectionId);
	if (projection?.status !== "staging") return true;
	const processingRows = await ctx.db
		.query("catalogProcessingInputs")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (processingRows.length > 0) {
		for (const row of processingRows) await ctx.db.delete(row._id);
		return false;
	}

	// Delete one normalized row kind per transaction. A row caps at 320 KiB, so
	// sixteen deletes stay below a conservative 8 MiB payload budget even when
	// a pathological catalog key or bound path is unusually large.
	const messageRows = await ctx.db
		.query("catalogProjectionMessages")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (messageRows.length > 0) {
		for (const row of messageRows) await ctx.db.delete(row._id);
		return false;
	}
	const gitChangeRows = await ctx.db
		.query("catalogProjectionGitChanges")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (gitChangeRows.length > 0) {
		for (const row of gitChangeRows) await ctx.db.delete(row._id);
		return false;
	}
	const translationResidueRows = await ctx.db
		.query("catalogProjectionTranslationResidues")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (translationResidueRows.length > 0) {
		for (const row of translationResidueRows) await ctx.db.delete(row._id);
		return false;
	}
	const restorationRows = await ctx.db
		.query("catalogProjectionRestorations")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (restorationRows.length > 0) {
		for (const row of restorationRows) await ctx.db.delete(row._id);
		return false;
	}
	const proposalResolutionHeads = await ctx.db
		.query("restoreProposalResolutionHeads")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (proposalResolutionHeads.length > 0) {
		for (const head of proposalResolutionHeads) {
			await ctx.db.delete(head._id);
		}
		return false;
	}
	const archiveValueRows = await ctx.db
		.query("catalogProjectionArchiveValues")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (archiveValueRows.length > 0) {
		for (const row of archiveValueRows) await ctx.db.delete(row._id);
		return false;
	}
	const archiveStateValueRows = await ctx.db
		.query("catalogProjectionArchiveStateValues")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (archiveStateValueRows.length > 0) {
		for (const row of archiveStateValueRows) await ctx.db.delete(row._id);
		return false;
	}
	const archiveKeyRows = await ctx.db
		.query("catalogProjectionArchiveKeys")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (archiveKeyRows.length > 0) {
		for (const row of archiveKeyRows) await ctx.db.delete(row._id);
		return false;
	}
	const archiveLocaleRows = await ctx.db
		.query("catalogProjectionArchiveLocales")
		.withIndex("by_projection", (q) => q.eq("projectionId", projectionId))
		.take(MAX_DELETES_PER_MUTATION);
	if (archiveLocaleRows.length > 0) {
		for (const row of archiveLocaleRows) await ctx.db.delete(row._id);
		return false;
	}
	if (projection.reconciliationReportId) {
		const report = await ctx.db.get(projection.reconciliationReportId);
		if (
			!report ||
			report.projectId !== projection.projectId ||
			report.projectionId !== projectionId ||
			report.status !== "staging"
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"A staging catalog projection has an invalid Reconciliation Report.",
			});
		}
		const reportFacts = await ctx.db
			.query("reconciliationReportFacts")
			.withIndex("by_report", (q) => q.eq("reportId", report._id))
			.take(MAX_DELETES_PER_MUTATION);
		if (reportFacts.length > 0) {
			for (const fact of reportFacts) await ctx.db.delete(fact._id);
			return false;
		}
		const reportRows = await ctx.db
			.query("reconciliationReportRows")
			.withIndex("by_report", (q) => q.eq("reportId", report._id))
			.take(MAX_DELETES_PER_MUTATION);
		if (reportRows.length > 0) {
			for (const row of reportRows) await ctx.db.delete(row._id);
			return false;
		}
		if (report.workHandoffId) {
			const handoff = await ctx.db.get(report.workHandoffId);
			if (
				!handoff ||
				handoff.projectId !== projection.projectId ||
				handoff.reportId !== report._id ||
				handoff.status !== "staging"
			) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"A staging catalog projection has an invalid Reconciliation Report Work Hand-off.",
				});
			}
			const handoffKeys = await ctx.db
				.query("reconciliationWorkHandoffKeys")
				.withIndex("by_handoff", (q) => q.eq("handoffId", handoff._id))
				.take(MAX_DELETES_PER_MUTATION);
			if (handoffKeys.length > 0) {
				for (const key of handoffKeys) await ctx.db.delete(key._id);
				return false;
			}
			await ctx.db.delete(handoff._id);
		}
		await ctx.db.delete(report._id);
	}
	const publicationState = await projectionPublicationStateFor(
		ctx,
		projectionId,
	);
	if (
		!publicationState ||
		publicationState.projectionId !== projectionId ||
		publicationState.projectId !== projection.projectId ||
		publicationState.status !== "staging" ||
		publicationState.snapshotId !== undefined
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A staging projection has an invalid visibility record.",
		});
	}
	await ctx.db.delete(publicationState._id);
	await ctx.db.delete(projectionId);
	return true;
}

/** Continue private staging cleanup in bounded transactions. Scheduled calls
 * have no user identity, so this function relies on its internal-only surface
 * and refuses to touch a published projection. */
export const continueDiscard = internalMutation({
	args: { projectionId: v.id("catalogProjections") },
	handler: async (ctx, args) => {
		const done = await discardBatch(ctx, args.projectionId);
		if (!done) {
			await ctx.scheduler.runAfter(
				0,
				internal.catalogProjection.continueDiscard,
				args,
			);
		}
		return null;
	},
});

/** Request cleanup of a projection the current editor owns. */
export const discard = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "staging" ||
			projection.snapshotId !== undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A staging catalog projection for this project was not found.",
			});
		}
		const done = await discardBatch(ctx, args.projectionId);
		if (!done) {
			await ctx.scheduler.runAfter(
				0,
				internal.catalogProjection.continueDiscard,
				{ projectionId: args.projectionId },
			);
		}
		return null;
	},
});

export async function activeProjectionFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"catalogProjections"> | null> {
	const project = await ctx.db.get(projectId);
	if (!project?.activeCatalogProjectionId) return null;
	const projection = await ctx.db.get(project.activeCatalogProjectionId);
	if (
		!projection ||
		projection.projectId !== projectId ||
		projection.status !== "published" ||
		projection.snapshotId === undefined ||
		projection.snapshotId !== project.baselineSnapshotId
	) {
		return null;
	}
	return projection;
}

function reconciliationEnvelopeFor(projection: Doc<"catalogProjections">): {
	changeCount: number;
	byteLength: number;
} {
	const fields = [
		projection.expectedGitChangeCount,
		projection.expectedGitChangeByteLength,
		projection.stagedGitChangeCount,
		projection.stagedGitChangeByteLength,
		projection.gitChangesStatus,
	];
	if (fields.every((field) => field === undefined)) {
		// #38 projections predate Git-change reconciliation. They are a quiet
		// accepted baseline, not a partial #39 transition.
		return { changeCount: 0, byteLength: 0 };
	}
	if (
		projection.expectedGitChangeCount === undefined ||
		projection.expectedGitChangeByteLength === undefined ||
		projection.stagedGitChangeCount === undefined ||
		projection.stagedGitChangeByteLength === undefined ||
		projection.gitChangesStatus !== "staged" ||
		projection.expectedGitChangeCount < 0 ||
		projection.expectedGitChangeCount > MAX_WORKING_CATALOG_ROWS ||
		projection.expectedGitChangeByteLength < 0 ||
		projection.expectedGitChangeByteLength > MAX_WORKING_CATALOG_BYTES ||
		projection.stagedGitChangeCount !== projection.expectedGitChangeCount ||
		projection.stagedGitChangeByteLength !==
			projection.expectedGitChangeByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active catalog reconciliation is incomplete.",
		});
	}
	return {
		changeCount: projection.expectedGitChangeCount,
		byteLength: projection.expectedGitChangeByteLength,
	};
}

/** The Archive Reconciliation uses the same staging discipline as projected
 * values and Git changes. Older accepted projections predate this envelope and
 * are deliberately quiet rather than being treated as incomplete. */
export function archiveReconciliationEnvelopeFor(
	projection: Doc<"catalogProjections">,
): {
	keyCount: number;
	localeCount: number;
	valueCount: number;
	byteLength: number;
} {
	const fields = [
		projection.expectedArchiveKeyCount,
		projection.expectedArchiveLocaleCount,
		projection.expectedArchiveValueCount,
		projection.expectedArchiveByteLength,
		projection.stagedArchiveKeyCount,
		projection.stagedArchiveLocaleCount,
		projection.stagedArchiveValueCount,
		projection.stagedArchiveByteLength,
		projection.archiveStatus,
	];
	if (fields.every((field) => field === undefined)) {
		return { keyCount: 0, localeCount: 0, valueCount: 0, byteLength: 0 };
	}
	if (
		projection.expectedArchiveKeyCount === undefined ||
		projection.expectedArchiveLocaleCount === undefined ||
		projection.expectedArchiveValueCount === undefined ||
		projection.expectedArchiveByteLength === undefined ||
		projection.stagedArchiveKeyCount === undefined ||
		projection.stagedArchiveLocaleCount === undefined ||
		projection.stagedArchiveValueCount === undefined ||
		projection.stagedArchiveByteLength === undefined ||
		projection.archiveStatus !== "staged" ||
		projection.expectedArchiveKeyCount < 0 ||
		projection.expectedArchiveKeyCount > MAX_WORKING_CATALOG_KEYS ||
		projection.expectedArchiveLocaleCount < 0 ||
		projection.expectedArchiveLocaleCount > MAX_PROJECTED_LOCALES ||
		projection.expectedArchiveValueCount < 0 ||
		projection.expectedArchiveValueCount > MAX_WORKING_CATALOG_ROWS ||
		projection.expectedArchiveByteLength < 0 ||
		projection.expectedArchiveByteLength > MAX_ARCHIVE_RECONCILIATION_BYTES ||
		projection.stagedArchiveKeyCount !== projection.expectedArchiveKeyCount ||
		projection.stagedArchiveLocaleCount !==
			projection.expectedArchiveLocaleCount ||
		projection.stagedArchiveValueCount !==
			projection.expectedArchiveValueCount ||
		projection.stagedArchiveByteLength !== projection.expectedArchiveByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active Archive Reconciliation is incomplete.",
		});
	}
	return {
		keyCount: projection.expectedArchiveKeyCount,
		localeCount: projection.expectedArchiveLocaleCount,
		valueCount: projection.expectedArchiveValueCount,
		byteLength: projection.expectedArchiveByteLength,
	};
}

/** The carry-forward archive state is complete before a projection can publish.
 * It makes restoration a bounded read of the immediately prior accepted state,
 * rather than a scan of unbounded Archive Reconciliation history. */
export function archiveStateEnvelopeFor(
	projection: Doc<"catalogProjections">,
): {
	valueCount: number;
	byteLength: number;
} {
	const fields = [
		projection.expectedArchiveStateValueCount,
		projection.expectedArchiveStateByteLength,
		projection.stagedArchiveStateValueCount,
		projection.stagedArchiveStateByteLength,
		projection.archiveStateStatus,
	];
	if (fields.every((field) => field === undefined)) {
		return { valueCount: 0, byteLength: 0 };
	}
	if (
		projection.expectedArchiveStateValueCount === undefined ||
		projection.expectedArchiveStateByteLength === undefined ||
		projection.stagedArchiveStateValueCount === undefined ||
		projection.stagedArchiveStateByteLength === undefined ||
		projection.archiveStateStatus !== "staged" ||
		projection.expectedArchiveStateValueCount < 0 ||
		projection.expectedArchiveStateValueCount > MAX_WORKING_CATALOG_ROWS ||
		projection.expectedArchiveStateByteLength < 0 ||
		projection.expectedArchiveStateByteLength >
			MAX_ARCHIVE_RECONCILIATION_BYTES ||
		projection.stagedArchiveStateValueCount !==
			projection.expectedArchiveStateValueCount ||
		projection.stagedArchiveStateByteLength !==
			projection.expectedArchiveStateByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active archive state is incomplete.",
		});
	}
	return {
		valueCount: projection.expectedArchiveStateValueCount,
		byteLength: projection.expectedArchiveStateByteLength,
	};
}

function restorationEnvelopeFor(projection: Doc<"catalogProjections">): {
	valueCount: number;
	byteLength: number;
} {
	const fields = [
		projection.expectedRestoreValueCount,
		projection.expectedRestoreByteLength,
		projection.stagedRestoreValueCount,
		projection.stagedRestoreByteLength,
		projection.restoreStatus,
	];
	if (fields.every((field) => field === undefined)) {
		return { valueCount: 0, byteLength: 0 };
	}
	if (
		projection.expectedRestoreValueCount === undefined ||
		projection.expectedRestoreByteLength === undefined ||
		projection.stagedRestoreValueCount === undefined ||
		projection.stagedRestoreByteLength === undefined ||
		projection.restoreStatus !== "staged" ||
		projection.expectedRestoreValueCount < 0 ||
		projection.expectedRestoreValueCount > MAX_WORKING_CATALOG_ROWS ||
		projection.expectedRestoreByteLength < 0 ||
		projection.expectedRestoreByteLength > MAX_WORKING_CATALOG_BYTES ||
		projection.stagedRestoreValueCount !==
			projection.expectedRestoreValueCount ||
		projection.stagedRestoreByteLength !== projection.expectedRestoreByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active automatic restoration set is incomplete.",
		});
	}
	return {
		valueCount: projection.expectedRestoreValueCount,
		byteLength: projection.expectedRestoreByteLength,
	};
}

function restorationFromRow(
	row: Doc<"catalogProjectionRestorations">,
): AutomaticRestoration {
	return {
		localeId: row.localeId,
		localeCode: row.localeCode,
		catalogPath: row.catalogPath,
		catalogIndex: row.catalogIndex,
		messageId: row.messageId,
		value: row.value,
		...(row.metadataCatalogPath === undefined
			? {}
			: { metadataCatalogPath: row.metadataCatalogPath }),
		...(row.metadataSnapshotId === undefined
			? {}
			: { metadataSnapshotId: row.metadataSnapshotId }),
		sourceFingerprint: row.sourceFingerprint,
		materialized: row.materialized,
		restoredFromSnapshotId: row.restoredFromSnapshotId,
	};
}

export function assertWorkingCatalogEnvelope(
	projection: Doc<"catalogProjections">,
): void {
	if (
		projection.expectedKeyCount > MAX_WORKING_CATALOG_KEYS ||
		projection.expectedMessageCount > MAX_WORKING_CATALOG_ROWS ||
		projection.expectedByteLength > MAX_WORKING_CATALOG_BYTES ||
		projection.stagedKeyCount !== projection.expectedKeyCount ||
		projection.stagedMessageCount !== projection.expectedMessageCount ||
		projection.stagedByteLength !== projection.expectedByteLength
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The active catalog projection is incomplete.",
		});
	}
}

/** Shape a verified working catalog for public readers without exposing the
 * projection's internal staging records. The Catalog Workspace uses this same
 * adapter after it has substituted current translator-authored values. */
export function readActiveCatalog(
	projection: Doc<"catalogProjections">,
	rows: readonly Doc<"catalogProjectionMessages">[],
	options: { includeGitValueFingerprint?: boolean } = {},
) {
	const reconciliation = reconciliationEnvelopeFor(projection);
	archiveReconciliationEnvelopeFor(projection);
	archiveStateEnvelopeFor(projection);

	// Shape either a bounded page or an internal complete reference catalog.
	const valuesByCatalogIndex = new Map<number, typeof rows>();
	for (const row of rows) {
		valuesByCatalogIndex.set(row.catalogIndex, [
			...(valuesByCatalogIndex.get(row.catalogIndex) ?? []),
			row,
		]);
	}
	const sourceMessages = rows
		.filter((row) => row.isSource)
		.sort((a, b) => a.catalogIndex - b.catalogIndex);
	const keys = [];
	for (const sourceMessage of sourceMessages) {
		const values = valuesByCatalogIndex.get(sourceMessage.catalogIndex) ?? [];
		if (values.length > MAX_PROJECTED_LOCALES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog projection exceeds its supported Locale envelope.",
			});
		}
		const orderedValues = [...values].sort(
			(a, b) =>
				Number(b.isSource) - Number(a.isSource) ||
				a.localeCode.localeCompare(b.localeCode),
		);
		const argumentNames = [
			...new Set(orderedValues.flatMap((value) => value.argumentNames)),
		];
		keys.push({
			id: sourceMessage.messageId,
			icuType: sourceMessage.icuType,
			messageSignature: {
				declaredPlaceholderNames: sourceMessage.declaredPlaceholderNames ?? [],
				declaredPlaceholderNamesComplete:
					sourceMessage.declaredPlaceholderNamesComplete ?? true,
				declaredPlaceholderNameCount:
					sourceMessage.declaredPlaceholderNameCount ?? 0,
				argumentNames,
				argumentNamesComplete: orderedValues.every(
					(value) => value.argumentNamesComplete,
				),
			},
			values: orderedValues.map((value) => {
				return {
					localeId: value.localeId,
					localeCode: value.localeCode,
					catalogPath: value.catalogPath,
					isSource: value.isSource,
					value: value.value,
					...(value.metadataCatalogPath === undefined
						? {}
						: { metadataCatalogPath: value.metadataCatalogPath }),
					...(value.metadataSnapshotId === undefined
						? {}
						: { metadataSnapshotId: value.metadataSnapshotId }),
					...(value.restoredFromSnapshotId === undefined
						? {}
						: {
								restoredFromSnapshotId: value.restoredFromSnapshotId,
							}),
					...(value.metadataTransforms === undefined
						? {}
						: {
								metadataTransforms: value.metadataTransforms.map(
									(transform) => ({ ...transform }),
								),
							}),
					sourceFingerprint: value.sourceFingerprint,
					icuType: value.icuType,
					argumentNamesComplete: value.argumentNamesComplete,
					argumentNameCount: value.argumentNameCount,
					...(options.includeGitValueFingerprint &&
					value.gitValueFingerprint !== undefined
						? { gitValueFingerprint: value.gitValueFingerprint }
						: {}),
					snapshotId: projection.snapshotId,
					materialized: value.materialized,
				};
			}),
		});
	}

	return {
		projectionId: projection._id,
		snapshotId: projection.snapshotId,
		previousSnapshotId: projection.previousBaselineSnapshotId ?? null,
		gitChangeCount: reconciliation.changeCount,
		keys,
	};
}

/** Continuations must pin the published generation returned on the first page. */
export async function publishedReadProjection(
	ctx: QueryCtx,
	args: {
		projectId: Id<"projects">;
		projectionId?: Id<"catalogProjections">;
		cursor?: string | null;
	},
) {
	if (args.cursor && !args.projectionId)
		throw new ConvexError({
			code: "VALIDATION",
			message: "A continuation requires its projectionId.",
		});
	const projection = args.projectionId
		? await ctx.db.get(args.projectionId)
		: await activeProjectionFor(ctx, args.projectId);
	if (
		projection &&
		(projection.projectId !== args.projectId ||
			projection.status !== "published")
	)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Published catalog not found.",
		});
	if (args.projectionId && !projection)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Published catalog not found.",
		});
	return projection;
}

export const getActive = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.optional(v.id("catalogProjections")),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await publishedReadProjection(ctx, args);
		if (!projection) return null;
		const page = await ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_catalogIndex", (q) =>
				q.eq("projectionId", projection._id),
			)
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 32,
				maximumBytesRead: 512 * 1024,
			});
		const rows = [...page.page];
		for (const messageId of new Set(rows.map((row) => row.messageId))) {
			if (rows.some((row) => row.messageId === messageId && row.isSource))
				continue;
			const source = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", messageId)
						.eq("isSource", true),
				)
				.unique();
			if (source) rows.push(source);
		}
		return {
			...readActiveCatalog(projection, rows),
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/** The automatic target restorations that accompanied the active Baseline
 * transition. They are derived from durable projection provenance rather than
 * from a transient action response, so readers can inspect them later. */
export const getRestorations = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.optional(v.id("catalogProjections")),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await publishedReadProjection(ctx, args);
		if (!projection) return null;
		restorationEnvelopeFor(projection);
		const page = await ctx.db
			.query("catalogProjectionRestorations")
			.withIndex("by_projection_and_catalogIndex", (q) =>
				q.eq("projectionId", projection._id),
			)
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 100,
				maximumBytesRead: 512 * 1024,
			});
		const restorations = page.page.map(restorationFromRow);
		const valuesByCatalogIndex = new Map<number, AutomaticRestoration[]>();
		for (const restoration of restorations) {
			valuesByCatalogIndex.set(restoration.catalogIndex, [
				...(valuesByCatalogIndex.get(restoration.catalogIndex) ?? []),
				restoration,
			]);
		}
		if (valuesByCatalogIndex.size > MAX_WORKING_CATALOG_KEYS) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Automatic restorations exceed the working-catalog key envelope.",
			});
		}
		const keys = [...valuesByCatalogIndex.entries()]
			.sort(([left], [right]) => left - right)
			.map(([catalogIndex, values]) => {
				const [first] = values;
				if (
					!first ||
					values.length > MAX_PROJECTED_LOCALES ||
					new Set(values.map((value) => value.localeId)).size !==
						values.length ||
					values.some((value) => value.messageId !== first.messageId)
				) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"Automatic restorations do not form valid Locale value groups.",
					});
				}
				return {
					id: first.messageId,
					catalogIndex,
					origin: "automatic_restore" as const,
					values: [...values]
						.sort((left, right) =>
							left.localeCode.localeCompare(right.localeCode),
						)
						.map((value) => ({
							localeId: value.localeId,
							localeCode: value.localeCode,
							catalogPath: value.catalogPath,
							value: value.value,
							...(value.metadataCatalogPath === undefined
								? {}
								: { metadataCatalogPath: value.metadataCatalogPath }),
							...(value.metadataSnapshotId === undefined
								? {}
								: { metadataSnapshotId: value.metadataSnapshotId }),
							sourceFingerprint: value.sourceFingerprint,
							materialized: value.materialized,
							restoredFromSnapshotId: value.restoredFromSnapshotId,
							origin: "automatic_restore" as const,
						})),
				};
			});
		return {
			projectionId: projection._id,
			snapshotId: projection.snapshotId,
			previousSnapshotId: projection.previousBaselineSnapshotId ?? null,
			keys,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/** The current Baseline transition's Git-authored consequences. These are a
 * review surface, not translator history: both sides deliberately retain
 * Snapshot provenance. */
export const getGitChanges = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.optional(v.id("catalogProjections")),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await publishedReadProjection(ctx, args);
		if (!projection) return null;
		const reconciliation = reconciliationEnvelopeFor(projection);
		const previousSnapshotId = projection.previousBaselineSnapshotId;
		if (reconciliation.changeCount > 0 && !previousSnapshotId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Git-authored changes are missing their previous Snapshot provenance.",
			});
		}
		if (previousSnapshotId) {
			const previousSnapshot = await ctx.db.get(previousSnapshotId);
			if (!previousSnapshot || previousSnapshot.projectId !== args.projectId) {
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Git-authored changes point to a missing previous Source Snapshot.",
				});
			}
		}
		const page = await ctx.db
			.query("catalogProjectionGitChanges")
			.withIndex("by_projection_and_catalogIndex", (q) =>
				q.eq("projectionId", projection._id),
			)
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 32,
				maximumBytesRead: 512 * 1024,
			});
		const rows = page.page;

		const valuesByCatalogIndex = new Map<number, typeof rows>();
		for (const row of rows) {
			valuesByCatalogIndex.set(row.catalogIndex, [
				...(valuesByCatalogIndex.get(row.catalogIndex) ?? []),
				row,
			]);
		}
		if (valuesByCatalogIndex.size > MAX_WORKING_CATALOG_KEYS) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Git-authored changes exceed the working-catalog key envelope.",
			});
		}
		const keys = [...valuesByCatalogIndex.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, values]) => {
				const [first] = values;
				if (!first) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Git-authored changes contain an empty key group.",
					});
				}
				if (
					values.length > MAX_PROJECTED_LOCALES ||
					new Set(values.map((value) => value.localeId)).size !==
						values.length ||
					values.some((value) => value.messageId !== first.messageId)
				) {
					throw new ConvexError({
						code: "INTEGRITY",
						message:
							"Git-authored changes do not form valid Locale value groups.",
					});
				}
				const orderedValues = [...values].sort(
					(left, right) =>
						Number(right.isSource) - Number(left.isSource) ||
						left.localeCode.localeCompare(right.localeCode),
				);
				return {
					id: first.messageId,
					values: orderedValues.map((value) => ({
						localeId: value.localeId,
						localeCode: value.localeCode,
						isSource: value.isSource,
						origin: "git" as const,
						previous: {
							snapshotId: previousSnapshotId ?? null,
							catalogPath: value.previousCatalogPath,
							value: value.previousValue,
							sourceFingerprint: value.previousSourceFingerprint,
							materialized: value.previousMaterialized,
						},
						current: {
							snapshotId: projection.snapshotId,
							catalogPath: value.catalogPath,
							value: value.value,
							sourceFingerprint: value.sourceFingerprint,
							materialized: value.materialized,
						},
					})),
				};
			});

		return {
			projectionId: projection._id,
			snapshotId: projection.snapshotId,
			previousSnapshotId: previousSnapshotId ?? null,
			keys,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});
