import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type ActionCtx,
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	type AgentReviewAuthorization,
	agentReviewAuthorizationValidator,
	isHumanOrAuthorizedReview,
} from "./agentReviewModel";
import { type CatalogDocument, parse, serialize } from "./catalogDocument";
import {
	activeProjectionFor,
	MAX_WORKING_CATALOG_KEYS,
} from "./catalogProjection";
import {
	assertTargetValueContract,
	sourceContractsMatch,
} from "./contractTransforms";
import { DEFAULT_INTEGRATION_BRANCH, now, sha256Hex } from "./lib";
import { declaredPlaceholderNames, messageFacts } from "./messageFacts";
import { requireEditor, requireViewer } from "./permissions";

export const PORTUGUESE_LOCALE_CODE = "pt";
export const PORTUGUESE_LOCALE_LABEL = "Portuguese";
export const PORTUGUESE_RUNTIME_LOCALE = "pt-BR";
export const PORTUGUESE_CATALOG_FILE_NAME = "intl_pt.arb";

export const MAX_LOCALE_PROPOSAL_MESSAGES = MAX_WORKING_CATALOG_KEYS;
export const MAX_LOCALE_PROPOSAL_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_LOCALE_PROPOSAL_VALUE_BYTES = 256 * 1024;
export const MAX_LOCALE_PROPOSAL_VALUE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_LOCALE_PROPOSAL_STAGE_ITEMS = 16;
export const MAX_LOCALE_PROPOSAL_STAGE_BYTES = 512 * 1024;
export const MAX_LOCALE_PROPOSAL_CARRY_ITEMS = 64;
export const MAX_LOCALE_PROPOSAL_TEMPLATE_ITEMS = 16;
export const MAX_LOCALE_PROPOSAL_TEMPLATE_BYTES = 512 * 1024;
export const MAX_LOCALE_PROPOSAL_REVIEW_ITEMS = 48;
export const MAX_LOCALE_PROPOSAL_REVIEW_SCAN_ITEMS = 64;
export const MAX_LOCALE_PROPOSAL_ARTIFACT_BYTES = 12 * 1024 * 1024;
export const MAX_LOCALE_PROPOSAL_DIAGNOSTICS = 128;

const MAX_LOCALE_PROPOSAL_MESSAGE_ID_BYTES = 512;
const MAX_LOCALE_PROPOSAL_BLANK_REASON_BYTES = 4 * 1024;
const MAX_LOCALE_PROPOSAL_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES =
	MAX_LOCALE_PROPOSAL_TEMPLATE_BYTES - 1024;
const actorValidator = v.object({
	kind: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
	id: v.string(),
});

/** Authentication stays at the HTTP adapter; this is the narrow capability the
 * Locale Proposal module needs to operate on one project on its behalf. */
export type ProposalActor = {
	projectId: Id<"projects">;
	tokenId?: Id<"apiTokens">;
};

type SourceEvidence = {
	projectId: Id<"projects">;
	snapshotId: Id<"sourceSnapshots">;
	repository: string;
	integrationBranch: string;
	commit: string;
	manifestHash: string;
	sourceSnapshotFileId: Id<"sourceSnapshotFiles">;
	sourceCatalogPath: string;
	sourceStorageId: Id<"_storage">;
	isCurrentBaseline: boolean;
};

type ProposalValueInput = {
	messageId: string;
	value: string;
	sourceFingerprint: string;
	intentionalBlankReason?: string;
};

type CarryForwardValueInput = ProposalValueInput & {
	updatedBy: { kind: "user" | "agent"; id: string };
	reviewAuthorization?: AgentReviewAuthorization;
};

type TemplateMessage = {
	id: string;
	sourceValue: string;
	sourceFingerprint: string;
	staged: boolean;
	// Kept opaque so large, lossless ARB metadata does not become an unbounded
	// Convex object in the Agent API response.
	metadataJson?: string;
};

const localeProposalReviewFocusValidator = v.union(
	v.literal("all"),
	v.literal("awaiting"),
	v.literal("attention"),
	v.literal("routine"),
	v.literal("reviewed"),
	v.literal("missing"),
);

type LocaleProposalReviewFocus =
	| "all"
	| "awaiting"
	| "attention"
	| "routine"
	| "reviewed"
	| "missing";

type LocaleProposalReviewFacts = {
	state: "awaiting" | "needsEdit" | "reviewed" | "reviewedDraft" | "missing";
	sourceIdentical: boolean;
	sourceEmpty: boolean;
	blankCandidate: boolean;
	icu: boolean;
	edgeWhitespaceMismatch: boolean;
	staleSource: boolean;
};

type LocaleProposalSummary = {
	proposalId: Id<"localeProposals">;
	sourceSnapshotId: Id<"sourceSnapshots">;
	sourceSnapshot: {
		id: Id<"sourceSnapshots">;
		repository: string;
		integrationBranch: string;
		commit: string;
		manifestHash: string;
	};
	locale: {
		code: typeof PORTUGUESE_LOCALE_CODE;
		label: typeof PORTUGUESE_LOCALE_LABEL;
		runtimeLocale: typeof PORTUGUESE_RUNTIME_LOCALE;
	};
	status: "draft" | "ready";
	deliveryStatus: "draft" | "ready" | "stale";
	progress: { total: number; staged: number; remaining: number };
	diagnostics: { count: number; messages: string[] };
	artifact?: { hash: string; byteLength?: number };
};

type LocaleProposalArtifact = {
	version: 1;
	proposalId: Id<"localeProposals">;
	sourceSnapshot: {
		id: string;
		repository: string;
		integrationBranch: string;
		commit: string;
		manifestHash: string;
		catalogPath: string;
	};
	locale: {
		code: typeof PORTUGUESE_LOCALE_CODE;
		label: typeof PORTUGUESE_LOCALE_LABEL;
		runtimeLocale: typeof PORTUGUESE_RUNTIME_LOCALE;
	};
	catalog: {
		fileName: typeof PORTUGUESE_CATALOG_FILE_NAME;
		content: string;
		contentHash: string;
	};
};

export type LocaleProposalCarryForwardResult = {
	localeProposalId: Id<"localeProposals">;
	carriedValueCount: number;
	incompatibleValueCount: number;
	remainingValueCount: number;
	totalValueCount: number;
};

function encodedSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedDiagnostic(message: string): string {
	const bytes = new TextEncoder().encode(message);
	if (bytes.byteLength <= MAX_LOCALE_PROPOSAL_DIAGNOSTIC_BYTES) {
		return message;
	}
	return `${new TextDecoder().decode(
		bytes.slice(0, MAX_LOCALE_PROPOSAL_DIAGNOSTIC_BYTES - 3),
	)}...`;
}

function valueByteLength(input: ProposalValueInput): number {
	return encodedSize({
		messageId: input.messageId,
		value: input.value,
		sourceFingerprint: input.sourceFingerprint,
		...(input.intentionalBlankReason === undefined
			? {}
			: { intentionalBlankReason: input.intentionalBlankReason }),
	});
}

function validationError(message: string): never {
	throw new ConvexError({ code: "VALIDATION", message });
}

function integrityError(message: string): never {
	throw new ConvexError({ code: "INTEGRITY", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		integrityError("Portuguese delivery artifact has an invalid shape.");
	}
	return value;
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		integrityError("Portuguese delivery artifact has an invalid shape.");
	}
	return value;
}

function requiredRecord(
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) {
		integrityError("Portuguese delivery artifact has an invalid shape.");
	}
	return value;
}

function parseArtifact(
	text: string,
	expectedProposalId: Id<"localeProposals">,
): LocaleProposalArtifact {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		integrityError("Portuguese delivery artifact is not valid JSON.");
	}
	if (!isRecord(parsed) || parsed.version !== 1) {
		integrityError("Portuguese delivery artifact has an invalid shape.");
	}
	const sourceSnapshot = requiredRecord(parsed, "sourceSnapshot");
	const locale = requiredRecord(parsed, "locale");
	const catalog = requiredRecord(parsed, "catalog");
	if (
		requiredString(parsed, "proposalId") !== expectedProposalId ||
		requiredString(locale, "code") !== PORTUGUESE_LOCALE_CODE ||
		requiredString(locale, "label") !== PORTUGUESE_LOCALE_LABEL ||
		requiredString(locale, "runtimeLocale") !== PORTUGUESE_RUNTIME_LOCALE ||
		requiredString(catalog, "fileName") !== PORTUGUESE_CATALOG_FILE_NAME
	) {
		integrityError("Portuguese delivery artifact has an unexpected identity.");
	}
	return {
		version: 1,
		proposalId: expectedProposalId,
		sourceSnapshot: {
			id: requiredString(sourceSnapshot, "id"),
			repository: requiredString(sourceSnapshot, "repository"),
			integrationBranch:
				optionalString(sourceSnapshot, "integrationBranch") ??
				DEFAULT_INTEGRATION_BRANCH,
			commit: requiredString(sourceSnapshot, "commit"),
			manifestHash: requiredString(sourceSnapshot, "manifestHash"),
			catalogPath: requiredString(sourceSnapshot, "catalogPath"),
		},
		locale: {
			code: PORTUGUESE_LOCALE_CODE,
			label: PORTUGUESE_LOCALE_LABEL,
			runtimeLocale: PORTUGUESE_RUNTIME_LOCALE,
		},
		catalog: {
			fileName: PORTUGUESE_CATALOG_FILE_NAME,
			content: requiredString(catalog, "content"),
			contentHash: requiredString(catalog, "contentHash"),
		},
	};
}

function sourceStaleError(): never {
	throw new ConvexError({
		code: "STALE_SOURCE",
		message:
			"This Portuguese Locale Proposal is pinned to a Source Snapshot that is no longer the Baseline Snapshot.",
	});
}

async function currentSourceEvidenceForSnapshot(
	ctx: QueryCtx | MutationCtx,
	project: Doc<"projects">,
	snapshotId: Id<"sourceSnapshots">,
): Promise<SourceEvidence> {
	const snapshot = await ctx.db.get(snapshotId);
	if (!snapshot || snapshot.projectId !== project._id) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Source Snapshot not found.",
		});
	}
	const snapshotSources = await ctx.db
		.query("sourceSnapshotFiles")
		.withIndex("by_snapshot_and_isSource", (q) =>
			q.eq("snapshotId", snapshotId).eq("isSource", true),
		)
		.take(2);
	if (snapshotSources.length > 1) {
		integrityError(
			"The Baseline Snapshot has multiple source Catalog Documents.",
		);
	}
	const sourceLocaleId = project.sourceLocaleId;
	const source =
		snapshotSources[0] ??
		(sourceLocaleId === undefined
			? undefined
			: await ctx.db
					.query("sourceSnapshotFiles")
					.withIndex("by_snapshot_and_localeId", (q) =>
						q.eq("snapshotId", snapshotId).eq("localeId", sourceLocaleId),
					)
					.unique());
	if (!source) {
		integrityError("The Baseline Snapshot has no source Catalog Document.");
	}
	return {
		projectId: project._id,
		snapshotId,
		repository: snapshot.repository,
		integrationBranch: project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
		commit: snapshot.commit,
		manifestHash: snapshot.manifestHash,
		sourceSnapshotFileId: source._id,
		sourceCatalogPath: source.catalogPath,
		sourceStorageId: source.storageId,
		isCurrentBaseline: project.baselineSnapshotId === snapshotId,
	};
}

async function pinnedSourceEvidenceForProposal(
	ctx: QueryCtx | MutationCtx,
	project: Doc<"projects">,
	proposal: Doc<"localeProposals">,
): Promise<SourceEvidence> {
	const [snapshot, source] = await Promise.all([
		ctx.db.get(proposal.sourceSnapshotId),
		ctx.db.get(proposal.sourceSnapshotFileId),
	]);
	if (!snapshot || snapshot.projectId !== project._id) {
		integrityError(
			"Portuguese Locale Proposal references missing source snapshot evidence.",
		);
	}
	if (
		!source ||
		source.projectId !== project._id ||
		source.snapshotId !== proposal.sourceSnapshotId ||
		source.catalogPath !== proposal.sourceCatalogPath ||
		source.storageId !== proposal.sourceStorageId
	) {
		integrityError(
			"Portuguese Locale Proposal references altered source Catalog Document evidence.",
		);
	}
	return {
		projectId: project._id,
		snapshotId: snapshot._id,
		repository: snapshot.repository,
		integrationBranch: project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
		commit: snapshot.commit,
		manifestHash: snapshot.manifestHash,
		sourceSnapshotFileId: source._id,
		sourceCatalogPath: source.catalogPath,
		sourceStorageId: source.storageId,
		isCurrentBaseline: project.baselineSnapshotId === snapshot._id,
	};
}

