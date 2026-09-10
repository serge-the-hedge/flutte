import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, httpAction } from "./_generated/server";
import type { TranslationWorkReason } from "./agentRetrieval";

import { authComponent, createAuth, getTrustedOrigins } from "./auth";
import { resend } from "./emails";
import { sha256Hex, type TokenScope } from "./lib";
import {
	createOrResumeProposal,
	finalizeProposal,
	type ProposalActor,
	readProposal,
	readProposalArtifact,
	reviewProposalValues,
	stageProposal,
	taskProposalPage,
	templateProposal,
} from "./localeProposals";

import {
	applyStoredReleaseTree,
	downloadReleaseFile,
	finalizeReleaseUpload,
	storedReleaseBundle,
} from "./releaseUploadDelivery";
import { finalizeUpload, uploadFile } from "./snapshotUploads";

function searchChoice<T extends string>(
	params: URLSearchParams,
	name: string,
	choices: readonly T[],
): T | undefined {
	const raw = params.get(name);
	if (raw === null) return undefined;
	const value = choices.find((choice) => choice === raw);
	if (value === undefined)
		throw new ConvexError({
			code: "VALIDATION",
			message: `Invalid ${name} search option.`,
		});
	return value;
}

const http = httpRouter();
const internalApi = internal;

type AgentScope = TokenScope;
type AgentRateLimitName =
	| "agentDictionaryWrite"
	| "agentLanguagesWrite"
	| "agentRead"
	| "agentReview"
	| "agentSearch"
	| "agentLocaleProposal"
	| "agentTranslationProposal";
type RepositoryAdapterRateLimitName =
	| "repositorySnapshotContext"
	| "repositorySnapshotSubmit"
	| "repositorySnapshotUpload"
	| "repositoryReleaseDelivery";

const MAX_SNAPSHOT_FILES = 1_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// One new-Locale row may contain both a near-envelope Source/metadata item and
// a maximum-size immutable candidate. The page loop still stops before this
// bound, but the bound must always admit one valid row or its cursor deadlocks.
const MAX_TRANSLATION_TASK_PAGE_BYTES = 1024 * 1024;

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Authorization, X-Blabla-CLI-Version, X-Blabla-CLI-Protocol",
	"Access-Control-Expose-Headers":
		"X-Blabla-Minimum-CLI-Version, X-Blabla-Minimum-CLI-Protocol, Retry-After",
};

function json(
	data: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...corsHeaders,
			...extraHeaders,
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function translationWorkReasons(
	values: readonly string[],
): TranslationWorkReason[] | undefined {
	if (values.length === 0) return undefined;
	return values.map((value) => {
		if (
			value === "missing" ||
			value === "sourceIdentical" ||
			value === "sameKeyRepeat" ||
			value === "stale"
		) {
			return value;
		}
		throw new Error(
			"reason must be missing, sourceIdentical, sameKeyRepeat, or stale.",
		);
	});
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
	const body: unknown = await request.json();
	if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
	return body;
}

function jsonString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string") throw new Error(`${field} must be a string.`);
	return value;
}

function requiredJsonString(
	body: Record<string, unknown>,
	field: string,
): string {
	const value = jsonString(body, field);
	if (value.length === 0) throw new Error(`Missing ${field}.`);
	return value;
}

function optionalJsonArray(
	body: Record<string, unknown>,
	field: string,
): unknown[] {
	const value = body[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
	return value;
}

function translationTaskCandidateItems(body: Record<string, unknown>) {
	const items = optionalJsonArray(body, "items");
	return items.map((item, index) => {
		if (!isRecord(item)) throw new Error(`items[${index}] must be an object.`);
		const candidate = item.candidate;
		if (candidate === undefined) {
			return {
				messageId: requiredJsonString(item, "messageId"),
				value: requiredJsonString(item, "value"),
			};
		}
		if (!isRecord(candidate)) {
			throw new Error(`items[${index}].candidate must be an object.`);
		}
		if (candidate.kind === "value") {
			return {
				messageId: requiredJsonString(item, "messageId"),
				value: requiredJsonString(candidate, "value"),
			};
		}
		if (candidate.kind === "intentionalBlank") {
			return {
				messageId: requiredJsonString(item, "messageId"),
				value: "",
				intentionalBlankReason: requiredJsonString(candidate, "reason"),
			};
		}
		throw new Error(
			`items[${index}].candidate.kind must be value or intentionalBlank.`,
		);
	});
}

type TranslationTaskTargetInput =
	| {
			kind: "managedLocale";
			collectionId: Id<"contentCollections">;
			localeCode: string;
	  }
	| { kind: "existingLocale"; localeCode: string }
	| { kind: "newLocale"; localeCode: string };

/** The explicit target is the durable API. Keep the original top-level
 * localeCode request readable so existing agents can upgrade independently. */
function translationTaskTarget(
	body: Record<string, unknown>,
): TranslationTaskTargetInput {
	const target = body.target;
	if (target === undefined) {
		return {
			kind: "existingLocale",
			localeCode: requiredJsonString(body, "localeCode"),
		};
	}
	if (!isRecord(target)) {
		throw new Error("target must be an object with a kind and localeCode.");
	}
	const localeCode = requiredJsonString(target, "localeCode");
	if (target.kind === "managedLocale")
		return {
			kind: "managedLocale",
			localeCode,
			collectionId: requiredJsonString(
				target,
				"collectionId",
			) as Id<"contentCollections">,
		};
	if (target.kind === "existingLocale" || target.kind === "newLocale") {
		return { kind: target.kind, localeCode };
	}
	throw new Error(
		"target.kind must be existingLocale, managedLocale, or newLocale.",
	);
}

function translationTaskMessageIds(
	body: Record<string, unknown>,
	target: TranslationTaskTargetInput,
): string[] {
	const scope = body.scope;
	if (scope === undefined) {
		if (target.kind === "newLocale") return [];
		if (!isStringArray(body.messageIds)) {
			throw new Error("messageIds must be an array of strings.");
		}
		return body.messageIds;
	}
	if (!isRecord(scope)) throw new Error("scope must be an object.");
	if (target.kind === "newLocale") {
		if (scope.kind !== "completeCatalog") {
			throw new Error("A new-Locale task needs completeCatalog scope.");
		}
		return [];
	}
	if (scope.kind !== "selectedMessages" || !isStringArray(scope.messageIds)) {
		throw new Error(
			"An existing-Locale task needs selectedMessages scope with messageIds.",
		);
	}
	return scope.messageIds;
}

type SnapshotFileInput = { catalogPath: string; content: string };

function snapshotFiles(body: Record<string, unknown>): SnapshotFileInput[] {
	const items = optionalJsonArray(body, "files");
	if (items.length > MAX_SNAPSHOT_FILES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: `A snapshot may contain at most ${MAX_SNAPSHOT_FILES} catalog files.`,
		});
	}
	const files = items.map((item, index) => {
		if (!isRecord(item)) throw new Error(`files[${index}] must be an object.`);
		return {
			catalogPath: requiredJsonString(item, "catalogPath"),
			content: jsonString(item, "content"),
		};
	});
	const byteLength = new TextEncoder().encode(JSON.stringify(files)).byteLength;
	if (byteLength > MAX_SNAPSHOT_BYTES) {
		throw new ConvexError({
			code: "LIMIT_EXCEEDED",
			message: `A snapshot request may contain at most ${MAX_SNAPSHOT_BYTES} bytes.`,
		});
	}
	return files;
}

