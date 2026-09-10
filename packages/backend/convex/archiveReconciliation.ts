import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	activeProjectionFor,
	archiveReconciliationEnvelopeFor,
	archiveStateEnvelopeFor,
	assertProjectedMessage,
	MAX_ARCHIVE_RECONCILIATION_BYTES,
	MAX_ARCHIVE_VALUE_BYTES,
	MAX_PROJECTED_LOCALES,
	MAX_RECONCILIATION_READ_PAGE_ROWS,
	MAX_WORKING_CATALOG_KEYS,
	MAX_WORKING_CATALOG_ROWS,
	type ProjectedMessage,
	projectedMessageFields,
	publishedReadProjection,
} from "./catalogProjection";
import {
	authorizeProjectIngestion,
	repositoryAdapterActorValidator,
	requireViewer,
} from "./permissions";

const MAX_ARCHIVE_MEMBERS_PER_STAGE_BATCH = 500;
const MAX_ARCHIVE_VALUES_PER_STAGE_BATCH = 500;
const MAX_ARCHIVE_STAGE_BATCH_BYTES = 512_000;
const MAX_ARCHIVE_LIST_PAGE_ROWS = 100;

export type AbsentTargetLocale = {
	localeId: Id<"locales">;
	localeCode: string;
	catalogPath: string;
};

export type ArchivedKey = {
	catalogIndex: number;
	messageId: string;
	sourceFingerprint: string;
};

export type ArchivedLocale = AbsentTargetLocale;

export type ArchivedValue = ProjectedMessage & {
	keyArchived: boolean;
	localeArchived: boolean;
	evidenceSnapshotId: Id<"sourceSnapshots">;
};

export type ArchiveReconciliation = {
	keys: ArchivedKey[];
	locales: ArchivedLocale[];
	values: ArchivedValue[];
};

const archivedKeyValidator = v.object({
	catalogIndex: v.number(),
	messageId: v.string(),
	sourceFingerprint: v.string(),
});

const archivedLocaleValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	catalogPath: v.string(),
});

const archivedValueValidator = v.object({
	...projectedMessageFields,
	keyArchived: v.boolean(),
	localeArchived: v.boolean(),
	evidenceSnapshotId: v.id("sourceSnapshots"),
});

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function archivedKeyByteLength(key: ArchivedKey): number {
	return encodedSize(key);
}

function archivedLocaleByteLength(locale: ArchivedLocale): number {
	return encodedSize(locale);
}

function archivedValueByteLength(value: ArchivedValue): number {
	return encodedSize(value);
}

function archiveByteLength(archive: ArchiveReconciliation): number {
	return (
		archive.keys.reduce((total, key) => total + archivedKeyByteLength(key), 0) +
		archive.locales.reduce(
			(total, locale) => total + archivedLocaleByteLength(locale),
			0,
		) +
		archive.values.reduce(
			(total, value) => total + archivedValueByteLength(value),
			0,
		)
	);
}

function assertArchivedKey(key: ArchivedKey): void {
	if (
		!Number.isInteger(key.catalogIndex) ||
		key.catalogIndex < 0 ||
		key.messageId.length === 0 ||
		key.sourceFingerprint.length === 0 ||
		archivedKeyByteLength(key) > MAX_ARCHIVE_VALUE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An archived key exceeds the supported reconciliation envelope.",
		});
	}
}

function assertArchivedLocale(locale: ArchivedLocale): void {
	if (
		locale.localeCode.length === 0 ||
		locale.catalogPath.length === 0 ||
		archivedLocaleByteLength(locale) > MAX_ARCHIVE_VALUE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"An archived target Locale exceeds the supported reconciliation envelope.",
		});
	}
}

function assertArchivedValue(value: ArchivedValue): void {
	assertProjectedMessage(value);
	if (
		(!value.keyArchived && !value.localeArchived) ||
		archivedValueByteLength(value) > MAX_ARCHIVE_VALUE_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"An archived catalog value exceeds the supported reconciliation envelope.",
		});
	}
}

function archiveValueIdentity(value: {
	localeId: Id<"locales">;
	messageId: string;
}): string {
	return JSON.stringify([value.localeId, value.messageId]);
}

/**
 * Derive the automatic actions caused by one accepted-baseline transition.
 *
 * We compare only the prior active projection to the newly staged one. Once a
 * member has left active scope, it is no longer present in the prior active
 * catalog, so subsequent no-op baselines do not duplicate the archive action.
 * Published action rows remain immutable history for restoration work later.
 */
