#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{path: string, sha256: string}} Reference */
/** @typedef {{revisionId: string, taskId: string, messageId: string, localeCode: string, supersedes: string | null}} Revision */
/** @typedef {{id: string, owner: string, handoff: Reference, reviewState: string, brief: Reference, evidence: Reference[], revisions: Revision[]}} Round */
/** @typedef {{code: string, message: string, path?: string}} Problem */
/** @typedef {{revisionId: string, path: string, review: Row, createdAt: number, kind: 'accept' | 'reject' | 'intentionalBlank'}} Observation */
/** @typedef {'accepted' | 'intentionalBlank' | 'rejected' | 'pendingReview' | 'missing'} Status */
const MAX_BYTES = 32 * 1024 * 1024;

class CampaignError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** @param {string | Buffer} value */
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** @param {unknown} value @param {string} label @returns {Row} */
function row(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CampaignError("INVALID_MANIFEST", `${label} must be an object.`);
	return /** @type {Row} */ (value);
}
/** @param {unknown} value @param {string} label */
function text(value, label) {
	if (typeof value !== "string" || !value.trim())
		throw new CampaignError(
			"INVALID_MANIFEST",
			`${label} must be a nonempty string.`,
		);
	return value;
}
/** @param {unknown} value @param {string} label */
function id(value, label) {
	const result = text(value, label);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(result))
		throw new CampaignError("INVALID_MANIFEST", `Invalid ${label}.`);
	return result;
}
/** @param {unknown} value @param {string} label @returns {unknown[]} */
function list(value, label) {
	if (!Array.isArray(value))
		throw new CampaignError("INVALID_MANIFEST", `${label} must be an array.`);
	return value;
}
/** @param {string} localeCode @param {string} messageId */
function pair(localeCode, messageId) {
	return JSON.stringify([localeCode, messageId]);
}
/** @param {string} path */
async function bytes(path) {
	if ((await stat(path)).size > MAX_BYTES)
		throw new CampaignError(
			"INVALID_DATA",
			`File exceeds ${MAX_BYTES} bytes: ${path}.`,
		);
	return readFile(path);
}
/** @param {string} path @returns {Promise<unknown>} */
async function json(path) {
	return JSON.parse((await bytes(path)).toString("utf8"));
}
/** @param {string} path */
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return false;
		throw error;
	}
}
/** @param {unknown} value @param {string} base @param {string} label @returns {Reference} */
function reference(value, base, label) {
	const data = row(value, label);
	const sha256 = text(data.sha256, `${label}.sha256`);
	if (!/^[a-f0-9]{64}$/.test(sha256))
		throw new CampaignError(
			"INVALID_MANIFEST",
			`${label}.sha256 must be a lowercase SHA-256 digest.`,
		);
	return { path: resolve(base, text(data.path, `${label}.path`)), sha256 };
}
/** @param {Reference} ref */
async function verify(ref) {
	const content = await bytes(ref.path);
	if (hash(content) !== ref.sha256)
		throw new CampaignError(
			"CHANGED_EVIDENCE",
			`Pinned evidence changed: ${ref.path}. Create an assigned immutable manifest at an idle boundary.`,
		);
	return content;
}
/** Resolve aliases even when a new review state directory has not been created.
 * @param {string} path @returns {Promise<string>} */
async function canonical(path) {
	try {
		return await realpath(path);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			)
		)
			throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(await canonical(parent), relative(parent, path));
	}
}

/** Read-only campaign interface. Receipts are observations; review authority and
 * live Source/target currency remain the official review workflow's responsibility.
 * @param {string} manifestPath @param {{owner?: string, expectManifest?: string, details?: boolean}} [options] */
