#!/usr/bin/env node
// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	boundedNumber,
	cursor,
	endpoint,
	Failure,
	fetchJson,
	input,
	object,
} from "./blabla-agent.mjs";
import { CredentialError, resolveConnection } from "./credentials.mjs";

/** @typedef {Record<string, unknown>} RecordValue */
/** @typedef {{origin: URL, token: string}} Connection */
/** @typedef {{messageId: string, candidate: {kind: 'value', value: string} | {kind: 'intentionalBlank', reason: string}}} Candidate */
/** @typedef {{revisionId: string, reviewToken: string, decision: {kind: 'accept'} | {kind: 'reject', reason: string}}} Decision */
/** @typedef {{cursor: string | number | null, complete: boolean}} Checkpoint */
const PAGE_SIZE = 16;
const MAX_BYTES = 8 * 1024 * 1024;

/** @param {string} value */
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** @param {unknown} value @param {string} label @returns {RecordValue} */
function record(value, label) {
	if (!object(value))
		throw new Failure("INVALID_DATA", `${label} must be an object.`);
	return value;
}
/** @param {unknown} value @param {string} label */
function string(value, label) {
	if (typeof value !== "string" || !value.trim())
		throw new Failure("INVALID_DATA", `${label} must be a nonempty string.`);
	return value;
}
/** @param {unknown} value @param {string} label */
function id(value, label) {
	const result = string(value, label);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(result))
		throw new Failure("INVALID_DATA", `Invalid ${label}.`);
	return result;
}
/** @param {unknown} value @param {string} label */
function array(value, label) {
	if (!Array.isArray(value))
		throw new Failure("INVALID_DATA", `${label} must be an array.`);
	return /** @type {unknown[]} */ (value);
}
/** @param {string} path @returns {Promise<unknown>} */
async function read(path) {
	try {
		return (await input(path, 15000))?.value;
	} catch {
		throw new Failure("INVALID_STATE", `Cannot read valid JSON from ${path}.`);
	}
}
/** Atomic replacement: a killed process leaves the previous complete checkpoint.
 * @param {string} path @param {unknown} value */
async function save(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
/** @param {string} path @returns {Promise<unknown | null>} */
async function optional(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return null;
		throw new Failure("INVALID_STATE", `Invalid checkpoint: ${path}.`);
	}
}
/** A disappearing/replaced symlink can make readlink return EINVAL on macOS.
 * Retry only a confirmed symlink, within a bound; never remove an invalid lock.
 * @param {string} path @returns {Promise<string | null>} */
async function readLock(path) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await readlink(path);
		} catch (failure) {
			let reason = failure;
			if (object(failure) && failure.code === "ENOENT") return null;
			if (object(failure) && failure.code === "EINVAL") {
				let current;
				try {
					current = await lstat(path);
				} catch (error) {
					if (object(error) && error.code === "ENOENT") return null;
					reason = error;
				}
				if (current?.isSymbolicLink()) {
					if (attempt < 3) continue;
					throw new Failure(
						"BUSY",
						"Worker lock changed repeatedly while reading it. Resume this command with the same state.",
					);
				}
			}
			const code =
				object(reason) && typeof reason.code === "string"
					? ` (${reason.code})`
					: "";
			throw new Failure("INVALID_STATE", `Cannot read worker lock${code}.`);
		}
	}
}
/** Symlink creation publishes the owner atomically, including if killed during
 * acquisition. Dead owners are reclaimed under the same kind of lock; even a
 * killed reclaimer is recoverable. A live owner's lock is never removed.
 * @template T @param {string} path @param {() => Promise<T>} action @param {number} [waitMs] @returns {Promise<T>} */
async function locked(path, action, waitMs = 0) {
	const deadline = Date.now() + waitMs;
	const owner = JSON.stringify({
		pid: process.pid,
		host: hostname(),
		nonce: randomUUID(),
	});
	for (;;) {
		try {
			await symlink(owner, path);
			break;
		} catch (error) {
			if (!object(error) || error.code !== "EEXIST") throw error;
			const metadata = await readLock(path);
			if (metadata === null) continue;
			/** @type {unknown} */
			let previous;
			try {
				previous = JSON.parse(metadata);
			} catch {
				throw new Failure("INVALID_STATE", "Invalid worker lock JSON.");
			}
			if (
				object(previous) &&
				previous.host === hostname() &&
				typeof previous.pid === "number"
			) {
				let alive = true;
				try {
					process.kill(previous.pid, 0);
				} catch (failure) {
					alive = !(object(failure) && failure.code === "ESRCH");
				}
				if (!alive) {
					try {
						await locked(`${path}.reclaim`, async () => {
							try {
								if ((await readLock(path)) === JSON.stringify(previous))
									await rm(path, { force: true });
							} catch (failure) {
								if (!object(failure) || failure.code !== "ENOENT")
									throw failure;
							}
						});
						continue;
					} catch (failure) {
						if (!(failure instanceof Failure) || failure.info.code !== "BUSY")
							throw failure;
					}
				}
			}
			if (Date.now() >= deadline)
				throw new Failure(
					"BUSY",
					"Another worker owns this state. Resume after it exits; do not start overlapping work.",
				);
			await sleep(50);
		}
	}
	try {
		return await action();
	} finally {
		await rm(path, { force: true });
	}
}