export function archiveReconciliation(
	previousMessages: readonly ProjectedMessage[],
	currentMessages: readonly ProjectedMessage[],
	absentTargetLocales: readonly AbsentTargetLocale[],
	previousSnapshotId: Id<"sourceSnapshots"> | null,
	previousAbsentTargetLocaleIds: readonly Id<"locales">[],
): ArchiveReconciliation {
	const previousSourceById = new Map<string, ProjectedMessage>();
	const previousValueIdentities = new Set<string>();
	for (const message of previousMessages) {
		assertProjectedMessage(message);
		const valueIdentity = archiveValueIdentity(message);
		if (previousValueIdentities.has(valueIdentity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate Locale value.",
			});
		}
		previousValueIdentities.add(valueIdentity);
		if (!message.isSource) continue;
		if (previousSourceById.has(message.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The previous catalog projection contains a duplicate source key.",
			});
		}
		previousSourceById.set(message.messageId, message);
	}

	const currentSourceIds = new Set<string>();
	for (const message of currentMessages) {
		assertProjectedMessage(message);
		if (!message.isSource) continue;
		if (currentSourceIds.has(message.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The staged catalog projection contains a duplicate source key.",
			});
		}
		currentSourceIds.add(message.messageId);
	}

	const absentLocaleIds = new Set<Id<"locales">>();
	const absentCatalogPaths = new Set<string>();
	for (const locale of absentTargetLocales) {
		assertArchivedLocale(locale);
		if (
			absentLocaleIds.has(locale.localeId) ||
			absentCatalogPaths.has(locale.catalogPath)
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The Source Snapshot records a duplicate absent target Locale.",
			});
		}
		absentLocaleIds.add(locale.localeId);
		absentCatalogPaths.add(locale.catalogPath);
	}
	const previousAbsentLocaleIds = new Set<Id<"locales">>();
	for (const localeId of previousAbsentTargetLocaleIds) {
		if (previousAbsentLocaleIds.has(localeId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The prior Source Snapshot records a duplicate absent target Locale.",
			});
		}
		previousAbsentLocaleIds.add(localeId);
	}

	const keys = [...previousSourceById.values()]
		.filter((source) => !currentSourceIds.has(source.messageId))
		.map((source) => ({
			catalogIndex: source.catalogIndex,
			messageId: source.messageId,
			sourceFingerprint: source.sourceFingerprint,
		}))
		.sort((left, right) => left.catalogIndex - right.catalogIndex);
	for (const key of keys) assertArchivedKey(key);

	const archivedKeyIds = new Set(keys.map((key) => key.messageId));
	const newlyArchivedLocaleIds = new Set(
		absentTargetLocales
			.filter((locale) => !previousAbsentLocaleIds.has(locale.localeId))
			.map((locale) => locale.localeId),
	);
	if (previousMessages.length > 0 && previousSnapshotId === null) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"Archive Reconciliation is missing its prior Baseline Snapshot provenance.",
		});
	}
	const values: ArchivedValue[] = previousMessages.flatMap((message) => {
		const keyArchived = archivedKeyIds.has(message.messageId);
		const localeArchived = newlyArchivedLocaleIds.has(message.localeId);
		if (!keyArchived && !localeArchived) return [];
		if (!previousSnapshotId) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive Reconciliation is missing archived value provenance.",
			});
		}
		const value = {
			...message,
			keyArchived,
			localeArchived,
			evidenceSnapshotId: previousSnapshotId,
		};
		assertArchivedValue(value);
		return [value];
	});

	return {
		keys,
		locales: absentTargetLocales
			.filter((locale) => newlyArchivedLocaleIds.has(locale.localeId))
			.sort((left, right) => left.localeCode.localeCompare(right.localeCode)),
		values,
	};
}

/** The carry-forward state contains every value for a source key that remains
 * absent from the active Catalog Projection. It is intentionally derived from
 * immutable Archive Reconciliation evidence, but stays projection-local so a
 * later re-add never needs to scan unbounded history. */
export type ArchiveState = {
	values: ArchivedValue[];
};

type ArchivedKeyState = {
	source: ArchivedValue;
	targets: ArchivedValue[];
};

function archiveStateGroups(
	values: readonly ArchivedValue[],
): Map<string, ArchivedKeyState> {
	const groupedValues = new Map<string, ArchivedValue[]>();
	const identities = new Set<string>();
	for (const value of values) {
		assertArchivedValue(value);
		if (!value.keyArchived) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state contains a value without a source-key archive.",
			});
		}
		const identity = archiveValueIdentity(value);
		if (identities.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state contains a duplicate Locale value.",
			});
		}
		identities.add(identity);
		groupedValues.set(value.messageId, [
			...(groupedValues.get(value.messageId) ?? []),
			value,
		]);
	}
	const groups = new Map<string, ArchivedKeyState>();
	for (const [messageId, group] of groupedValues) {
		const source = group.filter((value) => value.isSource);
		if (
			source.length !== 1 ||
			group.length > MAX_PROJECTED_LOCALES ||
			group.some((value) => value.catalogIndex !== source[0]?.catalogIndex)
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: `Archive state does not form a valid source-key group for "${messageId}".`,
			});
		}
		const [archivedSource] = source;
		if (!archivedSource) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state is missing its source value.",
			});
		}
		groups.set(messageId, {
			source: archivedSource,
			targets: group.filter((value) => !value.isSource),
		});
	}
	return groups;
}