async function projectFor(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
): Promise<Doc<"projects">> {
	const project = await ctx.db.get(projectId);
	if (!project || project.archivedAt !== undefined) {
		throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
	}
	return project;
}

function assertSourceDocument(
	document: CatalogDocument,
	byteLength: number,
): void {
	if (byteLength > MAX_LOCALE_PROPOSAL_DOCUMENT_BYTES) {
		validationError(
			"The source Catalog Document exceeds the Portuguese proposal envelope.",
		);
	}
	if (document.messages.length > MAX_LOCALE_PROPOSAL_MESSAGES) {
		validationError(
			`A Portuguese Locale Proposal supports at most ${MAX_LOCALE_PROPOSAL_MESSAGES} source messages.`,
		);
	}
	const ids = new Set<string>();
	for (const message of document.messages) {
		if (
			message.id.length === 0 ||
			new TextEncoder().encode(message.id).byteLength >
				MAX_LOCALE_PROPOSAL_MESSAGE_ID_BYTES ||
			ids.has(message.id)
		) {
			validationError(
				"The source Catalog Document has an invalid message identity.",
			);
		}
		ids.add(message.id);
		if (
			new TextEncoder().encode(message.value).byteLength >
			MAX_LOCALE_PROPOSAL_VALUE_BYTES
		) {
			validationError(
				`The source value for "${message.id}" exceeds the Portuguese proposal envelope.`,
			);
		}
	}
	const locale = document.globals.find((global) => global.name === "@@locale");
	if (!locale || typeof locale.value !== "string") {
		validationError(
			"The source Catalog Document has no string @@locale global.",
		);
	}
}

async function readSourceDocument(
	ctx: ActionCtx,
	source: SourceEvidence,
): Promise<CatalogDocument> {
	const blob = await ctx.storage.get(source.sourceStorageId);
	if (!blob) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Source Catalog Document evidence is missing.",
		});
	}
	const text = await blob.text();
	const document = parse(text);
	assertSourceDocument(document, new TextEncoder().encode(text).byteLength);
	return document;
}

async function sourceFingerprint(message: { value: string }): Promise<string> {
	return await sha256Hex(message.value);
}

function sourceContract(message: CatalogDocument["messages"][number]) {
	const facts = messageFacts(message.value);
	return {
		argumentNames: [...facts.argumentNames],
		argumentNamesComplete: true,
		declaredPlaceholderNames: [...declaredPlaceholderNames(message.metadata)],
		declaredPlaceholderNamesComplete: true,
	};
}

type ProjectionSourceRow = {
	messageId: string;
	value: string;
	sourceFingerprint: string;
	argumentNames: string[];
	argumentNamesComplete: boolean;
	declaredPlaceholderNames?: string[];
	declaredPlaceholderNamesComplete?: boolean;
};

async function currentSourceRowForProposal(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	proposal: Doc<"localeProposals">,
	messageId: string,
): Promise<ProjectionSourceRow> {
	const projection = await activeProjectionFor(ctx, projectId);
	const row = projection
		? await ctx.db
				.query("catalogProjectionMessages")
				.withIndex("by_projection_and_messageId_and_isSource", (q) =>
					q
						.eq("projectionId", projection._id)
						.eq("messageId", messageId)
						.eq("isSource", true),
				)
				.unique()
		: null;
	if (
		!projection ||
		projection.snapshotId !== proposal.sourceSnapshotId ||
		!row?.isSource
	) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Locale Proposal source basis is no longer current.",
		});
	}
	return row;
}

async function assertProposalItemsAgainstCurrentSource(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	proposal: Doc<"localeProposals">,
	items: readonly ProposalValueInput[],
): Promise<ProposalValueInput[]> {
	if (
		items.length === 0 ||
		items.length > MAX_LOCALE_PROPOSAL_STAGE_ITEMS ||
		encodedSize(items) > MAX_LOCALE_PROPOSAL_STAGE_BYTES
	) {
		validationError("Locale Proposal batches exceed their bounded envelope.");
	}
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.messageId)) {
			validationError("A Locale Proposal batch repeats a message identity.");
		}
		seen.add(item.messageId);
		const source = await currentSourceRowForProposal(
			ctx,
			projectId,
			proposal,
			item.messageId,
		);
		if (item.sourceFingerprint !== source.sourceFingerprint) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message: `Locale Proposal value "${item.messageId}" answers an outdated Source Contract.`,
			});
		}
		if (item.value.length === 0) {
			if (!item.intentionalBlankReason?.trim()) {
				validationError(
					`Locale Proposal value "${item.messageId}" needs an Intentional Blank reason.`,
				);
			}
		} else if (item.value.trim().length === 0 || item.intentionalBlankReason) {
			validationError(
				`Locale Proposal value "${item.messageId}" must be meaningful text or an Intentional Blank.`,
			);
		}
		if (valueByteLength(item) > MAX_LOCALE_PROPOSAL_STAGE_BYTES) {
			validationError("One Locale Proposal value exceeds its byte envelope.");
		}
		assertTargetValueContract({
			messageId: item.messageId,
			localeCode: proposal.localeCode,
			value: item.value,
			source: {
				argumentNames: source.argumentNames,
				argumentNamesComplete: source.argumentNamesComplete,
				declaredPlaceholderNames: source.declaredPlaceholderNames ?? [],
				declaredPlaceholderNamesComplete:
					source.declaredPlaceholderNamesComplete ?? true,
			},
		});
	}
	return [...items];
}

function assertStageItems(
	document: CatalogDocument,
	items: readonly ProposalValueInput[],
): Promise<ProposalValueInput[]> {
	return (async () => {
		if (items.length === 0) {
			validationError("Provide at least one Portuguese translation value.");
		}
		if (items.length > MAX_LOCALE_PROPOSAL_STAGE_ITEMS) {
			validationError(
				`Portuguese proposal batches support at most ${MAX_LOCALE_PROPOSAL_STAGE_ITEMS} values.`,
			);
		}
		if (encodedSize(items) > MAX_LOCALE_PROPOSAL_STAGE_BYTES) {
			validationError("Portuguese proposal batch exceeds its byte envelope.");
		}
		const sourceById = new Map(
			document.messages.map((message) => [message.id, message] as const),
		);
		const seen = new Set<string>();
		const normalized: ProposalValueInput[] = [];
		for (const item of items) {
			if (
				item.messageId.length === 0 ||
				new TextEncoder().encode(item.messageId).byteLength >
					MAX_LOCALE_PROPOSAL_MESSAGE_ID_BYTES ||
				seen.has(item.messageId)
			) {
				validationError(
					"A Portuguese proposal batch repeats or omits a message identity.",
				);
			}
			seen.add(item.messageId);
			const source = sourceById.get(item.messageId);
			if (!source) {
				validationError(
					`Portuguese proposal value "${item.messageId}" is not in the pinned Source Snapshot.`,
				);
			}
			if (
				new TextEncoder().encode(item.value).byteLength >
				MAX_LOCALE_PROPOSAL_VALUE_BYTES
			) {
				validationError(
					`Portuguese value "${item.messageId}" exceeds the proposal value envelope.`,
				);
			}
			const expectedSourceFingerprint = await sourceFingerprint(source);
			if (item.sourceFingerprint !== expectedSourceFingerprint) {
				validationError(
					`Portuguese value "${item.messageId}" answers an outdated Source Contract.`,
				);
			}
			const blankReason = item.intentionalBlankReason?.trim();
			if (item.value.length === 0) {
				if (!blankReason) {
					validationError(
						`Portuguese value "${item.messageId}" is empty; record an Intentional Blank reason instead.`,
					);
				}
				if (
					new TextEncoder().encode(blankReason).byteLength >
					MAX_LOCALE_PROPOSAL_BLANK_REASON_BYTES
				) {
					validationError(
						`Intentional Blank reason for "${item.messageId}" exceeds the proposal envelope.`,
					);
				}
			} else {
				if (item.value.trim().length === 0) {
					validationError(
						`Portuguese value "${item.messageId}" must be meaningful text or an exact Intentional Blank.`,
					);
				}
				if (blankReason) {
					validationError(
						`Portuguese value "${item.messageId}" has an Intentional Blank reason but is not blank.`,
					);
				}
				assertTargetValueContract({
					messageId: item.messageId,
					localeCode: PORTUGUESE_LOCALE_CODE,
					value: item.value,
					source: sourceContract(source),
				});
			}
			normalized.push({
				messageId: item.messageId,
				value: item.value,
				sourceFingerprint: item.sourceFingerprint,
				...(blankReason === undefined || blankReason.length === 0
					? {}
					: { intentionalBlankReason: blankReason }),
			});
		}
		return normalized;
	})();
}

function assertProposalEnvelope(proposal: Doc<"localeProposals">): void {
	if (
		!Number.isInteger(proposal.sourceMessageCount) ||
		proposal.sourceMessageCount < 0 ||
		proposal.sourceMessageCount > MAX_LOCALE_PROPOSAL_MESSAGES ||
		!Number.isInteger(proposal.stagedValueCount) ||
		proposal.stagedValueCount < 0 ||
		proposal.stagedValueCount > proposal.sourceMessageCount ||
		!Number.isInteger(proposal.stagedValueByteLength) ||
		proposal.stagedValueByteLength < 0 ||
		proposal.stagedValueByteLength > MAX_LOCALE_PROPOSAL_VALUE_TOTAL_BYTES ||
		!Number.isInteger(proposal.revision) ||
		proposal.revision < 0 ||
		!Number.isInteger(proposal.diagnosticGeneration) ||
		proposal.diagnosticGeneration < 0 ||
		!Number.isInteger(proposal.diagnosticCount) ||
		proposal.diagnosticCount < 0 ||
		proposal.diagnosticCount > MAX_LOCALE_PROPOSAL_MESSAGES
	) {
		integrityError(
			"Portuguese Locale Proposal does not match its bounded envelope.",
		);
	}
}

function proposalSummary(
	proposal: Doc<"localeProposals">,
	snapshot: Doc<"sourceSnapshots">,
	isCurrentBaseline: boolean,
	diagnostics: string[],
	integrationBranch = DEFAULT_INTEGRATION_BRANCH,
): LocaleProposalSummary {
	assertProposalEnvelope(proposal);
	return {
		proposalId: proposal._id,
		sourceSnapshotId: proposal.sourceSnapshotId,
		sourceSnapshot: {
			id: snapshot._id,
			repository: snapshot.repository,
			integrationBranch,
			commit: snapshot.commit,
			manifestHash: snapshot.manifestHash,
		},
		locale: {
			code: PORTUGUESE_LOCALE_CODE,
			label: PORTUGUESE_LOCALE_LABEL,
			runtimeLocale: PORTUGUESE_RUNTIME_LOCALE,
		},
		status: proposal.status,
		deliveryStatus:
			proposal.status === "ready"
				? isCurrentBaseline
					? "ready"
					: "stale"
				: isCurrentBaseline
					? "draft"
					: "stale",
		progress: {
			total: proposal.sourceMessageCount,
			staged: proposal.stagedValueCount,
			remaining: proposal.sourceMessageCount - proposal.stagedValueCount,
		},
		diagnostics: { count: proposal.diagnosticCount, messages: diagnostics },
		...(proposal.artifactHash === undefined
			? {}
			: {
					artifact: {
						hash: proposal.artifactHash,
						byteLength: proposal.artifactByteLength,
					},
				}),
	};
}

async function currentDiagnosticsForProposal(
	ctx: QueryCtx,
	proposal: Doc<"localeProposals">,
): Promise<string[]> {
	if (proposal.diagnosticCount === 0) return [];
	const diagnostics = await ctx.db
		.query("localeProposalDiagnostics")
		.withIndex("by_proposal_and_generation", (q) =>
			q
				.eq("proposalId", proposal._id)
				.eq("generation", proposal.diagnosticGeneration),
		)
		.take(MAX_LOCALE_PROPOSAL_DIAGNOSTICS + 1);
	if (diagnostics.length > MAX_LOCALE_PROPOSAL_DIAGNOSTICS) {
		integrityError(
			"Portuguese Locale Proposal exceeds its diagnostics sample envelope.",
		);
	}
	if (
		diagnostics.length !==
		Math.min(proposal.diagnosticCount, MAX_LOCALE_PROPOSAL_DIAGNOSTICS)
	) {
		integrityError(
			"Portuguese Locale Proposal diagnostics do not match the recorded validation result.",
		);
	}
	return diagnostics.map((diagnostic) => diagnostic.message);
}

