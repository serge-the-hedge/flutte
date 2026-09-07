import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	activeProjectionFor,
	MAX_PROJECTED_LOCALES,
} from "./catalogProjection";
import { readyNavigationStateFor } from "./catalogWorkspaceNavigation";
import { currentHeadForRow, valueIdentity } from "./catalogWorkspaceView";
import { DEFAULT_INTEGRATION_BRANCH, now, sha256Hex } from "./lib";
import { snapshotCatalogFiles } from "./localeDelivery";
import {
	repositoryAdapterActorValidator,
	requireEditor,
	requireViewer,
} from "./permissions";
import type {
	ReleaseBundleArtifact,
	ReleaseBundleManifest,
} from "./releaseBundleModel";
import { isReleaseDelta } from "./releaseRecordModel";
import {
	isCurrentSourceProposalHeadForSource,
	publishedResolutionFor,
	sourceProposalHeadFor,
} from "./sourceProposals";

const MAX_RELEASE_BUNDLE_FILES = MAX_PROJECTED_LOCALES;
// One key fits the catalog processing budget; its current heads can double the read.
const MAX_RELEASE_BUNDLE_PAGE = 1;
const RELEASE_CHUNK_TARGET_BYTES = 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;

const buildSummaryValidator = v.object({
	runId: v.id("releaseBuildRuns"),
	recordId: v.id("releaseRecords"),
	status: v.union(
		v.literal("building"),
		v.literal("ready"),
		v.literal("failed"),
	),
	changeKeyCount: v.union(v.number(), v.null()),
	bundleByteLength: v.union(v.number(), v.null()),
	failure: v.union(
		v.object({
			code: v.optional(v.string()),
			message: v.string(),
			failedAt: v.number(),
		}),
		v.null(),
	),
});

const readyLocaleProposalValidator = v.union(
	v.object({
		proposalId: v.id("localeProposals"),
		localeCode: v.string(),
		runtimeLocale: v.string(),
		valueCount: v.number(),
	}),
	v.null(),
);

function buildSummary(run: Doc<"releaseBuildRuns">) {
	return {
		runId: run._id,
		recordId: run.recordId,
		status: run.status,
		changeKeyCount: run.changeKeyCount ?? null,
		bundleByteLength: run.bundleByteLength ?? null,
		failure: run.failure ?? null,
	};
}

async function assertCurrentReadyRecord(
	ctx: QueryCtx | MutationCtx,
	record: Doc<"releaseRecords">,
) {
	if (record.status !== "ready" || record.posture !== "ready") {
		throw new ConvexError({
			code: "BAD_STATE",
			message: "Only a Ready Release Record can become a Release Bundle.",
		});
	}
	const projection = await activeProjectionFor(ctx, record.projectId);
	if (!projection || projection._id !== record.projectionId) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Baseline changed after this Release Record was prepared.",
		});
	}
	const navigation = await readyNavigationStateFor(ctx, {
		projectId: record.projectId,
		projectionId: projection._id,
		expectedRowCount: projection.expectedKeyCount,
	});
	if ((navigation.revision ?? 0) !== record.navigationRevision) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message:
				"The Catalog Workspace changed after this Release Record was prepared.",
		});
	}
}

export const build = mutation({
	args: { recordId: v.id("releaseRecords") },
	returns: buildSummaryValidator,
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Release Record not found.",
			});
		}
		const { userId } = await requireEditor(ctx, record.projectId);
		await assertCurrentReadyRecord(ctx, record);
		const existing = await ctx.db
			.query("releaseBuildRuns")
			.withIndex("by_record", (q) => q.eq("recordId", record._id))
			.order("desc")
			.take(1);
		const reusable = existing[0];
		if (reusable?.status === "ready" || reusable?.status === "building") {
			return buildSummary(reusable);
		}
		const timestamp = now();
		const runId = await ctx.db.insert("releaseBuildRuns", {
			projectId: record.projectId,
			recordId: record._id,
			status: "building",
			startedBy: { kind: "user", id: userId },
			createdAt: timestamp,
		});
		await ctx.scheduler.runAfter(0, internal.releaseBundles.buildArtifact, {
			runId,
		});
		await ctx.scheduler.runAfter(
			24 * 60 * 60 * 1000,
			internal.releaseBundles.cleanupChunks,
			{ runId },
		);
		const run = await ctx.db.get(runId);
		if (!run) throw new ConvexError("Release Build Run was not created.");
		return buildSummary(run);
	},
});

