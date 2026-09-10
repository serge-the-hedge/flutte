import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { sha256Hex } from "./lib";
import { authorizeProjectIngestion } from "./permissions";
import { ingestUploadedSnapshot } from "./snapshots";

export const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_FILES = 1_000;
const UPLOAD_LIFETIME = 24 * 60 * 60 * 1_000;
// Convex runtime actions can run for 30 minutes; never reclaim a live action.
const PROCESSING_LEASE = 35 * 60 * 1_000;
const identity = {
	sessionId: v.id("snapshotUploadSessions"),
	projectId: v.id("projects"),
	tokenId: v.id("apiTokens"),
};

export async function sessionFor(
	ctx: QueryCtx | MutationCtx,
	args: {
		sessionId: Id<"snapshotUploadSessions">;
		projectId: Id<"projects">;
		tokenId: Id<"apiTokens">;
	},
) {
	const session = await ctx.db.get(args.sessionId);
	if (
		!session ||
		session.projectId !== args.projectId ||
		session.tokenId !== args.tokenId
	)
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Snapshot upload session not found.",
		});
	if (session.releaseRecordId) {
		const token = await ctx.db.get(args.tokenId);
		if (
			!token ||
			token.projectId !== args.projectId ||
			token.revokedAt !== undefined ||
			!token.scopes.includes("export")
		)
			throw new ConvexError({
				code: "UNAUTHORIZED",
				message: "A valid export token is required.",
			});
	} else
		await authorizeProjectIngestion(ctx, args.projectId, {
			kind: "repositoryAdapter",
			id: args.tokenId,
		});
	if (session.expiresAt <= Date.now())
		throw new ConvexError({
			code: "CONFLICT",
			message: "Snapshot upload expired. Start a new sync.",
		});
	return session;
}

export const begin = internalMutation({
	args: {
		projectId: v.id("projects"),
		tokenId: v.id("apiTokens"),
		releaseRecordId: v.optional(v.id("releaseRecords")),
		repository: v.string(),
		commit: v.string(),
		expectedFiles: v.number(),
		lineage: v.optional(
			v.object({
				baselineCommit: v.string(),
				relationship: v.union(
					v.literal("ancestor"),
					v.literal("descendant"),
					v.literal("divergent"),
				),
				mergeBase: v.string(),
			}),
		),
	},
	handler: async (ctx, args) => {
		if (args.releaseRecordId) {
			const token = await ctx.db.get(args.tokenId);
			const record = await ctx.db.get(args.releaseRecordId);
			if (
				!token ||
				token.projectId !== args.projectId ||
				token.revokedAt !== undefined ||
				!token.scopes.includes("export") ||
				!record ||
				record.projectId !== args.projectId
			)
				throw new ConvexError({
					code: "UNAUTHORIZED",
					message:
						"A valid export token and project Release Record are required.",
				});
		} else
			await authorizeProjectIngestion(ctx, args.projectId, {
				kind: "repositoryAdapter",
				id: args.tokenId,
			});
		if (
			!Number.isInteger(args.expectedFiles) ||
			args.expectedFiles < 1 ||
			args.expectedFiles > MAX_UPLOAD_FILES
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: `A snapshot needs 1–${MAX_UPLOAD_FILES} files.`,
			});
		if (
			!args.repository ||
			args.repository.length > 2048 ||
			!args.commit ||
			args.commit.length > 256
		)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Invalid repository or commit identity.",
			});
		const sessionId = await ctx.db.insert("snapshotUploadSessions", {
			...args,
			uploadedFiles: 0,
			status: "uploading",
			createdAt: Date.now(),
			expiresAt: Date.now() + UPLOAD_LIFETIME,
		});
		await ctx.scheduler.runAfter(
			UPLOAD_LIFETIME,
			internal.snapshotUploads.cleanup,
			{ sessionId },
		);
		return { sessionId, maxFileBytes: MAX_UPLOAD_FILE_BYTES };
	},
});

export const inspect = internalQuery({ args: identity, handler: sessionFor });