/** Aggregate pacing is shared by all local workers using the same credential.
 * Rate limits and explicit contention on receipt-backed task reuse retry within
 * a bound. Unknown writes are recovered through task/review reads.
 * @param {Connection} auth */
function client(auth) {
	const directory = join(
		tmpdir(),
		`blabla-agent-${process.getuid?.() ?? "user"}`,
		hash(`${auth.origin.origin}\0${auth.token}`),
	);
	/** @param {string} method @param {string} path @param {RecordValue} [query] @param {unknown} [body] */
	return async (method, path, query, body) => {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const bucket = path.startsWith("/translation-tasks/")
			? "translation"
			: method === "GET"
				? "read"
				: "review";
		const interval = bucket === "read" ? 550 : 1100;
		const schedule = join(directory, `${bucket}.json`);
		const deadline = Date.now() + 30000;
		for (let attempt = 0; ; attempt++) {
			// Release the scheduler lock while waiting so another worker's 429
			// can extend the cooldown. Recheck it before reserving a request.
			for (;;) {
				const delay = await locked(
					join(directory, `${bucket}.lock`),
					async () => {
						const previous = await optional(schedule);
						const next =
							object(previous) && typeof previous.next === "number"
								? previous.next
								: 0;
						const delay = Math.max(0, next - Date.now());
						if (Date.now() + delay > deadline)
							throw new Failure(
								"RATE_LIMITED",
								"Shared request budget is busy. Resume this command later.",
								429,
								delay,
							);
						if (delay === 0)
							await save(schedule, { next: Date.now() + interval });
						return delay;
					},
					30000,
				);
				if (delay === 0) break;
				await sleep(delay);
			}
			try {
				return (
					await fetchJson({
						url: endpoint(auth.origin, path, query),
						method,
						token: auth.token,
						body: body === undefined ? undefined : JSON.stringify(body),
						maxBytes: MAX_BYTES,
						timeoutMs: 15000,
					})
				).value;
			} catch (error) {
				if (!(error instanceof Failure)) throw error;
				const reuseContention =
					method === "POST" &&
					/^\/translation-tasks\/[^/]+\/reuse$/.test(path) &&
					error.info.status === 503 &&
					error.info.code === "WRITE_CONTENTION";
				if (error.info.status !== 429 && !reuseContention) throw error;
				const delay =
					Math.max(error.info.retryAfterMs ?? 2000, interval) *
					(reuseContention ? 2 ** attempt : 1);
				await locked(
					join(directory, `${bucket}.lock`),
					async () => {
						const previous = await optional(schedule);
						await save(schedule, {
							next: Math.max(
								object(previous) && typeof previous.next === "number"
									? previous.next
									: 0,
								Date.now() + delay,
							),
						});
					},
					30000,
				);
				if (attempt >= 3 || Date.now() + delay > deadline) throw error;
			}
		}
	};
}
/** @typedef {ReturnType<typeof client>} Client */