export const forRecord = query({
	args: { recordId: v.id("releaseRecords") },
	returns: v.union(buildSummaryValidator, v.null()),
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record) return null;
		await requireViewer(ctx, record.projectId);
		const runs = await ctx.db
			.query("releaseBuildRuns")
			.withIndex("by_record", (q) => q.eq("recordId", record._id))
			.order("desc")
			.take(1);
		return runs[0] ? buildSummary(runs[0]) : null;
	},
});

/** The optional new-Locale artifact that can be composed with this exact
 * Release Record by the Repository Adapter. Compatibility is snapshot-bound;
 * the web adapter should never infer it from whichever proposal is newest. */
export const readyLocaleProposalForRecord = query({
	args: {
		recordId: v.id("releaseRecords"),
		localeCode: v.optional(v.string()),
	},
	returns: readyLocaleProposalValidator,
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record) return null;
		await requireViewer(ctx, record.projectId);
		if (record.status !== "ready" || record.posture !== "ready") return null;
		const proposal = await ctx.db
			.query("localeProposals")
			.withIndex("by_project_and_sourceSnapshotId_and_localeCode", (q) =>
				q
					.eq("projectId", record.projectId)
					.eq("sourceSnapshotId", record.snapshotId)
					.eq("localeCode", args.localeCode ?? "pt"),
			)
			.unique();
		if (proposal?.status !== "ready") return null;
		if (
			proposal.stagedValueCount !== proposal.sourceMessageCount ||
			proposal.artifactStorageId === undefined ||
			proposal.artifactHash === undefined ||
			proposal.artifactByteLength === undefined
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "The ready Locale Proposal has incomplete delivery evidence.",
			});
		}
		return {
			proposalId: proposal._id,
			localeCode: proposal.localeCode,
			runtimeLocale: proposal.runtimeLocale,
			valueCount: proposal.sourceMessageCount,
		};
	},
});

export const bundleContext = internalQuery({
	args: { runId: v.id("releaseBuildRuns") },
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		const record = run ? await ctx.db.get(run.recordId) : null;
		const project = record ? await ctx.db.get(record.projectId) : null;
		const snapshot = record ? await ctx.db.get(record.snapshotId) : null;
		if (!run || !record || !project || !snapshot || run.status !== "building") {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Release Build Run is no longer buildable.",
			});
		}
		await assertCurrentReadyRecord(ctx, record);
		const files = await snapshotCatalogFiles(ctx, snapshot._id);
		if (
			files.length === 0 ||
			files.length > MAX_RELEASE_BUNDLE_FILES ||
			files.filter(
				(file) => file.isSource ?? file.localeId === project.sourceLocaleId,
			).length !== 1
		) {
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release Bundle has an invalid bound-catalog envelope.",
			});
		}
		return {
			run,
			record,
			artifact: {
				version: 1 as const,
				releaseRecord: {
					id: record._id,
					projectId: record.projectId,
					baselineSnapshotId: snapshot._id,
					repository: snapshot.repository,
					baselineCommit: snapshot.commit,
					manifestHash: snapshot.manifestHash,
					integrationBranch:
						project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
				},
				catalogs: files
					.map((file) => ({
						localeCode: file.localeCode,
						catalogPath: file.catalogPath,
						isSource: file.isSource ?? file.localeId === project.sourceLocaleId,
					}))
					.sort((left, right) =>
						left.catalogPath.localeCompare(right.catalogPath),
					),
			},
		};
	},
});