export const attach = internalMutation({
	args: {
		...identity,
		catalogPath: v.string(),
		contentHash: v.string(),
		storageId: v.id("_storage"),
		byteLength: v.number(),
	},
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		if (session.status !== "uploading")
			throw new ConvexError({
				code: "CONFLICT",
				message: "This upload is already being finalized.",
			});
		const existing = await ctx.db
			.query("snapshotUploadFiles")
			.withIndex("by_session_and_catalogPath", (q) =>
				q.eq("sessionId", args.sessionId).eq("catalogPath", args.catalogPath),
			)
			.unique();
		if (existing) {
			if (existing.contentHash !== args.contentHash)
				throw new ConvexError({
					code: "CONFLICT",
					message:
						"A catalog was already uploaded with different content. Start a new sync.",
				});
			return false;
		}
		if (session.uploadedFiles >= session.expectedFiles)
			throw new ConvexError({
				code: "VALIDATION",
				message: "The upload contains more files than its manifest declares.",
			});
		await ctx.db.insert("snapshotUploadFiles", {
			sessionId: args.sessionId,
			catalogPath: args.catalogPath,
			contentHash: args.contentHash,
			storageId: args.storageId,
			byteLength: args.byteLength,
		});
		await ctx.db.patch(session._id, {
			uploadedFiles: session.uploadedFiles + 1,
		});
		return true;
	},
});

/** The HTTP action owns storage creation; clients never supply arbitrary storage IDs. */
export async function uploadFile(
	ctx: ActionCtx,
	args: {
		sessionId: Id<"snapshotUploadSessions">;
		projectId: Id<"projects">;
		tokenId: Id<"apiTokens">;
		catalogPath: string;
		content: string;
		contentHash: string;
	},
) {
	await ctx.runQuery(internal.snapshotUploads.inspect, argsIdentity(args));
	if (
		args.catalogPath.length > 512 ||
		!args.catalogPath.endsWith(".arb") ||
		args.catalogPath.startsWith("/") ||
		args.catalogPath.includes("\\") ||
		args.catalogPath
			.split("/")
			.some((part) => part === ".." || part === "." || !part)
	)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Expected a relative ARB catalog path.",
		});
	const blob = new Blob([args.content]);
	if (blob.size > MAX_UPLOAD_FILE_BYTES)
		throw new ConvexError({
			code: "VALIDATION",
			message: `Each catalog must be at most ${MAX_UPLOAD_FILE_BYTES} bytes.`,
		});
	if ((await sha256Hex(args.content)) !== args.contentHash)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Catalog content does not match its declared SHA-256 hash.",
		});
	const storageId = await ctx.storage.store(blob);
	try {
		const attached = await ctx.runMutation(internal.snapshotUploads.attach, {
			...argsIdentity(args),
			catalogPath: args.catalogPath,
			contentHash: args.contentHash,
			storageId,
			byteLength: blob.size,
		});
		if (!attached) await ctx.storage.delete(storageId);
	} catch (error) {
		await ctx.storage.delete(storageId);
		throw error;
	}
	return { catalogPath: args.catalogPath, contentHash: args.contentHash };
}

function argsIdentity(args: {
	sessionId: Id<"snapshotUploadSessions">;
	projectId: Id<"projects">;
	tokenId: Id<"apiTokens">;
}) {
	return {
		sessionId: args.sessionId,
		projectId: args.projectId,
		tokenId: args.tokenId,
	};
}

export const claim = internalMutation({
	args: identity,
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		if (session.status === "completed") return { session, files: [] };
		if (
			session.status === "processing" &&
			(session.processingAt ?? 0) + PROCESSING_LEASE > Date.now()
		)
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"This snapshot is already being finalized. Retry after it finishes.",
			});
		if (session.uploadedFiles !== session.expectedFiles)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Upload every manifest file before finalizing the snapshot.",
			});
		const files = await ctx.db
			.query("snapshotUploadFiles")
			.withIndex("by_session_and_catalogPath", (q) =>
				q.eq("sessionId", args.sessionId),
			)
			.take(MAX_UPLOAD_FILES + 1);
		if (files.length !== session.expectedFiles)
			throw new ConvexError({
				code: "INTEGRITY",
				message: "Upload manifest is incomplete.",
			});
		if (session.expiresAt < Date.now() + PROCESSING_LEASE) {
			await ctx.db.patch(session._id, {
				expiresAt: Date.now() + PROCESSING_LEASE,
			});
			await ctx.scheduler.runAfter(
				PROCESSING_LEASE,
				internal.snapshotUploads.cleanup,
				{ sessionId: session._id },
			);
		}
		await ctx.db.patch(session._id, {
			status: "processing",
			processingAt: Date.now(),
		});
		return { session, files };
	},
});