/** @param {unknown} value */
function page(value) {
	const result = record(value, "Task page");
	const task = record(result.task, "Task");
	id(task.taskId, "taskId");
	string(task.localeCode, "localeCode");
	if (
		!Number.isSafeInteger(task.targetCount) ||
		Number(task.targetCount) < 0 ||
		!cursor(result.nextCursor)
	)
		throw new Failure(
			"INVALID_RESPONSE",
			"Invalid task count or continuation.",
		);
	const targets = array(result.targets, "targets").map((value) => {
		const target = record(value, "Target");
		string(target.messageId, "messageId");
		if (
			typeof target.sourceValue !== "string" ||
			!(target.candidate === null || object(target.candidate))
		)
			throw new Failure("INVALID_RESPONSE", "Invalid task target.");
		if (object(target.candidate)) {
			id(target.candidate.revisionId, "candidate revisionId");
			if (typeof target.candidate.value !== "string")
				throw new Failure("INVALID_RESPONSE", "Candidate value is missing.");
		}
		return target;
	});
	if (
		targets.length > PAGE_SIZE ||
		new Set(targets.map((target) => target.messageId)).size !== targets.length
	)
		throw new Failure(
			"INVALID_RESPONSE",
			"Oversized page or duplicate task messages.",
		);
	return {
		...result,
		task,
		targets,
		guidance: result.guidance,
		nextCursor: result.nextCursor,
	};
}
/** @param {RecordValue} target */
function reviewKind(target) {
	if (!object(target.candidate)) return "missing";
	const review = target.candidate.latestReview;
	if (review === null || review === undefined) return "pendingReview";
	const kind = record(
		record(review, "Review").decision,
		"Review decision",
	).kind;
	if (kind === "intentionalBlank") return "intentionalBlank";
	if (kind === "reject") return "rejected";
	if (
		kind === "accept" ||
		kind === "acceptWithEdits" ||
		kind === "keepForCurrentSource"
	)
		return "accepted";
	throw new Failure(
		"INVALID_RESPONSE",
		"Unknown review decision; completion cannot be established.",
	);
}
/** @param {unknown} value @returns {Candidate[]} */
function candidates(value) {
	const items = array(record(value, "Submission").items, "items");
	if (!items.length || items.length > PAGE_SIZE)
		throw new Failure("INVALID_DATA", "Submit 1–16 candidates at a time.");
	const parsed = items.map((value) => {
		const item = record(value, "Candidate item");
		const messageId = string(item.messageId, "messageId");
		const candidate = record(item.candidate, "candidate");
		if (
			candidate.kind === "value" &&
			typeof candidate.value === "string" &&
			candidate.value.trim()
		)
			return {
				messageId,
				candidate: {
					kind: /** @type {const} */ ("value"),
					value: candidate.value,
				},
			};
		if (candidate.kind === "intentionalBlank")
			return {
				messageId,
				candidate: {
					kind: /** @type {const} */ ("intentionalBlank"),
					reason: string(candidate.reason, "blank reason"),
				},
			};
		throw new Failure(
			"INVALID_DATA",
			"Provide a nonempty value or an intentional blank with a reason.",
		);
	});
	if (new Set(parsed.map((item) => item.messageId)).size !== parsed.length)
		throw new Failure("INVALID_DATA", "Duplicate candidate messages.");
	return parsed;
}
/** @param {unknown} value @returns {Decision[]} */
function decisions(value) {
	const items = array(record(value, "Decisions").items, "items");
	if (!items.length || items.length > PAGE_SIZE)
		throw new Failure("INVALID_DATA", "Decide 1–16 exact revisions at a time.");
	const parsed = items.map((value) => {
		const item = record(value, "Decision item");
		const revisionId = id(item.revisionId, "revisionId");
		const reviewToken = string(item.reviewToken, "reviewToken");
		const verdict = record(
			item.decision,
			"decision (fill every assigned verdict explicitly)",
		);
		if (verdict.kind === "accept")
			return {
				revisionId,
				reviewToken,
				decision: { kind: /** @type {const} */ ("accept") },
			};
		if (verdict.kind === "reject")
			return {
				revisionId,
				reviewToken,
				decision: {
					kind: /** @type {const} */ ("reject"),
					reason: string(verdict.reason, "rejection reason"),
				},
			};
		throw new Failure(
			"INVALID_DATA",
			"Every review requires an explicit accept or reject decision.",
		);
	});
	if (new Set(parsed.map((item) => item.revisionId)).size !== parsed.length)
		throw new Failure(
			"INVALID_DATA",
			"Conflicting or duplicate revision decisions.",
		);
	return parsed;
}

