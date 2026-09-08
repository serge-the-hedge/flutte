import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	action,
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
	query,
} from "./_generated/server";
import {
	type AbsentTargetLocale,
	type ArchivedValue,
	archiveEnvelope,
	archiveKeyBatches,
	archiveLocaleBatches,
	archiveReconciliation,
	archiveStateEnvelope,
	archiveValueBatches,
	nextArchiveState,
	preserveArchivedTargetSourceFingerprint,
	restoreByteIdenticalArchivedTargets,
} from "./archiveReconciliation";
import { readCatalogDiscovery } from "./catalogDiscovery";
import {
	type CatalogDocument,
	type JsonObject,
	parse,
} from "./catalogDocument";
import {
	MAX_PROCESSING_KEY_BYTES,
	type ProcessingInput,
} from "./catalogProcessing";
import {
	assignGitValueRevisions,
	assignValueFingerprints,
	attachIntroductionReviews,
	automaticRestorationBatches,
	automaticRestorationEnvelope,
	automaticRestorations,
	gitAuthoredChanges,
	gitChangeBatches,
	gitChangeEnvelope,
	MAX_PROJECTED_LOCALES,
	MAX_WORKING_CATALOG_BYTES,
	MAX_WORKING_CATALOG_KEYS,
	MAX_WORKING_CATALOG_ROWS,
	type ProjectedMessage,
	projectedMessageByteLength,
	projectionEnvelope,
	type SourceProposalObservation,
	sourceProposalObservationBatches,
	sourceProposalObservationEnvelope,
	stageBatches,
} from "./catalogProjection";
import { advanceWorkspaceReconciliationGeneration } from "./catalogWorkspace";
import {
	activateNavigationGeneration,
	assertNavigationIndexStagedForPublication,
	MAX_NAVIGATION_STAGE_STEPS,
} from "./catalogWorkspaceNavigation";
import {
	contractValueIdentity,
	reconcileContractTransforms,
	type SubmittedTargetFingerprint,
} from "./contractTransforms";
import { DEFAULT_INTEGRATION_BRANCH, now, sha256Hex } from "./lib";
import {
	assertDeliveryStaged,
	snapshotCatalogFiles,
	stageLocaleDeliveries,
} from "./localeDelivery";
import {
	declaredPlaceholderNames,
	messageFacts,
	storedFactNames,
} from "./messageFacts";
import {
	authorizeProjectIngestion,
	type RepositoryAdapterActor,
	repositoryAdapterActorValidator,
	requireEditor,
	requireViewer,
} from "./permissions";
import {
	assertStagedReconciliationReport,
	publishStagedReconciliationReport,
	reconciliationReportDraft,
	reconciliationReportEnvelope,
	stageReconciliationReportChunk,
	type UnboundLocaleFile,
} from "./reconciliationReports";
import {
	MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP,
	supportsRestoreProposalMessageId,
} from "./restoreProposals";
import {
	translationResidueBatches,
	translationResidueEnvelope,
	translationResidues,
} from "./translationResidue";

type Diagnostic = { catalogPath?: string; message: string };

type SubmittedFile = { catalogPath: string; content: string };

type Binding = {
	localeId: Id<"locales">;
	localeCode: string;
	catalogPath: string;
	isSource: boolean;
};

type Lineage = {
	baselineCommit: string;
	relationship: "ancestor" | "descendant" | "divergent";
	mergeBase: string;
};

type MatchedFile = Binding & SubmittedFile & { document: CatalogDocument };

type StoredSnapshotFile = {
	localeId: Id<"locales">;
	localeCode: string;
	isSource: boolean;
	catalogPath: string;
	storageId: Id<"_storage">;
	byteLength: number;
};

type UnboundSnapshotFile = SubmittedFile &
	Pick<UnboundLocaleFile, "declaredLocaleCode" | "messageCount">;

type StoredUnboundSnapshotFile = Omit<UnboundSnapshotFile, "content"> & {
	storageId: Id<"_storage">;
	byteLength: number;
};

type IngestionResult = {
	runId: Id<"snapshotIngestionRuns">;
	snapshotId: Id<"sourceSnapshots"> | null;
	reused: boolean;
	publishedProjection: boolean;
	needsProjection: boolean;
};

const diagnosticValidator = v.object({
	catalogPath: v.optional(v.string()),
	message: v.string(),
});

const absentTargetLocaleValidator = v.object({
	localeId: v.id("locales"),
	localeCode: v.string(),
	catalogPath: v.string(),
});

const unboundLocaleFileValidator = v.object({
	catalogPath: v.string(),
	storageId: v.id("_storage"),
	byteLength: v.number(),
	declaredLocaleCode: v.optional(v.string()),
	messageCount: v.optional(v.number()),
});

const lineageValidator = v.object({
	baselineCommit: v.string(),
	relationship: v.union(
		v.literal("ancestor"),
		v.literal("descendant"),
		v.literal("divergent"),
	),
	mergeBase: v.string(),
});

const MAX_PROJECT_LOCALES = 1_000;
const MAX_LISTED_SNAPSHOTS = 100;
const MAX_SNAPSHOT_FILES = MAX_PROJECT_LOCALES;
const MAX_INGEST_CONFLICT_RESTAGES = 2;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_SETUP_DIAGNOSTICS = 32;
const MAX_SYNC_SETUP_EVIDENCE_ROWS = 1_000;

const authorizeIngestion = authorizeProjectIngestion;

function assertSnapshotEnvelope(files: readonly SubmittedFile[]) {
	if (files.length > MAX_SNAPSHOT_FILES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: `A snapshot may contain at most ${MAX_SNAPSHOT_FILES} catalog files.`,
		});
	}
	const byteLength = new TextEncoder().encode(
		JSON.stringify(
			files.map(({ catalogPath, content }) => [catalogPath, content]),
		),
	).byteLength;
	if (byteLength > MAX_SNAPSHOT_BYTES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: `A snapshot request may contain at most ${MAX_SNAPSHOT_BYTES} bytes.`,
		});
	}
}

function assertAbsentTargetLocaleEvidence(
	files: readonly StoredSnapshotFile[],
	absentTargetLocales: readonly AbsentTargetLocale[],
): void {
	if (absentTargetLocales.length > MAX_PROJECTED_LOCALES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Snapshot absence evidence supports at most ${MAX_PROJECTED_LOCALES} target Locales.`,
		});
	}
	const seenLocaleIds = new Set(files.map((file) => file.localeId));
	const seenCatalogPaths = new Set(files.map((file) => file.catalogPath));
	for (const locale of absentTargetLocales) {
		if (
			locale.localeCode.length === 0 ||
			locale.catalogPath.length === 0 ||
			seenLocaleIds.has(locale.localeId) ||
			seenCatalogPaths.has(locale.catalogPath)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Absent target Locale evidence must name each bound Locale exactly once.",
			});
		}
		seenLocaleIds.add(locale.localeId);
		seenCatalogPaths.add(locale.catalogPath);
	}
}

function assertUnboundLocaleFileEvidence(
	files: readonly StoredSnapshotFile[],
	unboundLocaleFiles: readonly StoredUnboundSnapshotFile[],
): void {
	if (files.length + unboundLocaleFiles.length > MAX_SNAPSHOT_FILES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Snapshot evidence supports at most ${MAX_SNAPSHOT_FILES} files.`,
		});
	}
	const catalogPaths = new Set(files.map((file) => file.catalogPath));
	for (const file of unboundLocaleFiles) {
		if (
			file.catalogPath.length === 0 ||
			catalogPaths.has(file.catalogPath) ||
			file.byteLength < 0 ||
			(file.declaredLocaleCode !== undefined &&
				file.declaredLocaleCode.length === 0) ||
			(file.messageCount !== undefined &&
				(!Number.isInteger(file.messageCount) || file.messageCount < 0))
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Unbound Locale File evidence must name each submitted path exactly once.",
			});
		}
		catalogPaths.add(file.catalogPath);
	}
}

async function hashManifest(files: readonly SubmittedFile[]): Promise<string> {
	const manifest = [...files]
		.sort((a, b) => a.catalogPath.localeCompare(b.catalogPath))
		.map(({ catalogPath, content }) => [catalogPath, content] as const);
	return await sha256Hex(JSON.stringify(manifest));
}

function inspectUnboundLocaleFile(file: SubmittedFile): UnboundSnapshotFile {
	try {
		const document = parse(file.content);
		const declared = document.globals.find(
			(global) => global.name === "@@locale",
		)?.value;
		return {
			...file,
			...(typeof declared === "string" ? { declaredLocaleCode: declared } : {}),
			messageCount: document.messages.length,
		};
	} catch {
		// An unbound file is setup evidence, not a Locale Contract candidate. Its
		// raw bytes remain available even when it cannot yet form a Catalog Document.
		return file;
	}
}

/** Both ingestion and explicit binding realization enforce this same Locale
 * Contract before any derived rows can be published. */
function parseBoundCatalog(
	file: SubmittedFile,
	localeCode: string,
): CatalogDocument {
	const document = parse(file.content);
	const declared = document.globals.find(
		(global) => global.name === "@@locale",
	)?.value;
	if (declared !== localeCode)
		throw new ConvexError({
			code: "VALIDATION",
			message: `${file.catalogPath} is bound to the "${localeCode}" Locale but declares @@locale ${declared === undefined ? "nothing" : `"${String(declared)}"`}.`,
		});
	return document;
}

/**
 * Match the submitted files against the project's Locale Bindings and check
 * each one can be represented faithfully.
 *
 * Pure, and deliberately exhaustive rather than fail-fast: a developer fixing
 * a catalog wants every complaint at once, not one per round trip.
 */
function inspect(
	files: readonly SubmittedFile[],
	bindings: readonly Binding[],
): {
	diagnostics: Diagnostic[];
	matched: MatchedFile[];
	absentTargetLocales: AbsentTargetLocale[];
	unboundLocaleFiles: UnboundSnapshotFile[];
} {
	const diagnostics: Diagnostic[] = [];
	if (files.length > MAX_SNAPSHOT_FILES) {
		diagnostics.push({
			message: `A snapshot may contain at most ${MAX_SNAPSHOT_FILES} catalog files.`,
		});
	}
	const byPath = new Map(bindings.map((b) => [b.catalogPath, b] as const));
	const submitted = new Set(files.map((file) => file.catalogPath));
	const duplicatePaths = files
		.map((file) => file.catalogPath)
		.filter((path, index, paths) => paths.indexOf(path) !== index);
	for (const catalogPath of new Set(duplicatePaths)) {
		diagnostics.push({
			catalogPath,
			message: `More than one file was submitted for ${catalogPath}.`,
		});
	}

	if (bindings.length === 0) {
		diagnostics.push({
			message: "No Locale in this project is bound to a catalog file.",
		});
	}

	const absentTargetLocales: AbsentTargetLocale[] = [];
	for (const binding of bindings) {
		if (!submitted.has(binding.catalogPath)) {
			if (binding.isSource) {
				diagnostics.push({
					catalogPath: binding.catalogPath,
					message: `No file submitted for the "${binding.localeCode}" Locale, which is bound to ${binding.catalogPath}.`,
				});
			} else {
				absentTargetLocales.push({
					localeId: binding.localeId,
					localeCode: binding.localeCode,
					catalogPath: binding.catalogPath,
				});
			}
		}
	}

	const matched: MatchedFile[] = [];
	const unboundLocaleFiles: UnboundSnapshotFile[] = [];
	for (const file of files) {
		const binding = byPath.get(file.catalogPath);
		if (!binding) {
			unboundLocaleFiles.push(inspectUnboundLocaleFile(file));
			continue;
		}

		let document: CatalogDocument;
		try {
			document = parseBoundCatalog(file, binding.localeCode);
		} catch (error) {
			const data = (error as { data?: { message?: string } }).data;
			diagnostics.push({
				catalogPath: file.catalogPath,
				message: data?.message ?? String(error),
			});
			continue;
		}

		matched.push({ ...binding, ...file, document });
	}

	return { diagnostics, matched, absentTargetLocales, unboundLocaleFiles };
}

