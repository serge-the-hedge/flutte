import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
	currentSourceProposalRows,
	encodedSize,
	isCurrentHeadForRow,
} from "./catalogWorkspaceView";
import {
	publishedResolutionFor,
	sourceProposalHeadFor,
} from "./sourceProposals";

type Address = {
	projectId: Id<"projects">;
	projectionId: Id<"catalogProjections">;
	messageId: string;
};

/** Literal search needs visible bytes, not ICU parsing, hashes, constraints or
 * review evidence. Reuse the editor's overlay rules without loading its context. */
export async function searchSourceText(ctx: QueryCtx, address: Address) {
	const [source, head] = await Promise.all([
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_isSource", (q) =>
				q
					.eq("projectionId", address.projectionId)
					.eq("messageId", address.messageId)
					.eq("isSource", true),
			)
			.unique(),
		sourceProposalHeadFor(ctx, address.projectId, address.messageId),
	]);
	if (!source)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog key is missing its Source.",
		});
	const resolution = head
		? await publishedResolutionFor(ctx, {
				_id: head.proposalId,
				projectId: address.projectId,
				messageId: address.messageId,
			})
		: null;
	const [effective] = currentSourceProposalRows(
		[source],
		new Map(head ? [[address.messageId, head]] : []),
		new Map(head && resolution ? [[head.proposalId, resolution]] : []),
	);
	return {
		value: effective?.value ?? source.value,
		bytes: encodedSize(source) + encodedSize(head) + encodedSize(resolution),
	};
}

export async function searchTargetText(
	ctx: QueryCtx,
	address: Address,
	localeId: Id<"locales">,
) {
	const [target, head] = await Promise.all([
		ctx.db
			.query("catalogProjectionMessages")
			.withIndex("by_projection_and_messageId_and_localeId", (q) =>
				q
					.eq("projectionId", address.projectionId)
					.eq("messageId", address.messageId)
					.eq("localeId", localeId),
			)
			.unique(),
		ctx.db
			.query("catalogWorkspaceValueHeads")
			.withIndex("by_project_and_messageId_and_localeId", (q) =>
				q
					.eq("projectId", address.projectId)
					.eq("messageId", address.messageId)
					.eq("localeId", localeId),
			)
			.unique(),
	]);
	if (!target || target.isSource)
		throw new ConvexError({
			code: "INTEGRITY",
			message: "Catalog key is missing its target.",
		});
	return {
		value: isCurrentHeadForRow(target, head) ? head.value : target.value,
		bytes: encodedSize(target) + encodedSize(head),
	};
}