function snapshotLineage(body: Record<string, unknown>) {
	const value = body.lineage;
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("lineage must be an object.");
	const relationshipValue = value.relationship;
	const relationship: "ancestor" | "descendant" | "divergent" =
		relationshipValue === "ancestor" ||
		relationshipValue === "descendant" ||
		relationshipValue === "divergent"
			? relationshipValue
			: (() => {
					throw new Error(
						"lineage.relationship must be ancestor, descendant, or divergent.",
					);
				})();
	if (
		relationshipValue !== "ancestor" &&
		relationshipValue !== "descendant" &&
		relationshipValue !== "divergent"
	) {
		throw new Error(
			"lineage.relationship must be ancestor, descendant, or divergent.",
		);
	}
	return {
		baselineCommit: requiredJsonString(value, "baselineCommit"),
		relationship,
		mergeBase: requiredJsonString(value, "mergeBase"),
	};
}

function localeProposalId(value: string | null): Id<"localeProposals"> {
	if (!value) throw new Error("Missing Locale Proposal id.");
	// The internal query and mutation boundaries validate this branded ID.
	return value as Id<"localeProposals">;
}

type LocaleProposalValueInput = {
	messageId: string;
	value: string;
	sourceFingerprint: string;
	intentionalBlankReason?: string;
};

function localeProposalValues(
	body: Record<string, unknown>,
): LocaleProposalValueInput[] {
	return optionalJsonArray(body, "items").map((item, index) => {
		if (!isRecord(item)) throw new Error(`items[${index}] must be an object.`);
		const intentionalBlankReason = item.intentionalBlankReason;
		if (
			intentionalBlankReason !== undefined &&
			typeof intentionalBlankReason !== "string"
		) {
			throw new Error(
				`items[${index}].intentionalBlankReason must be a string.`,
			);
		}
		return {
			messageId: requiredJsonString(item, "messageId"),
			value: jsonString(item, "value"),
			sourceFingerprint: requiredJsonString(item, "sourceFingerprint"),
			...(intentionalBlankReason === undefined
				? {}
				: { intentionalBlankReason }),
		};
	});
}

type TranslationProposalTargetInput =
	| { kind: "catalogWorkspace" }
	| { kind: "localeProposal"; localeProposalId: string };

type TranslationProposalRevisionHttpInput = {
	messageId: string;
	localeId?: string;
	value: string;
	clientRevisionKey: string;
	expectedCandidateRevision: number;
	basis:
		| {
				kind: "catalogWorkspace";
				projectionId: string;
				snapshotId: string;
				gitValueFingerprint: string;
				gitValueRevision: number;
				workspaceRevision: number;
				sourceFingerprint: string;
		  }
		| {
				kind: "localeProposal";
				localeProposalId: string;
				snapshotId: string;
				sourceFingerprint: string;
		  };
};

function translationProposalTarget(
	body: Record<string, unknown>,
): TranslationProposalTargetInput {
	const target = body.target;
	if (!isRecord(target) || typeof target.kind !== "string") {
		throw new Error("target must be an object with a kind.");
	}
	if (target.kind === "catalogWorkspace") return { kind: "catalogWorkspace" };
	if (
		target.kind === "localeProposal" &&
		typeof target.localeProposalId === "string" &&
		target.localeProposalId.length > 0
	) {
		return {
			kind: "localeProposal",
			localeProposalId: target.localeProposalId,
		};
	}
	throw new Error("target must describe catalogWorkspace or localeProposal.");
}

function requiredJsonNumber(
	body: Record<string, unknown>,
	field: string,
): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new Error(`${field} must be a safe integer.`);
	}
	return value;
}

function translationProposalRevisionItems(
	body: Record<string, unknown>,
): TranslationProposalRevisionHttpInput[] {
	return optionalJsonArray(body, "items").map((item, index) => {
		if (!isRecord(item)) throw new Error(`items[${index}] must be an object.`);
		const basis = item.basis;
		if (!isRecord(basis))
			throw new Error(`items[${index}].basis must be an object.`);
		// Catalog Workspace basis predated the discriminant; keep that wire
		// representation readable while making Locale Proposal evidence explicit.
		const kind =
			basis.kind ??
			(typeof basis.projectionId === "string" ? "catalogWorkspace" : undefined);
		if (kind === "catalogWorkspace") {
			return {
				messageId: requiredJsonString(item, "messageId"),
				localeId: requiredJsonString(item, "localeId"),
				value: jsonString(item, "value"),
				clientRevisionKey: requiredJsonString(item, "clientRevisionKey"),
				expectedCandidateRevision: requiredJsonNumber(
					item,
					"expectedCandidateRevision",
				),
				basis: {
					kind,
					projectionId: requiredJsonString(basis, "projectionId"),
					snapshotId: requiredJsonString(basis, "snapshotId"),
					gitValueFingerprint: requiredJsonString(basis, "gitValueFingerprint"),
					gitValueRevision: requiredJsonNumber(basis, "gitValueRevision"),
					workspaceRevision: requiredJsonNumber(basis, "workspaceRevision"),
					sourceFingerprint: requiredJsonString(basis, "sourceFingerprint"),
				},
			};
		}
		if (kind !== "localeProposal") {
			throw new Error(`items[${index}].basis.kind is invalid.`);
		}
		return {
			messageId: requiredJsonString(item, "messageId"),
			value: jsonString(item, "value"),
			clientRevisionKey: requiredJsonString(item, "clientRevisionKey"),
			expectedCandidateRevision: requiredJsonNumber(
				item,
				"expectedCandidateRevision",
			),
			basis: {
				kind,
				localeProposalId: requiredJsonString(basis, "localeProposalId"),
				snapshotId: requiredJsonString(basis, "snapshotId"),
				sourceFingerprint: requiredJsonString(basis, "sourceFingerprint"),
			},
		};
	});
}

function readToken(request: Request): string {
	const header = request.headers.get("Authorization") ?? "";
	const [, token] = header.match(/^Bearer\s+(.+)$/i) ?? [];
	if (!token) throw new Error("Missing bearer token.");
	return token;
}

/** The CLI compatibility floor applies only to repository delivery clients. */
async function cliResponseHeaders(
	ctx: ActionCtx,
	request: Request,
	projectId: Id<"projects">,
): Promise<Record<string, string>> {
	const compatibility = await ctx.runQuery(
		internalApi.agentApi.cliCompatibility,
		{ projectId },
	);
	const protocolHeader = request.headers.get("X-Blabla-CLI-Protocol");
	const protocol = protocolHeader === null ? undefined : Number(protocolHeader);
	if (
		compatibility.minimumProtocol !== undefined &&
		(protocol === undefined ||
			!Number.isSafeInteger(protocol) ||
			protocol < compatibility.minimumProtocol)
	) {
		throw new ConvexError({
			code: "CLI_UPGRADE_REQUIRED",
			message: `Blabla requires CLI protocol ${compatibility.minimumProtocol}. Install a compatible Blabla CLI and retry.`,
		});
	}
	return {
		...(compatibility.minimumVersion === undefined
			? {}
			: { "X-Blabla-Minimum-CLI-Version": compatibility.minimumVersion }),
		...(compatibility.minimumProtocol === undefined
			? {}
			: {
					"X-Blabla-Minimum-CLI-Protocol": String(
						compatibility.minimumProtocol,
					),
				}),
	};
}