export const currentSourceFor = internalQuery({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args): Promise<SourceEvidence> => {
		const project = await projectFor(ctx, args.projectId);
		if (!project.baselineSnapshotId) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Portuguese Locale Proposal needs an accepted Baseline Snapshot.",
			});
		}
		return await currentSourceEvidenceForSnapshot(
			ctx,
			project,
			project.baselineSnapshotId,
		);
	},
});

export const sourceForProposal = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args): Promise<SourceEvidence> => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		const project = await projectFor(ctx, args.projectId);
		return await pinnedSourceEvidenceForProposal(ctx, project, proposal);
	},
});

/** Immutable source facts used by the generic Agent Translation Proposal
 * module. Keeping this lookup here means every future Locale Proposal target
 * uses the same snapshot-bound evidence rather than mutable bindings. */
export const sourceMessageForProposal = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageId: v.string(),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		}
		const project = await projectFor(ctx, args.projectId);
		const projection = await activeProjectionFor(ctx, args.projectId);
		const source = projection
			? await ctx.db
					.query("catalogProjectionMessages")
					.withIndex("by_projection_and_messageId_and_isSource", (q) =>
						q
							.eq("projectionId", projection._id)
							.eq("messageId", args.messageId)
							.eq("isSource", true),
					)
					.unique()
			: null;
		if (
			!source?.isSource ||
			!projection ||
			projection.snapshotId !== proposal.sourceSnapshotId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal message not found.",
			});
		}
		return {
			proposalId: proposal._id,
			sourceSnapshotId: proposal.sourceSnapshotId,
			isCurrentBaseline:
				project.baselineSnapshotId === proposal.sourceSnapshotId,
			localeCode: proposal.localeCode,
			sourceValue: source.value,
			sourceFingerprint: source.sourceFingerprint,
			source: {
				argumentNames: source.argumentNames,
				argumentNamesComplete: source.argumentNamesComplete,
				declaredPlaceholderNames: source.declaredPlaceholderNames ?? [],
				declaredPlaceholderNamesComplete:
					source.declaredPlaceholderNamesComplete ?? true,
			},
		};
	},
});

/** Find the resumable proposal before consulting current Locale setup. Once a
 * proposal exists, its Source Catalog Document must stay immutable evidence. */
export const currentProposalFor = internalQuery({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args): Promise<Id<"localeProposals"> | null> => {
		const project = await projectFor(ctx, args.projectId);
		if (!project.baselineSnapshotId) {
			throw new ConvexError({
				code: "VALIDATION",
				message:
					"A Portuguese Locale Proposal needs an accepted Baseline Snapshot.",
			});
		}
		const baselineSnapshotId = project.baselineSnapshotId;
		const proposal = await ctx.db
			.query("localeProposals")
			.withIndex("by_project_and_sourceSnapshotId_and_localeCode", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("sourceSnapshotId", baselineSnapshotId)
					.eq("localeCode", PORTUGUESE_LOCALE_CODE),
			)
			.unique();
		return proposal?._id ?? null;
	},
});

export const begin = internalMutation({
	args: {
		projectId: v.id("projects"),
		sourceSnapshotId: v.id("sourceSnapshots"),
		sourceSnapshotFileId: v.id("sourceSnapshotFiles"),
		sourceCatalogPath: v.string(),
		sourceStorageId: v.id("_storage"),
		sourceMessageCount: v.number(),
		createdBy: actorValidator,
	},
	handler: async (ctx, args) => {
		const project = await projectFor(ctx, args.projectId);
		if (project.baselineSnapshotId !== args.sourceSnapshotId)
			sourceStaleError();
		const existingLocale = await ctx.db
			.query("locales")
			.withIndex("by_project_code", (q) =>
				q.eq("projectId", args.projectId).eq("code", PORTUGUESE_LOCALE_CODE),
			)
			.unique();
		if (existingLocale && existingLocale.archivedAt === undefined) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"Portuguese is already a project Locale, not a Locale Proposal.",
			});
		}
		const existing = await ctx.db
			.query("localeProposals")
			.withIndex("by_project_and_sourceSnapshotId_and_localeCode", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq("sourceSnapshotId", args.sourceSnapshotId)
					.eq("localeCode", PORTUGUESE_LOCALE_CODE),
			)
			.unique();
		if (existing) return existing._id;
		if (
			!Number.isInteger(args.sourceMessageCount) ||
			args.sourceMessageCount < 0 ||
			args.sourceMessageCount > MAX_LOCALE_PROPOSAL_MESSAGES ||
			args.sourceCatalogPath.length === 0
		) {
			validationError("Portuguese Locale Proposal source evidence is invalid.");
		}
		const source = await ctx.db.get(args.sourceSnapshotFileId);
		if (
			!source ||
			source.projectId !== args.projectId ||
			source.snapshotId !== args.sourceSnapshotId ||
			source.catalogPath !== args.sourceCatalogPath ||
			source.storageId !== args.sourceStorageId
		) {
			validationError("Portuguese Locale Proposal source evidence is invalid.");
		}
		const timestamp = now();
		return await ctx.db.insert("localeProposals", {
			projectId: args.projectId,
			sourceSnapshotId: args.sourceSnapshotId,
			sourceSnapshotFileId: args.sourceSnapshotFileId,
			sourceCatalogPath: args.sourceCatalogPath,
			sourceStorageId: args.sourceStorageId,
			sourceMessageCount: args.sourceMessageCount,
			localeCode: PORTUGUESE_LOCALE_CODE,
			runtimeLocale: PORTUGUESE_RUNTIME_LOCALE,
			status: "draft",
			stagedValueCount: 0,
			stagedValueByteLength: 0,
			revision: 0,
			diagnosticGeneration: 0,
			diagnosticCount: 0,
			createdBy: args.createdBy,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
	},
});

export const assertEditor = internalQuery({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		return await requireEditor(ctx, args.projectId);
	},
});

export async function ensureLocaleProposalForReview(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	userId: string,
): Promise<{ proposalId: Id<"localeProposals"> }> {
	const project = await projectFor(ctx, projectId);
	if (!project.baselineSnapshotId) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Accept a Baseline Snapshot before preparing a Locale Proposal.",
		});
	}
	const existing = await ctx.db
		.query("localeProposals")
		.withIndex("by_project_and_sourceSnapshotId_and_localeCode", (q) =>
			q
				.eq("projectId", projectId)
				.eq(
					"sourceSnapshotId",
					project.baselineSnapshotId as Id<"sourceSnapshots">,
				)
				.eq("localeCode", PORTUGUESE_LOCALE_CODE),
		)
		.unique();
	if (existing) return { proposalId: existing._id };
	const source = await currentSourceEvidenceForSnapshot(
		ctx,
		project,
		project.baselineSnapshotId,
	);
	const projection = await activeProjectionFor(ctx, projectId);
	if (!projection || projection.snapshotId !== source.snapshotId) {
		throw new ConvexError({
			code: "INTEGRITY",
			message:
				"The active Catalog Workspace does not match the Baseline Snapshot.",
		});
	}
	const proposalId: Id<"localeProposals"> = await ctx.runMutation(
		internal.localeProposals.begin,
		{
			projectId,
			sourceSnapshotId: source.snapshotId,
			sourceSnapshotFileId: source.sourceSnapshotFileId,
			sourceCatalogPath: source.sourceCatalogPath,
			sourceStorageId: source.sourceStorageId,
			sourceMessageCount: projection.expectedKeyCount,
			createdBy: { kind: "user", id: userId },
		},
	);
	return { proposalId };
}

/** Start the first configured Locale Proposal from the human workbench. This
 * is deliberately the same pinned-evidence path as the agent adapter. */
export const ensureForReview = mutation({
	args: { projectId: v.id("projects") },
	handler: async (
		ctx,
		args,
	): Promise<{ proposalId: Id<"localeProposals"> }> => {
		const { userId } = await requireEditor(ctx, args.projectId);
		return await ensureLocaleProposalForReview(ctx, args.projectId, userId);
	},
});

export const ensureForCarryForward = internalMutation({
	args: {
		projectId: v.id("projects"),
		userId: v.string(),
	},
	handler: async (ctx, args) =>
		await ensureLocaleProposalForReview(ctx, args.projectId, args.userId),
});

export const currentForReview = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args): Promise<Id<"localeProposals"> | null> => {
		await requireViewer(ctx, args.projectId);
		const project = await projectFor(ctx, args.projectId);
		if (!project.baselineSnapshotId) return null;
		const proposal = await ctx.db
			.query("localeProposals")
			.withIndex("by_project_and_sourceSnapshotId_and_localeCode", (q) =>
				q
					.eq("projectId", args.projectId)
					.eq(
						"sourceSnapshotId",
						project.baselineSnapshotId as Id<"sourceSnapshots">,
					)
					.eq("localeCode", PORTUGUESE_LOCALE_CODE),
			)
			.unique();
		return proposal?._id ?? null;
	},
});

export const read = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		const [project, snapshot, diagnostics] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(proposal.sourceSnapshotId),
			currentDiagnosticsForProposal(ctx, proposal),
		]);
		if (!snapshot || snapshot.projectId !== args.projectId) {
			integrityError(
				"Portuguese Locale Proposal references missing source evidence.",
			);
		}
		await pinnedSourceEvidenceForProposal(ctx, project, proposal);
		return proposalSummary(
			proposal,
			snapshot,
			project.baselineSnapshotId === proposal.sourceSnapshotId,
			diagnostics,
			project.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH,
		);
	},
});

export const valuesForFinalization = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		assertProposalEnvelope(proposal);
		const values = await ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
			.take(MAX_LOCALE_PROPOSAL_MESSAGES + 1);
		if (values.length > MAX_LOCALE_PROPOSAL_MESSAGES) {
			integrityError("Portuguese Locale Proposal exceeds its value envelope.");
		}
		const byteLength = values.reduce((total, value) => {
			if (value.projectId !== args.projectId) {
				integrityError("Portuguese Locale Proposal has a cross-project value.");
			}
			const expected = valueByteLength(value);
			if (value.byteLength !== expected) {
				integrityError(
					"Portuguese Locale Proposal value does not match its byte envelope.",
				);
			}
			return total + expected;
		}, 0);
		if (
			values.length !== proposal.stagedValueCount ||
			byteLength !== proposal.stagedValueByteLength
		) {
			integrityError(
				"Portuguese Locale Proposal does not match its staged values.",
			);
		}
		return { proposal, values };
	},
});

/** Read only reviewed values whose work may survive a source update. A finalized
 * proposal has already passed review as a whole; a draft contributes only
 * human-authored or explicitly reviewed values, never unreviewed agent output. */
export const valuesForCarryForward = internalQuery({
	args: {
		projectId: v.id("projects"),
		fromProposalId: v.id("localeProposals"),
		toProposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		const [project, fromProposal, toProposal] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(args.fromProposalId),
			ctx.db.get(args.toProposalId),
		]);
		if (
			!fromProposal ||
			fromProposal.projectId !== args.projectId ||
			!toProposal ||
			toProposal.projectId !== args.projectId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal continuation was not found.",
			});
		}
		if (fromProposal._id === toProposal._id) {
			validationError("The Locale Proposal is already on the current Source.");
		}
		if (
			toProposal.status !== "draft" ||
			project.baselineSnapshotId !== toProposal.sourceSnapshotId
		) {
			sourceStaleError();
		}
		assertProposalEnvelope(fromProposal);
		assertProposalEnvelope(toProposal);
		const values = await ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal", (q) => q.eq("proposalId", fromProposal._id))
			.take(MAX_LOCALE_PROPOSAL_MESSAGES + 1);
		if (values.length > MAX_LOCALE_PROPOSAL_MESSAGES) {
			integrityError("Portuguese Locale Proposal exceeds its value envelope.");
		}
		const [fromSource, source] = await Promise.all([
			pinnedSourceEvidenceForProposal(ctx, project, fromProposal),
			pinnedSourceEvidenceForProposal(ctx, project, toProposal),
		]);
		return {
			fromSource,
			source,
			values: values
				.filter(
					(
						value,
					): value is typeof value & {
						updatedBy: { kind: "user" | "agent"; id: string };
					} =>
						isHumanOrAuthorizedReview(
							value.updatedBy,
							value.reviewAuthorization,
						),
				)
				.map((value) => ({
					messageId: value.messageId,
					value: value.value,
					sourceFingerprint: value.sourceFingerprint,
					updatedBy: value.updatedBy,
					...(value.reviewAuthorization === undefined
						? {}
						: { reviewAuthorization: value.reviewAuthorization }),
					...(value.intentionalBlankReason === undefined
						? {}
						: { intentionalBlankReason: value.intentionalBlankReason }),
				})),
		};
	},
});

