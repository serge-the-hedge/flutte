import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { parse } from "./catalogDocument";
import { sha256Hex } from "./lib";
import {
	applyReleaseBundleToDeliveryTree,
	type DeliveryTreeResult,
	type ReleaseBundleArtifact,
	type StoredReleaseBundle,
} from "./releaseBundleModel";
import { MAX_UPLOAD_FILE_BYTES, sessionFor } from "./snapshotUploads";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function storedReleaseBundle(
	ctx: ActionCtx,
	storageId: Id<"_storage">,
	expectedHash: string | undefined,
): Promise<StoredReleaseBundle> {
	const blob = await ctx.storage.get(storageId);
	if (!blob) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release Bundle artifact is missing.",
		});
	}
	const content = await blob.text();
	if (
		expectedHash !== undefined &&
		(await sha256Hex(content)) !== expectedHash
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release Bundle artifact failed its integrity check.",
		});
	}
	const value: unknown = JSON.parse(content);
	if (
		!isRecord(value) ||
		(value.version !== 1 && value.version !== 2) ||
		!isRecord(value.releaseRecord) ||
		!Array.isArray(value.catalogs) ||
		(value.version === 1
			? !Array.isArray(value.changes)
			: !Array.isArray(value.chunks) ||
				typeof value.changeKeyCount !== "number")
	) {
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release Bundle artifact has an invalid shape.",
		});
	}
	return value as StoredReleaseBundle;
}

/** A v2 manifest contains only file-scoped chunk references. No reader assembles
 * every language's release values before applying one catalog. */
export async function* releaseChangesForCatalog(
	ctx: ActionCtx,
	bundle: StoredReleaseBundle,
	catalogPath: string,
): AsyncGenerator<ReleaseBundleArtifact["changes"], void, unknown> {
	if (bundle.version === 1) {
		yield bundle.changes.map((change) => ({
			...change,
			values: change.values.filter(
				(value) => value.catalogPath === catalogPath,
			),
		}));
		return;
	}
	let previousIndex = -1;
	let keyCount = 0;
	for (const chunk of bundle.chunks) {
		if (chunk.catalogPath !== catalogPath) continue;
		const blob = await ctx.storage.get(chunk.storageId as Id<"_storage">);
		if (!blob || blob.size !== chunk.byteLength || blob.size > 2 * 1024 * 1024)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release chunk is missing or has an invalid size.",
			});
		const content = await blob.text();
		if ((await sha256Hex(content)) !== chunk.contentHash)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release chunk failed its integrity check.",
			});
		const values: unknown = JSON.parse(content);
		if (!Array.isArray(values) || values.length !== chunk.changeKeyCount)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release chunk has an invalid shape.",
			});
		const changes = values as ReleaseBundleArtifact["changes"];
		for (const change of changes) {
			if (
				!Number.isInteger(change.catalogIndex) ||
				change.catalogIndex <= previousIndex ||
				change.values.some((value) => value.catalogPath !== catalogPath)
			)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Release chunks overlap or target a different catalog.",
				});
			previousIndex = change.catalogIndex;
		}
		keyCount += changes.length;
		yield changes;
	}
	if (
		bundle.catalogs.some(
			(catalog) => catalog.catalogPath === catalogPath && catalog.isSource,
		) &&
		keyCount !== bundle.changeKeyCount
	)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Release Source chunks do not cover every change key.",
		});
}

export async function applyStoredReleaseFile(
	ctx: ActionCtx,
	bundle: StoredReleaseBundle,
	file: { catalogPath: string; content: string },
	sourceFile: { catalogPath: string; content: string },
): Promise<DeliveryTreeResult> {
	parse(file.content);
	if (file.catalogPath !== sourceFile.catalogPath) parse(sourceFile.content);
	const paths = new Set([sourceFile.catalogPath, file.catalogPath]);
	let content = file.content;
	const applied: string[] = [];
	const skipped: DeliveryTreeResult["skipped"] = [];
	for await (const changes of releaseChangesForCatalog(
		ctx,
		bundle,
		file.catalogPath,
	)) {
		const delivery = applyReleaseBundleToDeliveryTree(
			{
				version: 1,
				releaseRecord: bundle.releaseRecord,
				catalogs: bundle.catalogs.filter((catalog) =>
					paths.has(catalog.catalogPath),
				),
				changes,
			},
			file.catalogPath === sourceFile.catalogPath
				? [{ catalogPath: file.catalogPath, content }]
				: [sourceFile, { catalogPath: file.catalogPath, content }],
		);
		const output = delivery.files.find(
			(output) => output.catalogPath === file.catalogPath,
		);
		if (!output)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release lost its output catalog.",
			});
		content = output.content;
		if (new Blob([content]).size > MAX_UPLOAD_FILE_BYTES)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message: `Delivered catalog ${file.catalogPath} exceeds the per-file byte limit.`,
			});
		applied.push(...delivery.applied);
		skipped.push(...delivery.skipped);
	}
	return {
		files: [{ catalogPath: file.catalogPath, content }],
		applied,
		skipped,
	};
}