export const bindingsFor = internalQuery({
	args: {
		projectId: v.id("projects"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		await authorizeIngestion(ctx, args.projectId, args.actor);
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(MAX_PROJECT_LOCALES + 1);
		if (locales.length > MAX_PROJECT_LOCALES) {
			throw new ConvexError({
				code: "VALIDATION",
				message: `A project may bind at most ${MAX_PROJECT_LOCALES} Locales.`,
			});
		}
		const bindings = locales
			.filter(
				(locale) =>
					locale.archivedAt === undefined && locale.catalogPath !== undefined,
			)
			.map((locale) => ({
				localeId: locale._id,
				localeCode: locale.code,
				isSource: locale.isSource,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				catalogPath: locale.catalogPath!,
			}));
		const project = await ctx.db.get(args.projectId);
		if (!project)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		return {
			bindings,
			projectionId: project.activeCatalogProjectionId ?? null,
			localeBindingRevision: project.localeBindingRevision ?? 0,
		};
	},
});

/** The single setup read used by the local Repository Adapter. It deliberately
 * exposes bindings and the current Baseline as one small envelope so the CLI
 * never needs project IDs or internal Convex queries. */
export const repositoryAdapterContext = internalQuery({
	args: {
		projectId: v.id("projects"),
		actor: repositoryAdapterActorValidator,
	},
	handler: async (ctx, args) => {
		await authorizeIngestion(ctx, args.projectId, args.actor);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(MAX_PROJECT_LOCALES + 1);
		if (locales.length > MAX_PROJECT_LOCALES) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `A project may bind at most ${MAX_PROJECT_LOCALES} Locales.`,
			});
		}
		const bindings = locales
			.filter(
				(locale) =>
					locale.archivedAt === undefined && locale.catalogPath !== undefined,
			)
			.map((locale) => {
				if (locale.catalogPath === undefined) {
					throw new ConvexError({
						code: "INTEGRITY",
						message: "A bound Locale is missing its catalog path.",
					});
				}
				return {
					localeCode: locale.code,
					catalogPath: locale.catalogPath,
					isSource: locale.isSource,
				};
			});
		const baseline = project.baselineSnapshotId
			? await ctx.db.get(project.baselineSnapshotId)
			: null;
		const latest = await ctx.db
			.query("sourceSnapshots")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.order("desc")
			.first();
		const setupIssues: string[] = [];
		if (!bindings.some((binding) => binding.isSource)) {
			setupIssues.push(
				"Bind the source Locale to a catalog path before syncing.",
			);
		}
		if (!bindings.some((binding) => !binding.isSource)) {
			setupIssues.push("Bind at least one target Locale before syncing.");
		}
		if (bindings.length > MAX_PROJECTED_LOCALES)
			setupIssues.push(
				`At most ${MAX_PROJECTED_LOCALES} bound Locales fit the working catalog.`,
			);
		const projection = project.activeCatalogProjectionId
			? await ctx.db.get(project.activeCatalogProjectionId)
			: null;
		if (
			projection &&
			projection.expectedKeyCount * bindings.length > MAX_WORKING_CATALOG_ROWS
		)
			setupIssues.push(
				`These bindings exceed the ${MAX_WORKING_CATALOG_ROWS}-value working catalog limit.`,
			);
		return {
			version: 1,
			integrationBranch:
				project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
			canSubmit: setupIssues.length === 0,
			setupIssues,
			repository:
				project.repository ??
				baseline?.repository ??
				latest?.repository ??
				null,
			bindings,
			baseline: baseline
				? {
						id: baseline._id,
						repository: baseline.repository,
						commit: baseline.commit,
						manifestHash: baseline.manifestHash,
						kind: baseline.kind,
					}
				: null,
			limits: {
				maxFiles: MAX_SNAPSHOT_FILES,
				maxBytes: MAX_SNAPSHOT_BYTES,
				maxFileBytes: MAX_SNAPSHOT_BYTES,
				uploadProtocol: "file-manifest-v1",
				maxBoundLocales: MAX_PROJECTED_LOCALES,
				maxWorkingCatalogRows: MAX_WORKING_CATALOG_ROWS,
				maxWorkingCatalogBytes: MAX_WORKING_CATALOG_BYTES,
			},
		};
	},
});

type ProjectionFile = Pick<
	Binding,
	"localeId" | "localeCode" | "catalogPath" | "isSource"
> & { document: CatalogDocument };

type BindingBasis = {
	projectionId: Id<"catalogProjections"> | null;
	localeBindingRevision: number;
};

type ProjectionEvidence = BindingBasis & {
	projectId: Id<"projects">;
	files: {
		localeId: Id<"locales">;
		localeCode: string;
		catalogPath: string;
		isSource: boolean;
		storageId: Id<"_storage">;
	}[];
	absentTargetLocales: AbsentTargetLocale[];
	unboundLocaleFiles: (UnboundLocaleFile & { storageId: Id<"_storage"> })[];
};

type Identity = {
	projectId: Id<"projects">;
	repository: string;
	commit: string;
	manifestHash: string;
	lineage?: Lineage;
	projectionId?: Id<"catalogProjections">;
	actor?: RepositoryAdapterActor;
};

type StagedProjection = {
	projectionId: Id<"catalogProjections">;
};

type IngestArgs = {
	projectId: Id<"projects">;
	repository: string;
	commit: string;
	files: SubmittedFile[];
	lineage?: Lineage;
	actor?: RepositoryAdapterActor;
};

type PublicIngestionResult = {
	runId: Id<"snapshotIngestionRuns">;
	snapshotId: Id<"sourceSnapshots"> | null;
};

function advancesBaseline(
	baseline: Doc<"sourceSnapshots"> | null,
	lineage: Lineage | undefined,
): boolean {
	return (
		baseline === null ||
		(lineage?.relationship === "descendant" &&
			lineage.baselineCommit === baseline.commit &&
			lineage.mergeBase === baseline.commit)
	);
}

async function baselineFor(
	ctx: MutationCtx,
	project: Doc<"projects">,
): Promise<Doc<"sourceSnapshots"> | null> {
	if (!project.baselineSnapshotId) return null;
	const baseline = await ctx.db.get(project.baselineSnapshotId);
	if (!baseline) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "The project points to a missing Baseline Snapshot.",
		});
	}
	return baseline;
}

async function findRun(
	ctx: MutationCtx,
	identity: Identity,
): Promise<Doc<"snapshotIngestionRuns"> | null> {
	return await ctx.db
		.query("snapshotIngestionRuns")
		.withIndex("by_project_and_repository_and_commit_and_manifestHash", (q) =>
			q
				.eq("projectId", identity.projectId)
				.eq("repository", identity.repository)
				.eq("commit", identity.commit)
				.eq("manifestHash", identity.manifestHash),
		)
		.first();
}

async function assertStagingProjection(
	ctx: MutationCtx,
	identity: Identity,
	projectionId: Id<"catalogProjections">,
) {
	const projection = await ctx.db.get(projectionId);
	if (
		!projection ||
		projection.projectId !== identity.projectId ||
		projection.repository !== identity.repository ||
		projection.commit !== identity.commit ||
		projection.manifestHash !== identity.manifestHash ||
		projection.status !== "staging" ||
		projection.snapshotId !== undefined ||
		projection.sourceProposalHeadVersion === undefined ||
		!Number.isInteger(projection.sourceProposalHeadVersion) ||
		projection.sourceProposalHeadVersion < 0 ||
		projection.stagedKeyCount !== projection.expectedKeyCount ||
		projection.stagedMessageCount !== projection.expectedMessageCount ||
		projection.stagedByteLength !== projection.expectedByteLength ||
		projection.gitChangesStatus !== "staged" ||
		projection.expectedGitChangeCount === undefined ||
		projection.expectedGitChangeByteLength === undefined ||
		projection.stagedGitChangeCount !== projection.expectedGitChangeCount ||
		projection.stagedGitChangeByteLength !==
			projection.expectedGitChangeByteLength ||
		projection.translationResidueStatus !== "staged" ||
		projection.expectedTranslationResidueCount === undefined ||
		projection.expectedTranslationResidueByteLength === undefined ||
		projection.stagedTranslationResidueCount !==
			projection.expectedTranslationResidueCount ||
		projection.stagedTranslationResidueByteLength !==
			projection.expectedTranslationResidueByteLength ||
		projection.archiveStatus !== "staged" ||
		projection.expectedArchiveKeyCount === undefined ||
		projection.expectedArchiveLocaleCount === undefined ||
		projection.expectedArchiveValueCount === undefined ||
		projection.expectedArchiveByteLength === undefined ||
		projection.stagedArchiveKeyCount !== projection.expectedArchiveKeyCount ||
		projection.stagedArchiveLocaleCount !==
			projection.expectedArchiveLocaleCount ||
		projection.stagedArchiveValueCount !==
			projection.expectedArchiveValueCount ||
		projection.stagedArchiveByteLength !==
			projection.expectedArchiveByteLength ||
		projection.archiveStateStatus !== "staged" ||
		projection.expectedArchiveStateValueCount === undefined ||
		projection.expectedArchiveStateByteLength === undefined ||
		projection.stagedArchiveStateValueCount !==
			projection.expectedArchiveStateValueCount ||
		projection.stagedArchiveStateByteLength !==
			projection.expectedArchiveStateByteLength ||
		projection.restoreStatus !== "staged" ||
		projection.expectedRestoreValueCount === undefined ||
		projection.expectedRestoreByteLength === undefined ||
		projection.stagedRestoreValueCount !==
			projection.expectedRestoreValueCount ||
		projection.stagedRestoreByteLength !==
			projection.expectedRestoreByteLength ||
		projection.sourceProposalObservationsStatus !== "staged" ||
		projection.expectedSourceProposalObservationCount === undefined ||
		projection.expectedSourceProposalObservationByteLength === undefined ||
		projection.stagedSourceProposalObservationCount !==
			projection.expectedSourceProposalObservationCount ||
		projection.stagedSourceProposalObservationByteLength !==
			projection.expectedSourceProposalObservationByteLength
	) {
		throw new ConvexError({
			code: "VALIDATION",
			message:
				"A Baseline Snapshot requires its own staging catalog projection.",
		});
	}
	await assertDeliveryStaged(ctx, projection._id);
	await assertStagedReconciliationReport(ctx, projection);
	return projection;
}

async function hasPublishedProjection(
	ctx: MutationCtx,
	project: Doc<"projects">,
	snapshot: Doc<"sourceSnapshots">,
): Promise<boolean> {
	if (!project.activeCatalogProjectionId) return false;
	const projection = await ctx.db.get(project.activeCatalogProjectionId);
	return (
		projection?.projectId === project._id &&
		projection.repository === snapshot.repository &&
		projection.commit === snapshot.commit &&
		projection.manifestHash === snapshot.manifestHash &&
		projection.status === "published" &&
		projection.snapshotId === snapshot._id
	);
}

/** Publish a verified, private projection with the Baseline Snapshot that
 * makes it visible. Nothing outside this transaction can observe one without
 * the other. */
async function publishProjection(
	ctx: MutationCtx,
	args: {
		identity: Identity;
		project: Doc<"projects">;
		snapshotId: Id<"sourceSnapshots">;
		projectionId: Id<"catalogProjections">;
		advancesBaseline: boolean;
		timestamp: number;
	},
): Promise<void> {
	const projection = await assertStagingProjection(
		ctx,
		args.identity,
		args.projectionId,
	);
	const publicationState = await ctx.db
		.query("catalogProjectionPublicationStates")
		.withIndex("by_projection", (q) => q.eq("projectionId", args.projectionId))
		.unique();
	if (
		!publicationState ||
		publicationState.projectId !== args.identity.projectId ||
		publicationState.projectionId !== args.projectionId ||
		publicationState.status !== "staging" ||
		publicationState.snapshotId !== undefined
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A staging catalog projection has an invalid visibility record.",
		});
	}
	if (
		(projection.localeBindingRevision !== undefined &&
			projection.localeBindingRevision !==
				(args.project.localeBindingRevision ?? 0)) ||
		projection.previousBaselineSnapshotId !== args.project.baselineSnapshotId ||
		projection.previousCatalogProjectionId !==
			args.project.activeCatalogProjectionId ||
		projection.sourceProposalHeadVersion !==
			(args.project.sourceProposalHeadVersion ?? 0)
	) {
		throw new ConvexError({
			code: "CONFLICT",
			message:
				"The Baseline Snapshot or Source Proposal set changed while catalog reconciliation was staged.",
		});
	}
	// The new generation may only become visible with a complete staged
	// Navigation Index, so the public Navigation read can rely on the exact
	// Catalog Projection it reads from.
	await assertNavigationIndexStagedForPublication(ctx, {
		projectId: args.identity.projectId,
		projectionId: args.projectionId,
	});
	if (
		args.advancesBaseline &&
		args.project.baselineSnapshotId &&
		args.project.baselineSnapshotId !== args.snapshotId
	) {
		await ctx.db.patch(args.project.baselineSnapshotId, { kind: "preview" });
	}
	if (args.advancesBaseline) {
		await ctx.db.patch(args.snapshotId, { kind: "baseline" });
	}
	await ctx.db.patch(args.project._id, {
		baselineSnapshotId: args.snapshotId,
		activeCatalogProjectionId: args.projectionId,
		updatedAt: args.timestamp,
	});
	await ctx.db.patch(args.projectionId, {
		snapshotId: args.snapshotId,
		status: "published",
	});
	await ctx.db.patch(publicationState._id, {
		status: "published",
		snapshotId: args.snapshotId,
	});
	// Source Proposal resolutions became visible with the accepted Baseline,
	// so refresh their keys and swap the active Navigation generation to the
	// staged one within this same transaction.
	await activateNavigationGeneration(ctx, {
		projectId: args.identity.projectId,
		projectionId: args.projectionId,
		previousProjectionId: args.project.activeCatalogProjectionId ?? undefined,
	});
	if (args.advancesBaseline) {
		await advanceWorkspaceReconciliationGeneration(ctx, args.project._id);
	}
	await publishStagedReconciliationReport(ctx, projection, args.snapshotId);
}

async function reuseExistingSnapshot(
	ctx: MutationCtx,
	identity: Identity,
	project: Doc<"projects">,
	run: Doc<"snapshotIngestionRuns">,
): Promise<IngestionResult> {
	if (!run.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A successful ingestion run has no Source Snapshot.",
		});
	}
	const snapshot = await ctx.db.get(run.snapshotId);
	if (
		!snapshot ||
		snapshot.projectId !== project._id ||
		snapshot.repository !== identity.repository ||
		snapshot.commit !== identity.commit ||
		snapshot.manifestHash !== identity.manifestHash
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A successful ingestion run points outside its project.",
		});
	}
	const baseline = await baselineFor(ctx, project);
	const isCurrentBaseline = project.baselineSnapshotId === snapshot._id;
	const shouldAdvance =
		!isCurrentBaseline && advancesBaseline(baseline, identity.lineage);
	const needsRepair =
		isCurrentBaseline &&
		!(await hasPublishedProjection(ctx, project, snapshot));

	if (identity.lineage)
		await ctx.db.patch(snapshot._id, { lineage: identity.lineage });
	if (!shouldAdvance && !needsRepair) {
		return {
			runId: run._id,
			snapshotId: snapshot._id,
			reused: true,
			publishedProjection: false,
			needsProjection: false,
		};
	}
	if (!identity.projectionId) {
		return {
			runId: run._id,
			snapshotId: snapshot._id,
			reused: true,
			publishedProjection: false,
			needsProjection: true,
		};
	}

	await publishProjection(ctx, {
		identity,
		project,
		snapshotId: snapshot._id,
		projectionId: identity.projectionId,
		advancesBaseline: shouldAdvance,
		timestamp: now(),
	});
	return {
		runId: run._id,
		snapshotId: snapshot._id,
		reused: true,
		publishedProjection: true,
		needsProjection: false,
	};
}

