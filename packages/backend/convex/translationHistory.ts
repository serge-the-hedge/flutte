import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { getAnyUserById } from "./auth";
import { activeProjectionFor } from "./catalogProjection";
import { decisionForIdentity } from "./catalogWorkspaceDecisionQueries";
import { encodedSize } from "./catalogWorkspaceView";
import { type Actor, sha256Hex } from "./lib";
import { requireViewer } from "./permissions";
import { translationHistoryEvent } from "./translationHistoryModel";

// Values can occupy 256 KiB. Keep both streams below the transaction byte limit,
// including quiet Git transitions that yield no visible event.
const PAGE_SIZE = 8;
const MAX_GIT_STEPS = 12;
// A step can additionally read two near-1 MiB identity documents. Stop before
// another step once this budget is reached, leaving room for its overshoot and
// the manual page, authorization, current head, and actor lookups.
const MAX_GIT_READ_BYTES = 4 * 1024 * 1024;
type Event = Infer<typeof translationHistoryEvent>;
type Scope = {
	projectId: Id<"projects">;
	messageId: string;
	localeId: Id<"locales">;
};
type Cursor = Scope & {
	version: 1;
	manualCursor: string | null;
	manualDone: boolean;
	pendingManualIds: string[];
	projectionId: string | null;
	retainedSeen: boolean;
};

function invalidCursor(): never {
	throw new ConvexError({
		code: "VALIDATION",
		message: "Invalid translation history cursor.",
	});
}

function parseCursor(text: string, scope: Scope): Cursor {
	if (text.length > 32768) invalidCursor();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		invalidCursor();
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalidCursor();
	const fields = value as Record<string, unknown>;
	if (
		fields.version !== 1 ||
		fields.projectId !== scope.projectId ||
		fields.messageId !== scope.messageId ||
		fields.localeId !== scope.localeId ||
		!(
			fields.manualCursor === null || typeof fields.manualCursor === "string"
		) ||
		typeof fields.manualDone !== "boolean" ||
		!Array.isArray(fields.pendingManualIds) ||
		fields.pendingManualIds.length > PAGE_SIZE ||
		!fields.pendingManualIds.every((id: unknown) => typeof id === "string") ||
		!(
			fields.projectionId === null || typeof fields.projectionId === "string"
		) ||
		typeof fields.retainedSeen !== "boolean"
	)
		invalidCursor();
	return {
		...scope,
		version: 1,
		manualCursor: fields.manualCursor,
		manualDone: fields.manualDone,
		pendingManualIds: fields.pendingManualIds,
		projectionId: fields.projectionId,
		retainedSeen: fields.retainedSeen,
	};
}

async function actorLabel(
	ctx: QueryCtx,
	projectId: Id<"projects">,
	actor: Actor,
): Promise<string> {
	if (actor.kind === "user")
		return (await getAnyUserById(ctx, actor.id))?.name ?? "Member";
	if (actor.kind === "agent" || actor.kind === "repositoryAdapter") {
		const id = ctx.db.normalizeId("apiTokens", actor.id);
		const token = id ? await ctx.db.get(id) : null;
		return token?.projectId === projectId
			? token.name
			: actor.kind === "agent"
				? "Agent"
				: "Repository sync";
	}
	return "Blabla";
}

/** Native cursors preserve Convex's complete tie-break order. The merge keeps
 * only unconsumed IDs (at most one page), never client-supplied event content. */
async function manualRows(ctx: QueryCtx, scope: Scope, state: Cursor) {
	const rows = await Promise.all(
		state.pendingManualIds.map(async (rawId) => {
			const id = ctx.db.normalizeId("catalogWorkspaceValueHistory", rawId);
			const row = id ? await ctx.db.get(id) : null;
			if (
				!row ||
				row.projectId !== scope.projectId ||
				row.messageId !== scope.messageId ||
				row.localeId !== scope.localeId
			)
				invalidCursor();
			return row;
		}),
	);
	if (!state.manualDone && rows.length < PAGE_SIZE) {
		const result = await ctx.db
			.query("catalogWorkspaceValueHistory")
			.withIndex("by_project_and_messageId_and_localeId_and_recordedAt", (q) =>
				q
					.eq("projectId", scope.projectId)
					.eq("messageId", scope.messageId)
					.eq("localeId", scope.localeId),
			)
			.order("desc")
			.paginate({
				numItems: PAGE_SIZE - rows.length,
				cursor: state.manualCursor,
			});
		rows.push(...result.page);
		state.manualCursor = result.continueCursor;
		state.manualDone = result.isDone;
	}
	return rows;
}