export async function campaign(manifestPath, options = {}) {
	const path = resolve(manifestPath);
	const manifestBytes = await bytes(path);
	const manifestHash = hash(manifestBytes);
	if (
		options.expectManifest !== undefined &&
		options.expectManifest !== manifestHash
	)
		throw new CampaignError(
			"MANIFEST_CHANGED",
			"Manifest differs from the hash assigned to this reviewer.",
		);
	const manifest = row(JSON.parse(manifestBytes.toString("utf8")), "Manifest");
	if (manifest.version !== 1)
		throw new CampaignError(
			"INVALID_MANIFEST",
			"Expected campaign manifest version 1.",
		);
	const projectId = id(manifest.projectId, "projectId");
	const base = dirname(path);
	/** @type {Map<string, {localeCode: string, messageId: string}>} */
	const scope = new Map();
	const locales = new Set();
	for (const entry of list(manifest.scope, "scope")) {
		const group = row(entry, "Scope group");
		const localeCode = text(group.localeCode, "localeCode");
		if (locales.has(localeCode))
			throw new CampaignError(
				"DUPLICATE_SCOPE",
				`Repeated Locale: ${localeCode}.`,
			);
		locales.add(localeCode);
		for (const value of list(group.messageIds, "messageIds")) {
			const messageId = text(value, "messageId");
			const key = pair(localeCode, messageId);
			if (scope.has(key))
				throw new CampaignError(
					"DUPLICATE_SCOPE",
					`Repeated scope pair: ${key}.`,
				);
			scope.set(key, { localeCode, messageId });
		}
	}
	if (!scope.size)
		throw new CampaignError(
			"INVALID_MANIFEST",
			"Campaign scope must contain at least one pair.",
		);
	/** @type {Map<string, string | null>} */
	const latest = new Map();
	for (const entry of list(manifest.latest, "latest")) {
		const current = row(entry, "Latest revision");
		const key = pair(
			text(current.localeCode, "localeCode"),
			text(current.messageId, "messageId"),
		);
		if (!scope.has(key) || latest.has(key))
			throw new CampaignError(
				"AMBIGUOUS_LATEST",
				`Latest revision duplicates or lies outside expected scope: ${key}.`,
			);
		latest.set(
			key,
			current.revisionId === null ? null : id(current.revisionId, "revisionId"),
		);
	}
	if (latest.size !== scope.size)
		throw new CampaignError(
			"INCOMPLETE_SCOPE",
			"Explicit latest revisions must cover every expected pair (use null for missing candidates).",
		);
	/** @type {Map<string, Revision>} */
	const revisions = new Map();
	for (const entry of list(manifest.revisions, "revisions")) {
		const data = row(entry, "Revision");
		const revision = {
			revisionId: id(data.revisionId, "revisionId"),
			taskId: id(data.taskId, "taskId"),
			messageId: text(data.messageId, "messageId"),
			localeCode: text(data.localeCode, "localeCode"),
			supersedes:
				data.supersedes === undefined
					? null
					: id(data.supersedes, "supersedes"),
		};
		if (
			revisions.has(revision.revisionId) ||
			!scope.has(pair(revision.localeCode, revision.messageId))
		)
			throw new CampaignError(
				"AMBIGUOUS_REVISION",
				`Revision duplicates or lies outside expected scope: ${revision.revisionId}.`,
			);
		revisions.set(revision.revisionId, revision);
	}
	/** @type {Map<string, string>} */
	const successors = new Map();
	for (const revision of revisions.values()) {
		if (revision.supersedes === null) continue;
		const prior = revisions.get(revision.supersedes);
		if (
			!prior ||
			pair(prior.localeCode, prior.messageId) !==
				pair(revision.localeCode, revision.messageId) ||
			successors.has(prior.revisionId)
		)
			throw new CampaignError(
				"INVALID_CORRECTION",
				`Correction must name one existing prior revision of the same pair: ${revision.revisionId}.`,
			);
		successors.set(prior.revisionId, revision.revisionId);
	}
	for (const revision of revisions.values()) {
		const seen = new Set();
		let head = revision.revisionId;
		while (successors.has(head)) {
			if (seen.has(head))
				throw new CampaignError(
					"INVALID_CORRECTION",
					"Correction chain contains a cycle.",
				);
			seen.add(head);
			head = /** @type {string} */ (successors.get(head));
		}
		if (latest.get(pair(revision.localeCode, revision.messageId)) !== head)
			throw new CampaignError(
				"AMBIGUOUS_LATEST",
				`Every pair's revision chain must end at its explicit latest: ${revision.revisionId}.`,
			);
	}
	for (const [key, revisionId] of latest) {
		if (revisionId === null) continue;
		const revision = revisions.get(revisionId);
		if (!revision || pair(revision.localeCode, revision.messageId) !== key)
			throw new CampaignError(
				"AMBIGUOUS_LATEST",
				`Latest must name an exact revision of its pair: ${key}.`,
			);
	}
	/** @type {Map<string, string | null>} */
	const reviewers = new Map();
	for (const entry of list(manifest.reviewers, "reviewers")) {
		const reviewer = row(entry, "Reviewer assignment");
		const owner = text(reviewer.owner, "owner");
		if (reviewers.has(owner))
			throw new CampaignError(
				"DUPLICATE_OWNER",
				`Repeated reviewer owner: ${owner}.`,
			);
		reviewers.set(
			owner,
			reviewer.tokenId === undefined ? null : id(reviewer.tokenId, "tokenId"),
		);
	}
	if (options.owner !== undefined && !reviewers.has(options.owner))
		throw new CampaignError(
			"UNKNOWN_OWNER",
			"Reviewer owner is not assigned in this manifest.",
		);
	/** @type {Map<string, Round>} */
	const assignment = new Map();
	/** @type {Round[]} */
	const rounds = [];
	const roundIds = new Set();
	for (const entry of list(manifest.rounds, "rounds")) {
		const data = row(entry, "Round");
		const round = {
			id: text(data.id, "round id"),
			owner: text(data.owner, "round owner"),
			handoff: reference(data.handoff, base, "handoff"),
			reviewState: await canonical(
				resolve(base, text(data.reviewState, "reviewState")),
			),
			brief: reference(data.brief, base, "brief"),
			evidence: list(data.evidence ?? [], "evidence").map((ref) =>
				reference(ref, base, "evidence"),
			),
			revisions: /** @type {Revision[]} */ ([]),
		};
		if (!reviewers.has(round.owner) || roundIds.has(round.id))
			throw new CampaignError(
				"INVALID_OWNER",
				`Round must have a unique id and assigned reviewer: ${round.id}.`,
			);
		roundIds.add(round.id);
		for (const prior of rounds) {
			const relation = relative(prior.reviewState, round.reviewState);
			const reverse = relative(round.reviewState, prior.reviewState);
			if (
				relation === "" ||
				(!isAbsolute(relation) &&
					!relation.startsWith(`..${sep}`) &&
					relation !== "..") ||
				(!isAbsolute(reverse) &&
					!reverse.startsWith(`..${sep}`) &&
					reverse !== "..")
			)
				throw new CampaignError(
					"OVERLAPPING_STATE",
					"Each round requires a disjoint review state directory.",
				);
		}
		const handoff = row(
			JSON.parse((await verify(round.handoff)).toString("utf8")),
			"Handoff",
		);
		await verify(round.brief);
		for (const ref of round.evidence) await verify(ref);
		for (const item of list(handoff.revisions, "handoff revisions")) {
			const data = row(item, "Handoff revision");
			const revisionId = id(data.revisionId, "revisionId");
			const revision = revisions.get(revisionId);
			if (!revision || assignment.has(revisionId))
				throw new CampaignError(
					"DUPLICATE_OWNERSHIP",
					`Each revision must have exactly one round owner: ${revisionId}.`,
				);
			for (const field of /** @type {const} */ ([
				"taskId",
				"messageId",
				"localeCode",
			])) {
				if (data[field] !== undefined && data[field] !== revision[field])
					throw new CampaignError(
						"WRONG_HANDOFF",
						`Handoff metadata disagrees with exact revision: ${revisionId}.`,
					);
			}
			round.revisions.push(revision);
			assignment.set(revisionId, round);
		}
		if (!round.revisions.length || round.revisions.length > 16)
			throw new CampaignError(
				"INVALID_HANDOFF",
				"Each round must contain 1–16 distinct exact revisions.",
			);
		rounds.push(round);
	}
	if (assignment.size !== revisions.size)
		throw new CampaignError(
			"MISSING_OWNERSHIP",
			"Every revision must have exactly one assigned review round.",
		);

	/** @type {Problem[]} */
	const problems = [];
	/** @type {Map<string, Observation>} */
	const observations = new Map();
	/** @type {Map<string, string>} */
	const receiptClaims = new Map();
	const conflictingRevisions = new Set();
	const busy = new Set();
	for (const round of rounds) {
		if (!(await exists(round.reviewState))) continue;
		const files = await readdir(round.reviewState);
		if (files.includes("worker.lock")) busy.add(round.id);
		const receiptFiles = files.filter(
			(file) => file.startsWith("receipt-") && file.endsWith(".json"),
		);
		let bindingValid = true;
		try {
			if (receiptFiles.length || files.includes("binding.json")) {
				const binding = row(
					await json(resolve(round.reviewState, "binding.json")),
					"Review state binding",
				);
				if (
					binding.version !== 1 ||
					binding.projectId !== projectId ||
					binding.role !== "review" ||
					binding.taskId !== null
				)
					throw new CampaignError(
						"WRONG_STATE",
						"Review state belongs to another project or role.",
					);
			}
		} catch (error) {
			bindingValid = false;
			problems.push({
				code: "WRONG_STATE",
				message:
					error instanceof Error ? error.message : "Invalid state binding.",
				path: round.reviewState,
			});
		}
		for (const file of receiptFiles) {
			const receiptPath = resolve(round.reviewState, file);
			try {
				const receipt = row(await json(receiptPath), "Receipt");
				const revisionId = id(receipt.revisionId, "Receipt revisionId");
				const signature = stable(receipt.review);
				const claim = receiptClaims.get(revisionId);
				if (claim !== undefined && claim !== signature) {
					conflictingRevisions.add(revisionId);
					observations.delete(revisionId);
					throw new CampaignError(
						"CONFLICTING_RECEIPT",
						"The revision has conflicting recorded review evidence.",
					);
				}
				receiptClaims.set(revisionId, signature);
				if (
					file !== `receipt-${revisionId}.json` ||
					assignment.get(revisionId) !== round
				)
					throw new CampaignError(
						"WRONG_RECEIPT",
						"Receipt does not name an exact revision assigned to this round.",
					);
				const review = row(receipt.review, "Recorded review");
				const decision = row(review.decision, "Recorded decision");
				if (
					receipt.status !== "recorded" ||
					!["accept", "reject", "intentionalBlank"].includes(
						String(decision.kind),
					)
				)
					throw new CampaignError(
						"INVALID_RECEIPT",
						"Expected a server-recorded explicit decision.",
					);
				id(review.reviewId, "reviewId");
				const authorization = row(
					review.reviewAuthorization,
					"Recorded authorization",
				);
				const reviewer = row(review.reviewer, "Recorded reviewer");
				const tokenId = id(authorization.reviewerTokenId, "reviewerTokenId");
				if (
					authorization.candidateRevisionId !== revisionId ||
					!["projectPolicy", "candidateGrant"].includes(
						String(authorization.kind),
					) ||
					reviewer.kind !== "agent" ||
					reviewer.id !== tokenId ||
					(reviewers.get(round.owner) !== null &&
						reviewers.get(round.owner) !== tokenId)
				)
					throw new CampaignError(
						"WRONG_AUTHORIZATION",
						"Recorded authorization/reviewer must identify this exact revision and assigned reviewer.",
					);
				if (
					decision.kind !== "reject" &&
					(typeof review.finalValueFingerprint !== "string" ||
						!review.finalValueFingerprint.trim())
				)
					throw new CampaignError(
						"INVALID_RECEIPT",
						"Recorded acceptance must include its final value fingerprint.",
					);
				if (
					typeof review.createdAt !== "number" ||
					!Number.isFinite(review.createdAt) ||
					review.createdAt < 0
				)
					throw new CampaignError(
						"INVALID_RECEIPT",
						"Recorded review must include its server timestamp.",
					);
				if (bindingValid && !conflictingRevisions.has(revisionId))
					observations.set(revisionId, {
						revisionId,
						path: receiptPath,
						review,
						createdAt: review.createdAt,
						kind: /** @type {Observation['kind']} */ (decision.kind),
					});
			} catch (error) {
				problems.push({
					code: error instanceof CampaignError ? error.code : "INVALID_RECEIPT",
					message: error instanceof Error ? error.message : "Invalid receipt.",
					path: receiptPath,
				});
			}
		}
	}
	/** @param {string | null} revisionId @returns {Status} */
	function status(revisionId) {
		if (revisionId === null) return "missing";
		const observed = observations.get(revisionId);
		return !observed
			? "pendingReview"
			: observed.kind === "accept"
				? "accepted"
				: observed.kind === "reject"
					? "rejected"
					: "intentionalBlank";
	}
	const counts = emptyCounts();
	/** @type {Map<string, ReturnType<typeof emptyCounts>>} */
	const byLocale = new Map();
	/** @type {Map<string, ReturnType<typeof emptyCounts> & {pendingRounds: number, busyRounds: number}>} */
	const byOwner = new Map(
		[...reviewers.keys()].map((owner) => [
			owner,
			{ ...emptyCounts(), pendingRounds: 0, busyRounds: 0 },
		]),
	);
	const current = [...scope].map(([key, value]) => {
		const revisionId = latest.get(key) ?? null;
		const currentStatus = status(revisionId);
		counts[currentStatus]++;
		const localeCounts = byLocale.get(value.localeCode) ?? emptyCounts();
		localeCounts[currentStatus]++;
		byLocale.set(value.localeCode, localeCounts);
		const round = revisionId === null ? null : assignment.get(revisionId);
		const ownerCounts = round ? byOwner.get(round.owner) : null;
		if (ownerCounts) ownerCounts[currentStatus]++;
		const observed = revisionId === null ? null : observations.get(revisionId);
		const decision = observed
			? row(observed.review.decision, "Recorded decision")
			: null;
		return {
			...value,
			revisionId,
			status: currentStatus,
			roundId: round?.id ?? null,
			owner: round?.owner ?? null,
			receiptPath: observed?.path ?? null,
			reason:
				typeof decision?.reason === "string"
					? decision.reason.slice(0, 512)
					: null,
		};
	});
	const historicalCounts = {
		...emptyCounts(),
		total: revisions.size,
		resolvedAcceptedRejections: 0,
		supersededPendingRejections: 0,
		supersededRejectedRejections: 0,
	};
	const history = [...revisions.values()].map((revision) => {
		const latestId =
			latest.get(pair(revision.localeCode, revision.messageId)) ?? null;
		const revisionStatus = status(revision.revisionId);
		historicalCounts[revisionStatus]++;
		const isLatest = latestId === revision.revisionId;
		const latestStatus = status(latestId);
		const rejectionResolution =
			revisionStatus !== "rejected"
				? null
				: isLatest
					? "current-rejected"
					: ["accepted", "intentionalBlank"].includes(latestStatus)
						? "resolved-accepted"
						: latestStatus === "rejected"
							? "superseded-rejected"
							: "superseded-pending";
		if (rejectionResolution === "resolved-accepted")
			historicalCounts.resolvedAcceptedRejections++;
		if (rejectionResolution === "superseded-pending")
			historicalCounts.supersededPendingRejections++;
		if (rejectionResolution === "superseded-rejected")
			historicalCounts.supersededRejectedRejections++;
		const observed = observations.get(revision.revisionId);
		return {
			...revision,
			roundId: assignment.get(revision.revisionId)?.id,
			owner: assignment.get(revision.revisionId)?.owner,
			isLatest,
			status: revisionStatus,
			supersededBy: successors.get(revision.revisionId) ?? null,
			rejectionResolution,
			receipt: observed
				? {
						path: observed.path,
						createdAt: observed.createdAt,
						reviewId: observed.review.reviewId,
						decision: observed.review.decision,
					}
				: null,
		};
	});
	const roundStatus = rounds.map((round) => {
		const currentRevisions = round.revisions.filter(
			(revision) =>
				latest.get(pair(revision.localeCode, revision.messageId)) ===
				revision.revisionId,
		);
		const pendingRevisions = currentRevisions.filter(
			(revision) => !observations.has(revision.revisionId),
		);
		return {
			id: round.id,
			owner: round.owner,
			handoff: round.handoff.path,
			reviewState: round.reviewState,
			brief: round.brief.path,
			evidence: round.evidence.map((ref) => ref.path),
			correction: currentRevisions.some(
				(revision) => revision.supersedes !== null,
			),
			pendingRevisions,
			reviewHandoff: {
				revisions: pendingRevisions.map(({ revisionId }) => ({ revisionId })),
			},
			recordedRevisions: round.revisions
				.filter((revision) => observations.has(revision.revisionId))
				.map((revision) => revision.revisionId),
			supersededRevisions: round.revisions
				.filter((revision) => !currentRevisions.includes(revision))
				.map((revision) => revision.revisionId),
			busy: busy.has(round.id),
		};
	});
	const times = [...observations.values()].map(
		(observation) => observation.createdAt,
	);
	for (const round of roundStatus) {
		const owner = byOwner.get(round.owner);
		if (owner && round.pendingRevisions.length) owner.pendingRounds++;
		if (owner && round.busy) owner.busyRounds++;
	}
	const openFindings = current.filter((entry) => entry.status === "rejected");
	const pendingCorrections = current
		.filter(
			(entry) =>
				entry.status === "pendingReview" &&
				entry.revisionId !== null &&
				revisions.get(entry.revisionId)?.supersedes !== null,
		)
		.map((entry) => {
			/** @type {string[]} */
			const rejectedAncestors = [];
			let previous =
				entry.revisionId === null
					? null
					: (revisions.get(entry.revisionId)?.supersedes ?? null);
			while (previous !== null) {
				if (observations.get(previous)?.kind === "reject")
					rejectedAncestors.push(previous);
				previous = revisions.get(previous)?.supersedes ?? null;
			}
			return {
				...entry,
				priorRejectionCount: rejectedAncestors.length,
				priorRejectedRevisionIds: rejectedAncestors.slice(0, 16),
			};
		});
	const report = {
		manifest: path,
		manifestHash,
		projectId,
		observedAt: new Date().toISOString(),
		valid: problems.length === 0,
		problemCount: problems.length,
		problems: problems.slice(0, 16),
		scopeCount: scope.size,
		counts,
		byLocale: Object.fromEntries(byLocale),
		byOwner: Object.fromEntries(byOwner),
		historicalCounts,
		openFindingCount: openFindings.length,
		openFindings: openFindings.slice(0, 16),
		pendingCorrectionCount: pendingCorrections.length,
		pendingCorrections: pendingCorrections.slice(0, 16),
		unresolvedFindingCount:
			openFindings.length +
			pendingCorrections.filter((entry) => entry.priorRejectionCount > 0)
				.length,
		sampleLimit: 16,
		recordedAt: {
			earliest: times.length ? Math.min(...times) : null,
			latest: times.length ? Math.max(...times) : null,
		},
		allLatestRecordedAcceptance:
			problems.length === 0 &&
			counts.accepted + counts.intentionalBlank === scope.size,
		sourceCurrency: "notObserved",
		releaseReady: null,
		evidenceBoundary:
			"Local historical observations only; current authorization, Source/target currency and server coverage are not observed.",
		details: options.details
			? {
					current,
					history,
					rounds: roundStatus,
					problems,
					pendingCorrections,
					openFindings,
				}
			: undefined,
		next: "Run official task status for live coverage and currency; finalization/delivery remain separate target workflow actions.",
	};
	if (options.owner === undefined) return report;
	const assigned = roundStatus.filter(
		(round) => round.owner === options.owner && round.pendingRevisions.length,
	);
	const next =
		assigned.find((round) => round.correction) ?? assigned[0] ?? null;
	return {
		manifest: path,
		manifestHash,
		projectId,
		owner: options.owner,
		status: problems.length
			? "blocked"
			: next?.busy
				? "busy"
				: next
					? "ready"
					: "complete",
		problemCount: problems.length,
		problems: problems.slice(0, 16),
		pendingReview: byOwner.get(options.owner)?.pendingReview ?? 0,
		pendingRounds: byOwner.get(options.owner)?.pendingRounds ?? 0,
		round: problems.length ? null : next,
		evidenceBoundary: report.evidenceBoundary,
		next: problems.length
			? "Preserve state and resolve invalid evidence before reviewing."
			: next?.busy
				? "The original state contains a worker lock. The official workflow owns live/dead-lock recovery; resume that state without reassignment."
				: next
					? "Independently read reviewHandoff with this assigned review state and pinned brief/evidence, assess pending revisions and submit explicit verdicts through blabla-workflow.mjs. Repeat campaign next after recorded receipts."
					: "Assigned local queue has no pending latest revisions. Check campaign status and official task coverage; rejections require assigned corrections.",
	};
}

