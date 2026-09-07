import { ConvexError, type Infer, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { authenticateAgent } from "./agentApi";
import { isHumanOrAuthorizedReview } from "./agentReviewModel";
import { authorizeCandidateReview } from "./agentReviews";
import { activeProjectionFor } from "./catalogProjection";
import {
	MAX_SEARCH_RESPONSE_BYTES,
	MAX_SEARCH_SCAN_KEYS,
	matchedFields,
	normalizedSearch,
	searchOptions,
} from "./catalogSearch";
import { encodedSize } from "./catalogWorkspaceView";
import { assertTargetValueContract } from "./contractTransforms";
import { sha256Hex } from "./lib";

export const proposalSearchScope = v.union(
	v.object({
		kind: v.literal("task"),
		taskId: v.id("agentTranslationProposals"),
	}),
	v.object({
		kind: v.literal("review"),
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
	}),
);
export type ProposalSearchScope = Infer<typeof proposalSearchScope>;

function decodeCursor(raw: string | undefined, basis: string): string | null {
	if (raw === undefined) return null;
	let parsed: unknown;
	try {
		if (raw.length > 4096) throw new Error("oversized cursor");
		parsed = JSON.parse(raw);
	} catch {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Invalid proposal search cursor.",
		});
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("basis" in parsed) ||
		typeof parsed.basis !== "string" ||
		!("after" in parsed) ||
		typeof parsed.after !== "string"
	)
		throw new ConvexError({
			code: "VALIDATION",
			message: "Invalid proposal search cursor.",
		});
	if (parsed.basis !== basis) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "Proposal examples or search scope changed; restart search.",
		});
	}
	return parsed.after;
}

function validExample(
	value: Doc<"localeProposalValues">,
	source: Doc<"catalogProjectionMessages">,
) {
	if (
		value.sourceFingerprint !== source.sourceFingerprint ||
		!isHumanOrAuthorizedReview(value.updatedBy, value.reviewAuthorization)
	)
		return false;
	if (value.value.length === 0)
		return Boolean(value.intentionalBlankReason?.trim());
	try {
		assertTargetValueContract({
			messageId: value.messageId,
			localeCode: "pt",
			value: value.value,
			source,
		});
		return true;
	} catch (error) {
		if (error instanceof ConvexError) return false;
		throw error;
	}
}

/** Reviewed draft examples are read through an owned task or a currently
 * authorized independent review. Neither scope exposes another task's candidates. */
