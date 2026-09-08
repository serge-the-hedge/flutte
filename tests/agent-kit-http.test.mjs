// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
	new URL("../agent-kit/_blabla/scripts/blabla-agent.mjs", import.meta.url),
);
const token = "PRIVATE_TEST_TOKEN_47";
/** @param {import('node:http').RequestListener} handler */
async function fixture(handler) {
	const server = createServer(handler);
	await new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(null)),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected loopback address");
	const directory = await mkdtemp(join(tmpdir(), "blabla-agent-http-"));
	return {
		url: `http://127.0.0.1:${address.port}`,
		/** @param {string} name @param {unknown} value */
		async json(name, value) {
			const path = join(directory, name);
			await writeFile(path, JSON.stringify(value));
			return path;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve(null)));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
/** @param {string} url @param {string[]} args @param {{stdin?: string, env?: NodeJS.ProcessEnv}} [options] */
async function run(url, args, options = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], {
			env: {
				...process.env,
				BLABLA_AGENT_URL: url,
				BLABLA_AGENT_TOKEN: token,
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(options.stdin);
	});
}
/** @param {import('node:http').ServerResponse} response @param {unknown} value @param {number} [status] */
function json(response, value, status = 200) {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

test("request preserves exact writes and successful JSON; credentials stay in Authorization", async (t) => {
	let received = "";
	let calls = 0;
	const server = await fixture(async (request, response) => {
		calls++;
		assert.equal(request.url, "/api/agent/v1/dictionary/terms");
		assert.equal(request.headers.authorization, `Bearer ${token}`);
		for await (const chunk of request) received += chunk;
		response.end('{ "ok": true }\n');
	});
	t.after(() => server.close());
	const body =
		'{ "sourceTerm": "$(echo nope) `literal`", "value": "line 1\\nline 2", "remove": null }\n';
	const result = await run(
		server.url,
		["request", "POST", "/dictionary/terms", "--body", "-"],
		{ stdin: body },
	);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, '{ "ok": true }\n');
	assert.equal(received, body);
	assert.equal(calls, 1);
	assert.equal(result.stderr, "");
});

test("GET scans continue empty pages and preserve whole evidence pages", async (t) => {
	/** @type {(string | null)[]} */ const cursors = [];
	const server = await fixture((request, response) => {
		const url = new URL(request.url ?? "", "http://localhost");
		cursors.push(url.searchParams.get("cursor"));
		assert.equal(url.searchParams.get("q"), "a & b");
		json(
			response,
			cursors.length === 1
				? { items: [], provenance: { revision: 7 }, nextCursor: "opaque+next" }
				: { items: [{ evidence: "keep me" }], nextCursor: null },
		);
	});
	t.after(() => server.close());
	const query = await server.json("query.json", { q: "a & b" });
	const result = await run(server.url, [
		"scan",
		"GET",
		"/workspace/search",
		"--query",
		query,
	]);
	assert.equal(result.code, 0);
	assert.deepEqual(cursors, [null, "opaque+next"]);
	assert.deepEqual(JSON.parse(result.stdout), {
		pages: [
			{ items: [], provenance: { revision: 7 }, nextCursor: "opaque+next" },
			{ items: [{ evidence: "keep me" }], nextCursor: null },
		],
		nextCursor: null,
		complete: true,
		stopReason: "complete",
	});
});

test("proposal scans put cursors only in the POST body and stop at page budget", async (t) => {
	/** @type {Record<string, unknown>[]} */ const bodies = [];
	const server = await fixture(async (request, response) => {
		assert.equal(request.url, "/api/agent/v1/proposal-examples/search");
		let body = "";
		for await (const chunk of request) body += chunk;
		bodies.push(JSON.parse(body));
		json(response, { items: [], nextCursor: `cursor${bodies.length}` });
	});
	t.after(() => server.close());
	const body = await server.json("body.json", {
		scope: { kind: "task", taskId: "task" },
		q: "term",
	});
	const result = await run(server.url, [
		"scan",
		"POST",
		"/proposal-examples/search",
		"--body",
		body,
		"--max-pages",
		"2",
	]);
	assert.equal(result.code, 0);
	assert.equal(bodies[0].cursor, undefined);
	assert.equal(bodies[1].cursor, "cursor1");
	assert.deepEqual(JSON.parse(result.stdout), {
		pages: [
			{ items: [], nextCursor: "cursor1" },
			{ items: [], nextCursor: "cursor2" },
		],
		nextCursor: "cursor2",
		complete: false,
		stopReason: "maxPages",
	});
});