/** Whether the lineage observed for a new submission might make it eligible to
 * become the Baseline Snapshot. This is only a staging hint; finalization
 * repeats the check transactionally before publishing the projection. */
export const shouldStageProjection = internalQuery({
	args: {
		projectId: v.id("projects"),
		lineage: v.optional(lineageValidator),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args): Promise<boolean> => {
		await authorizeIngestion(ctx, args.projectId, args.actor);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		if (!project.baselineSnapshotId) return true;
		const baseline = await ctx.db.get(project.baselineSnapshotId);
		return baseline !== null && advancesBaseline(baseline, args.lineage);
	},
});

/**
 * Return an existing successful Snapshot Identity before inspecting bindings,
 * parsing catalogs, or storing evidence. A Preview that can now advance asks
 * the action for a projection built from its own immutable evidence instead.
 */
export const reusePublished = internalMutation({
	args: {
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		manifestHash: v.string(),
		lineage: v.optional(lineageValidator),
		projectionId: v.optional(v.id("catalogProjections")),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args): Promise<IngestionResult | null> => {
		await authorizeIngestion(ctx, args.projectId, args.actor);
		const run = await findRun(ctx, args);
		if (run?.status !== "succeeded") return null;
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		return await reuseExistingSnapshot(ctx, args, project, run);
	},
});

/** The immutable unbound-file observation from one Source Snapshot. It is
 * deliberately separate from projection evidence because setup work must not
 * make later identical Baselines noisy. */
export const unboundLocaleFilesFor = internalQuery({
	args: {
		snapshotId: v.id("sourceSnapshots"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args): Promise<UnboundLocaleFile[]> => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Source Snapshot not found.",
			});
		}
		await authorizeIngestion(ctx, snapshot.projectId, args.actor);
		const files = await ctx.db
			.query("sourceSnapshotUnboundFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
			.take(MAX_SNAPSHOT_FILES + 1);
		if (files.length > MAX_SNAPSHOT_FILES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot exceeds the supported file envelope.",
			});
		}
		return files.map((file) => ({
			catalogPath: file.catalogPath,
			...(file.declaredLocaleCode === undefined
				? {}
				: { declaredLocaleCode: file.declaredLocaleCode }),
			...(file.messageCount === undefined
				? {}
				: { messageCount: file.messageCount }),
		}));
	},
});

/** Stored snapshot files and their ingest-time Locale roles, for the one
 * promotion path that must never consult current mutable bindings. */
export const projectionEvidenceFor = internalQuery({
	args: {
		snapshotId: v.id("sourceSnapshots"),
		actor: v.optional(repositoryAdapterActorValidator),
	},
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Source Snapshot not found.",
			});
		}
		await authorizeIngestion(ctx, snapshot.projectId, args.actor);
		const project = await ctx.db.get(snapshot.projectId);
		if (!project) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot belongs to a missing project.",
			});
		}
		const files = await snapshotCatalogFiles(ctx, snapshot._id);
		if (files.length > MAX_SNAPSHOT_FILES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot exceeds the supported file envelope.",
			});
		}
		const unboundLocaleFiles = await ctx.db
			.query("sourceSnapshotUnboundFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshot._id))
			.take(MAX_SNAPSHOT_FILES + 1);
		if (
			files.length +
				unboundLocaleFiles.filter(
					(unbound) =>
						!files.some((file) => file.catalogPath === unbound.catalogPath),
				).length >
			MAX_SNAPSHOT_FILES
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot exceeds the supported file envelope.",
			});
		}
		const absentTargetLocales = await ctx.db
			.query("sourceSnapshotAbsentLocales")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshot._id))
			.take(MAX_PROJECTED_LOCALES + 1);
		if (absentTargetLocales.length > MAX_PROJECTED_LOCALES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Source Snapshot exceeds the supported absent-Locale envelope.",
			});
		}
		return {
			projectId: snapshot.projectId,
			projectionId: project.activeCatalogProjectionId ?? null,
			localeBindingRevision: project.localeBindingRevision ?? 0,
			files: files.map((file) => ({
				localeId: file.localeId,
				localeCode: file.localeCode,
				catalogPath: file.catalogPath,
				isSource: file.isSource ?? file.localeId === project.sourceLocaleId,
				storageId: file.storageId,
			})),
			absentTargetLocales: absentTargetLocales
				.filter(
					(locale) => !files.some((file) => file.localeId === locale.localeId),
				)
				.map((locale) => ({
					localeId: locale.localeId,
					localeCode: locale.localeCode,
					catalogPath: locale.catalogPath,
				})),
			unboundLocaleFiles: unboundLocaleFiles
				.filter(
					(unbound) =>
						!files.some((file) => file.catalogPath === unbound.catalogPath),
				)
				.map((file) => ({
					storageId: file.storageId,
					catalogPath: file.catalogPath,
					...(file.declaredLocaleCode === undefined
						? {}
						: { declaredLocaleCode: file.declaredLocaleCode }),
					...(file.messageCount === undefined
						? {}
						: { messageCount: file.messageCount }),
				})),
		};
	},
});

/**
 * Write the run and, when the ingest succeeded, the snapshot and its files —
 * in one transaction. Baseline promotion is possible only alongside a verified
 * staging projection, so the catalog cannot point at another snapshot's rows.
 */
export const finalizeIngestion = internalMutation({
	args: {
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		manifestHash: v.string(),
		lineage: v.optional(lineageValidator),
		projectionId: v.optional(v.id("catalogProjections")),
		actor: v.optional(repositoryAdapterActorValidator),
		diagnostics: v.array(diagnosticValidator),
		absentTargetLocales: v.array(absentTargetLocaleValidator),
		unboundLocaleFiles: v.array(unboundLocaleFileValidator),
		files: v.array(
			v.object({
				localeId: v.id("locales"),
				localeCode: v.string(),
				isSource: v.boolean(),
				catalogPath: v.string(),
				storageId: v.id("_storage"),
				byteLength: v.number(),
			}),
		),
	},
	handler: async (ctx, args): Promise<IngestionResult> => {
		const createdBy = await authorizeIngestion(ctx, args.projectId, args.actor);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		if (
			args.actor?.kind === "repositoryAdapter" &&
			project.repository !== undefined &&
			project.repository !== args.repository
		) {
			throw new ConvexError({
				code: "REPOSITORY_MISMATCH",
				message: `This project is already connected to ${project.repository}; sync the matching checkout.`,
			});
		}
		const existing = await findRun(ctx, args);
		if (existing?.status === "succeeded") {
			return await reuseExistingSnapshot(ctx, args, project, existing);
		}

		const failed = args.diagnostics.length > 0;
		if (failed && args.projectionId) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A failed ingestion cannot publish a catalog projection.",
			});
		}
		if (
			failed &&
			(args.absentTargetLocales.length > 0 ||
				args.unboundLocaleFiles.length > 0)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A failed ingestion cannot record Locale-file evidence.",
			});
		}
		if (!failed && args.files.length === 0) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "A successful ingestion must contain catalog evidence.",
			});
		}
		if (!failed) {
			assertAbsentTargetLocaleEvidence(args.files, args.absentTargetLocales);
			assertUnboundLocaleFileEvidence(args.files, args.unboundLocaleFiles);
		}
		if (args.projectionId) {
			await assertStagingProjection(ctx, args, args.projectionId);
		}
		const baseline = await baselineFor(ctx, project);
		// A racing baseline may make an unstaged submission eligible after the
		// fact. It remains a Preview and can safely resume through the immutable
		// evidence path; it must never advance without a projection.
		const publishesBaseline =
			!failed &&
			args.projectionId !== undefined &&
			advancesBaseline(baseline, args.lineage);
		const timestamp = now();
		const snapshotId = failed
			? undefined
			: await ctx.db.insert("sourceSnapshots", {
					projectId: args.projectId,
					repository: args.repository,
					commit: args.commit,
					manifestHash: args.manifestHash,
					kind: publishesBaseline ? "baseline" : "preview",
					lineage: args.lineage,
					createdBy,
					createdAt: timestamp,
				});
		if (
			!failed &&
			args.actor?.kind === "repositoryAdapter" &&
			project.repository === undefined
		) {
			await ctx.db.patch(args.projectId, {
				repository: args.repository,
				updatedAt: timestamp,
			});
		}

		if (snapshotId) {
			for (const file of args.files) {
				await ctx.db.insert("sourceSnapshotFiles", {
					projectId: args.projectId,
					snapshotId,
					...file,
				});
			}
			for (const locale of args.absentTargetLocales) {
				await ctx.db.insert("sourceSnapshotAbsentLocales", {
					projectId: args.projectId,
					snapshotId,
					...locale,
				});
			}
			for (const file of args.unboundLocaleFiles) {
				await ctx.db.insert("sourceSnapshotUnboundFiles", {
					projectId: args.projectId,
					snapshotId,
					...file,
				});
			}
			if (publishesBaseline && args.projectionId) {
				await publishProjection(ctx, {
					identity: args,
					project,
					snapshotId,
					projectionId: args.projectionId,
					advancesBaseline: true,
					timestamp,
				});
			}
		}

		const outcome = {
			status: failed ? ("failed" as const) : ("succeeded" as const),
			snapshotId,
			diagnosticGeneration: (existing?.diagnosticGeneration ?? -1) + 1,
		};
		const runId =
			existing?._id ??
			(await ctx.db.insert("snapshotIngestionRuns", {
				projectId: args.projectId,
				repository: args.repository,
				commit: args.commit,
				manifestHash: args.manifestHash,
				...outcome,
				createdBy,
				createdAt: timestamp,
			}));
		if (existing) await ctx.db.patch(existing._id, outcome);
		for (const diagnostic of args.diagnostics) {
			await ctx.db.insert("snapshotIngestionDiagnostics", {
				runId,
				generation: outcome.diagnosticGeneration,
				...diagnostic,
			});
		}

		return {
			runId,
			snapshotId: snapshotId ?? null,
			reused: false,
			publishedProjection: publishesBaseline,
			needsProjection: false,
		};
	},
});

async function sourceDetailsFor(document: CatalogDocument) {
	return new Map(
		await Promise.all(
			document.messages.map(async (message) => {
				return [
					message.id,
					{
						sourceFingerprint: await sha256Hex(message.value),
						declaredFacts: storedFactNames(
							declaredPlaceholderNames(message.metadata),
						),
					},
				] as const;
			}),
		),
	);
}

async function* projectionRows(
	files: readonly ProjectionFile[],
	localeId: Id<"locales">,
	sourceDetails: Awaited<ReturnType<typeof sourceDetailsFor>>,
): AsyncGenerator<ProjectedMessage> {
	if (files.length > MAX_PROJECTED_LOCALES) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A catalog projection supports at most ${MAX_PROJECTED_LOCALES} Locales.`,
		});
	}
	const source = files.find((file) => file.isSource);
	if (!source) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A catalog projection needs one source Locale.",
		});
	}
	if (source.document.messages.length > MAX_WORKING_CATALOG_KEYS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A catalog projection supports at most ${MAX_WORKING_CATALOG_KEYS} keys.`,
		});
	}
	const rowCount = source.document.messages.length * files.length;
	if (rowCount > MAX_WORKING_CATALOG_ROWS) {
		throw new ConvexError({
			code: "VALIDATION",
			message: `A catalog projection supports at most ${MAX_WORKING_CATALOG_ROWS} message values.`,
		});
	}

	for (const file of files) {
		if (localeId !== undefined && file.localeId !== localeId) continue;
		const messages = new Map(
			file.document.messages.map((message) => [message.id, message] as const),
		);
		for (const [
			catalogIndex,
			sourceMessage,
		] of source.document.messages.entries()) {
			const message = messages.get(sourceMessage.id);
			const metadata: JsonObject | undefined =
				message === undefined ? sourceMessage.metadata : message.metadata;
			const value = message?.value ?? "";
			const parsedFacts = messageFacts(value);
			const facts = storedFactNames(parsedFacts.argumentNames);
			const details = sourceDetails.get(sourceMessage.id);
			if (!details) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Source message facts could not be derived.",
				});
			}
			yield {
				localeId: file.localeId,
				localeCode: file.localeCode,
				catalogPath: file.catalogPath,
				isSource: file.isSource,
				catalogIndex,
				messageId: sourceMessage.id,
				value,
				...(metadata === undefined
					? {}
					: {
							metadataCatalogPath:
								message === undefined ? source.catalogPath : file.catalogPath,
						}),
				gitValueFingerprint: await sha256Hex(value),
				sourceFingerprint: details.sourceFingerprint,
				icuType: parsedFacts.icuType,
				argumentNames: [...facts.names],
				argumentNamesComplete: facts.complete,
				argumentNameCount: facts.count,
				...(file.isSource
					? {
							declaredPlaceholderNames: [...details.declaredFacts.names],
							declaredPlaceholderNamesComplete: details.declaredFacts.complete,
							declaredPlaceholderNameCount: details.declaredFacts.count,
						}
					: {}),
				materialized: message === undefined,
			};
		}
	}
}