async function withAgent<T>(
	ctx: ActionCtx,
	request: Request,
	scope: AgentScope | readonly AgentScope[],
	rateLimitName: AgentRateLimitName,
	handler: (
		token: string,
		actor: ProposalActor,
		project: {
			type: "basic" | "repository";
			managedCollectionId?: Id<"contentCollections">;
		},
	) => Promise<T>,
	options: { requireCliProtocol?: boolean } = {},
): Promise<{ value: T; responseHeaders: Record<string, string> }> {
	const token = readToken(request);
	const scopes = Array.isArray(scope) ? scope : [scope];
	const [firstScope, ...remainingScopes] = scopes;
	if (!firstScope) throw new Error("Missing required API token scope.");
	const auth = await ctx.runQuery(internalApi.agentApi.authenticateToken, {
		token,
		scope: firstScope,
	});
	for (const requiredScope of remainingScopes) {
		await ctx.runQuery(internalApi.agentApi.authenticateToken, {
			token,
			scope: requiredScope,
		});
	}
	const responseHeaders = options.requireCliProtocol
		? await cliResponseHeaders(ctx, request, auth.projectId)
		: {};
	await ctx.runMutation(internalApi.rateLimits.consume, {
		name: rateLimitName,
		key: auth._id,
	});
	await ctx.runMutation(internalApi.agentApi.touchToken, { tokenId: auth._id });
	return {
		value: await handler(
			token,
			{
				projectId: auth.projectId,
				tokenId: auth._id,
			},
			{ type: auth.projectType, managedCollectionId: auth.managedCollectionId },
		),
		responseHeaders,
	};
}

async function withRepositoryAdapter<T>(
	ctx: ActionCtx,
	request: Request,
	rateLimitName: RepositoryAdapterRateLimitName,
	handler: (auth: {
		projectId: Id<"projects">;
		tokenId: Id<"apiTokens">;
	}) => Promise<T>,
	scope: AgentScope = "snapshot-submission",
): Promise<{ value: T; responseHeaders: Record<string, string> }> {
	const token = readToken(request);
	const auth = await ctx.runQuery(internalApi.agentApi.authenticateToken, {
		token,
		scope,
	});
	const responseHeaders = await cliResponseHeaders(
		ctx,
		request,
		auth.projectId,
	);
	await ctx.runMutation(internalApi.rateLimits.consume, {
		name: rateLimitName,
		key: auth._id,
	});
	await ctx.runMutation(internalApi.agentApi.touchToken, { tokenId: auth._id });
	return {
		value: await handler({ projectId: auth.projectId, tokenId: auth._id }),
		responseHeaders,
	};
}

function agentJson<T>(result: {
	value: T;
	responseHeaders: Record<string, string>;
}) {
	return json(result.value, 200, result.responseHeaders);
}

