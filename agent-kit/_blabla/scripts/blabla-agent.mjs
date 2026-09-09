#!/usr/bin/env node
// @ts-check
import { createReadStream } from "node:fs";
import { CredentialError, resolveConnection } from "./credentials.mjs";

/** @typedef {null | boolean | number | string | unknown[] | {[key: string]: unknown}} Json */
/** @typedef {string | number | null} Cursor */
/** @typedef {{status: number | null, code: string, retryAfterMs: number | null, message: string}} FailureInfo */
/** @typedef {{mode: 'request' | 'scan', method: string, path: string, profile?: string, queryFile?: string, bodyFile?: string, maxPages: number, maxBytes: number, timeoutMs: number}} Options */
const MAX_BYTES = 8 * 1024 * 1024;
const PREFIX = "/api/agent/v1";

class Failure extends Error {
	/** @param {string} code @param {string} message @param {number | null} [status] @param {number | null} [retryAfterMs] */
	constructor(code, message, status = null, retryAfterMs = null) {
		super(message);
		this.info = { status, code, retryAfterMs, message };
	}
}
/** @param {unknown} value @returns {value is {[key: string]: unknown}} */
function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {string | undefined} value @param {number} fallback @param {number} maximum */
function boundedNumber(value, fallback, maximum) {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
		throw new Failure(
			"INVALID_ARGUMENT",
			"A numeric option is outside its supported bounds.",
		);
	return Number(value);
}
/** @param {string[]} argv @returns {Options} */
function options(argv) {
	const [mode, rawMethod, path, ...flags] = argv;
	if ((mode !== "request" && mode !== "scan") || !rawMethod || !path)
		throw new Failure(
			"USAGE",
			"Use request|scan METHOD /path [--query file.json] [--body file.json] [--max-pages N] [--max-bytes N] [--timeout-ms N].",
		);
	const method = rawMethod.toUpperCase();
	if (
		!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
			method,
		)
	)
		throw new Failure("INVALID_ARGUMENT", "Unsupported HTTP method.");
	if (
		path.length > 2048 ||
		!/^\/[A-Za-z0-9_/-]*$/.test(path) ||
		path.includes("//")
	)
		throw new Failure(
			"INVALID_PATH",
			"Use a relative Agent API path without query strings, fragments, escapes, or traversal.",
		);
	/** @type {Map<string, string>} */ const values = new Map();
	const allowed = new Set([
		"--profile",
		"--query",
		"--body",
		"--max-pages",
		"--max-bytes",
		"--timeout-ms",
	]);
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!allowed.has(flag) || !value || values.has(flag))
			throw new Failure(
				"INVALID_ARGUMENT",
				"Unknown, repeated, or incomplete option.",
			);
		values.set(flag, value);
	}
	if (mode === "request" && values.has("--max-pages"))
		throw new Failure("INVALID_ARGUMENT", "--max-pages applies only to scan.");
	if ((method === "GET" || method === "HEAD") && values.has("--body"))
		throw new Failure(
			"INVALID_ARGUMENT",
			"GET and HEAD requests cannot carry a body.",
		);
	if (values.get("--query") === "-" && values.get("--body") === "-")
		throw new Failure("INVALID_ARGUMENT", "Only one input may consume stdin.");
	if (
		mode === "scan" &&
		!(
			(method === "GET" &&
				(/^\/(workspace\/(search|work|ordinary-confirmations)|dictionary)$/.test(
					path,
				) ||
					/^\/translation-tasks\/[A-Za-z0-9_-]+$/.test(path) ||
					/^\/collections\/[A-Za-z0-9_-]+\/search$/.test(path))) ||
			(method === "POST" && path === "/proposal-examples/search")
		)
	)
		throw new Failure(
			"SCAN_NOT_ALLOWED",
			"Scan is restricted to paginated read endpoints; use request for other operations.",
		);
	return {
		mode,
		method,
		path,
		profile: values.get("--profile"),
		queryFile: values.get("--query"),
		bodyFile: values.get("--body"),
		maxPages: boundedNumber(values.get("--max-pages"), 4, 32),
		maxBytes: boundedNumber(
			values.get("--max-bytes"),
			mode === "scan" ? 1024 * 1024 : MAX_BYTES,
			MAX_BYTES,
		),
		timeoutMs: boundedNumber(values.get("--timeout-ms"), 15000, 60000),
	};
}
/** @param {string | undefined} file @param {number} timeoutMs @returns {Promise<{text: string, value: Json} | undefined>} */
async function input(file, timeoutMs) {
	if (!file) return undefined;
	const stream = file === "-" ? process.stdin : createReadStream(file);
	const timer = setTimeout(
		() => stream.destroy(new Failure("TIMEOUT", "JSON input timed out.")),
		timeoutMs,
	);
	try {
		const chunks = [];
		let bytes = 0;
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.byteLength;
			if (bytes > MAX_BYTES)
				throw new Failure("INPUT_TOO_LARGE", "JSON input exceeds 8 MiB.");
			chunks.push(buffer);
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks),
		);
		return { text, value: JSON.parse(text) };
	} catch (error) {
		if (error instanceof Failure) throw error;
		throw new Failure(
			"INVALID_INPUT",
			"Could not read valid UTF-8 JSON input.",
		);
	} finally {
		clearTimeout(timer);
		stream.destroy();
	}
}
/** @param {URL} origin @param {string} path @param {Json | undefined} query */
function endpoint(origin, path, query) {
	const url = new URL(`${PREFIX}${path}`, origin);
	if (query !== undefined && !object(query))
		throw new Failure(
			"INVALID_INPUT",
			"Query JSON must be an object of scalar values or arrays of scalars.",
		);
	for (const [key, raw] of Object.entries(query ?? {})) {
		for (const value of Array.isArray(raw) ? raw : [raw]) {
			if (!["string", "boolean", "number"].includes(typeof value))
				throw new Failure(
					"INVALID_INPUT",
					"Query JSON values must be strings, numbers, booleans, or arrays of those values.",
				);
			url.searchParams.append(key, String(value));
		}
	}
	return url;
}
/** @param {Headers} headers @param {Json | undefined} body */
function retryAfter(headers, body) {
	const value = headers.get("retry-after");
	if (value !== null) {
		if (/^\d+(?:\.\d+)?$/.test(value.trim()))
			return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(Number(value) * 1000));
		const date = /[A-Za-z]{3}/.test(value) ? Date.parse(value) : Number.NaN;
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	const milliseconds = object(body) ? body.retryAfter : undefined;
	return typeof milliseconds === "number" &&
		Number.isFinite(milliseconds) &&
		milliseconds >= 0
		? milliseconds
		: null;
}
/** @param {Json | undefined} value @param {string} token */
function responseCode(value, token) {
	const code = object(value) ? value.code : undefined;
	return typeof code === "string" &&
		/^[A-Z][A-Z0-9_]{0,63}$/.test(code) &&
		!code.includes(token)
		? code
		: "HTTP_ERROR";
}
/** Preserve actionable API validation text without logging credentials or stacks.
 * @param {Json | undefined} value @param {string} token */