async function discardStagingProjection(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	projectionId: Id<"catalogProjections">,
	actor?: RepositoryAdapterActor,
): Promise<void> {
	try {
		for (
			let page = 0;
			page <= Math.ceil(MAX_WORKING_CATALOG_ROWS / 32);
			page++
		) {
			const done: boolean = await ctx.runMutation(
				internal.localeDelivery.discardDecisions,
				{ projectId, projectionId, actor },
			);
			if (done) break;
		}
		await ctx.runMutation(internal.catalogProjection.discard, {
			projectId,
			projectionId,
			actor,
		});
	} catch {
		// A staging projection is never active. Best-effort cleanup must not
		// prevent the ingestion run from recording its durable outcome.
	}
}

async function previousAbsentTargetLocaleIds(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots"> | null,
	actor?: RepositoryAdapterActor,
): Promise<Id<"locales">[]> {
	if (!snapshotId) return [];
	const evidence: ProjectionEvidence = await ctx.runQuery(
		internal.snapshots.projectionEvidenceFor,
		{ snapshotId, actor },
	);
	if (evidence.projectId !== projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Prior Source Snapshot evidence belongs to another project.",
		});
	}
	return evidence.absentTargetLocales.map((locale) => locale.localeId);
}

async function sourceDocumentFor(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots"> | null,
	actor?: RepositoryAdapterActor,
): Promise<CatalogDocument | null> {
	if (!snapshotId) return null;
	const evidence: ProjectionEvidence = await ctx.runQuery(
		internal.snapshots.projectionEvidenceFor,
		{ snapshotId, actor },
	);
	if (evidence.projectId !== projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Prior Source Snapshot evidence belongs to another project.",
		});
	}
	const source = evidence.files.find((file) => file.isSource);
	if (!source) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Prior Source Snapshot evidence has no source Locale.",
		});
	}
	const blob = await ctx.storage.get(source.storageId);
	if (!blob) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Prior source Catalog Document evidence is missing.",
		});
	}
	return parse(await blob.text());
}

/** Older working projections predate per-target submitted-byte fingerprints.
 * Recover only those missing fingerprints from their immutable Source Snapshot
 * evidence, so the first Contract Transform after this rollout still preserves
 * a target's currency and restored-value provenance correctly. */
async function previousSubmittedTargetFingerprintsFor(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots"> | null,
	previousMessages: readonly ProjectedMessage[],
	actor?: RepositoryAdapterActor,
): Promise<Map<string, SubmittedTargetFingerprint>> {
	const missing = previousMessages.filter(
		(message) => !message.isSource && message.gitValueFingerprint === undefined,
	);
	if (missing.length === 0 || snapshotId === null) return new Map();
	const evidence: ProjectionEvidence = await ctx.runQuery(
		internal.snapshots.projectionEvidenceFor,
		{ snapshotId, actor },
	);
	if (evidence.projectId !== projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Prior Source Snapshot evidence belongs to another project.",
		});
	}
	const fingerprints = new Map<string, SubmittedTargetFingerprint>();
	const missingByLocale = new Map<Id<"locales">, ProjectedMessage[]>();
	for (const row of missing) {
		const rows = missingByLocale.get(row.localeId) ?? [];
		rows.push(row);
		missingByLocale.set(row.localeId, rows);
	}
	for (const file of evidence.files) {
		const rows = missingByLocale.get(file.localeId);
		if (file.isSource || !rows) continue;
		const blob = await ctx.storage.get(file.storageId);
		if (!blob)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Prior target Catalog Document evidence is missing.",
			});
		const messages = new Map(
			parse(await blob.text()).messages.map((message) => [message.id, message]),
		);
		for (const row of rows) {
			const message = messages.get(row.messageId);
			if (!message && !row.materialized)
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"A prior target projection value is missing from its Source Snapshot evidence.",
				});
			fingerprints.set(contractValueIdentity(row), {
				value: await sha256Hex(message?.value ?? ""),
			});
		}
		missingByLocale.delete(file.localeId);
	}
	if (missingByLocale.size)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A prior target catalog has no immutable Snapshot file.",
		});

	return fingerprints;
}

type OpenSourceProposalObservation = {
	proposalId: Id<"sourceProposals">;
	messageId: string;
	basisGitValueFingerprint: string;
};

async function sourceProposalObservationsFor(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	rows: readonly ProjectedMessage[],
	archivedSourceMessageIds: ReadonlySet<string>,
	openSourceProposals: readonly OpenSourceProposalObservation[],
	actor?: RepositoryAdapterActor,
): Promise<SourceProposalObservation[]> {
	const sourceValues = new Map<
		string,
		Pick<ProjectedMessage, "value" | "sourceFingerprint">
	>();
	for (const row of rows) {
		if (!row.isSource) continue;
		if (sourceValues.has(row.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"The staged catalog contains duplicate source values for Source Proposal observation.",
			});
		}
		sourceValues.set(row.messageId, {
			value: row.value,
			sourceFingerprint: row.sourceFingerprint,
		});
	}
	const observations: SourceProposalObservation[] = [];
	const observedMessageIds = new Set<string>();
	const appendObservation = (proposal: {
		proposalId: Id<"sourceProposals">;
		messageId: string;
		basisGitValueFingerprint?: string;
	}) => {
		const source = sourceValues.get(proposal.messageId);
		// A Source Proposal whose source key was deleted cannot be mistaken for a
		// matching source value. Archive Reconciliation retains the key evidence;
		// this transition only observes proposals for keys Git still contains.
		if (source === undefined) return;
		// An ordinary accepted update that leaves Git's source wording unchanged
		// is not an outcome for a pending Source Proposal. Only a candidate match
		// lands it; a different Git value supersedes it.
		if (
			proposal.basisGitValueFingerprint !== undefined &&
			proposal.basisGitValueFingerprint === source.sourceFingerprint
		) {
			return;
		}
		if (observedMessageIds.has(proposal.messageId)) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"More than one open Source Proposal observed the same source key.",
			});
		}
		observedMessageIds.add(proposal.messageId);
		observations.push({
			proposalId: proposal.proposalId,
			messageId: proposal.messageId,
			value: source.value,
		});
	};
	const sourceMessageIds = [...sourceValues.keys()].filter(
		(messageId) =>
			archivedSourceMessageIds.has(messageId) &&
			supportsRestoreProposalMessageId(messageId),
	);
	const lookupMessageIds: string[][] = [];
	for (
		let offset = 0;
		offset < sourceMessageIds.length;
		offset += MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP
	) {
		lookupMessageIds.push(
			sourceMessageIds.slice(
				offset,
				offset + MAX_RESTORE_PROPOSAL_MESSAGE_IDS_PER_LOOKUP,
			),
		);
	}
	for (const messageIds of lookupMessageIds) {
		const result: {
			proposals: { proposalId: Id<"sourceProposals">; messageId: string }[];
		} = await ctx.runQuery(internal.restoreProposals.openForMessages, {
			projectId,
			messageIds,
			actor,
		});
		if (result.proposals.length > messageIds.length) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Restore Proposal lookup returned more proposals than source keys.",
			});
		}
		for (const proposal of result.proposals) appendObservation(proposal);
	}
	for (const proposal of openSourceProposals) appendObservation(proposal);
	return observations;
}

function addProcessingTotals<T extends Record<string, number>>(
	total: T,
	increment: T,
): void {
	for (const key of Object.keys(total) as (keyof T)[])
		total[key] = (total[key] + increment[key]) as T[keyof T];
}

/** Read a single immutable message partition. Database pages are byte-bounded;
 * the action rejects an oversized key before retaining the complete partition. */
async function processingValues(
	ctx: ActionCtx,
	identity: Identity,
	projectionId: Id<"catalogProjections">,
	messageIds: readonly string[],
	kind: "input" | "previous" | "archive",
) {
	const messageId = messageIds[0];
	const endMessageId = messageIds[messageIds.length - 1];
	if (messageId === undefined || endMessageId === undefined) return [];
	const values: ProcessingInput[] = [];
	let cursor: string | null = null;
	let bytes = 0;
	do {
		const page: {
			page: ProcessingInput[];
			isDone: boolean;
			continueCursor: string;
		} = await ctx.runQuery(internal.catalogProcessing.valuesPage, {
			projectId: identity.projectId,
			projectionId,
			messageId,
			endMessageId,
			kind,
			paginationOpts: { numItems: 500, cursor },
			actor: identity.actor,
		});
		bytes += new TextEncoder().encode(JSON.stringify(page.page)).length;
		if (bytes > MAX_PROCESSING_KEY_BYTES)
			throw new ConvexError({
				code: "PROCESSING_PARTITION_TOO_LARGE",
				message: "Catalog processing partition exceeds its byte budget.",
			});
		values.push(...page.page);
		if (page.isDone) return values;
		if (page.continueCursor === cursor)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog processing did not advance its cursor.",
			});
		cursor = page.continueCursor;
	} while (cursor !== null);
	return values;
}

async function processingKeys(
	ctx: ActionCtx,
	identity: Identity,
	projectionId: Id<"catalogProjections">,
	source: CatalogDocument,
) {
	const keys = new Set(source.messages.map((message) => message.id));
	for (const kind of ["previous", "archive"] as const) {
		let cursor: string | null = null;
		do {
			const page: { page: string[]; isDone: boolean; continueCursor: string } =
				await ctx.runQuery(internal.catalogProcessing.keyPage, {
					projectId: identity.projectId,
					projectionId,
					kind,
					paginationOpts: { numItems: 500, cursor },
					actor: identity.actor,
				});
			for (const key of page.page) keys.add(key);
			if (keys.size > MAX_WORKING_CATALOG_KEYS * 3)
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "Catalog key reconciliation exceeds its identity budget.",
				});
			if (page.isDone) break;
			if (page.continueCursor === cursor)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Catalog key processing did not advance its cursor.",
				});
			cursor = page.continueCursor;
		} while (cursor !== null);
	}
	return [...keys].sort();
}

async function deriveProcessingChunk(
	ctx: ActionCtx,
	identity: Identity,
	projectionId: Id<"catalogProjections">,
	messageIds: readonly string[],
	source: CatalogDocument,
	previousSourceDocument: CatalogDocument | null,
	previous: {
		previousProjectionId: Id<"catalogProjections"> | null;
		previousSnapshotId: Id<"sourceSnapshots"> | null;
	},
	absentTargetLocales: readonly AbsentTargetLocale[],
	priorAbsentTargetLocaleIds: readonly Id<"locales">[],
	introducedAt: number,
	openSourceProposals: readonly OpenSourceProposalObservation[],
) {
	const inputs = await processingValues(
		ctx,
		identity,
		projectionId,
		messageIds,
		"input",
	);
	const previousMessages = (
		await processingValues(ctx, identity, projectionId, messageIds, "previous")
	).map((input) => input.message);
	const archived = (
		await processingValues(ctx, identity, projectionId, messageIds, "archive")
	).map((input) => input.message as ArchivedValue);
	if (
		new TextEncoder().encode(
			JSON.stringify([inputs, previousMessages, archived]),
		).length > MAX_PROCESSING_KEY_BYTES
	)
		throw new ConvexError({
			code: "PROCESSING_PARTITION_TOO_LARGE",
			message:
				"Catalog reconciliation evidence exceeds its partition byte budget.",
		});
	const state = { values: archived };
	const raw = inputs.map((input) => input.message);
	const restorationRows = restoreByteIdenticalArchivedTargets(
		preserveArchivedTargetSourceFingerprint(raw, state),
		state,
	);
	const contract = reconcileContractTransforms({
		previousMessages,
		currentMessages: restorationRows,
		previousSourceDocument,
		currentSourceDocument: source,
		targetMetadataByValue: new Map(
			inputs
				.filter((input) => !input.message.isSource)
				.map((input) => [contractValueIdentity(input.message), input.metadata]),
		),
		previousSubmittedTargetFingerprintsByValue:
			await previousSubmittedTargetFingerprintsFor(
				ctx,
				identity.projectId,
				previous.previousSnapshotId,
				previousMessages,
				identity.actor,
			),
	});
	const withIntroductions = attachIntroductionReviews({
		hadPreviousBaseline: previous.previousProjectionId !== null,
		previousMessages,
		retainedMessages: state.values,
		currentMessages: contract.messages,
		introducedAt,
	});
	const rows: ProjectedMessage[] = (
		await assignValueFingerprints(
			assignGitValueRevisions(previousMessages, withIntroductions),
		)
	).map(
		({
			repeatedGitContent: _repeat,
			repeatedGitContentVersion: _version,
			...row
		}) => row,
	);
	const residues = translationResidues(contract.consequences);
	const sourceProposalObservations = await sourceProposalObservationsFor(
		ctx,
		identity.projectId,
		rows,
		new Set(
			archived
				.filter((row) => row.isSource && row.keyArchived)
				.map((row) => row.messageId),
		),
		openSourceProposals,
		identity.actor,
	);
	const gitChanges = gitAuthoredChanges(previousMessages, rows);
	const restorations = automaticRestorations(previousMessages, rows);
	const archives = archiveReconciliation(
		previousMessages,
		rows,
		absentTargetLocales,
		previous.previousSnapshotId,
		priorAbsentTargetLocaleIds,
	);
	// Locale/file facts belong to the transition, rather than each message.
	archives.locales = [];
	const nextState = nextArchiveState(state, rows, archives);
	const report = reconciliationReportDraft({
		hadPreviousBaseline: previous.previousProjectionId !== null,
		previousMessages,
		currentMessages: rows,
		gitChanges,
		archives,
		restorations,
		residues,
		contractConsequences: contract.consequences,
	});
	const sourceById = new Map(
		rows.filter((row) => row.isSource).map((row) => [row.messageId, row]),
	);
	const quietHandoff = !report
		? [...sourceById.values()]
				.filter((source) =>
					rows.some(
						(row) =>
							!row.isSource &&
							row.messageId === source.messageId &&
							(row.value.length === 0 ||
								row.sourceFingerprint !== source.sourceFingerprint),
					),
				)
				.map((source) => ({
					catalogIndex: source.catalogIndex,
					messageId: source.messageId,
				}))
		: [];
	return {
		rows,
		residues,
		sourceProposalObservations,
		gitChanges,
		restorations,
		archives,
		nextState,
		report,
		quietHandoff,
	};
}

