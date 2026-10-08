import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { parse } from "./catalogDocument";
import { sha256Hex } from "./lib";
import { type SourceFact, sourceFactValidator } from "./localeSourceFactModel";
import { declaredPlaceholderNames, messageFacts } from "./messageFacts";
import schema from "./schema";

export const MAX_SOURCE_FACT_ITEMS = 16;
export const MAX_SOURCE_FACT_BATCH_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_MESSAGES = 8192;

export const sourceFactsEligible = (
	project: Doc<"projects">,
	proposal: Doc<"localeProposals">,
) =>
	proposal.sourceSelection === "selectedSnapshot" ||
	project.baselineSnapshotId === proposal.sourceSnapshotId;
const size = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
function fail(message: string): never {
	throw new ConvexError({ code: "INTEGRITY", message });
}

/** A selected pin is evidence from a completed capture, never client supplied text. */
export async function selectedSourceEvidence(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	const project = await ctx.db.get(projectId);
	const snapshot = await ctx.db.get(snapshotId);
	if (
		!project ||
		project.archivedAt !== undefined ||
		!snapshot ||
		snapshot.projectId !== projectId ||
		snapshot.repository !== project.repository
	)
		throw new ConvexError({
			code: "NOT_FOUND",
			message:
				"Choose a captured Source Snapshot from this project and repository.",
		});
	const run = await ctx.db
		.query("snapshotIngestionRuns")
		.withIndex("by_project_and_repository_and_commit_and_manifestHash", (q) =>
			q
				.eq("projectId", projectId)
				.eq("repository", snapshot.repository)
				.eq("commit", snapshot.commit)
				.eq("manifestHash", snapshot.manifestHash),
		)
		.first();
	if (
		run?.status !== "succeeded" ||
		run.snapshotId !== snapshotId ||
		run.projectId !== projectId ||
		run.repository !== snapshot.repository ||
		run.commit !== snapshot.commit ||
		run.manifestHash !== snapshot.manifestHash
	)
		fail("The selected Source Snapshot has no successful capture evidence.");
	const files = await ctx.db
		.query("sourceSnapshotFiles")
		.withIndex("by_snapshot_and_isSource", (q) =>
			q.eq("snapshotId", snapshotId).eq("isSource", true),
		)
		.take(2);
	if (files.length > 1)
		fail("The selected Snapshot has multiple Source Catalog Documents.");
	const sourceLocaleId = project.sourceLocaleId;
	const file =
		files[0] ??
		(sourceLocaleId
			? await ctx.db
					.query("sourceSnapshotFiles")
					.withIndex("by_snapshot_and_localeId", (q) =>
						q.eq("snapshotId", snapshotId).eq("localeId", sourceLocaleId),
					)
					.unique()
			: null);
	if (
		!file ||
		file.projectId !== projectId ||
		file.isSource === false ||
		file.byteLength > MAX_SOURCE_BYTES
	)
		fail("The selected Snapshot has no supported Source Catalog Document.");
	return { file, snapshot };
}
export const evidence = internalQuery({
	args: { projectId: v.id("projects"), snapshotId: v.id("sourceSnapshots") },
	returns: v.object({
		file: schema.doc("sourceSnapshotFiles"),
		snapshot: schema.doc("sourceSnapshots"),
	}),
	handler: selectedEvidence,
});
async function selectedEvidence(
	ctx: QueryCtx,
	args: { projectId: Id<"projects">; snapshotId: Id<"sourceSnapshots"> },
) {
	return await selectedSourceEvidence(ctx, args.projectId, args.snapshotId);
}