test("oversized streamed pages retain the previous cursor without claiming completion", async (t) => {
	let calls = 0;
	const server = await fixture((_request, response) => {
		calls++;
		if (calls === 1)
			json(response, { items: ["first"], nextCursor: "resume-here" });
		else {
			response.writeHead(200);
			response.write('{"items":["');
			response.end(`${"x".repeat(16 * 1024)}"],"nextCursor":null}`);
		}
	});
	t.after(() => server.close());
	const result = await run(server.url, [
		"scan",
		"GET",
		"/workspace/work",
		"--max-bytes",
		"128",
	]);
	assert.equal(result.code, 0);
	assert.equal(calls, 2);
	assert.deepEqual(JSON.parse(result.stdout), {
		pages: [{ items: ["first"], nextCursor: "resume-here" }],
		nextCursor: "resume-here",
		complete: false,
		stopReason: "maxBytes",
	});
});

test("429 exposes header seconds before JSON milliseconds without retrying writes or leaking secrets", async (t) => {
	let calls = 0;
	const server = await fixture((_request, response) => {
		calls++;
		response.setHeader("Retry-After", "2");
		json(
			response,
			{
				error: `${token}\n at secret stack`,
				code: "RATE_LIMITED",
				retryAfter: 17,
			},
			429,
		);
	});
	t.after(() => server.close());
	const result = await run(server.url, [
		"request",
		"POST",
		"/translation-tasks",
	]);
	assert.equal(result.code, 1);
	assert.equal(calls, 1);
	assert.equal(result.stdout, "");
	assert.deepEqual(JSON.parse(result.stderr).error, {
		status: 429,
		code: "RATE_LIMITED",
		retryAfterMs: 2000,
		message: "The API rejected the request.",
	});
	assert.ok(!result.stderr.includes(token));
	assert.ok(!result.stderr.includes("stack"));
});

test("retry timing supports HTTP dates and millisecond JSON fallback", async (t) => {
	let calls = 0;
	const deadline = Date.now() + 5000;
	const server = await fixture((_request, response) => {
		calls++;
		if (calls === 1)
			response.setHeader("Retry-After", new Date(deadline).toUTCString());
		json(response, { code: "RATE_LIMITED", retryAfter: 450 }, 429);
	});
	t.after(() => server.close());
	const first = JSON.parse(
		(await run(server.url, ["request", "GET", "/dictionary"])).stderr,
	);
	assert.ok(first.error.retryAfterMs > 0 && first.error.retryAfterMs <= 5000);
	const second = JSON.parse(
		(await run(server.url, ["request", "GET", "/dictionary"])).stderr,
	);
	assert.equal(second.error.retryAfterMs, 450);
});

test("mid-scan stale errors retain completed pages and the failing request cursor", async (t) => {
	let calls = 0;
	const server = await fixture((_request, response) => {
		calls++;
		json(
			response,
			calls === 1
				? { targets: [], nextCursor: 3 }
				: { code: "STALE_BASIS", error: token },
			calls === 1 ? 200 : 409,
		);
	});
	t.after(() => server.close());
	const result = await run(server.url, [
		"scan",
		"GET",
		"/translation-tasks/task_1",
	]);
	assert.equal(result.code, 1);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(output.pages, [{ targets: [], nextCursor: 3 }]);
	assert.equal(output.nextCursor, 3);
	assert.equal(output.complete, false);
	assert.equal(output.error.code, "STALE_BASIS");
	assert.equal(output.error.status, 409);
	assert.ok(!result.stdout.includes(token));
});

test("missing and repeated cursors are protocol failures", async (t) => {
	let repeated = false;
	const server = await fixture((_request, response) =>
		json(
			response,
			repeated ? { items: [], nextCursor: "same" } : { items: [] },
		),
	);
	t.after(() => server.close());
	const missing = await run(server.url, ["scan", "GET", "/dictionary"]);
	assert.equal(JSON.parse(missing.stdout).error.code, "PAGINATION_PROTOCOL");
	repeated = true;
	const result = await run(server.url, ["scan", "GET", "/dictionary"]);
	assert.equal(result.code, 1);
	assert.equal(JSON.parse(result.stdout).pages.length, 1);
	assert.equal(JSON.parse(result.stdout).nextCursor, "same");
});