function routeError(
	error: unknown,
	statusByCode: Partial<Record<string, number>> = {},
) {
	const details =
		error instanceof ConvexError && isRecord(error.data)
			? error.data
			: undefined;
	const code = typeof details?.code === "string" ? details.code : undefined;
	const message =
		typeof details?.message === "string"
			? details.message
			: error instanceof Error
				? error.message
				: "Request failed.";
	const diagnostics = isStringArray(details?.diagnostics)
		? details.diagnostics
		: undefined;
	const diagnosticCount =
		typeof details?.diagnosticCount === "number"
			? details.diagnosticCount
			: undefined;
	const retryAfter =
		typeof details?.retryAfter === "number" && details.retryAfter >= 0
			? details.retryAfter
			: undefined;
	const isAuthError =
		code === "UNAUTHORIZED" ||
		/\b(Missing bearer|Invalid\b.*\b(token|bearer|authorization))\b/i.test(
			message,
		) ||
		(error instanceof Error && error.name === "UnauthorizedError");
	const status =
		(code ? statusByCode[code] : undefined) ??
		(isAuthError
			? 401
			: code === "CLI_UPGRADE_REQUIRED"
				? 426
				: code === "RATE_LIMITED"
					? 429
					: code === "REPOSITORY_MISMATCH" || code === "CONFLICT"
						? 409
						: code === "LIMIT_EXCEEDED"
							? 413
							: 400);
	return json(
		{
			error: message,
			...(code === "CHARACTER_LIMIT_EXCEEDED"
				? {
						...(typeof details?.messageId === "string"
							? { messageId: details.messageId }
							: {}),
						...(typeof details?.characterLimit === "number"
							? { characterLimit: details.characterLimit }
							: {}),
						...(typeof details?.characterCount === "number"
							? { characterCount: details.characterCount }
							: {}),
						...(typeof details?.overBy === "number"
							? { overBy: details.overBy }
							: {}),
					}
				: {}),
			...(code === undefined ? {} : { code }),
			...(diagnosticCount === undefined ? {} : { diagnosticCount }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			...(retryAfter === undefined ? {} : { retryAfter }),
		},
		status,
		retryAfter === undefined
			? {}
			: { "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1_000))) },
	);
}

authComponent.registerRoutesLazy(http, createAuth, {
	cors: true,
	trustedOrigins: getTrustedOrigins(),
});

http.route({
	path: "/resend-webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		return await resend.handleResendEventWebhook(ctx, request);
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/",
	method: "OPTIONS",
	handler: httpAction(
		async () => new Response(null, { status: 204, headers: corsHeaders }),
	),
});

http.route({
	pathPrefix: "/api/repository-adapter/v1/",
	method: "OPTIONS",
	handler: httpAction(
		async () => new Response(null, { status: 204, headers: corsHeaders }),
	),
});

http.route({
	path: "/api/repository-adapter/v1/snapshot-context",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotContext",
					async ({ projectId, tokenId }) =>
						await ctx.runQuery(internalApi.snapshots.repositoryAdapterContext, {
							projectId,
							actor: { kind: "repositoryAdapter", id: tokenId },
						}),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/repository-adapter/v1/snapshot-uploads",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const releaseRecordId =
				body.kind === "release"
					? (requiredJsonString(
							body,
							"releaseRecordId",
						) as Id<"releaseRecords">)
					: undefined;
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotSubmit",
					async ({ projectId, tokenId }) => {
						if (typeof body.expectedFiles !== "number")
							throw new ConvexError({
								code: "VALIDATION",
								message: "expectedFiles must be a number.",
							});
						return await ctx.runMutation(internal.snapshotUploads.begin, {
							projectId,
							tokenId,
							releaseRecordId,
							repository: requiredJsonString(body, "repository"),
							commit: requiredJsonString(body, "commit"),
							expectedFiles: body.expectedFiles,
							lineage: snapshotLineage(body),
						});
					},
					releaseRecordId ? "export" : "snapshot-submission",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});
http.route({
	path: "/api/repository-adapter/v1/snapshot-uploads/file",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotUpload",
					async ({ projectId, tokenId }) =>
						await uploadFile(ctx, {
							projectId,
							tokenId,
							sessionId: requiredJsonString(
								body,
								"sessionId",
							) as Id<"snapshotUploadSessions">,
							catalogPath: requiredJsonString(body, "catalogPath"),
							content: requiredJsonString(body, "content"),
							contentHash: requiredJsonString(body, "contentHash"),
						}),
					body.kind === "release" ? "export" : "snapshot-submission",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});
http.route({
	path: "/api/repository-adapter/v1/snapshot-uploads/finalize",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotSubmit",
					async ({ projectId, tokenId }) => {
						const args = {
							projectId,
							tokenId,
							sessionId: requiredJsonString(
								body,
								"sessionId",
							) as Id<"snapshotUploadSessions">,
						};
						return body.kind === "release"
							? await finalizeReleaseUpload(ctx, args)
							: await finalizeUpload(ctx, args);
					},
					body.kind === "release" ? "export" : "snapshot-submission",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});
http.route({
	path: "/api/repository-adapter/v1/snapshot-uploads/download",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotUpload",
					async ({ projectId, tokenId }) =>
						await downloadReleaseFile(ctx, {
							projectId,
							tokenId,
							sessionId: requiredJsonString(
								body,
								"sessionId",
							) as Id<"snapshotUploadSessions">,
							catalogPath: requiredJsonString(body, "catalogPath"),
						}),
					"export",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/repository-adapter/v1/snapshots",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const repository = requiredJsonString(body, "repository");
			const commit = requiredJsonString(body, "commit");
			const files = snapshotFiles(body);
			const lineage = snapshotLineage(body);
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositorySnapshotSubmit",
					async ({ projectId, tokenId }) => {
						const actor = { kind: "repositoryAdapter" as const, id: tokenId };
						const result = await ctx.runAction(
							internalApi.snapshots.ingestFromRepositoryAdapter,
							{ projectId, repository, commit, files, lineage, actor },
						);
						return await ctx.runQuery(
							internalApi.snapshots.repositoryAdapterReceipt,
							{ runId: result.runId, reused: result.reused, actor },
						);
					},
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/repository-adapter/v1/releases/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const recordId = new URL(request.url).pathname.replace(
				"/api/repository-adapter/v1/releases/",
				"",
			) as Id<"releaseRecords">;
			if (!recordId || recordId.includes("/")) {
				throw new Error("Missing Release Record id.");
			}
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositoryReleaseDelivery",
					async ({ projectId }) => {
						const context = await ctx.runQuery(
							internalApi.releaseBundles.deliveryContext,
							{ projectId, recordId },
						);
						const bundle = await storedReleaseBundle(
							ctx,
							context.bundleStorageId,
							context.bundleHash,
						);
						return {
							releaseRecord: bundle.releaseRecord,
							catalogs: bundle.catalogs,
							changeKeyCount:
								bundle.version === 1
									? bundle.changes.length
									: bundle.changeKeyCount,
						};
					},
					"export",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/repository-adapter/v1/releases/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const suffix = new URL(request.url).pathname.replace(
				"/api/repository-adapter/v1/releases/",
				"",
			);
			const marker = "/delivery-tree";
			if (!suffix.endsWith(marker)) {
				throw new Error("Expected /delivery-tree.");
			}
			const recordId = suffix.slice(0, -marker.length) as Id<"releaseRecords">;
			const body = await jsonObject(request);
			const files = snapshotFiles(body);
			return agentJson(
				await withRepositoryAdapter(
					ctx,
					request,
					"repositoryReleaseDelivery",
					async ({ projectId, tokenId }) => {
						const context = await ctx.runQuery(
							internalApi.releaseBundles.deliveryContext,
							{ projectId, recordId },
						);
						const bundle = await storedReleaseBundle(
							ctx,
							context.bundleStorageId,
							context.bundleHash,
						);
						const delivery = await applyStoredReleaseTree(ctx, bundle, files);
						const captureContent = JSON.stringify({
							version: 1,
							releaseRecordId: recordId,
							bundleHash: context.bundleHash,
							files,
							applied: delivery.applied,
							skipped: delivery.skipped,
						});
						const captureStorageId = await ctx.storage.store(
							new Blob([captureContent], { type: "application/json" }),
						);
						let deliveryCaptureId: Id<"releaseDeliveryCaptures">;
						try {
							deliveryCaptureId = await ctx.runMutation(
								internalApi.releaseBundles.recordDeliveryCapture,
								{
									projectId,
									recordId,
									runId: context.runId,
									actor: { kind: "repositoryAdapter", id: tokenId },
									captureStorageId,
									captureHash: await sha256Hex(captureContent),
									captureByteLength: new TextEncoder().encode(captureContent)
										.byteLength,
									appliedCount: delivery.applied.length,
									skippedCount: delivery.skipped.length,
								},
							);
						} catch (error) {
							await ctx.storage.delete(captureStorageId);
							throw error;
						}
						return {
							releaseRecord: bundle.releaseRecord,
							...delivery,
							deliveryCaptureId,
						};
					},
					"export",
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/agent/v1/projects/current",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token) =>
						await ctx.runQuery(internalApi.agentApi.currentProject, { token }),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/agent/v1/collections",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			return agentJson(
				await withAgent(ctx, request, "read", "agentRead", (token) =>
					ctx.runQuery(internalApi.agentContent.list, { token }),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/collections/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const url = new URL(request.url);
			const match =
				/^\/api\/agent\/v1\/collections\/([^/]+)(?:\/(search))?$/.exec(
					url.pathname,
				);
			if (!match) return json({ error: "Unknown collection route." }, 404);
			const collectionId = match[1] as Id<"contentCollections">;
			const search = match[2] === "search";
			return agentJson(
				await withAgent(
					ctx,
					request,
					search ? "search" : "read",
					search ? "agentSearch" : "agentRead",
					async (token) => {
						if (search)
							return ctx.runQuery(internalApi.agentContent.search, {
								token,
								collectionId,
								q: url.searchParams.get("q") ?? undefined,
								keyPrefix: url.searchParams.get("keyPrefix") ?? undefined,
								localeCode: url.searchParams.get("localeCode") ?? undefined,
								limit: Number(url.searchParams.get("limit") ?? 16),
								cursor: url.searchParams.get("cursor") ?? undefined,
								searchIn: searchChoice(url.searchParams, "searchIn", [
									"all",
									"key",
									"source",
									"target",
								] as const),
								match: searchChoice(url.searchParams, "match", [
									"substring",
									"exact",
								] as const),
								quality: searchChoice(url.searchParams, "quality", [
									"all",
									"confirmed",
								] as const),
							});
						return ctx.runQuery(internalApi.agentContent.detail, {
							token,
							collectionId,
						});
					},
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404, STALE_BASIS: 409 });
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/collections/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const match =
				/^\/api\/agent\/v1\/collections\/([^/]+)\/(context|download)$/.exec(
					new URL(request.url).pathname,
				);
			if (!match) return json({ error: "Unknown collection route." }, 404);
			const collectionId = match[1] as Id<"contentCollections">;
			const body = await jsonObject(request);
			if (!isStringArray(body.keys) || !isStringArray(body.locales))
				throw new Error("keys and locales must be string arrays.");
			const keys = body.keys;
			const locales = body.locales;
			const mode = body.mode ?? "reviewed";
			if (
				match[2] === "download" &&
				mode !== "reviewed" &&
				mode !== "partial" &&
				mode !== "draft"
			)
				throw new Error("mode must be reviewed, partial, or draft.");
			return agentJson(
				await withAgent(ctx, request, "read", "agentRead", async (token) =>
					match[2] === "context"
						? ctx.runQuery(internalApi.agentContent.context, {
								token,
								collectionId,
								keys,
								locales,
							})
						: ctx.runQuery(internalApi.agentContent.download, {
								token,
								collectionId,
								keys,
								locales,
								mode: mode as "reviewed" | "partial" | "draft",
							}),
				),
			);
		} catch (error) {
			return routeError(error, {
				NOT_FOUND: 404,
				NEEDS_REVIEW: 409,
				STALE_BASIS: 409,
			});
		}
	}),
});

http.route({
	path: "/api/agent/v1/workspace/search",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const url = new URL(request.url);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"search",
					"agentSearch",
					async (token, _actor, project) => {
						const options = {
							token,
							q: url.searchParams.get("q") ?? undefined,
							localeCode: url.searchParams.get("localeCode") ?? undefined,
							limit: Number(url.searchParams.get("limit") ?? 16),
							cursor: url.searchParams.get("cursor") ?? undefined,
							keyPrefix: url.searchParams.get("keyPrefix") ?? undefined,
							searchIn: searchChoice(url.searchParams, "searchIn", [
								"all",
								"key",
								"source",
								"target",
							] as const),
							match: searchChoice(url.searchParams, "match", [
								"substring",
								"exact",
							] as const),
							quality: searchChoice(url.searchParams, "quality", [
								"all",
								"confirmed",
							] as const),
							view: searchChoice(url.searchParams, "view", [
								"compact",
								"full",
							] as const),
						};
						if (project.type === "basic" && project.managedCollectionId) {
							const { view: _view, ...managedOptions } = options;
							return ctx.runQuery(internalApi.agentContent.search, {
								...managedOptions,
								collectionId: project.managedCollectionId,
							});
						}
						return ctx.runQuery(
							internalApi.agentRetrieval.workspaceSearch,
							options,
						);
					},
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404, STALE_BASIS: 409 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/workspace/work",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const url = new URL(request.url);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"search",
					"agentSearch",
					async (token) =>
						await ctx.runQuery(internalApi.agentRetrieval.workspaceWorkPage, {
							token,
							cursor: url.searchParams.get("cursor") ?? "",
							limit: Number(url.searchParams.get("limit") ?? 16),
							localeCode: url.searchParams.get("localeCode") ?? undefined,
							reasons: translationWorkReasons(
								url.searchParams.getAll("reason"),
							),
							q: url.searchParams.get("q") ?? undefined,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404, STALE_BASIS: 409 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/workspace/context",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const keys = body.keys;
			const locales = body.locales;
			if (!isStringArray(keys) || !isStringArray(locales)) {
				throw new Error("keys and locales must be string arrays.");
			}
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token, _actor, project) =>
						project.type === "basic" && project.managedCollectionId
							? ctx.runQuery(internalApi.agentContent.context, {
									token,
									keys,
									locales,
									collectionId: project.managedCollectionId,
								})
							: ctx.runQuery(internalApi.agentRetrieval.workspaceContext, {
									token,
									keys,
									locales,
								}),
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404, STALE_BASIS: 409 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/workspace/download",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			if (!isStringArray(body.keys) || !isStringArray(body.locales))
				throw new Error("keys and locales must be string arrays.");
			const keys = body.keys;
			const locales = body.locales;
			const mode = body.mode ?? "reviewed";
			if (mode !== "reviewed" && mode !== "partial" && mode !== "draft")
				throw new Error("mode must be reviewed, partial, or draft.");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token, _actor, project) => {
						if (project.type !== "basic" || !project.managedCollectionId)
							throw new ConvexError({
								code: "BAD_STATE",
								message:
									"Repository projects use Release Bundles for delivery.",
							});
						return ctx.runQuery(internalApi.agentContent.download, {
							token,
							collectionId: project.managedCollectionId,
							keys,
							locales,
							mode,
						});
					},
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404, NEEDS_REVIEW: 409 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/proposal-examples/search",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			if (!isRecord(body.scope))
				throw new Error("scope must identify a task or candidate review.");
			const rawScope = body.scope;
			const scope =
				rawScope.kind === "task"
					? {
							kind: "task" as const,
							taskId: requiredJsonString(
								rawScope,
								"taskId",
							) as Id<"agentTranslationProposals">,
						}
					: rawScope.kind === "review"
						? {
								kind: "review" as const,
								candidateRevisionId: requiredJsonString(
									rawScope,
									"candidateRevisionId",
								) as Id<"agentTranslationCandidateRevisions">,
							}
						: null;
			if (scope === null) throw new Error("scope.kind must be task or review.");
			const optionalString = (field: string) =>
				body[field] === undefined ? undefined : jsonString(body, field);
			const searchIn = body.searchIn;
			const match = body.match;
			const limit = body.limit;
			if (
				searchIn !== undefined &&
				searchIn !== "all" &&
				searchIn !== "key" &&
				searchIn !== "source" &&
				searchIn !== "target"
			) {
				throw new Error("searchIn must be all, key, source, or target.");
			}
			if (match !== undefined && match !== "substring" && match !== "exact")
				throw new Error("match must be substring or exact.");
			if (limit !== undefined && typeof limit !== "number")
				throw new Error("limit must be a number.");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"search",
					"agentSearch",
					async (token) =>
						await ctx.runQuery(internalApi.agentProposalRetrieval.search, {
							token,
							scope,
							q: optionalString("q"),
							searchIn,
							match,
							keyPrefix: optionalString("keyPrefix"),
							limit,
							cursor: optionalString("cursor"),
						}),
				),
			);
		} catch (error) {
			return routeError(error, {
				NOT_FOUND: 404,
				FORBIDDEN: 403,
				STALE_BASIS: 409,
			});
		}
	}),
});