export async function readySourceFacts(
	ctx: QueryCtx | MutationCtx,
	fileId: Id<"sourceSnapshotFiles">,
) {
	const index = await ctx.db
		.query("localeSourceFactIndexes")
		.withIndex("by_sourceFile", (q) => q.eq("sourceFileId", fileId))
		.unique();
	const file = await ctx.db.get(fileId);
	if (
		!file ||
		!index ||
		file.storageId !== index.storageId ||
		file.projectId !== index.projectId ||
		index.status !== "ready" ||
		index.stagedCount !== index.messageCount ||
		index.stagedBytes !== index.expectedBytes
	)
		fail(
			"The selected Source facts are not completely prepared. Retry preparation.",
		);
	return index;
}
export async function sourceFactFor(
	ctx: QueryCtx | MutationCtx,
	fileId: Id<"sourceSnapshotFiles">,
	messageId: string,
) {
	await readySourceFacts(ctx, fileId);
	return await ctx.db
		.query("localeSourceFacts")
		.withIndex("by_sourceFile_and_messageId", (q) =>
			q.eq("sourceFileId", fileId).eq("messageId", messageId),
		)
		.unique();
}
export async function sourceFactPage(
	ctx: QueryCtx,
	fileId: Id<"sourceSnapshotFiles">,
	cursor: number,
	limit: number,
) {
	await readySourceFacts(ctx, fileId);
	const result: Doc<"localeSourceFacts">[] = [];
	let bytes = 0;
	let hasMore = false;
	for await (const row of ctx.db
		.query("localeSourceFacts")
		.withIndex("by_sourceFile_and_catalogIndex", (q) =>
			q.eq("sourceFileId", fileId).gte("catalogIndex", cursor),
		)) {
		if (result.length && bytes + size(row) > MAX_SOURCE_FACT_BATCH_BYTES) {
			hasMore = true;
			break;
		}
		result.push(row);
		bytes += size(row);
		if (result.length >= limit) break;
	}
	return { rows: result, hasMore };
}
export const begin = internalMutation({
	args: {
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		contentHash: v.string(),
		messageCount: v.number(),
		expectedBytes: v.number(),
	},
	returns: v.object({
		sourceFileId: v.id("sourceSnapshotFiles"),
		stagedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const { file } = await selectedSourceEvidence(
			ctx,
			args.projectId,
			args.snapshotId,
		);
		const existing = await ctx.db
			.query("localeSourceFactIndexes")
			.withIndex("by_sourceFile", (q) => q.eq("sourceFileId", file._id))
			.unique();
		if (existing) {
			if (
				existing.contentHash !== args.contentHash ||
				existing.messageCount !== args.messageCount ||
				existing.expectedBytes !== args.expectedBytes
			)
				fail("The immutable Source facts changed during preparation.");
			return { sourceFileId: file._id, stagedCount: existing.stagedCount };
		}
		if (
			!Number.isInteger(args.messageCount) ||
			args.messageCount < 0 ||
			args.messageCount > MAX_SOURCE_MESSAGES ||
			!Number.isInteger(args.expectedBytes) ||
			args.expectedBytes < 0 ||
			(args.messageCount === 0 && args.expectedBytes !== 0) ||
			args.expectedBytes > 12 * 1024 * 1024
		)
			fail("The Source facts exceed their envelope.");
		await ctx.db.insert("localeSourceFactIndexes", {
			projectId: args.projectId,
			sourceFileId: file._id,
			storageId: file.storageId,
			contentHash: args.contentHash,
			messageCount: args.messageCount,
			expectedBytes: args.expectedBytes,
			stagedCount: 0,
			stagedBytes: 0,
			status: args.messageCount === 0 ? "ready" : "building",
		});
		return { sourceFileId: file._id, stagedCount: 0 };
	},
});
export const append = internalMutation({
	args: {
		sourceFileId: v.id("sourceSnapshotFiles"),
		items: v.array(sourceFactValidator),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (
			!args.items.length ||
			args.items.length > MAX_SOURCE_FACT_ITEMS ||
			size(args.items) > MAX_SOURCE_FACT_BATCH_BYTES
		)
			fail("The Source facts slice exceeds its envelope.");
		const index = await ctx.db
			.query("localeSourceFactIndexes")
			.withIndex("by_sourceFile", (q) =>
				q.eq("sourceFileId", args.sourceFileId),
			)
			.unique();
		const file = await ctx.db.get(args.sourceFileId);
		if (
			!index ||
			!file ||
			file.storageId !== index.storageId ||
			file.projectId !== index.projectId
		)
			fail("Source facts lost their immutable file identity.");
		let count = index.stagedCount;
		let bytes = index.stagedBytes;
		for (const item of args.items) {
			const existing = await ctx.db
				.query("localeSourceFacts")
				.withIndex("by_sourceFile_and_messageId", (q) =>
					q
						.eq("sourceFileId", args.sourceFileId)
						.eq("messageId", item.messageId),
				)
				.unique();
			if (existing) {
				const { _id, _creationTime, projectId, sourceFileId, ...fact } =
					existing;
				if (
					Object.entries(item).some(
						([key, value]) =>
							JSON.stringify(fact[key as keyof SourceFact]) !==
							JSON.stringify(value),
					)
				)
					fail("A retry attempted to replace immutable Source facts.");
				continue;
			}
			if (index.status === "ready" || item.catalogIndex !== count)
				fail("Source facts must be prepared in consecutive bounded slices.");
			await ctx.db.insert("localeSourceFacts", {
				projectId: index.projectId,
				sourceFileId: args.sourceFileId,
				...item,
			});
			count++;
			bytes += size(item);
		}
		if (count > index.messageCount || bytes > index.expectedBytes)
			fail("Source facts exceed the captured envelope.");
		if (count === index.messageCount && bytes !== index.expectedBytes)
			fail("Source facts do not match their completed byte envelope.");
		await ctx.db.patch(index._id, {
			stagedCount: count,
			stagedBytes: bytes,
			status: count === index.messageCount ? "ready" : "building",
		});
		return null;
	},
});

/** One index serves every Locale pinned to this immutable file. Partial slices
 * survive retry, but readers cannot use them before the final count/byte check. */
export async function prepareSourceFacts(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	snapshotId: Id<"sourceSnapshots">,
) {
	const { file }: Awaited<ReturnType<typeof selectedSourceEvidence>> =
		await ctx.runQuery(internal.localeSourceFacts.evidence, {
			projectId,
			snapshotId,
		});
	const blob = await ctx.storage.get(file.storageId);
	if (!blob || blob.size !== file.byteLength || blob.size > MAX_SOURCE_BYTES)
		fail("The selected Source file bytes are missing or altered.");
	const text = await blob.text();
	const document = parse(text);
	if (
		document.messages.length > MAX_SOURCE_MESSAGES ||
		new Set(document.messages.map((message) => message.id)).size !==
			document.messages.length ||
		!document.globals.some(
			(g) => g.name === "@@locale" && typeof g.value === "string",
		)
	)
		fail("The selected Source document is invalid.");
	const rows: SourceFact[] = await Promise.all(
		document.messages.map(async (message, catalogIndex) => {
			const facts = messageFacts(message.value);
			const placeholders = declaredPlaceholderNames(message.metadata);
			const row = {
				messageId: message.id,
				catalogIndex,
				value: message.value,
				sourceFingerprint: await sha256Hex(message.value),
				icuType: facts.icuType,
				argumentNames: [...facts.argumentNames],
				argumentNamesComplete: true,
				declaredPlaceholderNames: [...placeholders],
				declaredPlaceholderNamesComplete: true,
				...(message.metadata === undefined
					? {}
					: { metadataJson: JSON.stringify(message.metadata) }),
			};
			if (
				!message.id.length ||
				size(row) > MAX_SOURCE_FACT_BATCH_BYTES - 1024 ||
				new TextEncoder().encode(message.value).byteLength > 256 * 1024 ||
				new TextEncoder().encode(message.id).byteLength > 512 ||
				facts.argumentNames.length > 128 ||
				placeholders.length > 128
			)
				fail("A selected Source message exceeds the supported facts envelope.");
			return row;
		}),
	);
	const state: {
		sourceFileId: Id<"sourceSnapshotFiles">;
		stagedCount: number;
	} = await ctx.runMutation(internal.localeSourceFacts.begin, {
		projectId,
		snapshotId,
		contentHash: await sha256Hex(text),
		messageCount: rows.length,
		expectedBytes: rows.reduce((n, row) => n + size(row), 0),
	});
	let batch: SourceFact[] = [];
	for (const row of rows.slice(state.stagedCount)) {
		if (
			batch.length &&
			(batch.length >= MAX_SOURCE_FACT_ITEMS ||
				size([...batch, row]) > MAX_SOURCE_FACT_BATCH_BYTES)
		) {
			await ctx.runMutation(internal.localeSourceFacts.append, {
				sourceFileId: state.sourceFileId,
				items: batch,
			});
			batch = [];
		}
		batch.push(row);
	}
	if (batch.length)
		await ctx.runMutation(internal.localeSourceFacts.append, {
			sourceFileId: state.sourceFileId,
			items: batch,
		});
	return state.sourceFileId;
}