async function historyRowEvent(
	ctx: QueryCtx,
	row: Doc<"catalogWorkspaceValueHistory">,
): Promise<Event> {
	return {
		id: row._id,
		kind: row.kind,
		value: row.value,
		recordedAt: row.recordedAt,
		actorLabel: await actorLabel(ctx, row.projectId, row.actor),
		intentionalBlankReason: row.intentionalBlankReason,
	};
}

async function retainedHead(
	ctx: QueryCtx,
	scope: Scope,
): Promise<Event | null> {
	const head = await ctx.db
		.query("catalogWorkspaceValueHeads")
		.withIndex("by_project_and_messageId_and_localeId", (q) =>
			q
				.eq("projectId", scope.projectId)
				.eq("messageId", scope.messageId)
				.eq("localeId", scope.localeId),
		)
		.unique();
	if (!head) return null;
	const decision = await decisionForIdentity(ctx, {
		...scope,
		sourceFingerprint: head.sourceFingerprint,
		valueFingerprint: head.valueFingerprint ?? (await sha256Hex(head.value)),
	});
	return {
		id: `retained:${head._id}`,
		kind: "retained",
		value: head.value,
		recordedAt: head.updatedAt,
		actorLabel: await actorLabel(ctx, scope.projectId, head.updatedBy),
		intentionalBlankReason:
			decision?.kind === "intentionalBlank" ? decision.reason : undefined,
	};
}

async function gitStep(ctx: QueryCtx, scope: Scope, projectionId: string) {
	const id = ctx.db.normalizeId("catalogProjections", projectionId);
	const projection = id ? await ctx.db.get(id) : null;
	if (
		!projection ||
		projection.projectId !== scope.projectId ||
		projection.status !== "published" ||
		!projection.snapshotId
	)
		invalidCursor();
	const previousId = projection.previousCatalogProjectionId ?? null;
	const rowFor = (pid: Id<"catalogProjections">) =>
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", pid)
					.eq("messageId", scope.messageId)
					.eq("localeId", scope.localeId),
			)
			.unique();
	const [snapshot, row, previous] = await Promise.all([
		ctx.db.get(projection.snapshotId),
		rowFor(projection._id),
		previousId ? rowFor(previousId) : null,
	]);
	if (!snapshot || snapshot.projectId !== scope.projectId) invalidCursor();
	// Rebuilds and unchanged snapshots must not invent translation changes.
	const changed =
		row &&
		!row.isSource &&
		(!previous ||
			row.value !== previous.value ||
			row.sourceFingerprint !== previous.sourceFingerprint ||
			row.materialized !== previous.materialized);
	const event: Event | null = changed
		? {
				id: `git:${projection._id}`,
				kind: "git",
				value: row.value,
				recordedAt: projection.publishedAt ?? projection.createdAt,
				actorLabel: null,
				snapshot: {
					id: snapshot._id,
					commit: snapshot.commit,
					name: snapshot.name,
				},
			}
		: null;
	return {
		event,
		readBytes:
			encodedSize(projection) +
			encodedSize(snapshot) +
			encodedSize(row) +
			encodedSize(previous),
		previousId,
		recordedAt: projection.publishedAt ?? projection.createdAt,
	};
}

async function basicHistory(
	ctx: QueryCtx,
	scope: Scope,
	collectionId: Id<"contentCollections">,
	state: Cursor,
) {
	const result = await ctx.db
		.query("managedTargetRevisions")
		.withIndex("by_value", (q) =>
			q
				.eq("collectionId", collectionId)
				.eq("messageId", scope.messageId)
				.eq("localeId", scope.localeId),
		)
		.order("desc")
		.paginate({ numItems: PAGE_SIZE, cursor: state.manualCursor });
	const page = result.page;
	const events: Event[] = await Promise.all(
		page.map(async (row) => ({
			id: row._id,
			kind: row.reviewAuthorization ? "accepted" : "saved",
			value: row.value,
			recordedAt: row.createdAt,
			actorLabel: await actorLabel(ctx, scope.projectId, row.actor),
			intentionalBlankReason: row.intentionalBlankReason,
		})),
	);
	return {
		events,
		nextCursor: !result.isDone
			? JSON.stringify({ ...state, manualCursor: result.continueCursor })
			: null,
		olderManualHistoryUnavailable: false,
	};
}