export const bundleChangePage = internalQuery({
	args: {
		runId: v.id("releaseBuildRuns"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		const record = run ? await ctx.db.get(run.recordId) : null;
		if (!run || !record || run.status !== "building") {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Release Build Run is no longer buildable.",
			});
		}
		await assertCurrentReadyRecord(ctx, record);
		const page = await ctx.db
			.query("catalogWorkspaceNavigationRows")
			.withIndex("by_project_and_projection_and_catalogIndex", (q) =>
				q
					.eq("projectId", record.projectId)
					.eq("projectionId", record.projectionId),
			)
			.paginate({
				...args.paginationOpts,
				numItems: 1,
				maximumBytesRead: 1024 * 1024,
			});
		const changes = [];
		for (const key of page.page) {
			if (!isReleaseDelta(key)) continue;
			const rows = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId", (q) =>
					q
						.eq("projectionId", record.projectionId)
						.eq("messageId", key.messageId),
				)
				.take(MAX_PROJECTED_LOCALES + 1);
			if (rows.length === 0 || rows.length > MAX_PROJECTED_LOCALES) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release delta key has an invalid Locale envelope.",
				});
			}
			const source = rows.find((row) => row.isSource);
			if (!source) {
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release delta key has no Source Contract.",
				});
			}
			const sourceHead = await sourceProposalHeadFor(
				ctx,
				record.projectId,
				key.messageId,
			);
			const sourceResolution = sourceHead
				? await publishedResolutionFor(ctx, {
						_id: sourceHead.proposalId,
						projectId: record.projectId,
						messageId: key.messageId,
					})
				: null;
			const values: ReleaseBundleArtifact["changes"][number]["values"] = [];
			if (
				isCurrentSourceProposalHeadForSource(source, sourceHead) &&
				!sourceResolution &&
				sourceHead.sourceValue !== source.value
			) {
				values.push({
					localeCode: source.localeCode,
					catalogPath: source.catalogPath,
					isSource: true,
					baselineValue: source.value,
					value: sourceHead.sourceValue,
				});
			}
			for (const row of rows) {
				if (row.isSource) continue;
				const head = await ctx.db
					.query("catalogWorkspaceValueHeads")
					.withIndex("by_project_and_messageId_and_localeId", (q) =>
						q
							.eq("projectId", record.projectId)
							.eq("messageId", row.messageId)
							.eq("localeId", row.localeId),
					)
					.unique();
				const currentHead = currentHeadForRow(
					row,
					new Map(head ? [[valueIdentity(row), head]] : []),
				);
				if (currentHead && currentHead.value !== row.value) {
					values.push({
						localeCode: row.localeCode,
						catalogPath: row.catalogPath,
						isSource: false,
						baselineValue: row.value,
						value: currentHead.value,
					});
				}
			}
			if (values.length > 0) {
				values.sort((left, right) =>
					left.catalogPath.localeCompare(right.catalogPath),
				);
				changes.push({
					catalogIndex: key.catalogIndex,
					messageId: key.messageId,
					baselineSourceValue: source.value,
					values,
				});
			}
		}
		return { ...page, page: changes };
	},
});

export const completeBuild = internalMutation({
	args: {
		runId: v.id("releaseBuildRuns"),
		bundleStorageId: v.id("_storage"),
		bundleHash: v.string(),
		bundleByteLength: v.number(),
		changeKeyCount: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (run?.status !== "building") return false;
		const record = await ctx.db.get(run.recordId);
		if (!record) {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Release Build Run lost its Release Record.",
			});
		}
		await assertCurrentReadyRecord(ctx, record);
		await ctx.db.patch(run._id, {
			status: "ready",
			bundleStorageId: args.bundleStorageId,
			bundleHash: args.bundleHash,
			bundleByteLength: args.bundleByteLength,
			changeKeyCount: args.changeKeyCount,
			completedAt: now(),
		});
		return true;
	},
});

export const failBuild = internalMutation({
	args: {
		runId: v.id("releaseBuildRuns"),
		failure: v.object({
			code: v.optional(v.string()),
			message: v.string(),
			failedAt: v.number(),
		}),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (run?.status !== "building") return null;
		await ctx.db.patch(run._id, {
			status: "failed",
			failure: args.failure,
			completedAt: now(),
		});
		await ctx.scheduler.runAfter(0, internal.releaseBundles.cleanupChunks, {
			runId: args.runId,
		});
		return null;
	},
});