function projectionMessageIndexes(messages: readonly ProjectedMessage[]): {
	sourceById: Map<string, ProjectedMessage>;
	byIdentity: Map<string, ProjectedMessage>;
} {
	const sourceById = new Map<string, ProjectedMessage>();
	const byIdentity = new Map<string, ProjectedMessage>();
	for (const message of messages) {
		assertProjectedMessage(message);
		const identity = archiveValueIdentity(message);
		if (byIdentity.has(identity)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The staged catalog projection contains a duplicate Locale value.",
			});
		}
		byIdentity.set(identity, message);
		if (!message.isSource) continue;
		if (sourceById.has(message.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The staged catalog projection contains a duplicate source key.",
			});
		}
		sourceById.set(message.messageId, message);
	}
	return { sourceById, byIdentity };
}

/** Carry archive state forward only while the source key remains absent, then
 * add the keys that this accepted transition has newly archived. */
export function nextArchiveState(
	previous: ArchiveState,
	currentMessages: readonly ProjectedMessage[],
	archive: ArchiveReconciliation,
): ArchiveState {
	const previousGroups = archiveStateGroups(previous.values);
	const current = projectionMessageIndexes(currentMessages);
	const newlyArchived = archive.values.filter((value) => value.keyArchived);
	const newlyArchivedIds = new Set(
		newlyArchived.map((value) => value.messageId),
	);
	const values = [...previousGroups.entries()].flatMap(([messageId, group]) => {
		// A new Archive Reconciliation records the latest full state for this
		// source key, including any value restored on an earlier re-add.
		if (newlyArchivedIds.has(messageId)) return [];
		const currentSource = current.sourceById.get(messageId);
		if (!currentSource) return [group.source, ...group.targets];
		if (
			currentSource.value !== group.source.value ||
			currentSource.sourceFingerprint !== group.source.sourceFingerprint
		) {
			return [];
		}
		const targets = group.targets.filter((target) => {
			const currentTarget = current.byIdentity.get(
				archiveValueIdentity(target),
			);
			// An explicit Git target wins and becomes the new source of target
			// truth. A missing target remains eligible for a later automatic
			// restoration, including after a binding path changes.
			return currentTarget === undefined || currentTarget.materialized;
		});
		return targets.length === 0 ? [] : [group.source, ...targets];
	});
	const retainedIds = new Set(values.map((value) => value.messageId));
	for (const value of newlyArchived) {
		if (retainedIds.has(value.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state attempted to retain a source key twice.",
			});
		}
	}
	values.push(...newlyArchived);
	archiveStateGroups(values);
	return {
		values: [...values].sort(
			(left, right) =>
				left.catalogIndex - right.catalogIndex ||
				Number(right.isSource) - Number(left.isSource) ||
				left.localeCode.localeCompare(right.localeCode),
		),
	};
}

/** Rehydrate only materialized target values whose source value is exactly the
 * archived English value. Git-authored target entries always win; a target is
 * eligible only when the current Catalog Document has no entry for the key. */
export function restoreByteIdenticalArchivedTargets(
	currentMessages: readonly ProjectedMessage[],
	previous: ArchiveState,
): ProjectedMessage[] {
	const groups = archiveStateGroups(previous.values);
	const current = projectionMessageIndexes(currentMessages);

	const eligibleTargets = new Map<string, ArchivedValue>();
	for (const [messageId, group] of groups) {
		const currentSource = current.sourceById.get(messageId);
		if (
			!currentSource ||
			group.source.value !== currentSource.value ||
			group.source.sourceFingerprint !== currentSource.sourceFingerprint
		) {
			continue;
		}
		for (const value of group.targets) {
			eligibleTargets.set(archiveValueIdentity(value), value);
		}
	}

	return currentMessages.map((message) => {
		if (message.isSource || !message.materialized) return message;
		const archived = eligibleTargets.get(archiveValueIdentity(message));
		if (!archived) return message;
		const {
			metadataCatalogPath: _metadataCatalogPath,
			metadataSnapshotId: _metadataSnapshotId,
			restoredFromSnapshotId: _restoredFromSnapshotId,
			...current
		} = message;
		const restoredFromSnapshotId =
			archived.restoredFromSnapshotId ?? archived.evidenceSnapshotId;
		return {
			...current,
			value: archived.value,
			...(archived.metadataCatalogPath === undefined
				? {}
				: {
						metadataCatalogPath: archived.metadataCatalogPath,
						metadataSnapshotId:
							archived.metadataSnapshotId ?? archived.evidenceSnapshotId,
					}),
			icuType: archived.icuType,
			argumentNames: [...archived.argumentNames],
			argumentNamesComplete: archived.argumentNamesComplete,
			argumentNameCount: archived.argumentNameCount,
			...(archived.metadataTransforms === undefined
				? {}
				: { metadataTransforms: [...archived.metadataTransforms] }),
			sourceFingerprint: archived.sourceFingerprint,
			restoredFromSnapshotId,
		};
	});
}