/** @param {Client} api @param {string} taskId @param {string | number | null} position */
async function getPage(api, taskId, position) {
	const result = page(
		await api("GET", `/translation-tasks/${taskId}`, {
			cursor: position ?? 0,
			limit: PAGE_SIZE,
		}),
	);
	if (result.task.taskId !== taskId)
		throw new Failure("INVALID_RESPONSE", "The API returned a different task.");
	if (result.nextCursor !== null && result.nextCursor === position)
		throw new Failure("PAGINATION_PROTOCOL", "The task repeated its cursor.");
	return result;
}
/** @param {unknown} value @returns {Checkpoint} */
function checkpoint(value) {
	if (value === null) return { cursor: 0, complete: false };
	const state = record(value, "Checkpoint");
	if (!cursor(state.cursor) || typeof state.complete !== "boolean")
		throw new Failure("INVALID_STATE", "Invalid scan checkpoint.");
	return { cursor: state.cursor, complete: state.complete };
}
/** @param {ReturnType<typeof page>} current @param {string} directory */
async function handoff(current, directory) {
	const revisions = current.targets.flatMap((target) =>
		object(target.candidate) && reviewKind(target) === "pendingReview"
			? [
					{
						taskId: current.task.taskId,
						localeCode: current.task.localeCode,
						messageId: target.messageId,
						revisionId: id(target.candidate.revisionId, "revisionId"),
					},
				]
			: [],
	);
	if (!revisions.length) return { path: null, revisions };
	const path = join(
		directory,
		`handoff-${hash(JSON.stringify(revisions)).slice(0, 16)}.json`,
	);
	await save(path, { revisions });
	return { path, revisions };
}
/** @param {Client} api @param {string} taskId @param {string} directory */
async function taskRead(api, taskId, directory, restart = false) {
	const submission = await optional(join(directory, "submission.json"));
	if (object(submission) && submission.outcome === "unknown")
		throw new Failure(
			"UNKNOWN_WRITE",
			"Resume task submit with submission.json as --body to recover the unfinished write before reading another page.",
		);
	if (restart)
		await save(join(directory, "cursor.json"), { cursor: 0, complete: false });
	const progress = checkpoint(await optional(join(directory, "cursor.json")));
	if (progress.complete)
		return {
			taskId,
			submittedScopeComplete: true,
			next: "task status (fresh server review coverage)",
		};
	const current = await getPage(api, taskId, progress.cursor);
	await save(join(directory, "page.json"), {
		cursor: progress.cursor,
		page: current,
	});
	const pending = current.targets.filter((target) =>
		["missing", "rejected"].includes(reviewKind(target)),
	);
	const review = await handoff(current, directory);
	if (!pending.length)
		await save(join(directory, "cursor.json"), {
			cursor: current.nextCursor,
			complete: current.nextCursor === null,
		});
	return {
		...current,
		work: pending.map((target) => target.messageId),
		reviewHandoff: review.path,
		submittedScopeComplete: !pending.length && current.nextCursor === null,
		next: pending.length
			? "Translate this page, then task submit. Rejected terminal tasks need a correction task."
			: "Hand off pending reviews; task read continues the saved cursor.",
	};
}
/** @param {RecordValue} target @param {Candidate} item */
function sameCandidate(target, item) {
	if (!object(target.candidate)) return false;
	return item.candidate.kind === "value"
		? target.candidate.value === item.candidate.value &&
				!target.candidate.intentionalBlankReason
		: target.candidate.value === "" &&
				target.candidate.intentionalBlankReason === item.candidate.reason;
}
/** @param {Client} api @param {string} taskId @param {string} directory @param {unknown} body */
async function taskSubmit(api, taskId, directory, body) {
	const items = candidates(body);
	const saved = record(await read(join(directory, "page.json")), "Saved page");
	if (!cursor(saved.cursor))
		throw new Failure("INVALID_STATE", "Read the task page before submitting.");
	const before = page(saved.page);
	const current = await getPage(api, taskId, saved.cursor);
	if (
		before.task.taskId !== taskId ||
		before.task.localeCode !== current.task.localeCode ||
		before.task.format !== current.task.format ||
		JSON.stringify(before.guidance) !== JSON.stringify(current.guidance)
	)
		throw new Failure(
			"REASSESS",
			"Task identity or guidance changed. Read and reassess the page.",
		);
	const pending = items.filter((item) => {
		const prior = before.targets.find(
			(target) => target.messageId === item.messageId,
		);
		const live = current.targets.find(
			(target) => target.messageId === item.messageId,
		);
		if (!prior || !live)
			throw new Failure(
				"INVALID_DATA",
				"Submission includes a message outside the saved page.",
			);
		if (
			prior.sourceValue !== live.sourceValue ||
			JSON.stringify(prior.source) !== JSON.stringify(live.source) ||
			prior.context !== live.context ||
			prior.characterLimit !== live.characterLimit
		)
			throw new Failure(
				"REASSESS",
				`Source, target or limits changed for ${item.messageId}. Read and reassess.`,
			);
		if (sameCandidate(live, item)) return false;
		if (
			prior.targetValue !== live.targetValue ||
			JSON.stringify(prior.candidate) !== JSON.stringify(live.candidate)
		)
			throw new Failure(
				"REASSESS",
				`Target or candidate feedback changed for ${item.messageId}. Read and reassess.`,
			);
		if (["accepted", "intentionalBlank"].includes(reviewKind(live)))
			throw new Failure(
				"ALREADY_REVIEWED",
				`Preserve reviewed ${item.messageId}; use an explicitly assigned correction task.`,
			);
		const limit = live.characterLimit;
		if (
			typeof limit === "number" &&
			item.candidate.kind === "value" &&
			[...item.candidate.value].length > limit
		)
			throw new Failure(
				"CHARACTER_LIMIT_EXCEEDED",
				`${item.messageId} exceeds ${limit} Unicode code points. Shorten and resubmit.`,
			);
		return true;
	});
	const intentPath = join(directory, "submission.json");
	const previous = await optional(intentPath);
	if (
		object(previous) &&
		previous.outcome === "unknown" &&
		JSON.stringify(previous.items) !== JSON.stringify(items)
	)
		throw new Failure(
			"UNKNOWN_WRITE",
			"Recover the saved submission with the identical input before changing it.",
		);
	await save(intentPath, { items, outcome: "unknown", cursor: saved.cursor });
	if (pending.length) {
		try {
			const receipt = await api(
				"POST",
				`/translation-tasks/${taskId}/candidates`,
				undefined,
				{ items: pending },
			);
			await save(
				join(directory, `submission-${hash(JSON.stringify(items))}.json`),
				{ taskId, items: pending, receipt },
			);
		} catch (error) {
			if (
				error instanceof Failure &&
				error.info.status !== null &&
				error.info.status < 500
			)
				await save(intentPath, {
					items,
					outcome: "rejected",
					error: error.info,
				});
			throw error;
		}
	}
	// A fresh page also recovers a lost POST response without producing a revision.
	const after = await getPage(api, taskId, saved.cursor);
	for (const item of items) {
		const target = after.targets.find(
			(target) => target.messageId === item.messageId,
		);
		if (!target || !sameCandidate(target, item))
			throw new Failure(
				"REASSESS",
				"Submitted candidate differs from current server evidence; inspect the saved submission.",
			);
	}
	await save(intentPath, { items, outcome: "recorded", cursor: saved.cursor });
	await save(join(directory, "page.json"), {
		cursor: saved.cursor,
		page: after,
	});
	const remaining = after.targets
		.filter((target) => ["missing", "rejected"].includes(reviewKind(target)))
		.map((target) => target.messageId);
	if (!remaining.length)
		await save(join(directory, "cursor.json"), {
			cursor: after.nextCursor,
			complete: after.nextCursor === null,
		});
	const review = await handoff(after, directory);
	return {
		taskId,
		submitted: items.length,
		remainingOnPage: remaining,
		reviewHandoff: review.path,
		revisions: review.revisions,
		submittedScopeComplete: !remaining.length && after.nextCursor === null,
	};
}