export const buildArtifact = internalAction({
	args: { runId: v.id("releaseBuildRuns") },
	returns: v.null(),
	handler: async (ctx, args) => {
		let storedBundleId: Id<"_storage"> | null = null;
		try {
			const context: {
				artifact: Omit<ReleaseBundleArtifact, "changes">;
			} = await ctx.runQuery(internal.releaseBundles.bundleContext, {
				runId: args.runId,
			});
			const chunks: ReleaseBundleManifest["chunks"] = [];
			let manifestBytes =
				new TextEncoder().encode(JSON.stringify(context.artifact)).byteLength +
				256;
			const pending = new Map<string, ReleaseBundleArtifact["changes"]>();
			let pendingBytes = 0;
			let changeKeyCount = 0;
			async function flush() {
				for (const [catalogPath, changes] of pending) {
					const content = JSON.stringify(changes);
					const storageId = await ctx.storage.store(
						new Blob([content], { type: "application/json" }),
					);
					try {
						await ctx.runMutation(internal.releaseBundles.registerChunk, {
							runId: args.runId,
							storageId,
						});
					} catch (error) {
						await ctx.storage.delete(storageId);
						throw error;
					}
					const reference = {
						catalogPath,
						storageId,
						contentHash: await sha256Hex(content),
						byteLength: new Blob([content]).size,
						changeKeyCount: changes.length,
					};
					manifestBytes +=
						new TextEncoder().encode(JSON.stringify(reference)).byteLength + 1;
					if (manifestBytes > MAX_RELEASE_MANIFEST_BYTES)
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message:
								"Release manifest metadata exceeds its 1 MiB limit. Prepare a smaller release.",
						});
					chunks.push(reference);
				}
				pending.clear();
				pendingBytes = 0;
			}
			const sourceCatalog = context.artifact.catalogs.find(
				(catalog) => catalog.isSource,
			);
			if (!sourceCatalog)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release Bundle needs a Source catalog.",
				});
			let cursor: string | null = null;
			let done = false;
			while (!done) {
				const page: {
					page: ReleaseBundleArtifact["changes"];
					continueCursor: string;
					isDone: boolean;
				} = await ctx.runQuery(internal.releaseBundles.bundleChangePage, {
					runId: args.runId,
					paginationOpts: { cursor, numItems: MAX_RELEASE_BUNDLE_PAGE },
				});
				for (const change of page.page) {
					const paths = new Set([
						sourceCatalog.catalogPath,
						...change.values.map((value) => value.catalogPath),
					]);
					for (const catalogPath of paths) {
						const entry = {
							...change,
							values: change.values.filter(
								(value) => value.catalogPath === catalogPath,
							),
						};
						const bytes =
							new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
						if (
							pendingBytes &&
							pendingBytes + bytes > RELEASE_CHUNK_TARGET_BYTES
						)
							await flush();
						const entries = pending.get(catalogPath) ?? [];
						entries.push(entry);
						pending.set(catalogPath, entries);
						pendingBytes += bytes;
					}
					changeKeyCount++;
				}
				cursor = page.continueCursor;
				done = page.isDone;
			}
			await flush();
			const artifact: ReleaseBundleManifest = {
				...context.artifact,
				version: 2,
				chunks,
				changeKeyCount,
			};
			const content = JSON.stringify(artifact);
			const byteLength = new TextEncoder().encode(content).byteLength;
			storedBundleId = await ctx.storage.store(
				new Blob([content], { type: "application/json" }),
			);
			const completed: boolean = await ctx.runMutation(
				internal.releaseBundles.completeBuild,
				{
					runId: args.runId,
					bundleStorageId: storedBundleId,
					bundleHash: await sha256Hex(content),
					bundleByteLength:
						byteLength +
						chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
					changeKeyCount,
				},
			);
			if (!completed) {
				throw new ConvexError({
					code: "BAD_STATE",
					message: "Release Build Run stopped before publication.",
				});
			}
			storedBundleId = null;
		} catch (error) {
			if (storedBundleId) await ctx.storage.delete(storedBundleId);
			const data =
				error instanceof ConvexError &&
				typeof error.data === "object" &&
				error.data !== null
					? error.data
					: null;
			await ctx.runMutation(internal.releaseBundles.failBuild, {
				runId: args.runId,
				failure: {
					...(data && "code" in data && typeof data.code === "string"
						? { code: data.code }
						: {}),
					message:
						error instanceof Error
							? error.message
							: "Release Bundle construction failed.",
					failedAt: now(),
				},
			});
		}
		return null;
	},
});