/** A target that Git re-adds unchanged alongside changed English is not a new
 * translation. Keep the archived Source Fingerprint so downstream workflow
 * reads it as ordinary stale translation work rather than as an automatic
 * restoration or a current decision. */
export function preserveArchivedTargetSourceFingerprint(
	currentMessages: readonly ProjectedMessage[],
	previous: ArchiveState,
): ProjectedMessage[] {
	const groups = archiveStateGroups(previous.values);
	const current = projectionMessageIndexes(currentMessages);
	const archivedFingerprints = new Map<string, string>();
	for (const [messageId, group] of groups) {
		const currentSource = current.sourceById.get(messageId);
		if (!currentSource || currentSource.value === group.source.value) continue;
		for (const target of group.targets) {
			const currentTarget = current.byIdentity.get(
				archiveValueIdentity(target),
			);
			if (
				currentTarget &&
				!currentTarget.materialized &&
				currentTarget.value === target.value
			) {
				archivedFingerprints.set(
					archiveValueIdentity(target),
					target.sourceFingerprint,
				);
			}
		}
	}
	return currentMessages.map((message) => {
		const sourceFingerprint = archivedFingerprints.get(
			archiveValueIdentity(message),
		);
		return sourceFingerprint === undefined || message.isSource
			? message
			: { ...message, sourceFingerprint };
	});
}

export function archiveEnvelope(archive: ArchiveReconciliation): {
	keyCount: number;
	localeCount: number;
	valueCount: number;
	byteLength: number;
} {
	for (const key of archive.keys) assertArchivedKey(key);
	for (const locale of archive.locales) assertArchivedLocale(locale);
	for (const value of archive.values) assertArchivedValue(value);
	const byteLength = archiveByteLength(archive);
	if (
		archive.keys.length > MAX_WORKING_CATALOG_KEYS ||
		archive.locales.length > MAX_PROJECTED_LOCALES ||
		archive.values.length > MAX_WORKING_CATALOG_ROWS ||
		byteLength > MAX_ARCHIVE_RECONCILIATION_BYTES
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Archive Reconciliation exceeds the supported Brickit envelope.",
		});
	}
	return {
		keyCount: archive.keys.length,
		localeCount: archive.locales.length,
		valueCount: archive.values.length,
		byteLength,
	};
}

export function archiveStateEnvelope(state: ArchiveState): {
	valueCount: number;
	byteLength: number;
} {
	archiveStateGroups(state.values);
	const envelope = archiveEnvelope({
		keys: [],
		locales: [],
		values: state.values,
	});
	return { valueCount: envelope.valueCount, byteLength: envelope.byteLength };
}