http.route({
	path: "/api/agent/v1/languages",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			return agentJson(
				await withAgent(ctx, request, "read", "agentRead", (token) =>
					ctx.runQuery(internalApi.agentLanguages.list, { token }),
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/languages",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const optionalString = (field: string) =>
				body[field] === undefined ? undefined : jsonString(body, field);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"languages-write",
					"agentLanguagesWrite",
					(token) =>
						ctx.runMutation(internalApi.agentLanguages.add, {
							token,
							code: requiredJsonString(body, "code"),
							label: optionalString("label"),
							catalogPath: optionalString("catalogPath"),
							runtimeLocale: optionalString("runtimeLocale"),
							expectedUpdatedAt:
								body.expectedUpdatedAt === undefined
									? undefined
									: requiredJsonNumber(body, "expectedUpdatedAt"),
						}),
				),
			);
		} catch (error) {
			return routeError(error, {
				NOT_FOUND: 404,
				CONFLICT: 409,
				STALE_BASIS: 409,
				FORBIDDEN: 403,
			});
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/languages/",
	method: "PATCH",
	handler: httpAction(async (ctx, request) => {
		try {
			const match = new URL(request.url).pathname.match(
				/^\/api\/agent\/v1\/languages\/([^/]+)$/,
			);
			if (!match?.[1])
				return json(
					{ code: "NOT_FOUND", error: "Language endpoint not found." },
					404,
				);
			const body = await jsonObject(request);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"languages-write",
					"agentLanguagesWrite",
					(token) =>
						ctx.runMutation(internalApi.agentLanguages.update, {
							token,
							localeId: match[1] as Id<"locales">,
							code: requiredJsonString(body, "code"),
							label: jsonString(body, "label"),
							expectedCode: requiredJsonString(body, "expectedCode"),
							expectedLabel: jsonString(body, "expectedLabel"),
						}),
				),
			);
		} catch (error) {
			return routeError(error, {
				NOT_FOUND: 404,
				CONFLICT: 409,
				STALE_BASIS: 409,
				FORBIDDEN: 403,
			});
		}
	}),
});