/** Read-only history of applied translations. Private candidates never enter
 * this stream. Git evidence is walked along the accepted projection chain,
 * merging with indexed manual events without copying or scanning the catalog. */
export const list = query({
	args: {
		projectId: v.id("projects"),
		messageId: v.string(),
		localeId: v.id("locales"),
		cursor: v.optional(v.string()),
	},
	returns: v.object({
		events: v.array(translationHistoryEvent),
		nextCursor: v.union(v.string(), v.null()),
		olderManualHistoryUnavailable: v.boolean(),
	}),
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const [project, locale] = await Promise.all([
			ctx.db.get(args.projectId),
			ctx.db.get(args.localeId),
		]);
		if (
			!project ||
			!locale ||
			locale.projectId !== args.projectId ||
			locale.isSource
		)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Target language not found.",
			});
		if (args.messageId.length === 0 || args.messageId.length > 4096)
			throw new ConvexError({
				code: "VALIDATION",
				message: "Invalid string identifier.",
			});
		const initialProjection = args.cursor
			? null
			: await activeProjectionFor(ctx, args.projectId);
		const state: Cursor = args.cursor
			? parseCursor(args.cursor, args)
			: {
					projectId: args.projectId,
					messageId: args.messageId,
					localeId: args.localeId,
					version: 1,
					manualCursor: null,
					manualDone: false,
					pendingManualIds: [],
					projectionId: initialProjection?._id ?? null,
					retainedSeen: false,
				};
		if (project.type === "basic") {
			if (!project.managedCollectionId)
				throw new ConvexError({
					code: "BAD_STATE",
					message: "Project content is unavailable.",
				});
			return await basicHistory(ctx, args, project.managedCollectionId, state);
		}
		const rows = await manualRows(ctx, args, state);
		if (rows.length > 0) state.retainedSeen = true;
		const retained =
			!state.retainedSeen && rows.length === 0
				? await retainedHead(ctx, args)
				: null;
		let manualIndex = 0;
		let retainedPending = retained;
		let git: Awaited<ReturnType<typeof gitStep>> | null = null;
		let steps = 0;
		let gitReadBytes = 0;
		let boundary = Number.POSITIVE_INFINITY;
		const events: Event[] = [];
		while (events.length < PAGE_SIZE) {
			while (
				!git &&
				state.projectionId &&
				steps < MAX_GIT_STEPS &&
				gitReadBytes < MAX_GIT_READ_BYTES
			) {
				const next = await gitStep(ctx, args, state.projectionId);
				steps++;
				gitReadBytes += next.readBytes;
				boundary = next.recordedAt;
				if (next.event) git = next;
				else state.projectionId = next.previousId;
			}
			const row = rows[manualIndex];
			const manualTime = row?.recordedAt ?? retainedPending?.recordedAt;
			if (
				manualTime !== undefined &&
				(!git?.event || manualTime >= git.event.recordedAt)
			) {
				// A bounded quiet Git scan can stop before the next older event.
				if (!git && state.projectionId && manualTime < boundary) break;
				if (row) {
					events.push(await historyRowEvent(ctx, row));
					manualIndex++;
				} else if (retainedPending) {
					events.push(retainedPending);
					retainedPending = null;
					state.retainedSeen = true;
				}
			} else if (git?.event) {
				events.push(git.event);
				state.projectionId = git.previousId;
				git = null;
			} else break;
		}
		state.pendingManualIds = rows.slice(manualIndex).map((row) => row._id);
		const more =
			!state.manualDone ||
			state.pendingManualIds.length > 0 ||
			retainedPending !== null ||
			state.projectionId !== null;
		return {
			events,
			nextCursor: more ? JSON.stringify(state) : null,
			olderManualHistoryUnavailable: true,
		};
	},
});