/** Materialize one bounded continuation slice. Existing current-source work is
 * authoritative and is never overwritten; changed or removed source values
 * become ordinary residue instead of invalidating the whole proposal. */
export const carryForwardBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		fromProposalId: v.id("localeProposals"),
		toProposalId: v.id("localeProposals"),
		items: v.array(
			v.object({
				messageId: v.string(),
				value: v.string(),
				sourceFingerprint: v.string(),
				updatedBy: actorValidator,
				reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
				intentionalBlankReason: v.optional(v.string()),
			}),
		),
	},
	handler: async (ctx, args) => {
		if (
			args.items.length === 0 ||
			args.items.length > MAX_LOCALE_PROPOSAL_CARRY_ITEMS ||
			encodedSize(args.items) > MAX_LOCALE_PROPOSAL_STAGE_BYTES
		) {
			validationError(
				"Locale Proposal continuation exceeds its bounded envelope.",
			);
		}
		const [project, fromProposal, toProposal, projection] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(args.fromProposalId),
			ctx.db.get(args.toProposalId),
			activeProjectionFor(ctx, args.projectId),
		]);
		if (
			!fromProposal ||
			fromProposal.projectId !== args.projectId ||
			!toProposal ||
			toProposal.projectId !== args.projectId
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal continuation was not found.",
			});
		}
		if (
			toProposal.status !== "draft" ||
			project.baselineSnapshotId !== toProposal.sourceSnapshotId ||
			projection?.snapshotId !== toProposal.sourceSnapshotId
		) {
			sourceStaleError();
		}
		assertProposalEnvelope(toProposal);
		let carriedValueCount = 0;
		let skippedExistingCount = 0;
		let nextCount = toProposal.stagedValueCount;
		let nextByteLength = toProposal.stagedValueByteLength;
		const seen = new Set<string>();
		for (const item of args.items) {
			if (
				!isHumanOrAuthorizedReview(item.updatedBy, item.reviewAuthorization)
			) {
				validationError(
					"Only reviewed Locale Proposal values can be carried forward.",
				);
			}
			if (seen.has(item.messageId)) {
				validationError(
					"A Locale Proposal continuation repeats a message identity.",
				);
			}
			seen.add(item.messageId);
			const existing = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", toProposal._id).eq("messageId", item.messageId),
				)
				.unique();
			if (existing) {
				skippedExistingCount += 1;
				continue;
			}
			const byteLength = valueByteLength(item);
			nextCount += 1;
			nextByteLength += byteLength;
			await ctx.db.insert("localeProposalValues", {
				projectId: args.projectId,
				proposalId: toProposal._id,
				messageId: item.messageId,
				value: item.value,
				sourceFingerprint: item.sourceFingerprint,
				...(item.intentionalBlankReason === undefined
					? {}
					: { intentionalBlankReason: item.intentionalBlankReason }),
				byteLength,
				updatedBy: item.updatedBy,
				...(item.reviewAuthorization === undefined
					? {}
					: { reviewAuthorization: item.reviewAuthorization }),
				updatedAt: now(),
			});
			carriedValueCount += 1;
		}
		if (
			nextCount > toProposal.sourceMessageCount ||
			nextByteLength > MAX_LOCALE_PROPOSAL_VALUE_TOTAL_BYTES
		) {
			validationError(
				"Portuguese Locale Proposal exceeds its complete value envelope.",
			);
		}
		if (carriedValueCount > 0) {
			await ctx.db.patch(toProposal._id, {
				stagedValueCount: nextCount,
				stagedValueByteLength: nextByteLength,
				revision: toProposal.revision + 1,
				diagnosticGeneration: toProposal.diagnosticGeneration + 1,
				diagnosticCount: 0,
				updatedAt: now(),
			});
		}
		return {
			carriedValueCount,
			skippedExistingCount,
		};
	},
});

function carryForwardBatches(
	values: CarryForwardValueInput[],
): CarryForwardValueInput[][] {
	const batches: CarryForwardValueInput[][] = [];
	let batch: CarryForwardValueInput[] = [];
	for (const value of values) {
		const candidate = [...batch, value];
		if (
			batch.length > 0 &&
			(candidate.length > MAX_LOCALE_PROPOSAL_CARRY_ITEMS ||
				encodedSize(candidate) > MAX_LOCALE_PROPOSAL_STAGE_BYTES)
		) {
			batches.push(batch);
			batch = [value];
		} else {
			batch = candidate;
		}
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/** Continue reusable human work onto the current source proposal. The process
 * is retry-safe: completed slices are detected as existing and never replaced. */
export async function carryForwardLocaleProposal(
	ctx: ActionCtx,
	args: {
		projectId: Id<"projects">;
		fromProposalId: Id<"localeProposals">;
		userId: string;
	},
): Promise<LocaleProposalCarryForwardResult> {
	const ensured: { proposalId: Id<"localeProposals"> } = await ctx.runMutation(
		internal.localeProposals.ensureForCarryForward,
		{ projectId: args.projectId, userId: args.userId },
	);
	const toProposalId = ensured.proposalId;
	if (toProposalId === args.fromProposalId) {
		throw new ConvexError({
			code: "BAD_STATE",
			message: "This Locale Proposal already uses the current Source.",
		});
	}
	const carrySource: {
		fromSource: SourceEvidence;
		source: SourceEvidence;
		values: CarryForwardValueInput[];
	} = await ctx.runQuery(internal.localeProposals.valuesForCarryForward, {
		projectId: args.projectId,
		fromProposalId: args.fromProposalId,
		toProposalId,
	});
	const [previousDocument, currentDocument] = await Promise.all([
		readSourceDocument(ctx, carrySource.fromSource),
		readSourceDocument(ctx, carrySource.source),
	]);
	const previousSourceById = new Map(
		previousDocument.messages.map((message) => [message.id, message] as const),
	);
	const previousSourceFingerprints = new Map(
		await Promise.all(
			previousDocument.messages.map(
				async (message) =>
					[message.id, await sourceFingerprint(message)] as const,
			),
		),
	);
	const currentSourceById = new Map(
		currentDocument.messages.map((message) => [message.id, message] as const),
	);
	const values = carrySource.values.filter((value) => {
		const previous = previousSourceById.get(value.messageId);
		const current = currentSourceById.get(value.messageId);
		return (
			previous !== undefined &&
			current !== undefined &&
			previousSourceFingerprints.get(value.messageId) ===
				value.sourceFingerprint &&
			sourceContractsMatch(previous, current)
		);
	});
	let carriedValueCount = 0;
	const incompatibleValueCount = carrySource.values.length - values.length;
	for (const items of carryForwardBatches(values)) {
		const result = await ctx.runMutation(
			internal.localeProposals.carryForwardBatch,
			{
				projectId: args.projectId,
				fromProposalId: args.fromProposalId,
				toProposalId,
				items,
			},
		);
		carriedValueCount += result.carriedValueCount;
	}
	const current: LocaleProposalSummary = await ctx.runQuery(
		internal.localeProposals.read,
		{
			projectId: args.projectId,
			proposalId: toProposalId,
		},
	);
	return {
		localeProposalId: toProposalId,
		carriedValueCount,
		incompatibleValueCount,
		remainingValueCount: current.progress.remaining,
		totalValueCount: current.progress.total,
	};
}

export const carryForwardForReview = action({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args): Promise<LocaleProposalCarryForwardResult> => {
		const editor: { userId: string } = await ctx.runQuery(
			internal.localeProposals.assertEditor,
			{
				projectId: args.projectId,
			},
		);
		return await carryForwardLocaleProposal(ctx, {
			projectId: args.projectId,
			fromProposalId: args.proposalId,
			userId: editor.userId,
		});
	},
});

/** Return the staged values for one bounded source-template page. Actions keep
 * this private data behind separate template and review responses. */
export const stagedValuesForTemplate = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageIds: v.array(v.string()),
	},
	handler: async (
		ctx,
		args,
	): Promise<
		Array<{
			messageId: string;
			value: string;
			sourceFingerprint: string;
			intentionalBlankReason?: string;
			byteLength: number;
		}>
	> => {
		if (args.messageIds.length > MAX_LOCALE_PROPOSAL_TEMPLATE_ITEMS) {
			validationError(
				"Portuguese proposal template page exceeds its item envelope.",
			);
		}
		const messageIds = new Set<string>();
		for (const messageId of args.messageIds) {
			if (
				messageId.length === 0 ||
				new TextEncoder().encode(messageId).byteLength >
					MAX_LOCALE_PROPOSAL_MESSAGE_ID_BYTES ||
				messageIds.has(messageId)
			) {
				validationError(
					"Portuguese proposal template page has invalid message identities.",
				);
			}
			messageIds.add(messageId);
		}
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		const staged: Array<{
			messageId: string;
			value: string;
			sourceFingerprint: string;
			intentionalBlankReason?: string;
			byteLength: number;
		}> = [];
		for (const messageId of args.messageIds) {
			const value = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", args.proposalId).eq("messageId", messageId),
				)
				.unique();
			if (!value) continue;
			if (value.projectId !== args.projectId) {
				integrityError("Portuguese Locale Proposal has a cross-project value.");
			}
			if (value.byteLength !== valueByteLength(value)) {
				integrityError(
					"Portuguese Locale Proposal value does not match its byte envelope.",
				);
			}
			staged.push({
				messageId,
				value: value.value,
				sourceFingerprint: value.sourceFingerprint,
				...(value.intentionalBlankReason === undefined
					? {}
					: { intentionalBlankReason: value.intentionalBlankReason }),
				byteLength: value.byteLength,
			});
		}
		return staged;
	},
});