/** Resume a bounded server scan; local draft counts never establish review coverage.
 * @param {Client} api @param {string} taskId @param {string} directory @param {number} maxPages @param {boolean} restart */
async function taskStatus(api, taskId, directory, maxPages, restart) {
	const path = join(directory, "status.json");
	const old = restart ? null : await optional(path);
	const saved = object(old) ? old : {};
	if (saved.complete === true && !restart) {
		const { rows: _rows, ...summary } = saved;
		return {
			...summary,
			next: "Use --restart for a fresh scan; this is recorded coverage, not live release readiness.",
		};
	}
	let position = cursor(saved.cursor) ? saved.cursor : 0;
	const rows = object(saved.rows) ? saved.rows : {};
	let total = typeof saved.total === "number" ? saved.total : null;
	const startedAt =
		typeof saved.startedAt === "string"
			? saved.startedAt
			: new Date().toISOString();
	for (let index = 0; index < maxPages; index++) {
		const current = await getPage(api, taskId, position);
		if (total !== null && total !== current.task.targetCount)
			throw new Failure(
				"REASSESS",
				"Task scope changed. Restart the coverage scan.",
			);
		total = Number(current.task.targetCount);
		for (const target of current.targets) {
			const key = string(target.messageId, "messageId");
			if (Object.hasOwn(rows, key))
				throw new Failure(
					"PAGINATION_PROTOCOL",
					"Task scan repeated a message. Restart instead of double counting.",
				);
			Object.defineProperty(rows, key, {
				value: {
					status: reviewKind(target),
					revisionId: object(target.candidate)
						? target.candidate.revisionId
						: null,
				},
				enumerable: true,
				writable: true,
			});
		}
		position = current.nextCursor;
		const counts = {
			accepted: 0,
			intentionalBlank: 0,
			rejected: 0,
			pendingReview: 0,
			missing: 0,
		};
		for (const row of Object.values(rows)) {
			const status = record(row, "Coverage row").status;
			if (typeof status !== "string" || !Object.hasOwn(counts, status))
				throw new Failure("INVALID_STATE", "Unknown coverage state.");
			counts[/** @type {keyof typeof counts} */ (status)]++;
		}
		const complete = position === null;
		if (complete && Object.keys(rows).length !== total)
			throw new Failure(
				"INCOMPLETE_SCOPE",
				"Scan ended without accounting for every task message.",
			);
		const result = {
			taskId,
			startedAt,
			observedAt: new Date().toISOString(),
			cursor: position,
			total,
			scanned: Object.keys(rows).length,
			complete,
			counts,
			allLatestReviewed:
				complete && counts.accepted + counts.intentionalBlank === total,
		};
		await save(path, { ...result, rows });
		if (complete || index === maxPages - 1)
			return {
				...result,
				next: complete
					? "Coverage observed. Finalize or deliver only through the target workflow."
					: "Repeat task status to resume this scan.",
			};
	}
	throw new Failure("INVALID_ARGUMENT", "Expected a positive page budget.");
}