async function stageProjection(
	ctx: ActionCtx,
	identity: Identity,
	files: readonly ProjectionFile[] | AsyncIterable<ProjectionFile>,
	absentTargetLocales: readonly AbsentTargetLocale[],
	unboundLocaleFiles: readonly UnboundLocaleFile[],
	deliveryFiles: readonly SubmittedFile[] | AsyncIterable<SubmittedFile> = [],
	expectedBindingBasis?: BindingBasis,
): Promise<StagedProjection> {
	const projectionId: Id<"catalogProjections"> = await ctx.runMutation(
		internal.catalogProjection.begin,
		{
			projectId: identity.projectId,
			expectedBindingBasis,
			repository: identity.repository,
			commit: identity.commit,
			manifestHash: identity.manifestHash,
			expectedKeyCount: 0,
			expectedMessageCount: 0,
			expectedByteLength: 0,
			actor: identity.actor,
		},
	);
	const scope = {
		projectId: identity.projectId,
		projectionId,
		actor: identity.actor,
	};
	try {
		let currentSource: ProjectionFile | undefined;
		let sourceDetails: Awaited<ReturnType<typeof sourceDetailsFor>> | undefined;
		const boundFiles: Binding[] = [];
		const orderedFiles:
			| Iterable<ProjectionFile>
			| AsyncIterable<ProjectionFile> =
			Symbol.asyncIterator in files
				? files
				: [...files].sort((a, b) => Number(b.isSource) - Number(a.isSource));
		for await (const file of orderedFiles) {
			if (
				boundFiles.some(
					(bound) =>
						bound.localeId === file.localeId ||
						bound.catalogPath === file.catalogPath,
				)
			)
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"A processing input repeats a bound language or catalog path.",
				});
			boundFiles.push({
				localeId: file.localeId,
				localeCode: file.localeCode,
				catalogPath: file.catalogPath,
				isSource: file.isSource,
			});
			if (
				boundFiles.length + absentTargetLocales.length >
				MAX_PROJECTED_LOCALES
			)
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "The Snapshot exceeds the project binding resource budget.",
				});
			if (file.isSource) {
				if (currentSource)
					throw new ConvexError({
						code: "INTEGRITY",
						message: "A projection contains multiple Source catalogs.",
					});
				currentSource = file;
				sourceDetails = await sourceDetailsFor(file.document);
			}
			if (!currentSource || !sourceDetails)
				throw new ConvexError({
					code: "INTEGRITY",
					message:
						"Streaming catalog input must start with the Source catalog.",
				});
			const rows = projectionRows(
				file.isSource ? [file] : [currentSource, file],
				file.localeId,
				sourceDetails,
			);
			const metadata = new Map(
				file.document.messages.map((message) => [message.id, message.metadata]),
			);
			let inputs: { message: ProjectedMessage; metadata?: string }[] = [];
			let bytes = 2;
			for await (const message of rows) {
				const value = metadata.get(message.messageId);
				const input = {
					message,
					...(value === undefined ? {} : { metadata: JSON.stringify(value) }),
				};
				const size = new TextEncoder().encode(JSON.stringify(input)).length + 1;
				if (size > 500_000)
					throw new ConvexError({
						code: "LIMIT_EXCEEDED",
						message:
							"A catalog message and its metadata exceed the processing input budget.",
					});
				if (
					inputs.length > 0 &&
					(inputs.length >= 500 || bytes + size > 500_000)
				) {
					await ctx.runMutation(internal.catalogProcessing.stageInputs, {
						...scope,
						inputs,
					});
					inputs = [];
					bytes = 2;
				}
				inputs.push(input);
				bytes += size;
			}
			if (inputs.length)
				await ctx.runMutation(internal.catalogProcessing.stageInputs, {
					...scope,
					inputs,
				});
		}
		if (!currentSource)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "A catalog projection is missing its Source catalog.",
			});
		const previous: {
			previousProjectionId: Id<"catalogProjections"> | null;
			previousSnapshotId: Id<"sourceSnapshots"> | null;
		} = await ctx.runQuery(internal.catalogProcessing.basis, scope);
		const previousSourceDocument = await sourceDocumentFor(
			ctx,
			identity.projectId,
			previous.previousSnapshotId,
			identity.actor,
		);
		const previousUnboundLocaleFiles: UnboundLocaleFile[] =
			previous.previousSnapshotId
				? await ctx.runQuery(internal.snapshots.unboundLocaleFilesFor, {
						snapshotId: previous.previousSnapshotId,
						actor: identity.actor,
					})
				: [];
		const priorAbsentTargetLocaleIds = await previousAbsentTargetLocaleIds(
			ctx,
			identity.projectId,
			previous.previousSnapshotId,
			identity.actor,
		);
		const keys = await processingKeys(
			ctx,
			identity,
			projectionId,
			currentSource.document,
		);
		// One compact proposal capture feeds both passes. The projection's
		// sourceProposalHeadVersion still rejects a racing proposal at publish.
		const {
			proposals: openSourceProposals,
		}: { proposals: OpenSourceProposalObservation[] } = await ctx.runQuery(
			internal.sourceProposals.openForProject,
			{ projectId: identity.projectId, actor: identity.actor },
		);
		const introducedAt = now();
		const sourceDocument = currentSource.document;
		async function* chunks(
			messageIds: readonly string[],
		): AsyncGenerator<Awaited<ReturnType<typeof deriveProcessingChunk>>> {
			try {
				yield await deriveProcessingChunk(
					ctx,
					identity,
					projectionId,
					messageIds,
					sourceDocument,
					previousSourceDocument,
					previous,
					absentTargetLocales,
					priorAbsentTargetLocaleIds,
					introducedAt,
					openSourceProposals,
				);
			} catch (error) {
				if (
					!(error instanceof ConvexError) ||
					typeof error.data !== "object" ||
					error.data === null ||
					!("code" in error.data) ||
					error.data.code !== "PROCESSING_PARTITION_TOO_LARGE"
				)
					throw error;
				if (messageIds.length === 1)
					throw new ConvexError({
						code: "LIMIT_EXCEEDED",
						message:
							"One catalog message and its reconciliation evidence exceed the 6 MiB processing budget.",
					});
				const middle = Math.floor(messageIds.length / 2);
				yield* chunks(messageIds.slice(0, middle));
				yield* chunks(messageIds.slice(middle));
			}
		}
		async function* allChunks() {
			for (let offset = 0; offset < keys.length; offset += 32)
				yield* chunks(keys.slice(offset, offset + 32));
		}

		const transitionArchives = archiveReconciliation(
			[],
			[],
			absentTargetLocales,
			previous.previousSnapshotId,
			priorAbsentTargetLocaleIds,
		);
		const transitionReport = reconciliationReportDraft({
			previousMessages: [],
			currentMessages: [],
			gitChanges: [],
			archives: transitionArchives,
			restorations: [],
			residues: [],
			contractConsequences: [],
			unboundLocaleFiles,
			previousUnboundLocaleFiles,
		});
		const reconciledEnvelope = projectionEnvelope([]);
		const gitChangeTotals = gitChangeEnvelope([]);
		const residueTotals = translationResidueEnvelope([]);
		const restorationTotals = automaticRestorationEnvelope([]);
		const sourceProposalObservationTotals = sourceProposalObservationEnvelope(
			[],
		);
		const archiveTotals = archiveEnvelope(transitionArchives);
		const archiveStateTotals = archiveStateEnvelope({ values: [] });
		const reportTotals = reconciliationReportEnvelope(transitionReport);
		// Cache only fixed-size fingerprints, with a strict entry cap. Larger
		// catalogs retain the indexed fallback for identities outside this cache.
		const repeatedCounts = new Map<
			string,
			{ count: number; falseBytes: number; trueBytes: number }
		>();
		const repeatIdentity = (row: ProjectedMessage) =>
			JSON.stringify([row.localeId, row.valueFingerprint]);

		for await (const chunk of allChunks()) {
			addProcessingTotals(reconciledEnvelope, projectionEnvelope(chunk.rows));
			for (const row of chunk.rows) {
				if (row.isSource) continue;
				const identity = repeatIdentity(row);
				const existing = repeatedCounts.get(identity);
				if (existing) {
					existing.count++;
					continue;
				}
				if (repeatedCounts.size >= 32_000) continue;
				const base = projectedMessageByteLength(row);
				repeatedCounts.set(identity, {
					count: 1,
					falseBytes:
						projectedMessageByteLength({
							...row,
							repeatedGitContent: false,
							repeatedGitContentVersion: 2,
						}) - base,
					trueBytes:
						projectedMessageByteLength({
							...row,
							repeatedGitContent: true,
							repeatedGitContentVersion: 2,
						}) - base,
				});
			}

			addProcessingTotals(gitChangeTotals, gitChangeEnvelope(chunk.gitChanges));
			addProcessingTotals(
				residueTotals,
				translationResidueEnvelope(chunk.residues),
			);
			addProcessingTotals(
				restorationTotals,
				automaticRestorationEnvelope(chunk.restorations),
			);
			addProcessingTotals(
				sourceProposalObservationTotals,
				sourceProposalObservationEnvelope(chunk.sourceProposalObservations),
			);
			addProcessingTotals(archiveTotals, archiveEnvelope(chunk.archives));
			addProcessingTotals(
				archiveStateTotals,
				archiveStateEnvelope(chunk.nextState),
			);
			addProcessingTotals(
				reportTotals,
				reconciliationReportEnvelope(chunk.report),
			);
			reportTotals.handoffKeyCount += chunk.quietHandoff.length;
			reportTotals.handoffByteLength += chunk.quietHandoff.reduce(
				(total, key) =>
					total + new TextEncoder().encode(JSON.stringify(key)).length,
				0,
			);
		}
		for (const entry of repeatedCounts.values())
			reconciledEnvelope.byteLength +=
				entry.count * (entry.count > 1 ? entry.trueBytes : entry.falseBytes);
		await ctx.runMutation(
			internal.catalogProjection.setWorkingCatalogEnvelope,
			{
				...scope,
				expectedKeyCount: reconciledEnvelope.keyCount,
				expectedMessageCount: reconciledEnvelope.messageCount,
				expectedByteLength: reconciledEnvelope.byteLength,
			},
		);
		await ctx.runMutation(internal.catalogProjection.declareGitChanges, {
			projectId: identity.projectId,
			projectionId,
			expectedGitChangeCount: gitChangeTotals.changeCount,
			expectedGitChangeByteLength: gitChangeTotals.byteLength,
			actor: identity.actor,
		});
		await ctx.runMutation(internal.translationResidue.declare, {
			projectId: identity.projectId,
			projectionId,
			expectedTranslationResidueCount: residueTotals.count,
			expectedTranslationResidueByteLength: residueTotals.byteLength,
			actor: identity.actor,
		});
		await ctx.runMutation(internal.catalogProjection.declareRestorations, {
			projectId: identity.projectId,
			projectionId,
			expectedRestoreValueCount: restorationTotals.valueCount,
			expectedRestoreByteLength: restorationTotals.byteLength,
			actor: identity.actor,
		});
		await ctx.runMutation(
			internal.catalogProjection.declareSourceProposalObservations,
			{
				projectId: identity.projectId,
				projectionId,
				expectedSourceProposalObservationCount:
					sourceProposalObservationTotals.count,
				expectedSourceProposalObservationByteLength:
					sourceProposalObservationTotals.byteLength,
				actor: identity.actor,
			},
		);
		await ctx.runMutation(internal.archiveReconciliation.declare, {
			projectId: identity.projectId,
			projectionId,
			expectedArchiveKeyCount: archiveTotals.keyCount,
			expectedArchiveLocaleCount: archiveTotals.localeCount,
			expectedArchiveValueCount: archiveTotals.valueCount,
			expectedArchiveByteLength: archiveTotals.byteLength,
			actor: identity.actor,
		});
		await ctx.runMutation(internal.archiveReconciliation.declareState, {
			projectId: identity.projectId,
			projectionId,
			expectedArchiveStateValueCount: archiveStateTotals.valueCount,
			expectedArchiveStateByteLength: archiveStateTotals.byteLength,
			actor: identity.actor,
		});

		if (reportTotals.rowCount === 0) {
			reportTotals.handoffKeyCount = 0;
			reportTotals.handoffByteLength = 0;
		}
		await ctx.runMutation(internal.reconciliationReports.declare, {
			...scope,
			expectedRowCount: reportTotals.rowCount,
			expectedFactCount: reportTotals.factCount,
			expectedByteLength: reportTotals.byteLength,
			expectedHandoffKeyCount: reportTotals.handoffKeyCount,
			expectedHandoffByteLength: reportTotals.handoffByteLength,
		});
		let stagedChanges = 0;
		let stagedResidues = 0;
		let stagedRestorations = 0;
		let stagedObservations = 0;
		for await (const {
			rows,
			gitChanges,
			residues,
			restorations,
			sourceProposalObservations,
			archives,
			nextState,
			report,
			quietHandoff,
		} of allChunks()) {
			for (const row of rows) {
				if (row.isSource) continue;
				const entry = repeatedCounts.get(repeatIdentity(row));
				if (entry) {
					row.repeatedGitContent = entry.count > 1;
					row.repeatedGitContentVersion = 2;
				}
			}
			for (const messages of stageBatches(rows)) {
				await ctx.runMutation(internal.catalogProjection.stageBatch, {
					projectId: identity.projectId,
					projectionId,
					messages,
					actor: identity.actor,
				});
			}
			const changeBatches = gitChangeBatches(gitChanges);
			for (const changes of changeBatches) {
				await ctx.runMutation(internal.catalogProjection.stageGitChangeBatch, {
					projectId: identity.projectId,
					projectionId,
					changes,
					isFinal:
						stagedChanges + changes.length === gitChangeTotals.changeCount,
					actor: identity.actor,
				});
				stagedChanges += changes.length;
			}
			const residueBatches = translationResidueBatches(residues);
			for (const batch of residueBatches) {
				await ctx.runMutation(internal.translationResidue.stageBatch, {
					projectId: identity.projectId,
					projectionId,
					residues: batch,
					isFinal: stagedResidues + batch.length === residueTotals.count,
					actor: identity.actor,
				});
				stagedResidues += batch.length;
			}
			const restorationBatches = automaticRestorationBatches(restorations);
			for (const values of restorationBatches) {
				await ctx.runMutation(
					internal.catalogProjection.stageRestorationBatch,
					{
						projectId: identity.projectId,
						projectionId,
						restorations: values,
						isFinal:
							stagedRestorations + values.length ===
							restorationTotals.valueCount,
						actor: identity.actor,
					},
				);
				stagedRestorations += values.length;
			}
			const proposalObservationBatches = sourceProposalObservationBatches(
				sourceProposalObservations,
			);
			for (const observations of proposalObservationBatches) {
				await ctx.runMutation(
					internal.catalogProjection.stageSourceProposalObservationBatch,
					{
						projectId: identity.projectId,
						projectionId,
						observations,
						isFinal:
							stagedObservations + observations.length ===
							sourceProposalObservationTotals.count,
						actor: identity.actor,
					},
				);
				stagedObservations += observations.length;
			}
			for (const keys of archiveKeyBatches(archives.keys)) {
				await ctx.runMutation(internal.archiveReconciliation.stageKeys, {
					projectId: identity.projectId,
					projectionId,
					keys,
					actor: identity.actor,
				});
			}
			for (const locales of archiveLocaleBatches(archives.locales)) {
				await ctx.runMutation(internal.archiveReconciliation.stageLocales, {
					projectId: identity.projectId,
					projectionId,
					locales,
					actor: identity.actor,
				});
			}
			for (const values of archiveValueBatches(archives.values)) {
				await ctx.runMutation(internal.archiveReconciliation.stageValues, {
					projectId: identity.projectId,
					projectionId,
					values,
					actor: identity.actor,
				});
			}
			for (const values of archiveValueBatches(nextState.values)) {
				await ctx.runMutation(internal.archiveReconciliation.stageStateValues, {
					projectId: identity.projectId,
					projectionId,
					values,
					actor: identity.actor,
				});
			}

			if (reportTotals.rowCount > 0) {
				await stageReconciliationReportChunk(ctx, { ...scope, draft: report });
				if (quietHandoff.length)
					await ctx.runMutation(
						internal.reconciliationReports.stageHandoffKeys,
						{ ...scope, keys: quietHandoff },
					);
			}
		}
		for (const locales of archiveLocaleBatches(transitionArchives.locales))
			await ctx.runMutation(internal.archiveReconciliation.stageLocales, {
				...scope,
				locales,
			});
		if (reportTotals.rowCount > 0)
			await stageReconciliationReportChunk(ctx, {
				...scope,
				draft: transitionReport,
			});
		await ctx.runMutation(internal.archiveReconciliation.complete, {
			projectId: identity.projectId,
			projectionId,
			actor: identity.actor,
		});
		await ctx.runMutation(internal.archiveReconciliation.completeState, {
			projectId: identity.projectId,
			projectionId,
			actor: identity.actor,
		});
		if (reportTotals.rowCount > 0)
			await ctx.runMutation(internal.reconciliationReports.complete, scope);
		while (
			!(await ctx.runMutation(internal.catalogProcessing.discardInputs, scope))
		) {
			/* bounded cleanup */
		}
		await stageLocaleDeliveries(ctx, {
			projectId: identity.projectId,
			projectionId,
			repository: identity.repository,
			commit: identity.commit,
			source: currentSource.document,
			files: deliveryFiles,
			boundFiles,
			actor: identity.actor,
		});
		// Stage the complete Navigation Index for the pending generation so the
		// publish gate can rely on a full envelope for this projection.
		let navigationReady = false;
		for (
			let step = 0;
			step < MAX_NAVIGATION_STAGE_STEPS && !navigationReady;
			step += 1
		) {
			const staged = await ctx.runMutation(
				internal.catalogWorkspaceNavigation.stageNavigationIndexStep,
				{ projectId: identity.projectId, projectionId },
			);
			if (staged.status === "ready") {
				navigationReady = true;
			}
		}
		if (!navigationReady) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Navigation staging did not finish within its step budget.",
			});
		}
		return { projectionId };
	} catch (error) {
		await discardStagingProjection(
			ctx,
			identity.projectId,
			projectionId,
			identity.actor,
		);
		throw error;
	}
}