test("redirects and unsafe paths never forward credentials", async (t) => {
	let calls = 0;
	const server = await fixture((_request, response) => {
		calls++;
		response.writeHead(302, { Location: `https://example.invalid/${token}` });
		response.end();
	});
	t.after(() => server.close());
	const redirect = await run(server.url, ["request", "GET", "/dictionary"]);
	assert.equal(JSON.parse(redirect.stderr).error.code, "REDIRECT_REJECTED");
	assert.equal(calls, 1);
	assert.ok(!redirect.stderr.includes(token));
	for (const path of [
		"https://example.invalid",
		"//example.invalid",
		"/../other",
		"/%2e%2e/other",
		"/dictionary?q=secret",
		"/dictionary#fragment",
		"/dictionary\\other",
	]) {
		const result = await run(server.url, ["request", "GET", path]);
		assert.equal(result.code, 1);
	}
	assert.equal(calls, 1);
	const scanWrite = await run(server.url, [
		"scan",
		"POST",
		"/dictionary/terms",
	]);
	assert.equal(JSON.parse(scanWrite.stderr).error.code, "SCAN_NOT_ALLOWED");
	assert.equal(calls, 1);
});

test("timeouts and invalid responses terminate with safe machine-readable errors", async (t) => {
	let hang = true;
	const server = await fixture((_request, response) => {
		if (hang) {
			response.writeHead(200);
			response.write("{");
		} else response.end(`not JSON ${token}`);
	});
	t.after(() => server.close());
	const timeout = await run(server.url, [
		"request",
		"GET",
		"/dictionary",
		"--timeout-ms",
		"100",
	]);
	assert.equal(JSON.parse(timeout.stderr).error.code, "TIMEOUT");
	assert.ok(!timeout.stderr.includes(token));
	hang = false;
	const invalid = await run(server.url, ["request", "GET", "/dictionary"]);
	assert.equal(JSON.parse(invalid.stderr).error.code, "INVALID_RESPONSE");
	assert.ok(!invalid.stderr.includes(token));
});

test("help needs no credentials and validation errors remain actionable with redaction", async (t) => {
	const server = await fixture((_request, response) =>
		json(
			response,
			{
				code: "VALIDATION",
				error: `Missing sourceTerm; token=${token}; Authorization: Bearer another-secret\n    at private/server.ts:42`,
			},
			400,
		),
	);
	t.after(() => server.close());
	const help = await run(server.url, ["--help"], {
		env: { BLABLA_AGENT_TOKEN: "", BLABLA_AGENT_URL: "" },
	});
	assert.equal(help.code, 0);
	assert.match(help.stdout, /Node.js 22\+/);
	assert.match(help.stdout, /--max-pages/);
	const result = await run(server.url, [
		"request",
		"POST",
		"/dictionary/terms",
	]);
	const error = JSON.parse(result.stderr).error;
	assert.match(error.message, /Missing sourceTerm/);
	assert.match(error.message, /REDACTED/);
	assert.ok(!result.stderr.includes(token));
	assert.ok(!result.stderr.includes("another-secret"));
	assert.ok(!result.stderr.includes("private/server"));
});

test("a rate-limited continuation keeps the completed pages and does not retry", async (t) => {
	let calls = 0;
	const server = await fixture((_request, response) => {
		calls++;
		if (calls === 1)
			json(response, {
				terms: [],
				revision: 4,
				nextCursor: "dictionary-page-2",
			});
		else {
			response.setHeader("Retry-After", "3");
			json(
				response,
				{ code: "RATE_LIMITED", error: "Rate limit exceeded." },
				429,
			);
		}
	});
	t.after(() => server.close());
	const result = await run(server.url, ["scan", "GET", "/dictionary"]);
	const output = JSON.parse(result.stdout);
	assert.equal(result.code, 1);
	assert.equal(calls, 2);
	assert.deepEqual(output.pages, [
		{ terms: [], revision: 4, nextCursor: "dictionary-page-2" },
	]);
	assert.equal(output.complete, false);
	assert.equal(output.nextCursor, "dictionary-page-2");
	assert.equal(output.error.status, 429);
	assert.equal(output.error.retryAfterMs, 3000);
});