/** Compatibility transport remains request-bounded, and shares v2 application. */
export async function applyStoredReleaseTree(
	ctx: ActionCtx,
	bundle: StoredReleaseBundle,
	files: readonly { catalogPath: string; content: string }[],
): Promise<DeliveryTreeResult> {
	const source = bundle.catalogs.find((catalog) => catalog.isSource);
	const sourceFile = files.find(
		(file) => file.catalogPath === source?.catalogPath,
	);
	if (
		!sourceFile ||
		files.length !== bundle.catalogs.length ||
		new Set(files.map((file) => file.catalogPath)).size !== files.length ||
		bundle.catalogs.some(
			(catalog) =>
				!files.some((file) => file.catalogPath === catalog.catalogPath),
		)
	)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Delivery needs exactly the bound catalogs.",
		});
	const output: DeliveryTreeResult = { files: [], applied: [], skipped: [] };
	const encoder = new TextEncoder();
	let outputBytes = encoder.encode(JSON.stringify(output)).byteLength;
	for (const file of files) {
		const delivery = await applyStoredReleaseFile(
			ctx,
			bundle,
			file,
			sourceFile,
		);
		let nextBytes = outputBytes;
		for (const delivered of delivery.files) {
			nextBytes += encoder.encode(JSON.stringify(delivered)).byteLength;
			if (output.files.length) nextBytes++;
		}
		if (file.catalogPath === sourceFile.catalogPath) {
			nextBytes +=
				encoder.encode(JSON.stringify(delivery.applied)).byteLength - 2;
			nextBytes +=
				encoder.encode(JSON.stringify(delivery.skipped)).byteLength - 2;
		}
		if (nextBytes > MAX_UPLOAD_FILE_BYTES)
			throw new ConvexError({
				code: "LIMIT_EXCEEDED",
				message:
					"Combined delivery output exceeds 8 MiB. Upgrade to the current Blabla CLI, which uploads and downloads catalogs separately.",
			});
		outputBytes = nextBytes;
		output.files.push(...delivery.files);
		if (file.catalogPath === sourceFile.catalogPath) {
			output.applied = delivery.applied;
			output.skipped = delivery.skipped;
		}
	}
	return output;
}

const identity = {
	sessionId: v.id("snapshotUploadSessions"),
	projectId: v.id("projects"),
	tokenId: v.id("apiTokens"),
};
type UploadIdentity = {
	sessionId: Id<"snapshotUploadSessions">;
	projectId: Id<"projects">;
	tokenId: Id<"apiTokens">;
};
export const recordOutput = internalMutation({
	args: {
		...identity,
		fileId: v.id("snapshotUploadFiles"),
		storageId: v.id("_storage"),
	},
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		const file = await ctx.db.get(args.fileId);
		if (
			!session.releaseRecordId ||
			session.status !== "processing" ||
			!file ||
			file.sessionId !== session._id
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Release upload lost its processing lease.",
			});
		if (file.outputStorageId) await ctx.storage.delete(file.outputStorageId);
		await ctx.db.patch(file._id, { outputStorageId: args.storageId });
	},
});
export const finish = internalMutation({
	args: { ...identity, captureId: v.id("releaseDeliveryCaptures") },
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		const capture = await ctx.db.get(args.captureId);
		if (
			!capture ||
			capture.projectId !== session.projectId ||
			capture.recordId !== session.releaseRecordId
		)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Release capture does not belong to this upload.",
			});
		await ctx.db.patch(session._id, {
			status: "completed",
			deliveryCaptureId: args.captureId,
		});
	},
});
export const output = internalQuery({
	args: { ...identity, catalogPath: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		if (
			!session.releaseRecordId ||
			!session.deliveryCaptureId ||
			session.status !== "completed"
		)
			throw new ConvexError({
				code: "CONFLICT",
				message: "Release delivery is not complete.",
			});
		if (args.catalogPath === undefined)
			return (
				(await ctx.db.get(session.deliveryCaptureId))?.captureStorageId ?? null
			);
		const file = await ctx.db
			.query("snapshotUploadFiles")
			.withIndex("by_session_and_catalogPath", (q) =>
				q
					.eq("sessionId", session._id)
					.eq("catalogPath", args.catalogPath as string),
			)
			.unique();
		return file?.outputStorageId ?? null;
	},
});

export async function downloadReleaseFile(
	ctx: ActionCtx,
	args: UploadIdentity & { catalogPath: string },
) {
	const storageId = await ctx.runQuery(
		internal.releaseUploadDelivery.output,
		args,
	);
	const blob = storageId ? await ctx.storage.get(storageId) : null;
	if (!blob)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Delivered catalog is missing or expired.",
		});
	return { catalogPath: args.catalogPath, content: await blob.text() };
}