/** @param {string} directory @param {string} revisionId @param {string} reviewToken */
function contextPath(directory, revisionId, reviewToken) {
	return join(directory, `context-${revisionId}-${hash(reviewToken)}.json`);
}
/** @param {Client} api @param {string} directory @param {unknown} body */
async function reviewRead(api, directory, body) {
	const revisions = array(
		record(body, "Review assignment").revisions,
		"revisions",
	).map((entry) => id(record(entry, "Revision").revisionId, "revisionId"));
	if (
		!revisions.length ||
		revisions.length > PAGE_SIZE ||
		new Set(revisions).size !== revisions.length
	)
		throw new Failure("INVALID_DATA", "Assign 1–16 distinct exact revisions.");
	const contexts = [];
	const templates = [];
	for (const revisionId of revisions) {
		const context = record(
			await api("GET", `/candidate-reviews/${revisionId}`),
			"Reviewer context",
		);
		if (context.candidateRevisionId !== revisionId)
			throw new Failure(
				"INVALID_RESPONSE",
				"Review context belongs to a different revision.",
			);
		if (context.kind === "recordedReview") {
			contexts.push({ revisionId, recorded: context.latestReview });
			continue;
		}
		if (context.kind !== "candidate")
			throw new Failure(
				"INVALID_RESPONSE",
				"Expected candidate review context.",
			);
		const reviewToken = string(context.reviewToken, "reviewToken");
		const file = contextPath(directory, revisionId, reviewToken);
		await save(file, context);
		contexts.push({ revisionId, file, basisIsCurrent: context.basisIsCurrent });
		templates.push({ revisionId, reviewToken, decision: null });
	}
	const template = join(directory, `decisions-${randomUUID()}.json`);
	await save(template, { items: templates });
	return {
		contexts,
		decisionTemplate: template,
		next: "Read each context file and independently assess it. Fill explicit verdicts in the template, then review submit.",
	};
}
/** @param {RecordValue} current @param {Decision} item @param {RecordValue} assessed */
function matchingRecordedReview(current, item, assessed) {
	const review = record(current.latestReview, "Recorded review");
	const decision = record(review.decision, "Recorded decision");
	if (item.decision.kind === "reject")
		return (
			decision.kind === "reject" && decision.reason === item.decision.reason
		);
	const candidate = record(assessed.candidate, "Assessed candidate");
	return typeof candidate.intentionalBlankReason === "string"
		? decision.kind === "intentionalBlank" &&
				decision.reason === candidate.intentionalBlankReason
		: decision.kind === "accept";
}
/** Never refresh an assessed token or transfer a verdict between revisions.
 * @param {Client} api @param {string} directory @param {unknown} body */
async function reviewSubmit(api, directory, body) {
	const items = decisions(body);
	// Validate the complete input before making even the first write.
	const assessments = await Promise.all(
		items.map(async (item) => {
			const assessed = record(
				await read(contextPath(directory, item.revisionId, item.reviewToken)),
				"Assessed context",
			);
			if (
				assessed.kind !== "candidate" ||
				assessed.candidateRevisionId !== item.revisionId ||
				assessed.reviewToken !== item.reviewToken
			)
				throw new Failure(
					"REASSESS",
					"Decision must name the exact revision and token read by this reviewer.",
				);
			const prior = await optional(
				join(
					directory,
					`decision-${item.revisionId}-${hash(item.reviewToken)}.json`,
				),
			);
			if (prior !== null && JSON.stringify(prior) !== JSON.stringify(item))
				throw new Failure(
					"CONFLICTING_DECISION",
					"This assessed revision already has a different saved verdict.",
				);
			return assessed;
		}),
	);
	const results = [];
	for (const [index, item] of items.entries()) {
		const assessed = assessments[index];
		await save(
			join(
				directory,
				`decision-${item.revisionId}-${hash(item.reviewToken)}.json`,
			),
			item,
		);
		try {
			let current = record(
				await api("GET", `/candidate-reviews/${item.revisionId}`),
				"Review context",
			);
			if (current.candidateRevisionId !== item.revisionId)
				throw new Failure(
					"INVALID_RESPONSE",
					"Different review revision returned.",
				);
			if (current.kind !== "recordedReview") {
				if (
					current.kind !== "candidate" ||
					current.reviewToken !== item.reviewToken
				)
					throw new Failure(
						"REASSESS",
						"Review facts or permission changed. Read and assess again; the previous verdict was not replayed.",
					);
				try {
					await api(
						"POST",
						`/candidate-reviews/${item.revisionId}`,
						undefined,
						{ reviewToken: item.reviewToken, decision: item.decision },
					);
				} catch (error) {
					// A lost response might have committed. Read the same revision, but
					// never obtain a fresh token and silently reuse the old judgment.
					current = record(
						await api("GET", `/candidate-reviews/${item.revisionId}`),
						"Recovered review",
					);
					if (current.kind !== "recordedReview") throw error;
				}
				if (current.kind !== "recordedReview")
					current = record(
						await api("GET", `/candidate-reviews/${item.revisionId}`),
						"Recorded review",
					);
			}
			if (
				current.candidateRevisionId !== item.revisionId ||
				current.kind !== "recordedReview" ||
				!matchingRecordedReview(current, item, assessed)
			)
				throw new Failure(
					"CONFLICTING_REVIEW",
					"The server recorded a different verdict; inspect it instead of claiming this decision succeeded.",
				);
			const receipt = {
				revisionId: item.revisionId,
				status: "recorded",
				review: current.latestReview,
			};
			await save(join(directory, `receipt-${item.revisionId}.json`), receipt);
			results.push(receipt);
		} catch (error) {
			const failure =
				error instanceof Failure
					? error.info
					: new Failure(
							"REQUEST_FAILED",
							"Review recording stopped; resume from the exact saved decision.",
						).info;
			results.push({
				revisionId: item.revisionId,
				status: "blocked",
				error: failure,
			});
		}
	}
	return {
		results,
		complete: results.every((result) => result.status === "recorded"),
	};
}