async function stageStoredProjection(
	ctx: ActionCtx,
	identity: Identity,
	snapshotId: Id<"sourceSnapshots">,
): Promise<StagedProjection> {
	const evidence: ProjectionEvidence = await ctx.runQuery(
		internal.snapshots.projectionEvidenceFor,
		{
			snapshotId,
			actor: identity.actor,
		},
	);
	if (evidence.projectId !== identity.projectId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Source Snapshot evidence belongs to another project.",
		});
	}
	async function* projectionFiles(): AsyncGenerator<ProjectionFile> {
		for (const file of [...evidence.files].sort(
			(a, b) => Number(b.isSource) - Number(a.isSource),
		)) {
			const blob = await ctx.storage.get(file.storageId);
			if (!blob)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Stored catalog evidence is missing.",
				});
			yield { ...file, document: parse(await blob.text()) };
		}
	}
	async function* submittedFiles(): AsyncGenerator<SubmittedFile> {
		for (const file of [...evidence.files, ...evidence.unboundLocaleFiles]) {
			const blob = await ctx.storage.get(file.storageId);
			if (!blob)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Stored catalog evidence is missing.",
				});
			yield { catalogPath: file.catalogPath, content: await blob.text() };
		}
	}

	return await stageProjection(
		ctx,
		identity,
		projectionFiles(),
		evidence.absentTargetLocales,
		evidence.unboundLocaleFiles,
		submittedFiles(),
		{
			projectionId: evidence.projectionId,
			localeBindingRevision: evidence.localeBindingRevision,
		},
	);
}

async function deleteStoredFiles(
	ctx: ActionCtx,
	files: readonly { storageId: Id<"_storage"> }[],
): Promise<void> {
	for (const file of files) {
		try {
			await ctx.storage.delete(file.storageId);
		} catch {
			// The run still records the failed attempt if deletion itself fails.
			// File storage cleanup can be retried operationally without exposing a
			// Catalog Document or a baseline transition.
		}
	}
}

async function resolveProjectionNeed(
	ctx: ActionCtx,
	identity: Identity,
	result: IngestionResult,
): Promise<IngestionResult> {
	if (!result.needsProjection) return result;
	if (!result.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "A projection was requested without a Source Snapshot.",
		});
	}
	const stagedProjection = await stageStoredProjection(
		ctx,
		identity,
		result.snapshotId,
	);
	try {
		const resolved: IngestionResult | null = await ctx.runMutation(
			internal.snapshots.reusePublished,
			{
				...identity,
				projectionId: stagedProjection.projectionId,
			},
		);
		if (!resolved) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot disappeared while its projection was staged.",
			});
		}
		if (!resolved.publishedProjection) {
			await discardStagingProjection(
				ctx,
				identity.projectId,
				stagedProjection.projectionId,
				identity.actor,
			);
		}
		if (resolved.needsProjection) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Catalog projection could not be finalized.",
			});
		}
		return resolved;
	} catch (error) {
		await discardStagingProjection(
			ctx,
			identity.projectId,
			stagedProjection.projectionId,
			identity.actor,
		);
		throw error;
	}
}

async function recordFailure(
	ctx: ActionCtx,
	identity: Identity,
	error: unknown,
): Promise<IngestionResult> {
	const reason = error instanceof Error ? error.message : String(error);
	return await ctx.runMutation(internal.snapshots.finalizeIngestion, {
		...identity,
		diagnostics: [
			{
				message: `Catalog evidence or projection could not be completed: ${reason}`,
			},
		],
		absentTargetLocales: [],
		unboundLocaleFiles: [],
		files: [],
	});
}

async function ingestSnapshot(
	ctx: ActionCtx,
	args: IngestArgs,
	remainingConflictRetries: number,
): Promise<PublicIngestionResult> {
	assertSnapshotEnvelope(args.files);
	const identity: Identity = {
		projectId: args.projectId,
		repository: args.repository,
		commit: args.commit,
		manifestHash: await hashManifest(args.files),
		lineage: args.lineage,
		actor: args.actor,
	};
	const reused: IngestionResult | null = await ctx.runMutation(
		internal.snapshots.reusePublished,
		identity,
	);
	if (reused) {
		const result = await resolveProjectionNeed(ctx, identity, reused);
		return { runId: result.runId, snapshotId: result.snapshotId };
	}

	const bindingBasis: BindingBasis & { bindings: Binding[] } =
		await ctx.runQuery(internal.snapshots.bindingsFor, {
			projectId: args.projectId,
			actor: args.actor,
		});
	const { diagnostics, matched, absentTargetLocales, unboundLocaleFiles } =
		inspect(args.files, bindingBasis.bindings);
	if (diagnostics.length > 0) {
		const result: IngestionResult = await ctx.runMutation(
			internal.snapshots.finalizeIngestion,
			{
				...identity,
				diagnostics,
				absentTargetLocales: [],
				unboundLocaleFiles: [],
				files: [],
			},
		);
		const resolved = await resolveProjectionNeed(ctx, identity, result);
		return { runId: resolved.runId, snapshotId: resolved.snapshotId };
	}
	if (!matched.some((file) => file.isSource)) {
		const result: IngestionResult = await ctx.runMutation(
			internal.snapshots.finalizeIngestion,
			{
				...identity,
				diagnostics: [{ message: "The project has no bound source Locale." }],
				absentTargetLocales: [],
				unboundLocaleFiles: [],
				files: [],
			},
		);
		const resolved = await resolveProjectionNeed(ctx, identity, result);
		return { runId: resolved.runId, snapshotId: resolved.snapshotId };
	}

	const storedFiles: StoredSnapshotFile[] = [];
	const storedUnboundLocaleFiles: StoredUnboundSnapshotFile[] = [];
	let stagedProjection: StagedProjection | undefined;
	let result: IngestionResult;
	try {
		const shouldStage: boolean = await ctx.runQuery(
			internal.snapshots.shouldStageProjection,
			{
				projectId: args.projectId,
				lineage: args.lineage,
				actor: args.actor,
			},
		);
		if (shouldStage) {
			stagedProjection = await stageProjection(
				ctx,
				identity,
				matched,
				absentTargetLocales,
				unboundLocaleFiles,
				args.files,
				{
					projectionId: bindingBasis.projectionId,
					localeBindingRevision: bindingBasis.localeBindingRevision,
				},
			);
		}

		// Store sequentially: each storage write must complete before publication.
		for (const file of matched) {
			const blob = new Blob([file.content]);
			storedFiles.push({
				localeId: file.localeId,
				localeCode: file.localeCode,
				isSource: file.isSource,
				catalogPath: file.catalogPath,
				storageId: await ctx.storage.store(blob),
				byteLength: blob.size,
			});
		}
		for (const file of unboundLocaleFiles) {
			const blob = new Blob([file.content]);
			storedUnboundLocaleFiles.push({
				catalogPath: file.catalogPath,
				...(file.declaredLocaleCode === undefined
					? {}
					: { declaredLocaleCode: file.declaredLocaleCode }),
				...(file.messageCount === undefined
					? {}
					: { messageCount: file.messageCount }),
				storageId: await ctx.storage.store(blob),
				byteLength: blob.size,
			});
		}
		result = await ctx.runMutation(internal.snapshots.finalizeIngestion, {
			...identity,
			...(stagedProjection === undefined
				? {}
				: { projectionId: stagedProjection.projectionId }),
			diagnostics: [],
			absentTargetLocales,
			unboundLocaleFiles: storedUnboundLocaleFiles,
			files: storedFiles,
		});
	} catch (error) {
		if (
			error instanceof ConvexError &&
			error.data.code === "CONFLICT" &&
			stagedProjection
		) {
			await deleteStoredFiles(ctx, [
				...storedFiles,
				...storedUnboundLocaleFiles,
			]);
			await discardStagingProjection(
				ctx,
				args.projectId,
				stagedProjection.projectionId,
				identity.actor,
			);
			const resumed = await ctx.runMutation(
				internal.snapshots.reusePublished,
				identity,
			);
			if (resumed) {
				const resolved = await resolveProjectionNeed(ctx, identity, resumed);
				return { runId: resolved.runId, snapshotId: resolved.snapshotId };
			}
			if (remainingConflictRetries === 0) {
				return await recordFailureResult(ctx, identity, error);
			}
			return await ingestSnapshot(ctx, args, remainingConflictRetries - 1);
		}
		await deleteStoredFiles(ctx, [...storedFiles, ...storedUnboundLocaleFiles]);
		if (stagedProjection) {
			await discardStagingProjection(
				ctx,
				args.projectId,
				stagedProjection.projectionId,
				identity.actor,
			);
		}
		result = await recordFailure(ctx, identity, error);
	}

	if (result.reused)
		await deleteStoredFiles(ctx, [...storedFiles, ...storedUnboundLocaleFiles]);
	if (stagedProjection && !result.publishedProjection) {
		await discardStagingProjection(
			ctx,
			args.projectId,
			stagedProjection.projectionId,
			identity.actor,
		);
	}
	const resolved = await resolveProjectionNeed(ctx, identity, result);
	return { runId: resolved.runId, snapshotId: resolved.snapshotId };
}