function batchesWithinEnvelope<T>(
	values: readonly T[],
	maxItems: number,
	byteLength: (value: T) => number,
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let batchBytes = 2;
	for (const value of values) {
		const valueBytes = byteLength(value);
		const separatorBytes = batch.length === 0 ? 0 : 1;
		if (
			batch.length === maxItems ||
			batchBytes + separatorBytes + valueBytes > MAX_ARCHIVE_STAGE_BATCH_BYTES
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

export function archiveKeyBatches(
	keys: readonly ArchivedKey[],
): ArchivedKey[][] {
	for (const key of keys) assertArchivedKey(key);
	return batchesWithinEnvelope(
		keys,
		MAX_ARCHIVE_MEMBERS_PER_STAGE_BATCH,
		archivedKeyByteLength,
	);
}

export function archiveLocaleBatches(
	locales: readonly ArchivedLocale[],
): ArchivedLocale[][] {
	for (const locale of locales) assertArchivedLocale(locale);
	return batchesWithinEnvelope(
		locales,
		MAX_ARCHIVE_MEMBERS_PER_STAGE_BATCH,
		archivedLocaleByteLength,
	);
}

export function archiveValueBatches(
	values: readonly ArchivedValue[],
): ArchivedValue[][] {
	for (const value of values) assertArchivedValue(value);
	return batchesWithinEnvelope(
		values,
		MAX_ARCHIVE_VALUES_PER_STAGE_BATCH,
		archivedValueByteLength,
	);
}

function assertArchiveTotals(args: {
	expectedArchiveKeyCount: number;
	expectedArchiveLocaleCount: number;
	expectedArchiveValueCount: number;
	expectedArchiveByteLength: number;
}): void {
	const counts = [
		args.expectedArchiveKeyCount,
		args.expectedArchiveLocaleCount,
		args.expectedArchiveValueCount,
	];
	if (
		counts.some((count) => !Number.isInteger(count) || count < 0) ||
		args.expectedArchiveKeyCount > MAX_WORKING_CATALOG_KEYS ||
		args.expectedArchiveLocaleCount > MAX_PROJECTED_LOCALES ||
		args.expectedArchiveValueCount > MAX_WORKING_CATALOG_ROWS ||
		!Number.isInteger(args.expectedArchiveByteLength) ||
		args.expectedArchiveByteLength < 0 ||
		args.expectedArchiveByteLength > MAX_ARCHIVE_RECONCILIATION_BYTES ||
		(counts[0] === 0 && counts[1] === 0 && counts[2] === 0) !==
			(args.expectedArchiveByteLength === 0)
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Archive Reconciliation exceeds the supported staging envelope.",
		});
	}
}

async function stagingProjection(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
): Promise<Doc<"catalogProjections">> {
	const projection = await ctx.db.get(projectionId);
	if (
		!projection ||
		projection.projectId !== projectId ||
		projection.status !== "staging" ||
		projection.snapshotId !== undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message:
				"A staging Archive Reconciliation for this project was not found.",
		});
	}
	return projection;
}

export const declare = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedArchiveKeyCount: v.number(),
		expectedArchiveLocaleCount: v.number(),
		expectedArchiveValueCount: v.number(),
		expectedArchiveByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveTotals(args);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		if (projection.archiveStatus !== "pending") {
			throw new ConvexError({
				code: "NOT_FOUND",
				message:
					"A pending Archive Reconciliation for this project was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedArchiveKeyCount: args.expectedArchiveKeyCount,
			expectedArchiveLocaleCount: args.expectedArchiveLocaleCount,
			expectedArchiveValueCount: args.expectedArchiveValueCount,
			expectedArchiveByteLength: args.expectedArchiveByteLength,
			archiveStatus: "staging",
		});
		return null;
	},
});

function assertArchiveBatch<T>(
	values: readonly T[],
	maxItems: number,
	assertValue: (value: T) => void,
): void {
	if (values.length === 0 || values.length > maxItems) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An Archive Reconciliation batch has an invalid member count.",
		});
	}
	for (const value of values) assertValue(value);
	if (encodedSize(values) > MAX_ARCHIVE_STAGE_BATCH_BYTES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "An Archive Reconciliation batch exceeds its byte budget.",
		});
	}
}

function archiveStagingCounters(projection: Doc<"catalogProjections">): {
	expectedKeyCount: number;
	expectedLocaleCount: number;
	expectedValueCount: number;
	expectedByteLength: number;
	stagedKeyCount: number;
	stagedLocaleCount: number;
	stagedValueCount: number;
	stagedByteLength: number;
} {
	if (
		projection.archiveStatus !== "staging" ||
		projection.expectedArchiveKeyCount === undefined ||
		projection.expectedArchiveLocaleCount === undefined ||
		projection.expectedArchiveValueCount === undefined ||
		projection.expectedArchiveByteLength === undefined ||
		projection.stagedArchiveKeyCount === undefined ||
		projection.stagedArchiveLocaleCount === undefined ||
		projection.stagedArchiveValueCount === undefined ||
		projection.stagedArchiveByteLength === undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message:
				"A staging Archive Reconciliation for this project was not found.",
		});
	}
	return {
		expectedKeyCount: projection.expectedArchiveKeyCount,
		expectedLocaleCount: projection.expectedArchiveLocaleCount,
		expectedValueCount: projection.expectedArchiveValueCount,
		expectedByteLength: projection.expectedArchiveByteLength,
		stagedKeyCount: projection.stagedArchiveKeyCount,
		stagedLocaleCount: projection.stagedArchiveLocaleCount,
		stagedValueCount: projection.stagedArchiveValueCount,
		stagedByteLength: projection.stagedArchiveByteLength,
	};
}