export const stageBatch = internalMutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		sourceSnapshotId: v.id("sourceSnapshots"),
		actor: actorValidator,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		items: v.array(
			v.object({
				messageId: v.string(),
				value: v.string(),
				sourceFingerprint: v.string(),
				intentionalBlankReason: v.optional(v.string()),
			}),
		),
	},
	handler: async (ctx, args) => {
		if (
			args.reviewAuthorization &&
			(args.actor.kind !== "agent" ||
				!isHumanOrAuthorizedReview(args.actor, args.reviewAuthorization))
		) {
			validationError(
				"Review authorization must identify the reviewing agent.",
			);
		}
		const [project, proposal] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(args.proposalId),
		]);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		if (proposal.status !== "draft") {
			validationError("A finalized Portuguese Locale Proposal is immutable.");
		}
		if (
			proposal.sourceSnapshotId !== args.sourceSnapshotId ||
			project.baselineSnapshotId !== proposal.sourceSnapshotId
		) {
			sourceStaleError();
		}
		assertProposalEnvelope(proposal);
		if (
			args.items.length === 0 ||
			args.items.length > MAX_LOCALE_PROPOSAL_STAGE_ITEMS ||
			encodedSize(args.items) > MAX_LOCALE_PROPOSAL_STAGE_BYTES
		) {
			validationError(
				"Portuguese proposal batch exceeds its bounded envelope.",
			);
		}
		const seen = new Set<string>();
		let nextCount = proposal.stagedValueCount;
		let nextByteLength = proposal.stagedValueByteLength;
		let changed = false;
		for (const item of args.items) {
			if (seen.has(item.messageId)) {
				validationError(
					"Portuguese proposal batches cannot repeat a message identity.",
				);
			}
			seen.add(item.messageId);
			const nextValue = { ...item };
			const byteLength = valueByteLength(nextValue);
			if (byteLength > MAX_LOCALE_PROPOSAL_STAGE_BYTES) {
				validationError(
					"Portuguese proposal value exceeds its bounded envelope.",
				);
			}
			const existing = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", args.proposalId).eq("messageId", item.messageId),
				)
				.unique();
			if (existing) {
				if (existing.projectId !== args.projectId) {
					integrityError(
						"Portuguese Locale Proposal has a cross-project value.",
					);
				}
				if (
					existing.value === item.value &&
					existing.sourceFingerprint === item.sourceFingerprint &&
					existing.intentionalBlankReason === item.intentionalBlankReason
				) {
					// A translator retry does not undo review of identical content. A
					// real replacement below clears authorization and must be reviewed.
					if (
						args.actor.kind === "agent" &&
						args.reviewAuthorization === undefined &&
						isHumanOrAuthorizedReview(
							existing.updatedBy,
							existing.reviewAuthorization,
						)
					)
						continue;

					if (
						existing.updatedBy.kind !== args.actor.kind ||
						existing.updatedBy.id !== args.actor.id ||
						existing.reviewAuthorization?.candidateRevisionId !==
							args.reviewAuthorization?.candidateRevisionId
					) {
						await ctx.db.patch(existing._id, {
							updatedBy: args.actor,
							reviewAuthorization: args.reviewAuthorization,
							updatedAt: now(),
						});
						changed = true;
					}
					continue;
				}
				nextByteLength += byteLength - existing.byteLength;
				await ctx.db.patch(existing._id, {
					value: item.value,
					sourceFingerprint: item.sourceFingerprint,
					...(item.intentionalBlankReason === undefined
						? { intentionalBlankReason: undefined }
						: { intentionalBlankReason: item.intentionalBlankReason }),
					byteLength,
					updatedBy: args.actor,
					reviewAuthorization: args.reviewAuthorization,
					updatedAt: now(),
				});
				changed = true;
				continue;
			}
			nextCount += 1;
			nextByteLength += byteLength;
			await ctx.db.insert("localeProposalValues", {
				projectId: args.projectId,
				proposalId: args.proposalId,
				messageId: item.messageId,
				value: item.value,
				sourceFingerprint: item.sourceFingerprint,
				...(item.intentionalBlankReason === undefined
					? {}
					: { intentionalBlankReason: item.intentionalBlankReason }),
				byteLength,
				updatedBy: args.actor,
				reviewAuthorization: args.reviewAuthorization,
				updatedAt: now(),
			});
			changed = true;
		}
		if (
			nextCount > proposal.sourceMessageCount ||
			nextByteLength > MAX_LOCALE_PROPOSAL_VALUE_TOTAL_BYTES
		) {
			validationError(
				"Portuguese Locale Proposal exceeds its complete value envelope.",
			);
		}
		if (changed) {
			await ctx.db.patch(args.proposalId, {
				stagedValueCount: nextCount,
				stagedValueByteLength: nextByteLength,
				revision: proposal.revision + 1,
				diagnosticGeneration: proposal.diagnosticGeneration + 1,
				diagnosticCount: 0,
				updatedAt: now(),
			});
		}
		return {
			staged: nextCount,
			remaining: proposal.sourceMessageCount - nextCount,
		};
	},
});

/** Preserve a bounded diagnostic sample for the exact staged revision that
 * failed finalization. A later value edit advances the generation instead of
 * bulk-deleting historical review evidence. */
export const recordDiagnostics = internalMutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		expectedRevision: v.number(),
		count: v.number(),
		messages: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const [project, proposal] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(args.proposalId),
		]);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		assertProposalEnvelope(proposal);
		if (proposal.status !== "draft") {
			validationError("A finalized Portuguese Locale Proposal is immutable.");
		}
		if (project.baselineSnapshotId !== proposal.sourceSnapshotId)
			sourceStaleError();
		if (proposal.revision !== args.expectedRevision) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"Portuguese Locale Proposal changed while its diagnostics were recorded.",
			});
		}
		if (
			!Number.isInteger(args.count) ||
			args.count < 1 ||
			args.count > MAX_LOCALE_PROPOSAL_MESSAGES ||
			args.messages.length !==
				Math.min(args.count, MAX_LOCALE_PROPOSAL_DIAGNOSTICS)
		) {
			validationError("Portuguese proposal diagnostics exceed their envelope.");
		}
		for (const message of args.messages) {
			if (
				new TextEncoder().encode(message).byteLength >
				MAX_LOCALE_PROPOSAL_DIAGNOSTIC_BYTES
			) {
				validationError(
					"Portuguese proposal diagnostic exceeds its bounded envelope.",
				);
			}
		}
		const generation = proposal.diagnosticGeneration + 1;
		for (const message of args.messages) {
			await ctx.db.insert("localeProposalDiagnostics", {
				proposalId: args.proposalId,
				generation,
				message,
			});
		}
		await ctx.db.patch(args.proposalId, {
			diagnosticGeneration: generation,
			diagnosticCount: args.count,
			updatedAt: now(),
		});
		return null;
	},
});

export const finalize = internalMutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		sourceSnapshotId: v.id("sourceSnapshots"),
		expectedRevision: v.number(),
		artifactStorageId: v.id("_storage"),
		artifactHash: v.string(),
		artifactByteLength: v.number(),
	},
	handler: async (ctx, args): Promise<{ reused: boolean }> => {
		const [project, proposal] = await Promise.all([
			projectFor(ctx, args.projectId),
			ctx.db.get(args.proposalId),
		]);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		assertProposalEnvelope(proposal);
		if (proposal.status === "ready") {
			if (
				proposal.artifactStorageId === undefined ||
				proposal.artifactHash === undefined ||
				proposal.artifactByteLength === undefined
			) {
				integrityError(
					"A finalized Portuguese Locale Proposal is missing its artifact.",
				);
			}
			return { reused: true };
		}
		if (
			proposal.sourceSnapshotId !== args.sourceSnapshotId ||
			project.baselineSnapshotId !== proposal.sourceSnapshotId
		) {
			sourceStaleError();
		}
		if (proposal.revision !== args.expectedRevision) {
			throw new ConvexError({
				code: "CONFLICT",
				message:
					"Portuguese Locale Proposal changed while it was being finalized.",
			});
		}
		if (
			proposal.stagedValueCount !== proposal.sourceMessageCount ||
			args.artifactByteLength <= 0 ||
			args.artifactByteLength > MAX_LOCALE_PROPOSAL_ARTIFACT_BYTES
		) {
			validationError(
				"Portuguese Locale Proposal is incomplete or its artifact is invalid.",
			);
		}
		await ctx.db.patch(args.proposalId, {
			status: "ready",
			artifactStorageId: args.artifactStorageId,
			artifactHash: args.artifactHash,
			artifactByteLength: args.artifactByteLength,
			finalizedAt: now(),
			updatedAt: now(),
		});
		return { reused: false };
	},
});

export const artifactFor = internalQuery({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Portuguese Locale Proposal not found.",
			});
		}
		if (
			proposal.status !== "ready" ||
			proposal.artifactStorageId === undefined ||
			proposal.artifactHash === undefined ||
			proposal.artifactByteLength === undefined
		) {
			validationError(
				"Portuguese Locale Proposal has no finalized delivery artifact.",
			);
		}
		return {
			storageId: proposal.artifactStorageId,
			hash: proposal.artifactHash,
			byteLength: proposal.artifactByteLength,
		};
	},
});

/** Create a Portuguese proposal or return the proposal already pinned to the
 * current Baseline Snapshot. HTTP authentication happens before this module's
 * small project-scoped capability is constructed. */
export async function createOrResumeProposal(
	ctx: ActionCtx,
	actor: ProposalActor,
): Promise<LocaleProposalSummary> {
	const existingProposalId: Id<"localeProposals"> | null = await ctx.runQuery(
		internal.localeProposals.currentProposalFor,
		{ projectId: actor.projectId },
	);
	if (existingProposalId) {
		return await readProposal(ctx, actor, existingProposalId);
	}
	const source: SourceEvidence = await ctx.runQuery(
		internal.localeProposals.currentSourceFor,
		{ projectId: actor.projectId },
	);
	const document = await readSourceDocument(ctx, source);
	if (!actor.tokenId) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "An API token is required to create a Locale Proposal.",
		});
	}
	const proposalId: Id<"localeProposals"> = await ctx.runMutation(
		internal.localeProposals.begin,
		{
			projectId: actor.projectId,
			sourceSnapshotId: source.snapshotId,
			sourceSnapshotFileId: source.sourceSnapshotFileId,
			sourceCatalogPath: source.sourceCatalogPath,
			sourceStorageId: source.sourceStorageId,
			sourceMessageCount: document.messages.length,
			createdBy: { kind: "agent", id: actor.tokenId },
		},
	);
	return await readProposal(ctx, actor, proposalId);
}

export async function readProposal(
	ctx: ActionCtx | MutationCtx | QueryCtx,
	actor: ProposalActor,
	proposalId: Id<"localeProposals">,
): Promise<LocaleProposalSummary> {
	return await ctx.runQuery(internal.localeProposals.read, {
		projectId: actor.projectId,
		proposalId,
	});
}

type ProposalPage = {
	proposalId: Id<"localeProposals">;
	cursor: number;
	limit: number;
};

function assertProposalPage(args: ProposalPage): void {
	if (!Number.isInteger(args.cursor) || args.cursor < 0) {
		validationError(
			"Portuguese proposal template cursor must be a non-negative integer.",
		);
	}
	if (
		!Number.isInteger(args.limit) ||
		args.limit < 1 ||
		args.limit > MAX_LOCALE_PROPOSAL_TEMPLATE_ITEMS
	) {
		validationError(
			`Portuguese proposal pages support 1 to ${MAX_LOCALE_PROPOSAL_TEMPLATE_ITEMS} messages.`,
		);
	}
}

async function proposalSourceDocument(
	ctx: ActionCtx,
	actor: ProposalActor,
	proposalId: Id<"localeProposals">,
): Promise<{ source: SourceEvidence; document: CatalogDocument }> {
	const source: SourceEvidence = await ctx.runQuery(
		internal.localeProposals.sourceForProposal,
		{ projectId: actor.projectId, proposalId },
	);
	return { source, document: await readSourceDocument(ctx, source) };
}

export async function templateProposal(
	ctx: ActionCtx,
	actor: ProposalActor,
	args: ProposalPage,
) {
	assertProposalPage(args);
	const { source, document } = await proposalSourceDocument(
		ctx,
		actor,
		args.proposalId,
	);
	const messages: TemplateMessage[] = [];
	let byteLength = 0;
	for (const message of document.messages.slice(
		args.cursor,
		args.cursor + args.limit,
	)) {
		const item: TemplateMessage = {
			id: message.id,
			sourceValue: message.value,
			sourceFingerprint: await sourceFingerprint(message),
			staged: false,
			...(message.metadata === undefined
				? {}
				: { metadataJson: JSON.stringify(message.metadata) }),
		};
		const itemBytes = encodedSize(item);
		if (itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) {
			validationError(
				`Source message "${message.id}" exceeds the Portuguese template envelope.`,
			);
		}
		if (byteLength + itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) break;
		messages.push(item);
		byteLength += itemBytes;
	}
	const stagedValues = await ctx.runQuery(
		internal.localeProposals.stagedValuesForTemplate,
		{
			projectId: actor.projectId,
			proposalId: args.proposalId,
			messageIds: messages.map((message) => message.id),
		},
	);
	const staged = new Set(stagedValues.map((value) => value.messageId));
	const nextCursor = args.cursor + messages.length;
	return {
		proposalId: args.proposalId,
		sourceSnapshotId: source.snapshotId,
		messages: messages.map((message) => ({
			...message,
			staged: staged.has(message.id),
		})),
		isDone: nextCursor >= document.messages.length,
		continueCursor: nextCursor >= document.messages.length ? null : nextCursor,
	};
}

/** Translation Task adapter for a complete new Locale. It combines one bounded
 * Source-template page with any current staged candidate so agents can resume
 * and correct work through the same task read used for existing Locales. */
export async function taskProposalPage(
	ctx: ActionCtx,
	actor: ProposalActor,
	args: ProposalPage,
) {
	assertProposalPage(args);
	const { source, document } = await proposalSourceDocument(
		ctx,
		actor,
		args.proposalId,
	);
	const sourcePage = document.messages.slice(
		args.cursor,
		args.cursor + args.limit,
	);
	const stagedValues = await ctx.runQuery(
		internal.localeProposals.stagedValuesForTemplate,
		{
			projectId: actor.projectId,
			proposalId: args.proposalId,
			messageIds: sourcePage.map((message) => message.id),
		},
	);
	const stagedByMessageId = new Map(
		stagedValues.map((value) => [value.messageId, value] as const),
	);
	const messages = [];
	let pageBytes = 0;
	for (const message of sourcePage) {
		const staged = stagedByMessageId.get(message.id);
		const item = {
			messageId: message.id,
			sourceValue: message.value,
			sourceFingerprint: await sourceFingerprint(message),
			targetValue: staged?.value ?? "",
			staged: staged !== undefined,
			...(message.metadata === undefined
				? {}
				: { metadataJson: JSON.stringify(message.metadata) }),
		};
		const itemBytes = encodedSize(item);
		if (itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) {
			validationError(
				`Source message "${message.id}" exceeds the Portuguese task envelope.`,
			);
		}
		if (pageBytes + itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) break;
		messages.push(item);
		pageBytes += itemBytes;
	}
	const nextCursor = args.cursor + messages.length;
	return {
		proposalId: args.proposalId,
		sourceSnapshotId: source.snapshotId,
		messages,
		isDone: nextCursor >= document.messages.length,
		continueCursor: nextCursor >= document.messages.length ? null : nextCursor,
	};
}