function responseMessage(value, token) {
	const raw = object(value) ? value.error : undefined;
	if (typeof raw !== "string") return "The API rejected the request.";
	const message = raw
		.replaceAll(token, "[REDACTED]")
		.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
		.split(/[\r\n]/, 1)[0]
		.trim()
		.slice(0, 2048);
	return message && message !== "[REDACTED]" && !/^at\s/.test(message)
		? message
		: "The API rejected the request.";
}
/** @param {{url: URL, method: string, token: string, body?: string, maxBytes: number, timeoutMs: number}} args */
async function fetchJson(args) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), args.timeoutMs);
	try {
		const response = await fetch(args.url, {
			method: args.method,
			headers: {
				Authorization: `Bearer ${args.token}`,
				Accept: "application/json",
				...(args.body === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			body: args.body,
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400)
			throw new Failure(
				"REDIRECT_REJECTED",
				"Redirects are not followed.",
				response.status,
			);
		const reader = response.body?.getReader();
		const chunks = [];
		let bytes = 0;
		if (reader) {
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > args.maxBytes)
						throw response.ok
							? new Failure(
									"RESPONSE_TOO_LARGE",
									"Response exceeded the remaining byte budget.",
									response.status,
								)
							: new Failure(
									"HTTP_ERROR",
									"The API rejected the request.",
									response.status,
									retryAfter(response.headers, undefined),
								);
					chunks.push(part.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		let text;
		let value;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks),
			);
			value = /** @type {Json} */ (JSON.parse(text));
		} catch {
			if (response.ok)
				throw new Failure(
					"INVALID_RESPONSE",
					"The API did not return valid UTF-8 JSON.",
					response.status,
				);
		}
		if (!response.ok)
			throw new Failure(
				responseCode(value, args.token),
				responseMessage(value, args.token),
				response.status,
				retryAfter(response.headers, value),
			);
		if (text === undefined || value === undefined)
			throw new Failure(
				"INVALID_RESPONSE",
				"The API did not return JSON.",
				response.status,
			);
		return { text, value, bytes };
	} catch (error) {
		if (error instanceof Failure) throw error;
		throw new Failure(
			controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
			controller.signal.aborted
				? "The API request timed out."
				: "The API request could not be completed.",
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
/** @param {unknown} value @returns {value is Cursor} */
function cursor(value) {
	return (
		value === null ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}
/** @param {Options} config @param {{origin: URL, token: string}} auth @param {Json | undefined} query @param {{text: string, value: Json} | undefined} body */
async function scan(config, auth, query, body) {
	if (
		(query !== undefined && !object(query)) ||
		(body !== undefined && !object(body.value))
	)
		throw new Failure(
			"INVALID_INPUT",
			"Scan query and body inputs must be JSON objects.",
		);
	const baseQuery = object(query) ? query : {};
	const baseBody = object(body?.value) ? body.value : {};
	if (config.method !== "GET" && "cursor" in baseQuery)
		throw new Failure(
			"INVALID_INPUT",
			"POST scans accept cursors only in the body JSON.",
		);
	const original = config.method === "GET" ? baseQuery.cursor : baseBody.cursor;
	if (original !== undefined && !cursor(original))
		throw new Failure(
			"INVALID_INPUT",
			"A cursor must be an opaque string, nonnegative integer, or null.",
		);
	/** @type {Cursor} */ let nextCursor = original ?? null;
	/** @type {Json[]} */ const pages = [];
	const seen = new Set(nextCursor === null ? [] : [JSON.stringify(nextCursor)]);
	let bytes = 0;
	for (let page = 0; page < config.maxPages; page++) {
		if (bytes >= config.maxBytes)
			return { pages, nextCursor, complete: false, stopReason: "maxBytes" };
		try {
			const nextQuery = { ...baseQuery };
			const nextBody = { ...baseBody };
			const destination = config.method === "GET" ? nextQuery : nextBody;
			if (nextCursor === null) delete destination.cursor;
			else destination.cursor = nextCursor;
			const result = await fetchJson({
				url: endpoint(auth.origin, config.path, nextQuery),
				method: config.method,
				token: auth.token,
				body: config.method === "GET" ? undefined : JSON.stringify(nextBody),
				timeoutMs: config.timeoutMs,
				maxBytes: config.maxBytes - bytes,
			});
			if (
				!object(result.value) ||
				!("nextCursor" in result.value) ||
				!cursor(result.value.nextCursor)
			)
				throw new Failure(
					"PAGINATION_PROTOCOL",
					"A paginated API page must include nextCursor as a string, nonnegative integer, or null.",
				);
			const following = result.value.nextCursor;
			if (following !== null && seen.has(JSON.stringify(following)))
				throw new Failure(
					"PAGINATION_PROTOCOL",
					"The API repeated a cursor; scanning stopped.",
				);
			pages.push(result.value);
			bytes += result.bytes;
			nextCursor = following;
			if (following === null)
				return { pages, nextCursor, complete: true, stopReason: "complete" };
			seen.add(JSON.stringify(following));
		} catch (error) {
			if (
				error instanceof Failure &&
				error.info.code === "RESPONSE_TOO_LARGE" &&
				(error.info.status ?? 0) < 300
			)
				return { pages, nextCursor, complete: false, stopReason: "maxBytes" };
			const failure =
				error instanceof Failure
					? error.info
					: new Failure("REQUEST_FAILED", "Scanning stopped unexpectedly.")
							.info;
			return {
				pages,
				nextCursor,
				complete: false,
				stopReason: "error",
				error: failure,
			};
		}
	}
	return { pages, nextCursor, complete: false, stopReason: "maxPages" };
}

const help = `Blabla Agent API helper (Node.js 22+)

node blabla-agent.mjs request METHOD /path [--query query.json] [--body body.json]
node blabla-agent.mjs scan METHOD /path [--query query.json] [--body body.json]
  [--max-pages N] [--max-bytes N] [--timeout-ms N]

Select --profile NAME (or BLABLA_PROFILE), created with blabla login --profile NAME.
Alternatively set BLABLA_API_URL and BLABLA_TOKEN together. Legacy
BLABLA_AGENT_URL/BLABLA_AGENT_TOKEN are also supported as a pair.
Profiles and environment credentials cannot be mixed; missing profiles never fall back.
Paths are relative to /api/agent/v1. HTTP is allowed only for loopback testing.
JSON files carry exact data; one file may be '-' for stdin. Redirects are rejected.
request prints successful API JSON unchanged. No operation is automatically retried.
scan permits GET workspace or collection search, work/dictionary/ordinary-confirmations/task-detail and
POST /proposal-examples/search. Task inbox listing is request-only.
Scans preserve complete pages and opaque cursors, including empty intermediate pages.
Defaults: 4 pages (max 32), 1 MiB response bytes (max 8 MiB), 15000 ms per request
(max 60000 ms). request defaults to 8 MiB; --max-pages is scan-only.
Budget stops return complete:false and a resumable cursor; null before the first
accepted page means restart the original request. Only API nextCursor:null completes.
Errors are JSON; failed requests and scan errors exit nonzero. Partial scans keep
completed pages and the failing request's cursor in stdout. Request errors use stderr.
`;
if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
	process.stdout.write(help);
} else {
	try {
		const config = options(process.argv.slice(2));
		const auth = await resolveConnection(process.env, config.profile);
		const query = await input(config.queryFile, config.timeoutMs);
		const body = await input(config.bodyFile, config.timeoutMs);
		if (config.mode === "request") {
			const result = await fetchJson({
				url: endpoint(auth.origin, config.path, query?.value),
				method: config.method,
				token: auth.token,
				body: body?.text,
				maxBytes: config.maxBytes,
				timeoutMs: config.timeoutMs,
			});
			process.stdout.write(result.text);
		} else {
			const result = await scan(config, auth, query?.value, body);
			process.stdout.write(`${JSON.stringify(result)}\n`);
			if (result.stopReason === "error") process.exitCode = 1;
		}
	} catch (error) {
		const failure =
			error instanceof Failure
				? error.info
				: error instanceof CredentialError
					? new Failure("CONFIGURATION", error.message).info
					: new Failure("REQUEST_FAILED", "The request could not be completed.")
							.info;
		process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
		process.exitCode = 1;
	}
}