async function releaseReceipt(ctx: ActionCtx, args: UploadIdentity) {
	const storageId = await ctx.runQuery(
		internal.releaseUploadDelivery.output,
		args,
	);
	const blob = storageId ? await ctx.storage.get(storageId) : null;
	if (!blob)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Delivery capture is missing.",
		});
	const value: unknown = JSON.parse(await blob.text());
	if (!isRecord(value))
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Delivery capture is invalid.",
		});
	return {
		releaseRecord: value.releaseRecord,
		applied: value.applied,
		skipped: value.skipped,
		catalogPaths: value.catalogPaths,
	};
}

/** Every catalog is checked against the same original Source bytes. Filtering
 * only the output values preserves whole-key conflict behavior across languages. */
export async function finalizeReleaseUpload(
	ctx: ActionCtx,
	args: UploadIdentity,
) {
	const state = await ctx.runQuery(internal.snapshotUploads.inspect, args);
	if (!state.releaseRecordId)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Expected a Release upload.",
		});
	if (state.deliveryCaptureId) return await releaseReceipt(ctx, args);
	const { files } = await ctx.runMutation(internal.snapshotUploads.claim, args);
	try {
		const context = await ctx.runQuery(
			internal.releaseBundles.deliveryContext,
			{ projectId: args.projectId, recordId: state.releaseRecordId },
		);
		const bundle = await storedReleaseBundle(
			ctx,
			context.bundleStorageId,
			context.bundleHash,
		);
		const source = bundle.catalogs.find((catalog) => catalog.isSource);
		if (
			!source ||
			files.length !== bundle.catalogs.length ||
			bundle.catalogs.some(
				(catalog) =>
					!files.some((file) => file.catalogPath === catalog.catalogPath),
			)
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Upload exactly the Release Bundle's bound catalogs.",
			});
		async function load(storageId: Id<"_storage">) {
			const blob = await ctx.storage.get(storageId);
			if (!blob)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Uploaded catalog is missing.",
				});
			return await blob.text();
		}
		const sourceFile = files.find(
			(file) => file.catalogPath === source.catalogPath,
		);
		if (!sourceFile)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Source catalog is missing.",
			});
		const sourceContent = await load(sourceFile.storageId);
		let report: Pick<DeliveryTreeResult, "applied" | "skipped"> = {
			applied: [],
			skipped: [],
		};
		for (const file of files) {
			const delivery = await applyStoredReleaseFile(
				ctx,
				bundle,
				{
					catalogPath: file.catalogPath,
					content:
						file.catalogPath === source.catalogPath
							? sourceContent
							: await load(file.storageId),
				},
				{ catalogPath: source.catalogPath, content: sourceContent },
			);
			if (file.catalogPath === source.catalogPath)
				report = { applied: delivery.applied, skipped: delivery.skipped };
			const delivered = delivery.files.find(
				(output) => output.catalogPath === file.catalogPath,
			);
			if (!delivered)
				throw new ConvexError({
					code: "INTEGRITY",
					message: "Delivery lost a catalog.",
				});
			const storageId = await ctx.storage.store(new Blob([delivered.content]));
			try {
				await ctx.runMutation(internal.releaseUploadDelivery.recordOutput, {
					...args,
					fileId: file._id,
					storageId,
				});
			} catch (error) {
				await ctx.storage.delete(storageId);
				throw error;
			}
		}
		const manifestFiles = files.map(
			({ catalogPath, storageId, contentHash, byteLength }) => ({
				catalogPath,
				storageId,
				contentHash,
				byteLength,
			}),
		);
		const capture = JSON.stringify({
			version: 2,
			releaseRecord: bundle.releaseRecord,
			bundleHash: context.bundleHash,
			files: manifestFiles,
			catalogPaths: bundle.catalogs.map((catalog) => catalog.catalogPath),
			...report,
		});
		const captureStorageId = await ctx.storage.store(
			new Blob([capture], { type: "application/json" }),
		);
		let captureId: Id<"releaseDeliveryCaptures">;
		try {
			captureId = await ctx.runMutation(
				internal.releaseBundles.recordDeliveryCapture,
				{
					projectId: args.projectId,
					recordId: state.releaseRecordId,
					runId: context.runId,
					actor: { kind: "repositoryAdapter", id: args.tokenId },
					captureStorageId,
					captureHash: await sha256Hex(capture),
					captureByteLength: new Blob([capture]).size,
					appliedCount: report.applied.length,
					skippedCount: report.skipped.length,
					files: manifestFiles,
				},
			);
		} catch (error) {
			await ctx.storage.delete(captureStorageId);
			throw error;
		}
		await ctx.runMutation(internal.releaseUploadDelivery.finish, {
			...args,
			captureId,
		});
		return {
			releaseRecord: bundle.releaseRecord,
			catalogPaths: bundle.catalogs.map((catalog) => catalog.catalogPath),
			...report,
		};
	} catch (error) {
		await ctx.runMutation(internal.snapshotUploads.finish, args);
		throw error;
	}
}