/** Show the durable submitted values and Intentional Blank reasons through a
 * separate bounded review page, without inflating the immutable source template. */
export async function reviewProposalValues(
	ctx: ActionCtx,
	actor: ProposalActor,
	args: ProposalPage,
) {
	assertProposalPage(args);
	const { source, document } = await proposalSourceDocument(
		ctx,
		actor,
		args.proposalId,
	);
	const sourcePage = document.messages.slice(
		args.cursor,
		args.cursor + args.limit,
	);
	const stagedValues = await ctx.runQuery(
		internal.localeProposals.stagedValuesForTemplate,
		{
			projectId: actor.projectId,
			proposalId: args.proposalId,
			messageIds: sourcePage.map((message) => message.id),
		},
	);
	const valuesByMessageId = new Map(
		stagedValues.map((value) => [value.messageId, value] as const),
	);
	const values: Array<{
		messageId: string;
		value: string;
		sourceFingerprint: string;
		intentionalBlankReason?: string;
	}> = [];
	let byteLength = 0;
	let inspected = 0;
	for (const message of sourcePage) {
		const staged = valuesByMessageId.get(message.id);
		if (!staged) {
			inspected += 1;
			continue;
		}
		const item = {
			messageId: staged.messageId,
			value: staged.value,
			sourceFingerprint: staged.sourceFingerprint,
			...(staged.intentionalBlankReason === undefined
				? {}
				: { intentionalBlankReason: staged.intentionalBlankReason }),
		};
		const itemBytes = encodedSize(item);
		if (itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) {
			integrityError(
				"Portuguese proposal review value exceeds its bounded envelope.",
			);
		}
		if (byteLength + itemBytes > MAX_LOCALE_PROPOSAL_PAGE_CONTENT_BYTES) break;
		values.push(item);
		byteLength += itemBytes;
		inspected += 1;
	}
	const nextCursor = args.cursor + inspected;
	return {
		proposalId: args.proposalId,
		sourceSnapshotId: source.snapshotId,
		values,
		isDone: nextCursor >= document.messages.length,
		continueCursor: nextCursor >= document.messages.length ? null : nextCursor,
	};
}

export async function stageProposal(
	ctx: ActionCtx,
	actor: ProposalActor,
	args: { proposalId: Id<"localeProposals">; items: ProposalValueInput[] },
): Promise<LocaleProposalSummary> {
	const { source, document } = await proposalSourceDocument(
		ctx,
		actor,
		args.proposalId,
	);
	if (!source.isCurrentBaseline) sourceStaleError();
	if (!actor.tokenId) {
		throw new ConvexError({
			code: "UNAUTHORIZED",
			message: "An API token is required to stage Locale Proposal values.",
		});
	}
	const items = await assertStageItems(document, args.items);
	await ctx.runMutation(internal.localeProposals.stageBatch, {
		projectId: actor.projectId,
		proposalId: args.proposalId,
		sourceSnapshotId: source.snapshotId,
		actor: { kind: "agent", id: actor.tokenId },
		items,
	});
	return await readProposal(ctx, actor, args.proposalId);
}

/** Human editing seam for a Locale Proposal. Manual values are already human
 * authored; agent-authored values remain agent-owned until a review applies
 * them through the generic proposal module. */
export const stageForReview = mutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		items: v.array(
			v.object({
				messageId: v.string(),
				value: v.string(),
				sourceFingerprint: v.string(),
				intentionalBlankReason: v.optional(v.string()),
			}),
		),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		}
		const project = await projectFor(ctx, args.projectId);
		const source = await pinnedSourceEvidenceForProposal(
			ctx,
			project,
			proposal,
		);
		if (!source.isCurrentBaseline) sourceStaleError();
		const items = await assertProposalItemsAgainstCurrentSource(
			ctx,
			args.projectId,
			proposal,
			args.items,
		);
		await ctx.runMutation(internal.localeProposals.stageBatch, {
			projectId: args.projectId,
			proposalId: args.proposalId,
			sourceSnapshotId: source.snapshotId,
			actor: { kind: "user", id: userId },
			items,
		});
		return await readProposal(
			ctx,
			{ projectId: args.projectId },
			args.proposalId,
		);
	},
});

/** Persist a reviewed Translation Task value through the private Locale
 * Proposal adapter. The Translation Task module owns its immutable review
 * evidence; this helper only validates and stages the human-authored value. */
export async function applyTaskReviewedValue(
	ctx: MutationCtx,
	input: {
		projectId: Id<"projects">;
		proposalId: Id<"localeProposals">;
		messageId: string;
		sourceSnapshotId: Id<"sourceSnapshots">;
		sourceFingerprint: string;
		value: string;
		reviewer: { kind: "user"; id: string };
	},
) {
	const proposal = await ctx.db.get(input.proposalId);
	if (!proposal || proposal.projectId !== input.projectId) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Locale Proposal not found.",
		});
	}
	const project = await projectFor(ctx, input.projectId);
	const source = await pinnedSourceEvidenceForProposal(ctx, project, proposal);
	if (
		!source.isCurrentBaseline ||
		source.snapshotId !== input.sourceSnapshotId
	) {
		sourceStaleError();
	}
	const sourceMessage = await currentSourceRowForProposal(
		ctx,
		input.projectId,
		proposal,
		input.messageId,
	);
	if (sourceMessage.sourceFingerprint !== input.sourceFingerprint) {
		throw new ConvexError({
			code: "STALE_BASIS",
			message: "The Locale Proposal source contract changed; refresh it.",
		});
	}
	const validated = await assertProposalItemsAgainstCurrentSource(
		ctx,
		input.projectId,
		proposal,
		[
			{
				messageId: input.messageId,
				value: input.value,
				sourceFingerprint: input.sourceFingerprint,
			},
		],
	);
	await ctx.runMutation(internal.localeProposals.stageBatch, {
		projectId: input.projectId,
		proposalId: input.proposalId,
		sourceSnapshotId: source.snapshotId,
		actor: input.reviewer,
		items: validated,
	});
}

/** Apply one authorized review to a Locale Proposal value. Human and independent
 * agent reviews share validation while retaining their actual actor and authority. */
export const applyReviewedValue = internalMutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageId: v.string(),
		sourceSnapshotId: v.id("sourceSnapshots"),
		sourceFingerprint: v.string(),
		candidateValueFingerprint: v.string(),
		acceptedValue: v.optional(v.string()),
		decision: v.union(
			v.object({ kind: v.literal("accept") }),
			v.object({ kind: v.literal("acceptWithEdits"), value: v.string() }),
			v.object({ kind: v.literal("reject"), reason: v.optional(v.string()) }),
			v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
		),
		reviewer: actorValidator,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
	},
	handler: async (ctx, args) => {
		if (!isHumanOrAuthorizedReview(args.reviewer, args.reviewAuthorization)) {
			validationError(
				"A Locale Proposal review requires a human or an authorized reviewer.",
			);
		}
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		}
		const project = await projectFor(ctx, args.projectId);
		const source = await pinnedSourceEvidenceForProposal(
			ctx,
			project,
			proposal,
		);
		if (
			!source.isCurrentBaseline ||
			source.snapshotId !== args.sourceSnapshotId
		) {
			sourceStaleError();
		}
		const sourceMessage = await currentSourceRowForProposal(
			ctx,
			args.projectId,
			proposal,
			args.messageId,
		);
		if (sourceMessage.sourceFingerprint !== args.sourceFingerprint) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message: "The Locale Proposal source contract changed; refresh it.",
			});
		}
		let finalValue: string | undefined;
		let finalValueFingerprint: string | undefined;
		if (args.decision.kind !== "reject") {
			const value =
				args.decision.kind === "accept"
					? undefined
					: args.decision.kind === "acceptWithEdits"
						? args.decision.value
						: "";
			const intentionalBlankReason =
				args.decision.kind === "intentionalBlank"
					? args.decision.reason
					: undefined;
			const currentValue = await ctx.db
				.query("localeProposalValues")
				.withIndex("by_proposal_and_messageId", (q) =>
					q.eq("proposalId", args.proposalId).eq("messageId", args.messageId),
				)
				.unique();
			const resolvedValue = value ?? args.acceptedValue ?? currentValue?.value;
			if (resolvedValue === undefined) {
				throw new ConvexError({
					code: "NOT_FOUND",
					message: "There is no submitted Locale Proposal value to accept.",
				});
			}
			const staged: ProposalValueInput = {
				messageId: args.messageId,
				value: resolvedValue,
				sourceFingerprint: args.sourceFingerprint,
				...(intentionalBlankReason === undefined
					? {}
					: { intentionalBlankReason }),
			};
			const validated = await assertProposalItemsAgainstCurrentSource(
				ctx,
				args.projectId,
				proposal,
				[staged],
			);
			await ctx.runMutation(internal.localeProposals.stageBatch, {
				projectId: args.projectId,
				proposalId: args.proposalId,
				sourceSnapshotId: source.snapshotId,
				actor: args.reviewer,
				...(args.reviewAuthorization === undefined
					? {}
					: { reviewAuthorization: args.reviewAuthorization }),
				items: validated,
			});
			finalValue = resolvedValue;
			finalValueFingerprint = await sha256Hex(resolvedValue);
		}
		const reviewId = await ctx.db.insert("localeProposalValueReviews", {
			projectId: args.projectId,
			proposalId: args.proposalId,
			messageId: args.messageId,
			valueFingerprint: args.candidateValueFingerprint,
			decision: args.decision,
			reviewer: args.reviewer,
			...(args.reviewAuthorization === undefined
				? {}
				: { reviewAuthorization: args.reviewAuthorization }),
			...(finalValue === undefined ? {} : { finalValue }),
			...(finalValueFingerprint === undefined ? {} : { finalValueFingerprint }),
			createdAt: now(),
		});
		return await ctx.db.get(reviewId);
	},
});

export const reviewStagedValue = mutation({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageId: v.string(),
		expectedValueFingerprint: v.optional(v.string()),
		decision: v.union(
			v.object({ kind: v.literal("accept") }),
			v.object({ kind: v.literal("acceptWithEdits"), value: v.string() }),
			v.object({ kind: v.literal("reject"), reason: v.optional(v.string()) }),
			v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
		),
	},
	handler: async (ctx, args): Promise<unknown> => {
		const { userId } = await requireEditor(ctx, args.projectId);
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal || proposal.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Locale Proposal not found.",
			});
		}
		const value = await ctx.db
			.query("localeProposalValues")
			.withIndex("by_proposal_and_messageId", (q) =>
				q.eq("proposalId", args.proposalId).eq("messageId", args.messageId),
			)
			.unique();
		if (!value || value.projectId !== args.projectId) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Submitted Locale Proposal value not found.",
			});
		}
		const valueFingerprint = await sha256Hex(value.value);
		if (
			args.expectedValueFingerprint !== undefined &&
			args.expectedValueFingerprint !== valueFingerprint
		) {
			throw new ConvexError({
				code: "STALE_BASIS",
				message:
					"The Locale Proposal value changed; review its current revision before deciding.",
			});
		}
		return await ctx.runMutation(internal.localeProposals.applyReviewedValue, {
			projectId: args.projectId,
			proposalId: args.proposalId,
			messageId: args.messageId,
			sourceSnapshotId: proposal.sourceSnapshotId,
			sourceFingerprint: value.sourceFingerprint,
			candidateValueFingerprint: valueFingerprint,
			decision: args.decision,
			reviewer: { kind: "user", id: userId },
		});
	},
});