/** Adapter-only action: the HTTP transport authenticates the token, then this
 * reuses the same ingestion state machine as the browser action. */
export const ingestFromRepositoryAdapter = internalAction({
	args: {
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		files: v.array(v.object({ catalogPath: v.string(), content: v.string() })),
		lineage: v.optional(lineageValidator),
		actor: repositoryAdapterActorValidator,
	},
	handler: async (ctx, args): Promise<PublicIngestionResult> =>
		await ingestSnapshot(ctx, args, MAX_INGEST_CONFLICT_RESTAGES),
});

/** Compact receipt reader for the Repository Adapter transport. */
export const repositoryAdapterReceipt = internalQuery({
	args: {
		runId: v.id("snapshotIngestionRuns"),
		actor: repositoryAdapterActorValidator,
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (!run) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Ingestion run not found.",
			});
		}
		await authorizeIngestion(ctx, run.projectId, args.actor);
		const diagnostics = await ctx.db
			.query("snapshotIngestionDiagnostics")
			.withIndex("by_run_and_generation", (q) =>
				q.eq("runId", run._id).eq("generation", run.diagnosticGeneration),
			)
			.take(8_193);
		if (diagnostics.length > 8_192) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Ingestion diagnostics exceed the supported receipt envelope.",
			});
		}
		let unboundLocaleFiles: Array<{
			catalogPath: string;
			declaredLocaleCode: string | null;
			messageCount: number | null;
		}> = [];
		let absentTargetLocaleCount = 0;
		const snapshotId = run.snapshotId;
		if (snapshotId) {
			const { files } = await readCatalogDiscovery(
				ctx,
				run.projectId,
				snapshotId,
			);
			unboundLocaleFiles = files.map((file) => ({
				catalogPath: file.catalogPath,
				declaredLocaleCode: file.declaredLocaleCode ?? null,
				messageCount: file.messageCount ?? null,
			}));
			const absent = await ctx.db
				.query("sourceSnapshotAbsentLocales")
				.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
				.take(MAX_PROJECTED_LOCALES + 1);
			if (absent.length > MAX_PROJECTED_LOCALES) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Absent Locale evidence exceeds the receipt envelope.",
				});
			}
			absentTargetLocaleCount = absent.length;
		}
		let syncUrl: string | null = null;
		if (process.env.SITE_URL) {
			try {
				const url = new URL(
					`/projects/${run.projectId}/sync#discovered-catalogs`,
					process.env.SITE_URL,
				);
				if (url.protocol === "https:" || url.protocol === "http:")
					syncUrl = url.href;
			} catch {
				/* Missing or invalid web configuration must not fail an accepted sync. */
			}
		}

		return {
			version: 1,
			syncUrl,
			run: {
				id: run._id,
				status: run.status,
				snapshotId: run.snapshotId ?? null,
				diagnosticCount: diagnostics.length,
				diagnostics: diagnostics.map(({ catalogPath, message }) => ({
					...(catalogPath === undefined ? {} : { catalogPath }),
					message,
				})),
				unboundLocaleFileCount: unboundLocaleFiles.length,
				unboundLocaleFiles,
				absentTargetLocaleCount,
			},
		};
	},
});

async function recordFailureResult(
	ctx: ActionCtx,
	identity: Identity,
	error: unknown,
): Promise<PublicIngestionResult> {
	const result = await recordFailure(ctx, identity, error);
	const resolved = await resolveProjectionNeed(ctx, identity, result);
	return { runId: resolved.runId, snapshotId: resolved.snapshotId };
}

/**
 * Ingest one commit's bound catalogs as a Source Snapshot.
 *
 * Existing Snapshot Identities are reused before mutable bindings are read.
 * New evidence is staged privately and becomes visible only in the same
 * transaction that promotes its Source Snapshot to the baseline. A concurrent
 * recovery request causes bounded private restaging; sustained contention is
 * recorded as durable diagnostics that a later resubmission can resume.
 */
export const ingest = action({
	args: {
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		files: v.array(v.object({ catalogPath: v.string(), content: v.string() })),
		lineage: v.optional(lineageValidator),
	},
	handler: async (ctx, args): Promise<PublicIngestionResult> =>
		await ingestSnapshot(ctx, args, MAX_INGEST_CONFLICT_RESTAGES),
});

export const list = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args): Promise<Doc<"sourceSnapshots">[]> => {
		await requireViewer(ctx, args.projectId);
		return await ctx.db
			.query("sourceSnapshots")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.order("desc")
			.take(MAX_LISTED_SNAPSHOTS);
	},
});

/**
 * The bounded Project Control Plane read for the first-use web flow. It keeps
 * setup, accepted-catalog availability, and the latest durable sync receipt in
 * one seam so the Dashboard and Sync route never need to inspect ingestion
 * tables or load the working catalog merely to choose the next action.
 */
export const syncSetup = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		const locales = await ctx.db
			.query("locales")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.take(MAX_PROJECT_LOCALES + 1);
		if (locales.length > MAX_PROJECT_LOCALES) {
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `A project may bind at most ${MAX_PROJECT_LOCALES} Locales.`,
			});
		}
		const activeLocales = locales.filter(
			(locale) => locale.archivedAt === undefined,
		);
		const bindings = activeLocales.map((locale) => ({
			id: locale._id,
			code: locale.code,
			label: locale.label,
			isSource: locale.isSource,
			catalogPath: locale.catalogPath ?? null,
		}));
		const latestRun = await ctx.db
			.query("snapshotIngestionRuns")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.order("desc")
			.first();
		const baseline = project.baselineSnapshotId
			? await ctx.db.get(project.baselineSnapshotId)
			: null;
		const latestDiagnostics = latestRun
			? await ctx.db
					.query("snapshotIngestionDiagnostics")
					.withIndex("by_run_and_generation", (q) =>
						q
							.eq("runId", latestRun._id)
							.eq("generation", latestRun.diagnosticGeneration),
					)
					.take(MAX_SYNC_SETUP_DIAGNOSTICS + 1)
			: [];
		const setupIssues: string[] = [];
		if (!bindings.some((binding) => binding.isSource && binding.catalogPath)) {
			setupIssues.push(
				"Bind the source Locale to a catalog path before syncing.",
			);
		}
		if (!bindings.some((binding) => !binding.isSource && binding.catalogPath)) {
			setupIssues.push("Bind at least one target Locale before syncing.");
		}
		const boundCount = bindings.filter(
			(binding) => binding.catalogPath !== null,
		).length;
		if (boundCount > MAX_PROJECTED_LOCALES)
			setupIssues.push(
				`At most ${MAX_PROJECTED_LOCALES} bound Locales fit the working catalog.`,
			);
		const projection = project.activeCatalogProjectionId
			? await ctx.db.get(project.activeCatalogProjectionId)
			: null;
		if (
			projection &&
			projection.expectedKeyCount * boundCount > MAX_WORKING_CATALOG_ROWS
		)
			setupIssues.push(
				`These bindings exceed the ${MAX_WORKING_CATALOG_ROWS}-value working catalog limit.`,
			);
		const snapshotId = latestRun?.snapshotId;
		const evidenceCounts = snapshotId
			? await Promise.all([
					ctx.db
						.query("sourceSnapshotUnboundFiles")
						.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
						.take(MAX_SYNC_SETUP_EVIDENCE_ROWS + 1),
					ctx.db
						.query("sourceSnapshotAbsentLocales")
						.withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
						.take(MAX_SYNC_SETUP_EVIDENCE_ROWS + 1),
				])
			: [[], []];
		return {
			version: 1,
			integrationBranch:
				project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
			project: {
				id: project._id,
				name: project.name,
				repository: project.repository ?? baseline?.repository ?? null,
			},
			bindings,
			setupIssues,
			canSync: setupIssues.length === 0,
			limits: {
				maxBoundLocales: MAX_PROJECTED_LOCALES,
				maxWorkingCatalogRows: MAX_WORKING_CATALOG_ROWS,
				maxWorkingCatalogBytes: MAX_WORKING_CATALOG_BYTES,
				maxFiles: MAX_SNAPSHOT_FILES,
				maxBytes: MAX_SNAPSHOT_BYTES,
			},
			baseline: baseline
				? {
						id: baseline._id,
						repository: baseline.repository,
						commit: baseline.commit,
						kind: baseline.kind,
						createdAt: baseline.createdAt,
					}
				: null,
			latestRun: latestRun
				? {
						id: latestRun._id,
						status: latestRun.status,
						snapshotId: latestRun.snapshotId ?? null,
						createdAt: latestRun.createdAt,
						diagnosticCount: latestDiagnostics.length,
						diagnostics: latestDiagnostics
							.slice(0, MAX_SYNC_SETUP_DIAGNOSTICS)
							.map(({ catalogPath, message }) => ({
								...(catalogPath === undefined ? {} : { catalogPath }),
								message,
							})),
						unboundLocaleFileCount: Math.min(
							evidenceCounts[0].length,
							MAX_SYNC_SETUP_EVIDENCE_ROWS,
						),
						absentTargetLocaleCount: Math.min(
							evidenceCounts[1].length,
							MAX_SYNC_SETUP_EVIDENCE_ROWS,
						),
					}
				: null,
		};
	},
});

export const getBaseline = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const project = await ctx.db.get(args.projectId);
		if (!project) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Project not found.",
			});
		}
		return project.baselineSnapshotId
			? await ctx.db.get(project.baselineSnapshotId)
			: null;
	},
});

export const get = query({
	args: { snapshotId: v.id("sourceSnapshots") },
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Snapshot not found.",
			});
		}
		await requireViewer(ctx, snapshot.projectId);
		const files = await ctx.db
			.query("sourceSnapshotFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
			.take(MAX_SNAPSHOT_FILES + 1);
		if (files.length > MAX_SNAPSHOT_FILES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot exceeds the supported file envelope.",
			});
		}
		const unboundLocaleFiles = await ctx.db
			.query("sourceSnapshotUnboundFiles")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
			.take(MAX_SNAPSHOT_FILES + 1);
		if (files.length + unboundLocaleFiles.length > MAX_SNAPSHOT_FILES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source Snapshot exceeds the supported file envelope.",
			});
		}
		const absentTargetLocales = await ctx.db
			.query("sourceSnapshotAbsentLocales")
			.withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
			.take(MAX_PROJECTED_LOCALES + 1);
		if (absentTargetLocales.length > MAX_PROJECTED_LOCALES) {
			throw new ConvexError({
				code: "INTEGRITY",
				message:
					"Source Snapshot exceeds the supported absent-Locale envelope.",
			});
		}
		return { ...snapshot, files, absentTargetLocales, unboundLocaleFiles };
	},
});

export const getRun = query({
	args: { runId: v.id("snapshotIngestionRuns") },
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (!run) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Ingestion run not found.",
			});
		}
		await requireViewer(ctx, run.projectId);
		const diagnostics = await ctx.db
			.query("snapshotIngestionDiagnostics")
			.withIndex("by_run_and_generation", (q) =>
				q.eq("runId", args.runId).eq("generation", run.diagnosticGeneration),
			)
			// `inspect` accepts at most 1,000 files, so even its exhaustive
			// missing, duplicate, unbound, and parse diagnostics fit below this
			// explicit Convex array bound.
			.take(8_192);
		return { ...run, diagnostics };
	},
});

export const storageIdFor = internalQuery({
	args: {
		snapshotId: v.id("sourceSnapshots"),
		localeCode: v.string(),
	},
	handler: async (ctx, args): Promise<Id<"_storage">> => {
		const snapshot = await ctx.db.get(args.snapshotId);
		if (!snapshot) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Snapshot not found.",
			});
		}
		await requireViewer(ctx, snapshot.projectId);
		const files = await snapshotCatalogFiles(ctx, snapshot._id);
		const file = files.find((file) => file.localeCode === args.localeCode);
		if (!file) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: `Snapshot holds no catalog for the "${args.localeCode}" Locale.`,
			});
		}
		return file.storageId;
	},
});

/**
 * The exact bytes a snapshot holds for one Locale. This is the evidence the
 * whole model rests on, so it is readable rather than merely stored.
 */
export const catalogText = action({
	args: {
		snapshotId: v.id("sourceSnapshots"),
		localeCode: v.string(),
	},
	handler: async (ctx, args): Promise<string> => {
		const storageId: Id<"_storage"> = await ctx.runQuery(
			internal.snapshots.storageIdFor,
			args,
		);
		const blob = await ctx.storage.get(storageId);
		if (!blob) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Stored catalog is missing.",
			});
		}
		return await blob.text();
	},
});