export const stageKeys = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		keys: v.array(archivedKeyValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveBatch(
			args.keys,
			MAX_ARCHIVE_MEMBERS_PER_STAGE_BATCH,
			assertArchivedKey,
		);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStagingCounters(projection);
		const batchByteLength = args.keys.reduce(
			(total, key) => total + archivedKeyByteLength(key),
			0,
		);
		if (
			counters.stagedKeyCount + args.keys.length > counters.expectedKeyCount ||
			counters.stagedByteLength + batchByteLength > counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Archive Reconciliation staging exceeded its declared envelope.",
			});
		}
		for (const key of args.keys) {
			await ctx.db.insert("catalogProjectionArchiveKeys", {
				projectId: args.projectId,
				projectionId: projection._id,
				...key,
			});
		}
		await ctx.db.patch(projection._id, {
			stagedArchiveKeyCount: counters.stagedKeyCount + args.keys.length,
			stagedArchiveByteLength: counters.stagedByteLength + batchByteLength,
		});
		return null;
	},
});

export const stageLocales = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		locales: v.array(archivedLocaleValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveBatch(
			args.locales,
			MAX_ARCHIVE_MEMBERS_PER_STAGE_BATCH,
			assertArchivedLocale,
		);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStagingCounters(projection);
		const batchByteLength = args.locales.reduce(
			(total, locale) => total + archivedLocaleByteLength(locale),
			0,
		);
		if (
			counters.stagedLocaleCount + args.locales.length >
				counters.expectedLocaleCount ||
			counters.stagedByteLength + batchByteLength > counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Archive Reconciliation staging exceeded its declared envelope.",
			});
		}
		for (const locale of args.locales) {
			await ctx.db.insert("catalogProjectionArchiveLocales", {
				projectId: args.projectId,
				projectionId: projection._id,
				...locale,
			});
		}
		await ctx.db.patch(projection._id, {
			stagedArchiveLocaleCount:
				counters.stagedLocaleCount + args.locales.length,
			stagedArchiveByteLength: counters.stagedByteLength + batchByteLength,
		});
		return null;
	},
});

export const stageValues = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		values: v.array(archivedValueValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveBatch(
			args.values,
			MAX_ARCHIVE_VALUES_PER_STAGE_BATCH,
			assertArchivedValue,
		);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStagingCounters(projection);
		const batchByteLength = args.values.reduce(
			(total, value) => total + archivedValueByteLength(value),
			0,
		);
		if (
			counters.stagedValueCount + args.values.length >
				counters.expectedValueCount ||
			counters.stagedByteLength + batchByteLength > counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Archive Reconciliation staging exceeded its declared envelope.",
			});
		}
		for (const value of args.values) {
			await ctx.db.insert("catalogProjectionArchiveValues", {
				projectId: args.projectId,
				projectionId: projection._id,
				...value,
				argumentNames: [...value.argumentNames],
				...(value.metadataTransforms === undefined
					? {}
					: { metadataTransforms: [...value.metadataTransforms] }),
				...(value.declaredPlaceholderNames === undefined
					? {}
					: {
							declaredPlaceholderNames: [...value.declaredPlaceholderNames],
						}),
			});
		}
		await ctx.db.patch(projection._id, {
			stagedArchiveValueCount: counters.stagedValueCount + args.values.length,
			stagedArchiveByteLength: counters.stagedByteLength + batchByteLength,
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
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStagingCounters(projection);
		if (
			counters.stagedKeyCount !== counters.expectedKeyCount ||
			counters.stagedLocaleCount !== counters.expectedLocaleCount ||
			counters.stagedValueCount !== counters.expectedValueCount ||
			counters.stagedByteLength !== counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive Reconciliation staging is incomplete.",
			});
		}
		await ctx.db.patch(projection._id, { archiveStatus: "staged" });
		return null;
	},
});

function assertArchiveStateTotals(args: {
	expectedArchiveStateValueCount: number;
	expectedArchiveStateByteLength: number;
}): void {
	if (
		!Number.isInteger(args.expectedArchiveStateValueCount) ||
		args.expectedArchiveStateValueCount < 0 ||
		args.expectedArchiveStateValueCount > MAX_WORKING_CATALOG_ROWS ||
		!Number.isInteger(args.expectedArchiveStateByteLength) ||
		args.expectedArchiveStateByteLength < 0 ||
		args.expectedArchiveStateByteLength > MAX_ARCHIVE_RECONCILIATION_BYTES ||
		(args.expectedArchiveStateValueCount === 0) !==
			(args.expectedArchiveStateByteLength === 0)
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Archive state exceeds the supported staging envelope.",
		});
	}
}