export const deliveryContext = internalQuery({
	args: {
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.recordId);
		if (!record || record.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Release Record not found.",
			});
		}
		const runs = await ctx.db
			.query("releaseBuildRuns")
			.withIndex("by_record", (q) => q.eq("recordId", record._id))
			.order("desc")
			.take(1);
		const run = runs[0];
		if (run?.status !== "ready" || !run.bundleStorageId) {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "This Release Record has no ready Release Bundle.",
			});
		}
		return {
			runId: run._id,
			bundleStorageId: run.bundleStorageId,
			bundleHash: run.bundleHash,
			bundleByteLength: run.bundleByteLength,
		};
	},
});

export const recordDeliveryCapture = internalMutation({
	args: {
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
		runId: v.id("releaseBuildRuns"),
		actor: repositoryAdapterActorValidator,
		files: v.optional(
			v.array(
				v.object({
					catalogPath: v.string(),
					storageId: v.id("_storage"),
					contentHash: v.string(),
					byteLength: v.number(),
				}),
			),
		),
		captureStorageId: v.id("_storage"),
		captureHash: v.string(),
		captureByteLength: v.number(),
		appliedCount: v.number(),
		skippedCount: v.number(),
	},
	returns: v.id("releaseDeliveryCaptures"),
	handler: async (ctx, args) => {
		const [record, run, existing] = await Promise.all([
			ctx.db.get(args.recordId),
			ctx.db.get(args.runId),
			ctx.db
				.query("releaseDeliveryCaptures")
				.withIndex("by_record_and_captureHash", (q) =>
					q.eq("recordId", args.recordId).eq("captureHash", args.captureHash),
				)
				.unique(),
		]);
		if (
			!record ||
			record.projectId !== args.projectId ||
			!run ||
			run.recordId !== record._id ||
			run.status !== "ready"
		) {
			throw new ConvexError({
				code: "BAD_STATE",
				message: "Release delivery lost its ready Release Bundle.",
			});
		}
		if (existing) {
			await ctx.storage.delete(args.captureStorageId);
			return existing._id;
		}
		const captureId = await ctx.db.insert("releaseDeliveryCaptures", {
			projectId: args.projectId,
			recordId: record._id,
			runId: run._id,
			deliveredBy: args.actor,
			captureStorageId: args.captureStorageId,
			captureHash: args.captureHash,
			captureByteLength: args.captureByteLength,
			appliedCount: args.appliedCount,
			skippedCount: args.skippedCount,
			createdAt: now(),
		});
		for (const file of args.files ?? [])
			await ctx.db.insert("releaseDeliveryCaptureFiles", {
				captureId,
				...file,
			});
		return captureId;
	},
});

/** Chunk references are registered before publication so interrupted builds can
 * clean up in bounded transactions without touching a Ready artifact. */
export const registerChunk = internalMutation({
	args: { runId: v.id("releaseBuildRuns"), storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (run?.status !== "building")
			throw new ConvexError({
				code: "CONFLICT",
				message: "Release build stopped.",
			});
		await ctx.db.insert("releaseBuildChunks", args);
	},
});
export const cleanupChunks = internalMutation({
	args: { runId: v.id("releaseBuildRuns") },
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (run?.status === "ready") return;
		if (run?.status === "building") {
			if (run.createdAt + 24 * 60 * 60 * 1000 > Date.now()) return;
			await ctx.db.patch(run._id, {
				status: "failed",
				completedAt: Date.now(),
				failure: {
					code: "EXPIRED",
					message: "Release build expired before publication.",
					failedAt: Date.now(),
				},
			});
		}
		const chunks = await ctx.db
			.query("releaseBuildChunks")
			.withIndex("by_runId", (q) => q.eq("runId", args.runId))
			.take(32);
		for (const chunk of chunks) {
			await ctx.storage.delete(chunk.storageId);
			await ctx.db.delete(chunk._id);
		}
		if (chunks.length === 32)
			await ctx.scheduler.runAfter(
				0,
				internal.releaseBundles.cleanupChunks,
				args,
			);
	},
});