export const search = internalQuery({
	args: { token: v.string(), scope: proposalSearchScope, ...searchOptions },
	handler: async (ctx, args) => {
		const token = await authenticateAgent(ctx, args.token, "search");
		if (!token.scopes.includes("read")) {
			throw new ConvexError({
				code: "UNAUTHORIZED",
				message: "Proposal examples require read and search scopes.",
			});
		}
		let task: Doc<"agentTranslationProposals">;
		if (args.scope.kind === "review") {
			// A recorded revision remains an access anchor, but current human
			// authorization is rechecked even when its review already happened.
			task = (
				await authorizeCandidateReview(
					ctx,
					args.token,
					args.scope.candidateRevisionId,
					false,
				)
			).proposal;
		} else {
			const found = await ctx.db.get(args.scope.taskId);
			if (
				!found ||
				found.projectId !== token.projectId ||
				(found.createdByTokenId !== undefined &&
					found.createdByTokenId !== token._id)
			)
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "Translation Task not found.",
				});
			task = found;
		}
		if (
			task.target.kind !== "localeProposal" ||
			(args.scope.kind === "task" && !task.localeProposalTaskScope)
		) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"Proposal examples require a new-Locale task or candidate; use Workspace search for existing Locales.",
			});
		}
		const proposal = await ctx.db.get(task.target.localeProposalId);
		if (!proposal || proposal.projectId !== token.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		}
		const projection = await activeProjectionFor(ctx, token.projectId);
		if (!projection || projection.snapshotId !== proposal.sourceSnapshotId) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"Proposal source is no longer the active Snapshot; refresh the new-Locale task.",
			});
		}
		const options = normalizedSearch(args);
		const basis = await sha256Hex(
			JSON.stringify({
				scope: args.scope,
				tokenId: token._id,
				proposalId: proposal._id,
				revision: proposal.revision,
				snapshotId: proposal.sourceSnapshotId,
				projectionId: projection._id,
				options,
			}),
		);
		const after = decodeCursor(args.cursor, basis);
		const exactKey = options.match === "exact" && options.searchIn === "key";
		const rows = ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal_and_messageId", (q) => {
				const scoped = q.eq("proposalId", proposal._id);
				if (exactKey) return scoped.eq("messageId", options.q);
				return after === null
					? scoped.gte("messageId", options.keyPrefix)
					: scoped.gt("messageId", after);
			});
		type Example = {
			messageId: string;
			source: { localeCode: string; value: string; sourceFingerprint: string };
			target: {
				localeCode: string;
				value: string;
				intentionalBlankReason?: string;
			};
			matchedFields: ReturnType<typeof matchedFields>;
			provenance: {
				kind: "reviewedDraft";
				valueId: Doc<"localeProposalValues">["_id"];
				proposalId: Doc<"localeProposals">["_id"];
				snapshotId: Doc<"localeProposals">["sourceSnapshotId"];
				reviewedBy: Doc<"localeProposalValues">["updatedBy"];
				reviewAuthorization?: Doc<"localeProposalValues">["reviewAuthorization"];
				reviewedAt: number;
			};
		};
		const items: Example[] = [];
		let scanned = 0;
		let readBytes = 0;
		let responseBytes = 4096;
		let lastScanned = after;
		let hasMore = false;
		for await (const value of rows) {
			if (!value.messageId.startsWith(options.keyPrefix)) break;
			const source = await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", value.messageId)
						.eq("isSource", true),
				)
				.unique();
			scanned += 1;
			readBytes += encodedSize(value) + encodedSize(source);
			const fields =
				source && validExample(value, source)
					? matchedFields(options, {
							key: value.messageId,
							source: source.value,
							target: value.value,
						})
					: [];
			if (source && fields.length > 0) {
				const item: Example = {
					messageId: value.messageId,
					source: {
						localeCode: source.localeCode,
						value: source.value,
						sourceFingerprint: source.sourceFingerprint,
					},
					target: {
						localeCode: proposal.localeCode,
						value: value.value,
						intentionalBlankReason: value.intentionalBlankReason,
					},
					matchedFields: fields,
					provenance: {
						kind: "reviewedDraft",
						valueId: value._id,
						proposalId: proposal._id,
						snapshotId: proposal.sourceSnapshotId,
						reviewedBy: value.updatedBy,
						reviewAuthorization: value.reviewAuthorization,
						reviewedAt: value.updatedAt,
					},
				};
				const size = encodedSize(item);
				if (responseBytes + size > MAX_SEARCH_RESPONSE_BYTES) {
					if (items.length === 0)
						throw new ConvexError({
							code: "LIMIT_EXCEEDED",
							message: "One proposal example exceeds the response envelope.",
						});
					hasMore = true;
					break;
				}
				items.push(item);
				responseBytes += size;
			}
			lastScanned = value.messageId;
			if (exactKey) break;
			if (
				scanned >= MAX_SEARCH_SCAN_KEYS ||
				items.length >= options.limit ||
				readBytes >= 4 * 1024 * 1024
			) {
				hasMore = true;
				break;
			}
		}
		return {
			proposalId: proposal._id,
			snapshotId: proposal.sourceSnapshotId,
			proposalRevision: proposal.revision,
			items,
			nextCursor: hasMore
				? JSON.stringify({ version: 1, basis, after: lastScanned })
				: null,
		};
	},
});