export const getForReview = query({
	args: {
		proposalId: v.id("localeProposals"),
		taskId: v.optional(v.id("agentTranslationProposals")),
		cursor: v.optional(v.number()),
		pendingCursor: v.optional(v.string()),
		limit: v.optional(v.number()),
		focus: v.optional(localeProposalReviewFocusValidator),
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const proposal = await ctx.db.get(args.proposalId);
		if (!proposal) return null;
		await requireViewer(ctx, proposal.projectId);
		const project = await projectFor(ctx, proposal.projectId);
		const task = args.taskId ? await ctx.db.get(args.taskId) : null;
		if (
			args.taskId &&
			(!task ||
				task.projectId !== proposal.projectId ||
				task.target.kind !== "localeProposal" ||
				task.target.localeProposalId !== proposal._id ||
				task.localeProposalTaskScope?.localeProposalId !== proposal._id)
		) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "New-Locale Translation Task not found.",
			});
		}
		const taskSummary = task
			? {
					taskId: task._id,
					status: task.status,
					candidateCount: task.candidateCount,
					revisionCount: task.revisionCount,
					targetCount:
						task.localeProposalTaskScope?.targetCount ??
						proposal.sourceMessageCount,
				}
			: null;
		const source = await pinnedSourceEvidenceForProposal(
			ctx,
			project,
			proposal,
		);
		const activeProjection = await activeProjectionFor(ctx, proposal.projectId);
		if (proposal.sourceMessageCount > MAX_LOCALE_PROPOSAL_MESSAGES) {
			integrityError("Locale Proposal exceeds its source message envelope.");
		}
		const snapshot = await ctx.db.get(proposal.sourceSnapshotId);
		if (!snapshot || snapshot.projectId !== proposal.projectId) {
			integrityError("Locale Proposal source snapshot evidence is missing.");
		}
		const diagnostics = await currentDiagnosticsForProposal(ctx, proposal);
		const cursor = Math.max(0, Math.trunc(args.cursor ?? 0));
		const limit = Math.min(
			MAX_LOCALE_PROPOSAL_REVIEW_ITEMS,
			Math.max(1, Math.trunc(args.limit ?? MAX_LOCALE_PROPOSAL_REVIEW_ITEMS)),
		);
		const focus: LocaleProposalReviewFocus = args.focus ?? "all";
		const search = args.search?.trim().toLocaleLowerCase() ?? "";
		if (new TextEncoder().encode(search).byteLength > 512) {
			validationError("Locale Proposal review search is too long.");
		}
		if (
			args.pendingCursor !== undefined &&
			new TextEncoder().encode(args.pendingCursor).byteLength >
				MAX_LOCALE_PROPOSAL_MESSAGE_ID_BYTES
		) {
			validationError("Locale Proposal review cursor is invalid.");
		}
		if (
			(!activeProjection ||
				activeProjection.snapshotId !== proposal.sourceSnapshotId) &&
			source.isCurrentBaseline
		) {
			integrityError(
				"The active Catalog Workspace does not match the current Baseline Snapshot.",
			);
		}
		const projection =
			activeProjection?.snapshotId === proposal.sourceSnapshotId
				? activeProjection
				: await ctx.db
						.query("catalogProjections")
						.withIndex("by_project_and_snapshot_and_status", (q) =>
							q
								.eq("projectId", proposal.projectId)
								.eq("snapshotId", proposal.sourceSnapshotId)
								.eq("status", "published"),
						)
						.unique();
		if (!projection) {
			return {
				proposal: proposalSummary(
					proposal,
					snapshot,
					false,
					diagnostics,
					source.integrationBranch,
				),
				locale: {
					code: proposal.localeCode,
					runtimeLocale: proposal.runtimeLocale,
				},
				task: taskSummary,
				messages: [],
				cursor,
				windowEnd: cursor,
				continueCursor: null,
				pendingQueueContinueCursor: null,
				isDone: true,
				pendingReview: { count: 0, hasMore: false },
				diagnostics,
				isCurrentBaseline: source.isCurrentBaseline,
			};
		}
		const pendingAgentValueSummaryWindow =
			proposal.status === "draft"
				? await ctx.db
						.query("localeProposalValues")
						.withIndex(
							"by_proposal_and_author_and_reviewer_and_messageId",
							(q) =>
								q
									.eq("proposalId", proposal._id)
									.eq("updatedBy.kind", "agent")
									.eq("reviewAuthorization.reviewerTokenId", undefined),
						)
						.take(limit + 1)
				: [];
		const requestedPendingAgentValueWindow =
			proposal.status === "draft" && args.pendingCursor !== undefined
				? await ctx.db
						.query("localeProposalValues")
						.withIndex(
							"by_proposal_and_author_and_reviewer_and_messageId",
							(q) =>
								q
									.eq("proposalId", proposal._id)
									.eq("updatedBy.kind", "agent")
									.eq("reviewAuthorization.reviewerTokenId", undefined)
									.gt("messageId", args.pendingCursor as string),
						)
						.take(limit + 1)
				: pendingAgentValueSummaryWindow;
		// A queue cursor may become empty as live review decisions remove values.
		// Wrap to the first remaining item so deferred work never becomes stranded.
		const pendingAgentValueWindow =
			requestedPendingAgentValueWindow.length === 0 &&
			pendingAgentValueSummaryWindow.length > 0
				? pendingAgentValueSummaryWindow
				: requestedPendingAgentValueWindow;
		const pendingAgentValues = pendingAgentValueWindow.slice(0, limit);
		const pendingReview = {
			count: Math.min(limit, pendingAgentValueSummaryWindow.length),
			hasMore: pendingAgentValueSummaryWindow.length > limit,
		};
		const pendingQueueContinueCursor =
			pendingAgentValueWindow.length > limit
				? (pendingAgentValues[pendingAgentValues.length - 1]?.messageId ?? null)
				: null;
		// Values submitted through the earlier Locale Proposal API are still valid
		// review work after a Translation Task takes over. Surface them directly
		// instead of walking the whole source Catalog to rediscover them.
		const usePendingReviewQueue =
			task !== null &&
			focus === "awaiting" &&
			search.length === 0 &&
			pendingAgentValues.length > 0;
		const completedReviewQueue =
			task !== null &&
			focus === "awaiting" &&
			search.length === 0 &&
			proposal.stagedValueCount === proposal.sourceMessageCount &&
			pendingAgentValueSummaryWindow.length === 0;
		const scanLimit =
			focus === "all" && search.length === 0
				? limit
				: MAX_LOCALE_PROPOSAL_REVIEW_SCAN_ITEMS;
		const pendingValuesByMessageId = new Map(
			pendingAgentValues.map((value) => [value.messageId, value] as const),
		);
		const queuedSourceMessages = usePendingReviewQueue
			? await Promise.all(
					pendingAgentValues.map(async (value) => {
						const message = await ctx.db
							.query("catalogProjectionMessages")
							.withIndex("by_projection_and_messageId_and_isSource", (q) =>
								q
									.eq("projectionId", projection._id)
									.eq("messageId", value.messageId)
									.eq("isSource", true),
							)
							.unique();
						if (!message) {
							integrityError(
								`Locale Proposal value "${value.messageId}" has no pinned Source.`,
							);
						}
						return message;
					}),
				)
			: [];
		queuedSourceMessages.sort((left, right) =>
			left.catalogIndex === right.catalogIndex
				? left.messageId.localeCompare(right.messageId)
				: left.catalogIndex - right.catalogIndex,
		);
		const sourceWindow =
			usePendingReviewQueue || completedReviewQueue
				? queuedSourceMessages
				: await ctx.db
						.query("catalogProjectionMessages")
						.withIndex("by_projection_and_isSource_and_catalogIndex", (q) =>
							q
								.eq("projectionId", projection._id)
								.eq("isSource", true)
								.gte("catalogIndex", cursor),
						)
						.take(scanLimit + 1);
		const sourcePage = usePendingReviewQueue
			? sourceWindow
			: sourceWindow.slice(0, scanLimit);
		const hydratedMessages = await Promise.all(
			sourcePage.map(async (message) => {
				const candidate = task
					? await ctx.db
							.query("agentTranslationCandidates")
							.withIndex(
								"by_proposal_and_messageId_and_localeProposalId",
								(q) =>
									q
										.eq("proposalId", task._id)
										.eq("messageId", message.messageId)
										.eq("localeProposalId", proposal._id),
							)
							.unique()
					: null;
				const candidateRevision = candidate?.latestRevisionId
					? await ctx.db.get(candidate.latestRevisionId)
					: null;
				const candidateReview = candidateRevision
					? await ctx.db
							.query("agentTranslationCandidateReviews")
							.withIndex("by_revision", (q) =>
								q.eq("revisionId", candidateRevision._id),
							)
							.order("desc")
							.first()
					: null;
				const value =
					pendingValuesByMessageId.get(message.messageId) ??
					(await ctx.db
						.query("localeProposalValues")
						.withIndex("by_proposal_and_messageId", (q) =>
							q
								.eq("proposalId", proposal._id)
								.eq("messageId", message.messageId),
						)
						.unique());
				const fingerprint = message.sourceFingerprint;
				const valueFingerprint = value
					? await sha256Hex(value.value)
					: undefined;
				const storedReview = value
					? await ctx.db
							.query("localeProposalValueReviews")
							.withIndex(
								"by_proposal_and_messageId_and_valueFingerprint",
								(q) =>
									q
										.eq("proposalId", proposal._id)
										.eq("messageId", message.messageId)
										.eq("valueFingerprint", valueFingerprint as string),
							)
							.order("desc")
							.first()
					: null;
				const review =
					storedReview &&
					(storedReview.decision.kind === "reject" ||
						(value &&
							isHumanOrAuthorizedReview(
								value.updatedBy,
								value.reviewAuthorization,
							)))
						? storedReview
						: null;
				const candidateValue = candidateRevision
					? candidateRevision.value
					: value?.updatedBy.kind === "agent"
						? value.value
						: undefined;
				const resolvedReview = candidateRevision ? candidateReview : review;
				// A carried value retains its authorization even though its review lives
				// on the earlier proposal. It cannot approve a different new candidate.
				const authorizedValueReview =
					value?.reviewAuthorization !== undefined &&
					isHumanOrAuthorizedReview(
						value.updatedBy,
						value.reviewAuthorization,
					) &&
					(!candidateRevision ||
						value.reviewAuthorization.candidateRevisionId ===
							candidateRevision._id);
				const state: LocaleProposalReviewFacts["state"] =
					candidateValue !== undefined
						? resolvedReview?.decision.kind === "reject"
							? value?.updatedBy.kind === "user"
								? "reviewedDraft"
								: "needsEdit"
							: resolvedReview || authorizedValueReview
								? "reviewed"
								: "awaiting"
						: value
							? "reviewedDraft"
							: "missing";
				const leadingWhitespace = (text: string) =>
					text.match(/^\s*/u)?.[0] ?? "";
				const trailingWhitespace = (text: string) =>
					text.match(/\s*$/u)?.[0] ?? "";
				const facts: LocaleProposalReviewFacts = {
					state,
					sourceIdentical:
						candidateValue !== undefined &&
						candidateValue.length > 0 &&
						candidateValue === message.value,
					sourceEmpty: message.value.length === 0,
					blankCandidate: candidateValue === "",
					icu: message.icuType === "icu",
					edgeWhitespaceMismatch:
						candidateValue !== undefined &&
						(leadingWhitespace(candidateValue) !==
							leadingWhitespace(message.value) ||
							trailingWhitespace(candidateValue) !==
								trailingWhitespace(message.value)),
					staleSource:
						candidateRevision?.basis.sourceFingerprint !== undefined
							? candidateRevision.basis.sourceFingerprint !== fingerprint
							: value !== null && value.sourceFingerprint !== fingerprint,
				};
				const reviewBasisIsCurrent =
					candidateReview?.appliedBasis?.kind === "localeProposal" &&
					candidateReview.appliedBasis.localeProposalId === proposal._id &&
					candidateReview.appliedBasis.snapshotId === source.snapshotId &&
					candidateReview.appliedBasis.sourceFingerprint === fingerprint;
				return {
					messageId: message.messageId,
					catalogIndex: message.catalogIndex,
					sourceValue: message.value,
					sourceFingerprint: fingerprint,
					sourceIcuType: message.icuType,
					facts,
					value: value
						? {
								value: value.value,
								reviewToken: valueFingerprint as string,
								sourceFingerprint: value.sourceFingerprint,
								updatedBy: value.updatedBy,
								reviewAuthorization: value.reviewAuthorization,
								intentionalBlankReason: value.intentionalBlankReason,
							}
						: null,
					review: review
						? {
								_id: review._id,
								decision: review.decision,
								finalValue: review.finalValue,
								reviewer: review.reviewer,
								reviewAuthorization: review.reviewAuthorization,
							}
						: null,
					candidate: candidateRevision
						? {
								revisionId: candidateRevision._id,
								revision: candidateRevision.revision,
								value: candidateRevision.value,
								intentionalBlankReason:
									candidateRevision.intentionalBlankReason,
								review: candidateReview
									? {
											decision: candidateReview.decision,
											reviewer: candidateReview.reviewer,
											reviewAuthorization: candidateReview.reviewAuthorization,
											finalValue: candidateReview.finalValue,
											reviewBasisIsCurrent,
										}
									: null,
							}
						: null,
				};
			}),
		);
		const messages: typeof hydratedMessages = [];
		let scannedCount = 0;
		for (const message of hydratedMessages) {
			scannedCount += 1;
			const needsAttention =
				message.facts.state === "needsEdit" ||
				message.facts.sourceIdentical ||
				message.facts.sourceEmpty ||
				message.facts.blankCandidate ||
				message.facts.icu ||
				message.facts.edgeWhitespaceMismatch ||
				message.facts.staleSource;
			const focusMatches =
				focus === "all" ||
				(focus === "awaiting" &&
					(message.facts.state === "awaiting" ||
						message.facts.state === "needsEdit")) ||
				(focus === "attention" &&
					(message.facts.state === "awaiting" ||
						message.facts.state === "needsEdit") &&
					needsAttention) ||
				(focus === "routine" &&
					message.facts.state === "awaiting" &&
					!needsAttention) ||
				(focus === "reviewed" && message.facts.state === "reviewed") ||
				(focus === "missing" && message.facts.state === "missing");
			const searchMatches =
				search.length === 0 ||
				message.messageId.toLocaleLowerCase().includes(search) ||
				message.sourceValue.toLocaleLowerCase().includes(search) ||
				message.candidate?.value.toLocaleLowerCase().includes(search) ||
				message.value?.value.toLocaleLowerCase().includes(search);
			if (focusMatches && searchMatches) messages.push(message);
			if (messages.length >= limit) break;
		}
		const lastScanned = sourcePage[scannedCount - 1];
		const hasMore = usePendingReviewQueue
			? pendingQueueContinueCursor !== null
			: !completedReviewQueue &&
				lastScanned !== undefined &&
				(scannedCount < sourcePage.length || sourceWindow.length > scanLimit);
		return {
			proposal: proposalSummary(
				proposal,
				snapshot,
				source.isCurrentBaseline,
				diagnostics,
				source.integrationBranch,
			),
			locale: {
				code: proposal.localeCode,
				runtimeLocale: proposal.runtimeLocale,
			},
			task: taskSummary,
			messages,
			cursor,
			windowEnd: lastScanned?.catalogIndex ?? cursor,
			continueCursor:
				!usePendingReviewQueue && hasMore ? lastScanned.catalogIndex + 1 : null,
			pendingQueueContinueCursor,
			isDone: !hasMore,
			pendingReview,
			diagnostics,
			isCurrentBaseline: source.isCurrentBaseline,
		};
	},
});