/** Reuse receipts are server-owned. Persist the request key before the first
 * POST and advance only after saving the exact receipt and review handoff.
 * @param {Client} api @param {string} taskId @param {string} sourceTaskId @param {string} directory @param {number} maxPages */
async function taskReuse(api, taskId, sourceTaskId, directory, maxPages) {
	const checkpointPath = join(directory, "reuse.json");
	const saved = await optional(checkpointPath);
	const progress =
		saved === null
			? {
					clientReuseKey: `workflow-reuse:${randomUUID()}`,
					cursor: 0,
					complete: false,
					sourceTaskId,
					destinationTaskId: taskId,
				}
			: record(saved, "Reuse checkpoint");
	if (
		progress.sourceTaskId !== sourceTaskId ||
		progress.destinationTaskId !== taskId ||
		typeof progress.complete !== "boolean" ||
		!Number.isSafeInteger(progress.cursor) ||
		Number(progress.cursor) < 0
	)
		throw new Failure(
			"IDENTITY_MISMATCH",
			"Reuse state belongs to another task pair or has an invalid cursor.",
		);
	const clientReuseKey = string(progress.clientReuseKey, "clientReuseKey");
	await save(checkpointPath, progress);
	const pages = [];
	for (
		let pageIndex = 0;
		pageIndex < maxPages && !progress.complete;
		pageIndex++
	) {
		const position = Number(progress.cursor);
		const receipt = record(
			await api("POST", `/translation-tasks/${taskId}/reuse`, undefined, {
				sourceTaskId,
				clientReuseKey,
				cursor: position,
			}),
			"Reuse receipt",
		);
		const items = array(receipt.items, "Reuse items").map((item) =>
			record(item, "Reuse item"),
		);
		if (
			receipt.sourceTaskId !== sourceTaskId ||
			receipt.destinationTaskId !== taskId ||
			receipt.clientReuseKey !== clientReuseKey ||
			items.length > PAGE_SIZE ||
			new Set(items.map((item) => string(item.messageId, "messageId"))).size !==
				items.length ||
			!(
				receipt.nextCursor === null ||
				(Number.isSafeInteger(receipt.nextCursor) &&
					Number(receipt.nextCursor) > position)
			)
		)
			throw new Failure(
				"INVALID_RESPONSE",
				"Invalid reuse receipt or continuation.",
			);
		const revisions = [];
		for (const item of items) {
			if (
				![
					"copied",
					"alreadyCopied",
					"unreviewed",
					"sourceChanged",
					"incompatibleSource",
					"outsideDestination",
					"occupiedDestination",
					"invalidDestination",
				].includes(string(item.status, "reuse status"))
			)
				throw new Failure("INVALID_RESPONSE", "Unknown reuse result.");
			if (["copied", "alreadyCopied"].includes(String(item.status)))
				revisions.push({ revisionId: id(item.revisionId, "revisionId") });
		}
		const receiptPath = join(directory, `reuse-page-${position}.json`);
		const handoffPath = join(directory, `reuse-handoff-${position}.json`);
		await save(receiptPath, receipt);
		await save(handoffPath, { revisions });
		progress.cursor = receipt.nextCursor ?? position;
		progress.complete = receipt.nextCursor === null;
		await save(checkpointPath, progress);
		pages.push({ receipt: receiptPath, reviewHandoff: handoffPath, items });
	}
	return {
		taskId,
		sourceTaskId,
		clientReuseKey,
		pages,
		complete: progress.complete,
		next: progress.complete
			? "Independently review copied revisions; task status observes coverage."
			: "Repeat task reuse with the same state and source to continue.",
	};
}

const help = `Blabla resumable workflow (Node.js 22+)
node blabla-workflow.mjs task read|submit|status TASK_ID --state DIRECTORY [--profile NAME]
node blabla-workflow.mjs task reuse DESTINATION_TASK_ID --source SOURCE_TASK_ID --state DIRECTORY [--profile NAME]
node blabla-workflow.mjs review read|submit --state DIRECTORY --body FILE [--profile NAME]

task read returns at most 16 targets with live guidance; submit takes the ordinary
{items:[{messageId,candidate:{kind:"value",value:"..."}}]} body (--body FILE).
The cursor advances only when the page has candidates; repeated reads preserve work.
Submissions use the server's ICU and character-limit validation and save review handoffs.
task reuse copies exact reviewed authorship as fresh pending candidates, saves receipts
and review handoffs, and scans 4 source pages per call. Use separate reuse state.
task status scans 4 pages per call (--max-pages 1..32), checkpoints, and resumes.
Use --restart to start a fresh status scan after edits/reviews; old observations are dated.
review read takes {revisions:[{revisionId:"..."}]} (max 16) and writes authoritative
context files plus a decision template. Read those files before filling verdicts.
review submit takes {items:[{revisionId,reviewToken,decision:{kind:"accept"}}]}.
Rejection requires {kind:"reject",reason:"..."}. Missing verdicts never accept.
Use a separate reviewer agent, credential, and state directory. State binds one
credential and role. Local workers share rate pacing; one worker owns each state.
Only rejected 429 requests retry automatically. Changed facts require reassessment.
No API credentials are written to workflow state. Review tokens are exact-context evidence.
`;