export const finish = internalMutation({
	args: { ...identity, runId: v.optional(v.id("snapshotIngestionRuns")) },
	handler: async (ctx, args) => {
		const session = await sessionFor(ctx, args);
		await ctx.db.patch(
			session._id,
			args.runId
				? { status: "completed", runId: args.runId }
				: { status: "uploading", processingAt: undefined },
		);
		if (args.runId)
			await ctx.scheduler.runAfter(0, internal.snapshotUploads.cleanup, {
				sessionId: session._id,
			});
	},
});

export async function finalizeUpload(
	ctx: ActionCtx,
	args: {
		sessionId: Id<"snapshotUploadSessions">;
		projectId: Id<"projects">;
		tokenId: Id<"apiTokens">;
	},
) {
	const inspected = await ctx.runQuery(internal.snapshotUploads.inspect, args);
	if (inspected.releaseRecordId)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Use Release delivery finalization for this upload.",
		});
	const { session, files } = await ctx.runMutation(
		internal.snapshotUploads.claim,
		args,
	);

	const actor = { kind: "repositoryAdapter" as const, id: args.tokenId };
	if (session.runId)
		return await ctx.runQuery(internal.snapshots.repositoryAdapterReceipt, {
			runId: session.runId,
			reused: true,
			actor,
		});
	try {
		const result = await ingestUploadedSnapshot(ctx, {
			projectId: args.projectId,
			repository: session.repository,
			commit: session.commit,
			lineage: session.lineage,
			actor,
			files,
		});
		await ctx.runMutation(internal.snapshotUploads.finish, {
			...args,
			runId: result.runId,
		});
		return await ctx.runQuery(internal.snapshots.repositoryAdapterReceipt, {
			runId: result.runId,
			reused: result.reused,
			actor,
		});
	} catch (error) {
		await ctx.runMutation(internal.snapshotUploads.finish, args);
		throw error;
	}
}

/** Bounded cleanup retains blobs already owned by an immutable Snapshot, including
 * when an action stopped after publication but before recording its receipt. */
export const cleanup = internalMutation({
	args: { sessionId: v.id("snapshotUploadSessions") },
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.sessionId);
		if (
			!session ||
			((session.status !== "completed" ||
				session.releaseRecordId !== undefined) &&
				session.expiresAt > Date.now())
		)
			return;
		const files = await ctx.db
			.query("snapshotUploadFiles")
			.withIndex("by_session_and_catalogPath", (q) =>
				q.eq("sessionId", args.sessionId),
			)
			.take(32);
		for (const file of files) {
			const bound = await ctx.db
				.query("sourceSnapshotFiles")
				.withIndex("by_storageId", (q) => q.eq("storageId", file.storageId))
				.first();
			const unbound = bound
				? null
				: await ctx.db
						.query("sourceSnapshotUnboundFiles")
						.withIndex("by_storageId", (q) => q.eq("storageId", file.storageId))
						.first();
			const captured =
				bound || unbound
					? null
					: await ctx.db
							.query("releaseDeliveryCaptureFiles")
							.withIndex("by_storageId", (q) =>
								q.eq("storageId", file.storageId),
							)
							.first();
			if (
				file.outputStorageId &&
				(await ctx.db.system.get(file.outputStorageId))
			)
				await ctx.storage.delete(file.outputStorageId);
			if (
				!bound &&
				!unbound &&
				!captured &&
				(await ctx.db.system.get(file.storageId))
			)
				await ctx.storage.delete(file.storageId);
			await ctx.db.delete(file._id);
		}
		if (files.length === 32)
			await ctx.scheduler.runAfter(0, internal.snapshotUploads.cleanup, args);
		else if (session.expiresAt <= Date.now()) await ctx.db.delete(session._id);
	},
});