export const publishBindingRealization = internalMutation({
	args: {
		pendingLocale: v.optional(v.boolean()),
		projectId: v.id("projects"),
		localeId: v.id("locales"),
		catalogPath: v.string(),
		expectedCatalogPath: v.optional(v.string()),
		snapshotId: v.id("sourceSnapshots"),
		projectionId: v.id("catalogProjections"),
		unboundFileId: v.id("sourceSnapshotUnboundFiles"),
	},
	handler: async (ctx, args) => {
		await requireEditor(ctx, args.projectId);
		const [project, locale, snapshot, file] = await Promise.all([
			ctx.db.get(args.projectId),
			ctx.db.get(args.localeId),
			ctx.db.get(args.snapshotId),
			ctx.db.get(args.unboundFileId),
		]);
		if (
			!project ||
			!locale ||
			locale.projectId !== args.projectId ||
			locale.isSource ||
			(args.pendingLocale
				? !locale.pendingBinding || locale.archivedAt === undefined
				: locale.archivedAt !== undefined) ||
			locale.catalogPath !== args.expectedCatalogPath ||
			!snapshot ||
			snapshot.projectId !== args.projectId ||
			project.baselineSnapshotId !== snapshot._id ||
			!file ||
			file.snapshotId !== snapshot._id ||
			file.catalogPath !== args.catalogPath
		)
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"Binding evidence or Baseline changed during realization. Retry the binding.",
			});
		const claimants = await ctx.db
			.query("locales")
			.withIndex("by_project_catalogPath", (q) =>
				q.eq("projectId", args.projectId).eq("catalogPath", args.catalogPath),
			)
			.take(2);
		if (claimants.some((candidate) => candidate._id !== locale._id))
			throw new ConvexError({
				code: "CONFLICT",
				message: "The observed file was bound to another Locale.",
			});
		const existing = await ctx.db
			.query("localeBindingRealizations")
			.withIndex("by_snapshot_and_localeCode", (q) =>
				q.eq("snapshotId", snapshot._id).eq("localeCode", locale.code),
			)
			.unique();
		if (existing)
			throw new ConvexError({
				code: "CONFLICT",
				message: "This Locale binding has already been realized.",
			});
		await ctx.db.insert("localeBindingRealizations", {
			projectId: args.projectId,
			snapshotId: snapshot._id,
			localeId: locale._id,
			localeCode: locale.code,
			isSource: false,
			catalogPath: file.catalogPath,
			storageId: file.storageId,
			byteLength: file.byteLength,
			projectionId: args.projectionId,
			realizedAt: now(),
		});
		await ctx.db.patch(locale._id, {
			catalogPath: args.catalogPath,
			...(args.pendingLocale
				? { archivedAt: undefined, pendingBinding: undefined }
				: {}),
		});
		await publishProjection(ctx, {
			identity: {
				projectId: args.projectId,
				repository: snapshot.repository,
				commit: snapshot.commit,
				manifestHash: snapshot.manifestHash,
			},
			project,
			snapshotId: snapshot._id,
			projectionId: args.projectionId,
			advancesBaseline: false,
			timestamp: now(),
		});
		await ctx.db.patch(project._id, {
			localeBindingRevision: (project.localeBindingRevision ?? 0) + 1,
		});
		return null;
	},
});

/** Reuse the ordinary bounded projection pipeline over immutable Baseline
 * bytes, adding exactly the file the editor chose. Publication rechecks the
 * Baseline, binding claim, and staged generation in one transaction. */
export async function realizeLocaleBinding(
	ctx: ActionCtx,
	input: {
		pendingLocale?: boolean;
		projectId: Id<"projects">;
		localeId: Id<"locales">;
		catalogPath: string;
		expectedCatalogPath?: string;
		snapshotId: Id<"sourceSnapshots">;
		unboundFileId: Id<"sourceSnapshotUnboundFiles">;
	},
): Promise<void> {
	const plan = await ctx.runQuery(internal.locales.bindingPlan, {
		localeId: input.localeId,
		allowPending: input.pendingLocale,
		catalogPath: input.catalogPath,
	});
	if (
		!plan.snapshot ||
		plan.snapshot._id !== input.snapshotId ||
		!plan.unboundFile ||
		plan.unboundFile._id !== input.unboundFileId
	)
		throw new ConvexError({
			code: "CONFLICT",
			message: "The chosen Unbound Locale File is no longer current.",
		});
	const evidence: ProjectionEvidence = await ctx.runQuery(
		internal.snapshots.projectionEvidenceFor,
		{ snapshotId: input.snapshotId },
	);
	const storedFiles = [
		...evidence.files.filter((file) => file.localeId !== input.localeId),
		{
			localeId: input.localeId,
			localeCode: plan.locale.code,
			isSource: false,
			catalogPath: input.catalogPath,
			storageId: plan.unboundFile.storageId,
		},
	].sort((a, b) => Number(b.isSource) - Number(a.isSource));
	async function load(
		file: (typeof storedFiles)[number],
	): Promise<SubmittedFile> {
		const blob = await ctx.storage.get(file.storageId);
		if (!blob)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Stored Baseline file is missing.",
			});
		return { catalogPath: file.catalogPath, content: await blob.text() };
	}
	async function* files(): AsyncGenerator<ProjectionFile> {
		for (const file of storedFiles)
			yield {
				...file,
				document: parseBoundCatalog(await load(file), file.localeCode),
			};
	}
	async function* deliveryFiles(): AsyncGenerator<SubmittedFile> {
		for (const file of storedFiles) yield await load(file);
	}

	const identity: Identity = {
		projectId: input.projectId,
		repository: plan.snapshot.repository,
		commit: plan.snapshot.commit,
		manifestHash: plan.snapshot.manifestHash,
	};
	const staged = await stageProjection(
		ctx,
		identity,
		files(),
		evidence.absentTargetLocales.filter(
			(locale) => locale.localeId !== input.localeId,
		),
		evidence.unboundLocaleFiles.filter(
			(file) => file.catalogPath !== input.catalogPath,
		),
		deliveryFiles(),
		{
			projectionId: evidence.projectionId,
			localeBindingRevision: evidence.localeBindingRevision,
		},
	);
	try {
		await ctx.runMutation(internal.snapshots.publishBindingRealization, {
			...input,
			projectionId: staged.projectionId,
		});
	} catch (error) {
		await discardStagingProjection(ctx, input.projectId, staged.projectionId);
		throw error;
	}
}

/** File uploads enter the same publication protocol as inline ingestion, while
 * retaining only one parsed catalog at a time. Uploaded blobs become immutable
 * Snapshot evidence directly; the upload session cleans up unreferenced blobs. */
export async function ingestUploadedSnapshot(
	ctx: ActionCtx,
	args: Omit<IngestArgs, "files"> & {
		files: readonly {
			catalogPath: string;
			storageId: Id<"_storage">;
			contentHash: string;
			byteLength: number;
		}[];
	},
	remainingConflictRetries = MAX_INGEST_CONFLICT_RESTAGES,
): Promise<PublicIngestionResult> {
	const { sha256 } = await import("@noble/hashes/sha2.js");
	const { bytesToHex } = await import("@noble/hashes/utils.js");
	const encoder = new TextEncoder();
	const manifest = sha256.create().update(encoder.encode("["));
	const sorted = [...args.files].sort((a, b) =>
		a.catalogPath.localeCompare(b.catalogPath),
	);
	const bindingBasis: BindingBasis & { bindings: Binding[] } =
		await ctx.runQuery(internal.snapshots.bindingsFor, {
			projectId: args.projectId,
			actor: args.actor,
		});
	const bindings = new Map(
		bindingBasis.bindings.map((binding) => [binding.catalogPath, binding]),
	);
	const submitted = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	const storedFiles: StoredSnapshotFile[] = [];
	const unboundFiles: StoredUnboundSnapshotFile[] = [];
	if (sorted.length > MAX_SNAPSHOT_FILES)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Too many catalog files in the upload.",
		});
	async function load(file: (typeof sorted)[number]) {
		const blob = await ctx.storage.get(file.storageId);
		if (!blob || blob.size !== file.byteLength || blob.size > 8 * 1024 * 1024)
			throw new ConvexError({
				code: "INTEGRITY",
				message: `Uploaded catalog ${file.catalogPath} is missing or has an invalid size.`,
			});
		const content = await blob.text();
		if ((await sha256Hex(content)) !== file.contentHash)
			throw new ConvexError({
				code: "INTEGRITY",
				message: `Uploaded catalog ${file.catalogPath} has changed.`,
			});
		return { catalogPath: file.catalogPath, content };
	}
	for (const [index, file] of sorted.entries()) {
		const loaded = await load(file);
		if (index > 0) manifest.update(encoder.encode(","));
		manifest.update(
			encoder.encode(JSON.stringify([file.catalogPath, loaded.content])),
		);
		if (submitted.has(file.catalogPath))
			diagnostics.push({
				catalogPath: file.catalogPath,
				message: "More than one file was submitted for this catalog.",
			});
		submitted.add(file.catalogPath);
		const binding = bindings.get(file.catalogPath);
		if (binding) {
			try {
				parseBoundCatalog(loaded, binding.localeCode);
				storedFiles.push({
					...binding,
					storageId: file.storageId,
					byteLength: file.byteLength,
				});
			} catch (error) {
				diagnostics.push({
					catalogPath: file.catalogPath,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			const inspected = inspectUnboundLocaleFile(loaded);
			unboundFiles.push({
				catalogPath: file.catalogPath,
				storageId: file.storageId,
				byteLength: file.byteLength,
				...(inspected.declaredLocaleCode === undefined
					? {}
					: { declaredLocaleCode: inspected.declaredLocaleCode }),
				...(inspected.messageCount === undefined
					? {}
					: { messageCount: inspected.messageCount }),
			});
		}
	}
	manifest.update(encoder.encode("]"));
	const identity: Identity = {
		projectId: args.projectId,
		repository: args.repository,
		commit: args.commit,
		lineage: args.lineage,
		actor: args.actor,
		manifestHash: bytesToHex(manifest.digest()),
	};
	const reused: IngestionResult | null = await ctx.runMutation(
		internal.snapshots.reusePublished,
		identity,
	);
	if (reused) {
		const result = await resolveProjectionNeed(ctx, identity, reused);
		return { runId: result.runId, snapshotId: result.snapshotId };
	}
	const absentTargetLocales: AbsentTargetLocale[] = [];
	for (const binding of bindingBasis.bindings) {
		if (submitted.has(binding.catalogPath)) continue;
		if (binding.isSource)
			diagnostics.push({
				catalogPath: binding.catalogPath,
				message: `No file submitted for the "${binding.localeCode}" Source Locale.`,
			});
		else
			absentTargetLocales.push({
				localeId: binding.localeId,
				localeCode: binding.localeCode,
				catalogPath: binding.catalogPath,
			});
	}
	if (!storedFiles.some((file) => file.isSource))
		diagnostics.push({
			message: "The project has no valid bound Source catalog.",
		});
	if (diagnostics.length) {
		const result: IngestionResult = await ctx.runMutation(
			internal.snapshots.finalizeIngestion,
			{
				...identity,
				diagnostics,
				files: [],
				absentTargetLocales: [],
				unboundLocaleFiles: [],
			},
		);
		return { runId: result.runId, snapshotId: result.snapshotId };
	}
	const sourceFirst = [...sorted].sort(
		(a, b) =>
			Number(bindings.get(b.catalogPath)?.isSource ?? false) -
			Number(bindings.get(a.catalogPath)?.isSource ?? false),
	);
	async function* projectionFiles(): AsyncGenerator<ProjectionFile> {
		for (const file of sourceFirst) {
			const binding = bindings.get(file.catalogPath);
			if (!binding) continue;
			yield {
				...binding,
				document: parseBoundCatalog(await load(file), binding.localeCode),
			};
		}
	}
	async function* deliveryFiles(): AsyncGenerator<SubmittedFile> {
		for (const file of sorted) yield await load(file);
	}
	let stagedProjection: StagedProjection | undefined;
	let result: IngestionResult;
	try {
		const shouldStage: boolean = await ctx.runQuery(
			internal.snapshots.shouldStageProjection,
			{ projectId: args.projectId, lineage: args.lineage, actor: args.actor },
		);
		if (shouldStage)
			stagedProjection = await stageProjection(
				ctx,
				identity,
				projectionFiles(),
				absentTargetLocales,
				unboundFiles,
				deliveryFiles(),
				{
					projectionId: bindingBasis.projectionId,
					localeBindingRevision: bindingBasis.localeBindingRevision,
				},
			);
		result = await ctx.runMutation(internal.snapshots.finalizeIngestion, {
			...identity,
			...(stagedProjection
				? { projectionId: stagedProjection.projectionId }
				: {}),
			diagnostics: [],
			files: storedFiles,
			absentTargetLocales,
			unboundLocaleFiles: unboundFiles,
		});
	} catch (error) {
		if (stagedProjection)
			await discardStagingProjection(
				ctx,
				args.projectId,
				stagedProjection.projectionId,
				args.actor,
			);
		if (
			error instanceof ConvexError &&
			error.data.code === "CONFLICT" &&
			remainingConflictRetries > 0
		)
			return await ingestUploadedSnapshot(
				ctx,
				args,
				remainingConflictRetries - 1,
			);
		return await recordFailure(ctx, identity, error);
	}
	if (stagedProjection && !result.publishedProjection)
		await discardStagingProjection(
			ctx,
			args.projectId,
			stagedProjection.projectionId,
			args.actor,
		);
	const resolved = await resolveProjectionNeed(ctx, identity, result);
	return { runId: resolved.runId, snapshotId: resolved.snapshotId };
}