/** @param {string[]} argv */
export async function main(argv) {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0]))
		return process.stdout.write(help);
	const [role, command, ...rest] = argv;
	if (
		!(
			(role === "task" &&
				["read", "submit", "status", "reuse"].includes(command)) ||
			(role === "review" && ["read", "submit"].includes(command))
		)
	)
		throw new Failure("USAGE", help);
	const taskId = role === "task" ? id(rest.shift(), "taskId") : null;
	const stateRole = command === "reuse" ? "reuse" : role;
	const flags = new Map(/** @type {[string, string][]} */ ([]));
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (
			![
				"--state",
				"--profile",
				"--body",
				"--max-pages",
				"--restart",
				"--source",
			].includes(flag) ||
			flags.has(flag)
		)
			throw new Failure(
				"INVALID_ARGUMENT",
				"Unknown or repeated workflow option.",
			);
		if (flag === "--restart") flags.set(flag, "true");
		else flags.set(flag, string(rest[++index], flag));
	}
	if (
		(flags.has("--max-pages") &&
			!(role === "task" && ["status", "reuse"].includes(command))) ||
		(flags.has("--restart") &&
			!(role === "task" && ["read", "status"].includes(command)))
	)
		throw new Failure(
			"INVALID_ARGUMENT",
			"--max-pages is for task status or reuse; --restart is for task read or status.",
		);
	if (
		flags.has("--source") !== (command === "reuse") ||
		(command === "reuse" && flags.has("--body"))
	)
		throw new Failure(
			"INVALID_ARGUMENT",
			"task reuse requires --source and does not take --body.",
		);
	const sourceTaskId =
		command === "reuse" ? id(flags.get("--source"), "--source taskId") : null;
	const directory = resolve(string(flags.get("--state"), "--state directory"));
	const auth = await resolveConnection(process.env, flags.get("--profile"));
	const api = client(auth);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return await locked(join(directory, "worker.lock"), async () => {
		const fingerprint = hash(`${auth.origin.origin}\0${auth.token}`);
		const bindingPath = join(directory, "binding.json");
		const binding = await optional(bindingPath);
		if (binding !== null) {
			if (
				!object(binding) ||
				binding.version !== 1 ||
				binding.credential !== fingerprint ||
				binding.role !== stateRole ||
				binding.taskId !== taskId
			)
				throw new Failure(
					"IDENTITY_MISMATCH",
					"State belongs to another task, credential, or role. Use its assigned worker and state directory.",
				);
		} else {
			const project = record(
				await api("GET", "/projects/current"),
				"Project discovery",
			);
			const scopes = array(project.tokenScopes, "tokenScopes");
			if (
				!scopes.includes("read") ||
				(role === "review"
					? !scopes.includes("review") || scopes.includes("propose")
					: !scopes.includes("propose") || scopes.includes("review"))
			)
				throw new Failure(
					"WRONG_ROLE",
					"Use only the assigned translation or dedicated reviewer credential.",
				);
			await save(bindingPath, {
				version: 1,
				credential: fingerprint,
				origin: auth.origin.origin,
				projectId: project.projectId,
				role: stateRole,
				taskId,
			});
		}
		const body = flags.has("--body")
			? (await input(flags.get("--body"), 15000))?.value
			: undefined;
		const result =
			role === "review"
				? command === "read"
					? await reviewRead(api, directory, body)
					: await reviewSubmit(api, directory, body)
				: taskId === null
					? null
					: command === "reuse" && sourceTaskId !== null
						? await taskReuse(
								api,
								taskId,
								sourceTaskId,
								directory,
								boundedNumber(flags.get("--max-pages"), 4, 32),
							)
						: command === "read"
							? await taskRead(api, taskId, directory, flags.has("--restart"))
							: command === "submit"
								? await taskSubmit(api, taskId, directory, body)
								: await taskStatus(
										api,
										taskId,
										directory,
										boundedNumber(flags.get("--max-pages"), 4, 32),
										flags.has("--restart"),
									);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (
			result &&
			"complete" in result &&
			result.complete === false &&
			"results" in result
		)
			process.exitCode = 1;
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		const failure =
			error instanceof Failure
				? error.info
				: error instanceof CredentialError
					? new Failure("CONFIGURATION", error.message).info
					: new Failure(
							"WORKFLOW_FAILED",
							"Workflow stopped. Its last complete checkpoint is preserved.",
						).info;
		process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
		process.exitCode = 1;
	}
}