/** Compare JSON observations independently of object property order.
 * @param {unknown} value @returns {string} */
function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const data = /** @type {Row} */ (value);
		return `{${Object.keys(data)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(data[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function emptyCounts() {
	return {
		accepted: 0,
		intentionalBlank: 0,
		rejected: 0,
		pendingReview: 0,
		missing: 0,
	};
}

const help = `Usage: blabla-campaign.mjs status --manifest FILE [--details NEW_FILE]
       blabla-campaign.mjs next --manifest FILE --owner NAME [--expect-manifest SHA256]

Local, read-only campaign queue and receipt report. No profile, credential or network.
status prints compact totals and at most 16 examples per list; --details exclusively
creates a new detailed report file without changing inputs or printing all rows.
next returns an assigned exact handoff of at most 16 revisions and its original state.
Missing receipts stay pending. Recorded rejection completes review, but remains an
open current finding until an explicit correction supersedes it. Local acceptance
does not prove current Source, whole-task completion, finalization or release readiness.
`;

/** @param {string[]} argv */
export async function main(argv) {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
		process.stdout.write(help);
		return;
	}
	const [command, ...args] = argv;
	if (!["status", "next"].includes(command))
		throw new CampaignError("USAGE", help);
	const flags = new Map();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (
			!["--manifest", "--owner", "--expect-manifest", "--details"].includes(
				flag,
			) ||
			flags.has(flag)
		)
			throw new CampaignError("USAGE", help);
		const value = text(args[++index], flag);
		if (value.startsWith("--")) throw new CampaignError("USAGE", help);
		flags.set(flag, value);
	}
	if (
		(command === "next") !== flags.has("--owner") ||
		(command === "status" && flags.has("--expect-manifest")) ||
		(command === "next" && flags.has("--details"))
	)
		throw new CampaignError("USAGE", help);
	const result = await campaign(text(flags.get("--manifest"), "--manifest"), {
		owner: flags.get("--owner"),
		expectManifest: flags.get("--expect-manifest"),
		details: flags.has("--details"),
	});
	if ("details" in result && result.details && flags.has("--details")) {
		const detailsPath = resolve(text(flags.get("--details"), "--details"));
		await writeFile(detailsPath, `${JSON.stringify(result, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		result.details = undefined;
		Object.assign(result, { detailsFile: detailsPath });
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if (
		("valid" in result && !result.valid) ||
		("status" in result && ["blocked", "busy"].includes(result.status))
	)
		process.exitCode = 1;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(
			`${JSON.stringify({ error: { code: error instanceof CampaignError ? error.code : "INVALID_DATA", message: error instanceof Error ? error.message : "Cannot inspect campaign." } })}\n`,
		);
		process.exitCode = 1;
	});
}