export const finalizeForReview = action({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		await ctx.runQuery(internal.localeProposals.assertEditor, {
			projectId: args.projectId,
		});
		return await finalizeProposal(
			ctx,
			{ projectId: args.projectId },
			args.proposalId,
		);
	},
});

export const artifactForReview = action({
	args: {
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
	},
	handler: async (ctx, args) => {
		await ctx.runQuery(internal.localeProposals.assertEditor, {
			projectId: args.projectId,
		});
		return await readProposalArtifact(
			ctx,
			{ projectId: args.projectId },
			args.proposalId,
		);
	},
});

async function validationDiagnostics(
	document: CatalogDocument,
	values: readonly Doc<"localeProposalValues">[],
): Promise<{ count: number; messages: string[] }> {
	const valuesByMessageId = new Map(
		values.map((value) => [value.messageId, value] as const),
	);
	const messages: string[] = [];
	let count = 0;
	const add = (message: string) => {
		count += 1;
		if (messages.length < MAX_LOCALE_PROPOSAL_DIAGNOSTICS) {
			messages.push(boundedDiagnostic(message));
		}
	};
	for (const source of document.messages) {
		const value = valuesByMessageId.get(source.id);
		if (!value) {
			add(`Missing Portuguese value for "${source.id}".`);
			continue;
		}
		valuesByMessageId.delete(source.id);
		if (value.sourceFingerprint !== (await sourceFingerprint(source))) {
			add(
				`Portuguese value "${source.id}" answers an outdated Source Contract.`,
			);
			continue;
		}
		if (value.value.length === 0) {
			if (!value.intentionalBlankReason?.trim()) {
				add(
					`Portuguese value "${source.id}" is empty without an Intentional Blank reason.`,
				);
			}
			continue;
		}
		try {
			assertTargetValueContract({
				messageId: source.id,
				localeCode: PORTUGUESE_LOCALE_CODE,
				value: value.value,
				source: sourceContract(source),
			});
		} catch (error) {
			add(error instanceof Error ? error.message : String(error));
		}
	}
	for (const messageId of valuesByMessageId.keys()) {
		add(
			`Portuguese value "${messageId}" is not in the pinned Source Snapshot.`,
		);
	}
	return { count, messages };
}

function derivePortugueseDocument(
	source: CatalogDocument,
	values: ReadonlyMap<string, Doc<"localeProposalValues">>,
): CatalogDocument {
	return {
		globals: source.globals.map((global) =>
			global.name === "@@locale"
				? { ...global, value: PORTUGUESE_LOCALE_CODE }
				: { ...global },
		),
		messages: source.messages.map((message) => {
			const value = values.get(message.id);
			if (!value)
				integrityError(`Portuguese value "${message.id}" is missing.`);
			return { ...message, value: value.value };
		}),
		memberOrder: [...source.memberOrder],
	};
}

export async function finalizeProposal(
	ctx: ActionCtx,
	actor: ProposalActor,
	proposalId: Id<"localeProposals">,
): Promise<LocaleProposalSummary> {
	const staged: {
		proposal: Doc<"localeProposals">;
		values: Doc<"localeProposalValues">[];
	} = await ctx.runQuery(internal.localeProposals.valuesForFinalization, {
		projectId: actor.projectId,
		proposalId,
	});
	if (staged.proposal.status === "ready") {
		return await readProposal(ctx, actor, proposalId);
	}
	const { source, document } = await proposalSourceDocument(
		ctx,
		actor,
		proposalId,
	);
	if (!source.isCurrentBaseline) sourceStaleError();
	if (document.messages.length !== staged.proposal.sourceMessageCount) {
		integrityError(
			"Portuguese Locale Proposal does not match its source message envelope.",
		);
	}
	const awaitingHumanReview = staged.values.filter(
		(value) =>
			!isHumanOrAuthorizedReview(value.updatedBy, value.reviewAuthorization),
	);
	if (awaitingHumanReview.length > 0) {
		const messages = awaitingHumanReview
			.slice(0, MAX_LOCALE_PROPOSAL_DIAGNOSTICS)
			.map((value) => `Value "${value.messageId}" is awaiting review.`);
		await ctx.runMutation(internal.localeProposals.recordDiagnostics, {
			projectId: actor.projectId,
			proposalId,
			expectedRevision: staged.proposal.revision,
			count: awaitingHumanReview.length,
			messages,
		});
		throw new ConvexError({
			code: "REVIEW_REQUIRED",
			message:
				"Every agent-submitted Portuguese value needs human or authorized independent-agent review.",
			diagnosticCount: awaitingHumanReview.length,
			diagnostics: messages,
		});
	}
	const diagnostics = await validationDiagnostics(document, staged.values);
	if (diagnostics.count > 0) {
		await ctx.runMutation(internal.localeProposals.recordDiagnostics, {
			projectId: actor.projectId,
			proposalId,
			expectedRevision: staged.proposal.revision,
			count: diagnostics.count,
			messages: diagnostics.messages,
		});
		throw new ConvexError({
			code: "VALIDATION",
			message: `Portuguese Locale Proposal cannot finalize: ${diagnostics.messages[0] ?? "its staged values are invalid."}`,
			diagnosticCount: diagnostics.count,
			diagnostics: diagnostics.messages,
		});
	}
	const catalogContent = serialize(
		derivePortugueseDocument(
			document,
			new Map(staged.values.map((value) => [value.messageId, value] as const)),
		),
	);
	const contentHash = await sha256Hex(catalogContent);
	const artifact: LocaleProposalArtifact = {
		version: 1,
		proposalId,
		sourceSnapshot: {
			id: source.snapshotId,
			repository: source.repository,
			integrationBranch: source.integrationBranch,
			commit: source.commit,
			manifestHash: source.manifestHash,
			catalogPath: source.sourceCatalogPath,
		},
		locale: {
			code: PORTUGUESE_LOCALE_CODE,
			label: PORTUGUESE_LOCALE_LABEL,
			runtimeLocale: PORTUGUESE_RUNTIME_LOCALE,
		},
		catalog: {
			fileName: PORTUGUESE_CATALOG_FILE_NAME,
			content: catalogContent,
			contentHash,
		},
	};
	const artifactText = JSON.stringify(artifact);
	const artifactByteLength = new TextEncoder().encode(artifactText).byteLength;
	if (artifactByteLength > MAX_LOCALE_PROPOSAL_ARTIFACT_BYTES) {
		validationError(
			"Portuguese delivery artifact exceeds its bounded envelope.",
		);
	}
	const artifactHash = await sha256Hex(artifactText);
	let storageId: Id<"_storage"> | undefined;
	try {
		storageId = await ctx.storage.store(
			new Blob([artifactText], { type: "application/json" }),
		);
		const result: { reused: boolean } = await ctx.runMutation(
			internal.localeProposals.finalize,
			{
				projectId: actor.projectId,
				proposalId,
				sourceSnapshotId: source.snapshotId,
				expectedRevision: staged.proposal.revision,
				artifactStorageId: storageId,
				artifactHash,
				artifactByteLength,
			},
		);
		if (result.reused) {
			await ctx.storage.delete(storageId);
			storageId = undefined;
		}
		return await readProposal(ctx, actor, proposalId);
	} catch (error) {
		if (storageId) await ctx.storage.delete(storageId);
		throw error;
	}
}

export async function readProposalArtifact(
	ctx: ActionCtx,
	actor: ProposalActor,
	proposalId: Id<"localeProposals">,
): Promise<LocaleProposalArtifact> {
	const source: SourceEvidence = await ctx.runQuery(
		internal.localeProposals.sourceForProposal,
		{ projectId: actor.projectId, proposalId },
	);
	const artifact: {
		storageId: Id<"_storage">;
		hash: string;
		byteLength: number;
	} = await ctx.runQuery(internal.localeProposals.artifactFor, {
		projectId: actor.projectId,
		proposalId,
	});
	if (artifact.byteLength > MAX_LOCALE_PROPOSAL_ARTIFACT_BYTES) {
		integrityError(
			"Portuguese delivery artifact exceeds its bounded envelope.",
		);
	}
	const blob = await ctx.storage.get(artifact.storageId);
	if (!blob) {
		throw new ConvexError({
			code: "NOT_FOUND",
			message: "Portuguese delivery artifact is missing.",
		});
	}
	const text = await blob.text();
	if (new TextEncoder().encode(text).byteLength !== artifact.byteLength) {
		integrityError(
			"Portuguese delivery artifact does not match its byte envelope.",
		);
	}
	if ((await sha256Hex(text)) !== artifact.hash) {
		integrityError("Portuguese delivery artifact does not match its hash.");
	}
	const parsed = parseArtifact(text, proposalId);
	if (
		(await sha256Hex(parsed.catalog.content)) !== parsed.catalog.contentHash
	) {
		integrityError("Portuguese catalog does not match its artifact hash.");
	}
	if (
		parsed.sourceSnapshot.id !== source.snapshotId ||
		parsed.sourceSnapshot.repository !== source.repository ||
		parsed.sourceSnapshot.integrationBranch !== source.integrationBranch ||
		parsed.sourceSnapshot.commit !== source.commit ||
		parsed.sourceSnapshot.manifestHash !== source.manifestHash ||
		parsed.sourceSnapshot.catalogPath !== source.sourceCatalogPath
	) {
		integrityError(
			"Portuguese delivery artifact does not match its pinned Source Snapshot.",
		);
	}
	return parsed;
}