http.route({
	path: "/api/agent/v1/dictionary",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const params = new URL(request.url).searchParams;
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token) =>
						await ctx.runQuery(internalApi.agentDictionary.list, {
							token,
							q: params.get("q") ?? undefined,
							sourceTerm: params.get("sourceTerm") ?? undefined,
							limit: Number(params.get("limit") ?? 16),
							cursor: params.get("cursor") ?? undefined,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { STALE_BASIS: 409, NOT_FOUND: 404 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/dictionary/terms",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			if (!Array.isArray(body.terms))
				throw new Error("terms must be an array.");
			const terms = body.terms.map((term: unknown) => {
				if (!isRecord(term)) throw new Error("Each term must be an object.");
				const fields = {
					sourceTerm: requiredJsonString(term, "sourceTerm"),
					definition: requiredJsonString(term, "definition"),
				};
				if (term.kind === "untranslatable")
					return { ...fields, kind: "untranslatable" as const };
				if (term.kind !== "translated" || !Array.isArray(term.renderings))
					throw new Error("A translated term must include renderings.");
				return {
					...fields,
					kind: "translated" as const,
					renderings: term.renderings.map((rendering: unknown) => {
						if (!isRecord(rendering))
							throw new Error("Each rendering must be an object.");
						return {
							localeCode: requiredJsonString(rendering, "localeCode"),
							value: requiredJsonString(rendering, "value"),
						};
					}),
				};
			});
			const expectedRevision = requiredJsonNumber(body, "expectedRevision");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"dictionary-write",
					"agentDictionaryWrite",
					async (token) =>
						await ctx.runMutation(internalApi.agentDictionary.save, {
							token,
							expectedRevision,
							expectedDictionaryId:
								body.expectedDictionaryId === undefined
									? undefined
									: (requiredJsonString(
											body,
											"expectedDictionaryId",
										) as Id<"dictionaries">),
							expectedConnectionRevision:
								body.expectedConnectionRevision === undefined
									? undefined
									: requiredJsonNumber(body, "expectedConnectionRevision"),
							terms,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { STALE_BASIS: 409, NOT_FOUND: 404 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/dictionary/terms",
	method: "DELETE",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const expectedRevision = requiredJsonNumber(body, "expectedRevision");
			const sourceTerm = requiredJsonString(body, "sourceTerm");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"dictionary-write",
					"agentDictionaryWrite",
					async (token) =>
						await ctx.runMutation(internalApi.agentDictionary.remove, {
							token,
							expectedRevision,
							expectedDictionaryId:
								body.expectedDictionaryId === undefined
									? undefined
									: (requiredJsonString(
											body,
											"expectedDictionaryId",
										) as Id<"dictionaries">),
							expectedConnectionRevision:
								body.expectedConnectionRevision === undefined
									? undefined
									: requiredJsonNumber(body, "expectedConnectionRevision"),
							sourceTerm,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { STALE_BASIS: 409, NOT_FOUND: 404 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/guidance/context",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			if (!isStringArray(body.texts) || !isStringArray(body.locales))
				throw new Error("texts and locales must be string arrays.");
			const texts = body.texts;
			const localeCodes = body.locales;
			const syntax = body.syntax ?? "icu";
			if (syntax !== "plain" && syntax !== "icu")
				throw new Error("syntax must be plain or icu.");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token) =>
						await ctx.runQuery(internalApi.agentRetrieval.guidanceContext, {
							token,
							texts,
							localeCodes,
							syntax,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404 });
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/guidance/revisions/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const revisionId = new URL(request.url).pathname.slice(
				"/api/agent/v1/guidance/revisions/".length,
			);
			if (!revisionId || revisionId.includes("/"))
				throw new Error("Missing guidance revision id.");
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token) =>
						await ctx.runQuery(internalApi.agentRetrieval.guidanceRevision, {
							token,
							revisionId: revisionId as Id<"translationGuidanceRevisions">,
						}),
				),
			);
		} catch (error) {
			return routeError(error, { NOT_FOUND: 404 });
		}
	}),
});

http.route({
	path: "/api/agent/v1/workspace/ordinary-confirmations",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const url = new URL(request.url);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (_token, actor) =>
						await ctx.runQuery(
							internalApi.ordinaryImportRuns.pageOrdinaryImportCandidates,
							{
								projectId: actor.projectId,
								cursor: url.searchParams.get("cursor") ?? "",
								limit: Number(url.searchParams.get("limit") ?? 100),
							},
						),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/agent/v1/translation-proposals",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			return agentJson(
				await withAgent(
					ctx,
					request,
					["read", "propose"],
					"agentTranslationProposal",
					async (token) =>
						await ctx.runMutation(
							internalApi.agentTranslationProposals.create,
							{
								token,
								clientProposalKey: requiredJsonString(
									body,
									"clientProposalKey",
								),
								target: (() => {
									const target = translationProposalTarget(body);
									return target.kind === "localeProposal"
										? {
												kind: target.kind,
												localeProposalId:
													target.localeProposalId as Id<"localeProposals">,
											}
										: target;
								})(),
							},
						),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/agent/v1/translation-tasks",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const status = new URL(request.url).searchParams.get("status");
			if (
				status !== null &&
				status !== "open" &&
				status !== "accepted" &&
				status !== "rejected"
			) {
				throw new Error("status must be open, accepted, or rejected.");
			}
			return agentJson(
				await withAgent(ctx, request, "read", "agentRead", async (token) => ({
					tasks: await ctx.runQuery(
						internalApi.agentTranslationProposals.listTasksForAgent,
						{
							token,
							...(status === null ? {} : { status }),
						},
					),
				})),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	path: "/api/agent/v1/translation-tasks",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const body = await jsonObject(request);
			const target = translationTaskTarget(body);
			const messageIds = translationTaskMessageIds(body, target);
			const clientTaskKey = requiredJsonString(body, "clientTaskKey");
			return agentJson(
				await withAgent(
					ctx,
					request,
					["read", "propose"],
					"agentTranslationProposal",
					async (token, actor) => {
						if (target.kind !== "newLocale") {
							return await ctx.runMutation(
								internalApi.agentTranslationProposals.createTaskForAgent,
								{
									token,
									clientTaskKey,
									localeCode: target.localeCode,
									collectionId:
										target.kind === "managedLocale"
											? target.collectionId
											: undefined,
									messageIds,
								},
							);
						}
						const proposal = await createOrResumeProposal(
							ctx,
							actor,
							target.localeCode,
						);
						const task = await ctx.runMutation(
							internalApi.agentTranslationProposals.create,
							{
								token,
								clientProposalKey: clientTaskKey,
								target: {
									kind: "localeProposal",
									localeProposalId: proposal.proposalId,
								},
								localeProposalTaskScope: {
									localeProposalId: proposal.proposalId,
									localeCode: proposal.locale.code,
									targetCount: proposal.progress.total,
								},
							},
						);
						return {
							taskId: task.proposalId,
							title: clientTaskKey,
							localeCode: proposal.locale.code,
							targetCount: proposal.progress.total,
						};
					},
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/translation-tasks/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const url = new URL(request.url);
			const taskId = url.pathname.replace(
				"/api/agent/v1/translation-tasks/",
				"",
			) as Id<"agentTranslationProposals">;
			if (!taskId || taskId.includes("/")) {
				throw new Error("Missing Translation Task id.");
			}
			const cursor = Number(url.searchParams.get("cursor") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? 16);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentTranslationProposal",
					async (token, actor) => {
						const descriptor = await ctx.runQuery(
							internalApi.agentTranslationProposals.taskDescriptorForAgent,
							{ token, taskId },
						);
						if (descriptor.kind !== "newLocale") {
							return await ctx.runQuery(
								internalApi.agentTranslationProposals.taskForAgent,
								{ token, taskId, cursor, limit },
							);
						}
						const page = await taskProposalPage(ctx, actor, {
							proposalId: descriptor.localeProposalId,
							cursor,
							limit,
						});
						const candidates = await ctx.runQuery(
							internalApi.agentTranslationProposals
								.newLocaleTaskCandidatesForAgent,
							{
								token,
								taskId,
								messageIds: page.messages.map((message) => message.messageId),
							},
						);
						const candidateByMessageId = new Map(
							candidates.map(
								(candidate) => [candidate.messageId, candidate] as const,
							),
						);
						const targets = [];
						let targetBytes = 0;
						for (const message of page.messages) {
							const target = {
								...message,
								candidate: candidateByMessageId.get(message.messageId) ?? null,
							};
							const bytes = new TextEncoder().encode(
								JSON.stringify(target),
							).byteLength;
							if (bytes > MAX_TRANSLATION_TASK_PAGE_BYTES) {
								throw new ConvexError({
									code: "LIMIT_EXCEEDED",
									message: `Translation Task value “${message.messageId}” exceeds its page envelope.`,
								});
							}
							if (targetBytes + bytes > MAX_TRANSLATION_TASK_PAGE_BYTES) break;
							targets.push(target);
							targetBytes += bytes;
						}
						return {
							task: {
								taskId: descriptor.taskId,
								title: descriptor.title,
								status: descriptor.status,
								localeCode: descriptor.localeCode,
								targetCount: descriptor.targetCount,
								candidateCount: descriptor.candidateCount,
							},
							targets,
							guidance: await ctx.runQuery(
								internalApi.agentRetrieval.guidanceContext,
								{
									token,
									texts: targets.map((target) => target.sourceValue),
									localeCodes: [descriptor.localeCode],
								},
							),
							nextCursor:
								targets.length < page.messages.length
									? cursor + targets.length
									: page.continueCursor,
						};
					},
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/translation-tasks/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const suffix = new URL(request.url).pathname.replace(
				"/api/agent/v1/translation-tasks/",
				"",
			);
			const marker = "/candidates";
			if (!suffix.endsWith(marker)) {
				throw new Error("Expected /candidates.");
			}
			const taskId = suffix.slice(
				0,
				-marker.length,
			) as Id<"agentTranslationProposals">;
			const body = await jsonObject(request);
			const submitted = translationTaskCandidateItems(body);
			return agentJson(
				await withAgent(
					ctx,
					request,
					["read", "propose"],
					"agentTranslationProposal",
					async (token) => {
						const descriptor = await ctx.runQuery(
							internalApi.agentTranslationProposals.taskDescriptorForAgent,
							{ token, taskId },
						);
						if (descriptor.kind === "newLocale") {
							const context = await ctx.runQuery(
								internalApi.agentTranslationProposals
									.newLocaleTaskSubmissionContext,
								{
									token,
									taskId,
									messageIds: submitted.map((item) => item.messageId),
								},
							);
							const byMessageId = new Map(
								context.map((item) => [item.messageId, item] as const),
							);
							const existingResults = new Map<
								string,
								{
									candidateId: Id<"agentTranslationCandidates">;
									revisionId: Id<"agentTranslationCandidateRevisions">;
									revision: number;
									status: "open";
								}
							>();
							const items = (
								await Promise.all(
									submitted.map(async (item) => {
										const target = byMessageId.get(item.messageId);
										if (!target) {
											throw new Error(`Unknown task key: ${item.messageId}.`);
										}
										if (
											target.currentCandidate?.value === item.value &&
											target.currentCandidate.intentionalBlankReason ===
												item.intentionalBlankReason &&
											target.currentCandidate.basisIsCurrent
										) {
											existingResults.set(item.messageId, {
												candidateId: target.currentCandidate.candidateId,
												revisionId: target.currentCandidate.revisionId,
												revision: target.currentCandidate.revision,
												status: "open",
											});
											return null;
										}
										return {
											messageId: item.messageId,
											value: item.value,
											...(item.intentionalBlankReason === undefined
												? {}
												: {
														intentionalBlankReason: item.intentionalBlankReason,
													}),
											clientRevisionKey: `task-v1:${await sha256Hex(`${taskId}\u0000${item.messageId}\u0000${item.value}\u0000${item.intentionalBlankReason ?? ""}\u0000${target.currentRevision}`)}`,
											expectedCandidateRevision: target.currentRevision,
											basis: target.basis,
										};
									}),
								)
							).filter((item) => item !== null);
							const created =
								items.length === 0
									? null
									: await ctx.runMutation(
											internalApi.agentTranslationProposals.submitRevisions,
											{ token, proposalId: taskId, items },
										);
							const createdResults = new Map(
								items.map(
									(item, index) =>
										[item.messageId, created?.revisions[index]] as const,
								),
							);
							const revisions = submitted.map((item) => {
								const result =
									existingResults.get(item.messageId) ??
									createdResults.get(item.messageId);
								if (!result) {
									throw new Error(
										`Candidate result missing: ${item.messageId}.`,
									);
								}
								return result;
							});
							return {
								revisions,
								candidates: submitted.map((item) => ({
									messageId: item.messageId,
									status: "awaitingReview" as const,
								})),
							};
						}
						const context = await ctx.runQuery(
							internalApi.agentTranslationProposals.taskSubmissionContext,
							{
								token,
								taskId,
								messageIds: submitted.map((item) => item.messageId),
							},
						);
						const byMessageId = new Map(
							context.map((item) => [item.messageId, item] as const),
						);
						const existingResults = new Map<
							string,
							{
								candidateId: Id<"agentTranslationCandidates">;
								revisionId: Id<"agentTranslationCandidateRevisions">;
								revision: number;
								status: "open";
							}
						>();
						const items = (
							await Promise.all(
								submitted.map(async (item) => {
									const target = byMessageId.get(item.messageId);
									if (!target) {
										throw new Error(`Unknown task key: ${item.messageId}.`);
									}
									if (
										target.currentCandidate?.value === item.value &&
										target.currentCandidate.intentionalBlankReason ===
											item.intentionalBlankReason &&
										target.currentCandidate.basisIsCurrent
									) {
										existingResults.set(item.messageId, {
											candidateId: target.currentCandidate.candidateId,
											revisionId: target.currentCandidate.revisionId,
											revision: target.currentCandidate.revision,
											status: "open",
										});
										return null;
									}
									return {
										messageId: item.messageId,
										localeId: target.localeId,
										value: item.value,
										...(item.intentionalBlankReason === undefined
											? {}
											: {
													intentionalBlankReason: item.intentionalBlankReason,
												}),
										clientRevisionKey: `task-v1:${await sha256Hex(`${taskId}\u0000${item.messageId}\u0000${item.value}\u0000${item.intentionalBlankReason ?? ""}\u0000${target.currentRevision}`)}`,
										expectedCandidateRevision: target.currentRevision,
										basis: target.basis,
									};
								}),
							)
						).filter((item) => item !== null);
						const created =
							items.length === 0
								? null
								: await ctx.runMutation(
										internalApi.agentTranslationProposals.submitRevisions,
										{ token, proposalId: taskId, items },
									);
						const createdResults = new Map(
							items.map(
								(item, index) =>
									[item.messageId, created?.revisions[index]] as const,
							),
						);
						const revisions = submitted.map((item) => {
							const result =
								existingResults.get(item.messageId) ??
								createdResults.get(item.messageId);
							if (!result) {
								throw new Error(`Candidate result missing: ${item.messageId}.`);
							}
							return result;
						});
						return {
							revisions,
							candidates: submitted.map((item) => ({
								messageId: item.messageId,
								status: "awaitingReview" as const,
							})),
						};
					},
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/translation-proposals/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const suffix = new URL(request.url).pathname.replace(
				"/api/agent/v1/translation-proposals/",
				"",
			);
			const candidatesSuffix = "/candidates";
			const isCandidates = suffix.endsWith(candidatesSuffix);
			const proposalId = (
				isCandidates ? suffix.slice(0, -candidatesSuffix.length) : suffix
			) as Id<"agentTranslationProposals">;
			if (!proposalId) throw new Error("Missing translation proposal id.");
			const url = new URL(request.url);
			const numItems = Math.min(
				16,
				Math.max(1, Number(url.searchParams.get("limit") ?? 16)),
			);
			const cursor = url.searchParams.get("cursor");
			return agentJson(
				await withAgent(
					ctx,
					request,
					isCandidates ? ["read", "propose"] : "read",
					"agentTranslationProposal",
					async (token) =>
						isCandidates
							? await ctx.runQuery(
									internalApi.agentTranslationProposals.listCandidates,
									{
										token,
										proposalId,
										paginationOpts: { numItems, cursor },
									},
								)
							: await ctx.runQuery(internalApi.agentTranslationProposals.get, {
									token,
									proposalId,
								}),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

http.route({
	pathPrefix: "/api/agent/v1/translation-proposals/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		try {
			const suffix = new URL(request.url).pathname.replace(
				"/api/agent/v1/translation-proposals/",
				"",
			);
			const marker = "/candidate-revisions";
			if (!suffix.endsWith(marker)) {
				throw new Error("Expected /candidate-revisions.");
			}
			const proposalId = suffix.slice(
				0,
				-marker.length,
			) as Id<"agentTranslationProposals">;
			const body = await jsonObject(request);
			const rawItems = translationProposalRevisionItems(body);
			const items = rawItems.map((item) =>
				item.basis.kind === "catalogWorkspace"
					? {
							...item,
							localeId: item.localeId as Id<"locales">,
							basis: {
								kind: item.basis.kind,
								projectionId: item.basis
									.projectionId as Id<"catalogProjections">,
								snapshotId: item.basis.snapshotId as Id<"sourceSnapshots">,
								gitValueFingerprint: item.basis.gitValueFingerprint,
								gitValueRevision: item.basis.gitValueRevision,
								workspaceRevision: item.basis.workspaceRevision,
								sourceFingerprint: item.basis.sourceFingerprint,
							},
						}
					: (() => {
							const { localeId: _localeId, ...rest } = item;
							return {
								...rest,
								basis: {
									kind: item.basis.kind,
									localeProposalId: item.basis
										.localeProposalId as Id<"localeProposals">,
									snapshotId: item.basis.snapshotId as Id<"sourceSnapshots">,
									sourceFingerprint: item.basis.sourceFingerprint,
								},
							};
						})(),
			);
			return agentJson(
				await withAgent(
					ctx,
					request,
					["read", "propose"],
					"agentTranslationProposal",
					async (token) =>
						await ctx.runMutation(
							internalApi.agentTranslationProposals.submitRevisions,
							{ token, proposalId, items },
						),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

// Both routes share the same bounded workflow; /pt remains a compatibility entry point.
for (const prefix of [
	"/api/agent/v1/locale-proposals",
	"/api/agent/v1/locale-proposals/pt",
]) {
	http.route({
		path: prefix,
		method: "POST",
		handler: httpAction(async (ctx, request) => {
			try {
				const localeCode = prefix.endsWith("/pt")
					? undefined
					: requiredJsonString(await jsonObject(request), "localeCode");
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await createOrResumeProposal(ctx, actor, localeCode),
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: prefix,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			try {
				const proposalId = localeProposalId(
					new URL(request.url).searchParams.get("proposalId"),
				);
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) => await readProposal(ctx, actor, proposalId),
						{ requireCliProtocol: prefix.endsWith("/pt") },
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: `${prefix}/template`,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			try {
				const url = new URL(request.url);
				const proposalId = localeProposalId(url.searchParams.get("proposalId"));
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await templateProposal(ctx, actor, {
								proposalId,
								cursor: Number(url.searchParams.get("cursor") ?? 0),
								limit: Number(url.searchParams.get("limit") ?? 16),
							}),
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: `${prefix}/values`,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			try {
				const url = new URL(request.url);
				const proposalId = localeProposalId(url.searchParams.get("proposalId"));
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await reviewProposalValues(ctx, actor, {
								proposalId,
								cursor: Number(url.searchParams.get("cursor") ?? 0),
								limit: Number(url.searchParams.get("limit") ?? 16),
							}),
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: `${prefix}/values`,
		method: "POST",
		handler: httpAction(async (ctx, request) => {
			try {
				const body = await jsonObject(request);
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await stageProposal(ctx, actor, {
								proposalId: localeProposalId(
									requiredJsonString(body, "proposalId"),
								),
								items: localeProposalValues(body),
							}),
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: `${prefix}/finalize`,
		method: "POST",
		handler: httpAction(async (ctx, request) => {
			try {
				const body = await jsonObject(request);
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await finalizeProposal(
								ctx,
								actor,
								localeProposalId(requiredJsonString(body, "proposalId")),
							),
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});

	http.route({
		path: `${prefix}/artifact`,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			try {
				const proposalId = localeProposalId(
					new URL(request.url).searchParams.get("proposalId"),
				);
				return agentJson(
					await withAgent(
						ctx,
						request,
						["read", "propose"],
						"agentLocaleProposal",
						async (_token, actor) =>
							await readProposalArtifact(ctx, actor, proposalId),
						{ requireCliProtocol: true },
					),
				);
			} catch (error) {
				return routeError(error);
			}
		}),
	});
}

http.route({
	pathPrefix: "/api/agent/v1/change-sets/",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		try {
			const id = new URL(request.url).pathname.replace(
				"/api/agent/v1/change-sets/",
				"",
			);
			return agentJson(
				await withAgent(
					ctx,
					request,
					"read",
					"agentRead",
					async (token) =>
						await ctx.runQuery(internalApi.agentApi.getChangeSet, {
							token,
							changeSetId: id as Id<"changeSets">,
						}),
				),
			);
		} catch (error) {
			return routeError(error);
		}
	}),
});

// Keep migration errors at the old transport addresses; no legacy write is registered.
for (const [path, method] of [
	["/strings/search", "GET"],
	["/context", "POST"],
	["/change-sets", "POST"],
	["/strings/tags", "POST"],
	["/export", "POST"],
] as const) {
	http.route({
		path: `/api/agent/v1${path}`,
		method,
		handler: httpAction(async () =>
			json(
				{
					code: "RETIRED_WORKFLOW",
					error:
						"Legacy catalog operations are retired. Use /workspace/search and /translation-tasks for proposals, or build a Ready Release Bundle for delivery.",
				},
				410,
			),
		),
	});
}

for (const method of ["GET", "POST"] as const) {
	http.route({
		pathPrefix: "/api/agent/v1/candidate-reviews/",
		method,
		handler: httpAction(async (ctx, request) => {
			try {
				const candidateRevisionId = new URL(request.url).pathname.slice(
					"/api/agent/v1/candidate-reviews/".length,
				);
				if (!candidateRevisionId || candidateRevisionId.includes("/"))
					throw new Error("Expected one exact candidate revision ID.");
				return agentJson(
					await withAgent(
						ctx,
						request,
						"review",
						method === "GET" ? "agentRead" : "agentReview",
						async (token) => {
							if (method === "GET")
								return await ctx.runQuery(
									internalApi.agentTranslationProposals.contextForAgentReview,
									{
										token,
										candidateRevisionId:
											candidateRevisionId as Id<"agentTranslationCandidateRevisions">,
									},
								);
							const body = await jsonObject(request);
							const reviewToken = requiredJsonString(body, "reviewToken");
							const decision = body.decision;
							if (
								!decision ||
								typeof decision !== "object" ||
								Array.isArray(decision)
							)
								throw new Error("Provide an exact accept or reject decision.");
							if (
								!("kind" in decision) ||
								(decision.kind !== "accept" && decision.kind !== "reject")
							)
								throw new Error(
									"Review agents can only accept or reject exact candidate revisions.",
								);
							const allowedFields =
								decision.kind === "reject" ? ["kind", "reason"] : ["kind"];
							if (
								Object.keys(decision).some(
									(key) => !allowedFields.includes(key),
								)
							)
								throw new Error("Review agents cannot edit candidate values.");
							const reason = "reason" in decision ? decision.reason : undefined;
							if (reason !== undefined && typeof reason !== "string")
								throw new Error("Review reason must be a string.");
							return await ctx.runMutation(
								internalApi.agentTranslationProposals.reviewCandidateForAgent,
								{
									token,
									candidateRevisionId:
										candidateRevisionId as Id<"agentTranslationCandidateRevisions">,
									reviewToken,
									decision:
										decision.kind === "accept"
											? { kind: "accept" }
											: {
													kind: "reject",
													...(reason === undefined ? {} : { reason }),
												},
								},
							);
						},
					),
				);
			} catch (error) {
				return routeError(error, {
					FORBIDDEN: 403,
					STALE_BASIS: 409,
					BAD_STATE: 409,
					NOT_FOUND: 404,
				});
			}
		}),
	});
}

export default http;