function archiveStateStagingCounters(projection: Doc<"catalogProjections">): {
	expectedValueCount: number;
	expectedByteLength: number;
	stagedValueCount: number;
	stagedByteLength: number;
} {
	if (
		projection.archiveStateStatus !== "staging" ||
		projection.expectedArchiveStateValueCount === undefined ||
		projection.expectedArchiveStateByteLength === undefined ||
		projection.stagedArchiveStateValueCount === undefined ||
		projection.stagedArchiveStateByteLength === undefined
	) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "A staging archive state for this project was not found.",
		});
	}
	return {
		expectedValueCount: projection.expectedArchiveStateValueCount,
		expectedByteLength: projection.expectedArchiveStateByteLength,
		stagedValueCount: projection.stagedArchiveStateValueCount,
		stagedByteLength: projection.stagedArchiveStateByteLength,
	};
}

/** Declare complete carried archive state before any row is staged, so a
 * Baseline Snapshot can never expose a partial restoration lookup. */
export const declareState = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		expectedArchiveStateValueCount: v.number(),
		expectedArchiveStateByteLength: v.number(),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveStateTotals(args);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		if (projection.archiveStateStatus !== "pending") {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "A pending archive state for this project was not found.",
			});
		}
		await ctx.db.patch(projection._id, {
			expectedArchiveStateValueCount: args.expectedArchiveStateValueCount,
			expectedArchiveStateByteLength: args.expectedArchiveStateByteLength,
			archiveStateStatus: "staging",
		});
		return null;
	},
});

export const stageStateValues = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		values: v.array(archivedValueValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		assertArchiveBatch(
			args.values,
			MAX_ARCHIVE_VALUES_PER_STAGE_BATCH,
			assertArchivedValue,
		);
		if (args.values.some((value) => !value.keyArchived)) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Archive state may contain only source-key archive values.",
			});
		}
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStateStagingCounters(projection);
		const batchByteLength = args.values.reduce(
			(total, value) => total + archivedValueByteLength(value),
			0,
		);
		if (
			counters.stagedValueCount + args.values.length >
				counters.expectedValueCount ||
			counters.stagedByteLength + batchByteLength > counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state staging exceeded its declared envelope.",
			});
		}
		for (const value of args.values) {
			await ctx.db.insert("catalogProjectionArchiveStateValues", {
				projectId: args.projectId,
				projectionId: projection._id,
				...value,
				argumentNames: [...value.argumentNames],
				...(value.metadataTransforms === undefined
					? {}
					: { metadataTransforms: [...value.metadataTransforms] }),
				...(value.declaredPlaceholderNames === undefined
					? {}
					: {
							declaredPlaceholderNames: [...value.declaredPlaceholderNames],
						}),
			});
		}
		await ctx.db.patch(projection._id, {
			stagedArchiveStateValueCount:
				counters.stagedValueCount + args.values.length,
			stagedArchiveStateByteLength: counters.stagedByteLength + batchByteLength,
		});
		return null;
	},
});

export const completeState = internalMutation({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeProjectIngestion(ctx, args.projectId, args.actor);
		const projection = await stagingProjection(
			ctx,
			args.projectId,
			args.projectionId,
		);
		const counters = archiveStateStagingCounters(projection);
		if (
			counters.stagedValueCount !== counters.expectedValueCount ||
			counters.stagedByteLength !== counters.expectedByteLength
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Archive state staging is incomplete.",
			});
		}
		await ctx.db.patch(projection._id, { archiveStateStatus: "staged" });
		return null;
	},
});

export function archivedValueFromRow(
	row:
		| Doc<"catalogProjectionArchiveValues">
		| Doc<"catalogProjectionArchiveStateValues">,
): ArchivedValue {
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
		...(row.firstSeenProjectionId
			? { firstSeenProjectionId: row.firstSeenProjectionId }
			: {}),
		...(row.introducedAt === undefined
			? {}
			: {
					introducedAt: row.introducedAt,
					introductionLocaleIds: [...(row.introductionLocaleIds ?? [])],
				}),
		materialized: row.materialized,
		keyArchived: row.keyArchived,
		localeArchived: row.localeArchived,
		evidenceSnapshotId: row.evidenceSnapshotId,
	};
}

/** Read the prior accepted archive state in bounded pages. The action that
 * stages a new projection verifies the returned projection ID on every page,
 * then carries the complete state forward before publication. */
export const statePage = internalQuery({
	args: {
		projectId: v.id("projects"),
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
				message: `An archive-state page may contain at most ${MAX_RECONCILIATION_READ_PAGE_ROWS} values.`,
			});
		}
		const projection = await activeProjectionFor(ctx, args.projectId);
		if (!projection) {
			return {
				projectionId: null,
				totalValueCount: 0,
				byteLength: 0,
				page: [],
				isDone: true,
				continueCursor: "",
			};
		}
		const envelope = archiveStateEnvelopeFor(projection);
		const page = await ctx.db
			.query("catalogProjectionArchiveStateValues")
			.withIndex("by_projection", (q) => q.eq("projectionId", projection._id))
			.paginate(args.paginationOpts);
		return {
			projectionId: projection._id,
			totalValueCount: envelope.valueCount,
			byteLength: envelope.byteLength,
			page: page.page.map(archivedValueFromRow),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

/** Value pages may split a message across pages. Published projection IDs pin
 * the history generation; clients merge values by message and Locale identity. */
async function archiveForProjection(
	ctx: QueryCtx,
	projection: Doc<"catalogProjections">,
	cursor: string | null = null,
) {
	const page = await ctx.db
		.query("catalogProjectionArchiveValues")
		.withIndex("by_projection_and_catalogIndex", (q) =>
			q.eq("projectionId", projection._id),
		)
		.paginate({ cursor, numItems: 100, maximumBytesRead: 512 * 1024 });
	const locales = await ctx.db
		.query("catalogProjectionArchiveLocales")
		.withIndex("by_projection", (q) => q.eq("projectionId", projection._id))
		.take(MAX_PROJECTED_LOCALES + 1);
	const groups = new Map<string, ArchivedValue[]>();
	for (const row of page.page) {
		const value = archivedValueFromRow(row);
		assertArchivedValue(value);
		const group = groups.get(value.messageId) ?? [];
		group.push(value);
		groups.set(value.messageId, group);
	}
	return {
		projectionId: projection._id,
		snapshotId: projection.snapshotId ?? null,
		previousSnapshotId: projection.previousBaselineSnapshotId ?? null,
		continueCursor: page.continueCursor,
		isDone: page.isDone,
		locales: locales
			.sort((a, b) => a.localeCode.localeCompare(b.localeCode))
			.map(({ localeId, localeCode, catalogPath }) => ({
				localeId,
				localeCode,
				catalogPath,
				origin: "archive_reconciliation" as const,
			})),
		keys: [...groups.entries()]
			.map(([id, values]) => {
				const first = values[0];
				if (!first)
					throw new ConvexError({
						code: "INTEGRITY",
						message: "Archive page contains an empty key group.",
					});
				return {
					id,
					catalogIndex: first.catalogIndex,
					keyArchived: first.keyArchived,
					origin: "archive_reconciliation" as const,
					values: values
						.sort(
							(a, b) =>
								Number(b.isSource) - Number(a.isSource) ||
								a.localeCode.localeCompare(b.localeCode),
						)
						.map((value) => ({
							...value,
							origin: "archive_reconciliation" as const,
						})),
				};
			})
			.sort((a, b) => a.catalogIndex - b.catalogIndex),
	};
}

export const getActive = query({
	args: {
		projectId: v.id("projects"),
		cursor: v.optional(v.union(v.string(), v.null())),
		projectionId: v.optional(v.id("catalogProjections")),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await publishedReadProjection(ctx, args);
		if (!projection) return null;
		return await archiveForProjection(ctx, projection, args.cursor ?? null);
	},
});

/** Read the automatic archive facts for one accepted Baseline transition.
 * `list` makes older transitions discoverable without returning unbounded
 * history in one query. */
export const get = query({
	args: {
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const projection = await ctx.db.get(args.projectionId);
		if (
			!projection ||
			projection.projectId !== args.projectId ||
			projection.status !== "published" ||
			projection.snapshotId === undefined
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "An accepted Archive Reconciliation was not found.",
			});
		}
		return await archiveForProjection(ctx, projection, args.cursor ?? null);
	},
});

/** Page archive-bearing transitions so retained history never becomes an
 * unbounded document or query result. */
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
			args.paginationOpts.numItems > MAX_ARCHIVE_LIST_PAGE_ROWS
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `An archive history page may contain at most ${MAX_ARCHIVE_LIST_PAGE_ROWS} transitions.`,
			});
		}
		const page = await ctx.db
			.query("catalogProjections")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.paginate(args.paginationOpts);
		return {
			...page,
			page: page.page.flatMap((projection) => {
				if (
					projection.status !== "published" ||
					projection.snapshotId === undefined
				) {
					return [];
				}
				const archive = archiveReconciliationEnvelopeFor(projection);
				if (
					archive.keyCount === 0 &&
					archive.localeCount === 0 &&
					archive.valueCount === 0
				) {
					return [];
				}
				return [
					{
						projectionId: projection._id,
						snapshotId: projection.snapshotId,
						previousSnapshotId: projection.previousBaselineSnapshotId ?? null,
						archiveKeyCount: archive.keyCount,
						archiveLocaleCount: archive.localeCount,
						archiveValueCount: archive.valueCount,
					},
				];
			}),
		};
	},
});
