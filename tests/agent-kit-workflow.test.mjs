// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
	new URL("../agent-kit/_blabla/scripts/blabla-workflow.mjs", import.meta.url),
);
const token = "workflow-test-credential";
/** @typedef {Record<string, unknown>} Row */
/** @param {import('node:http').ServerResponse} response @param {unknown} value @param {number} [status] */
function json(response, value, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}
/** @param {import('node:http').IncomingMessage} request @returns {Promise<Row>} */
async function body(request) {
	let text = "";
	for await (const chunk of request) text += chunk;
	return JSON.parse(text);
}
/** @param {'task' | 'review'} role @param {import('node:http').RequestListener} handler */
async function fixture(role, handler) {
	const directory = await mkdtemp(join(tmpdir(), "blabla-workflow-test-"));
	const server = createServer((request, response) => {
		if (request.url === "/api/agent/v1/projects/current")
			return json(response, {
				projectId: "project",
				tokenScopes: ["read", "search", role === "task" ? "propose" : "review"],
			});
		return handler(request, response);
	});
	await new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(null)),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No listening address");
	const url = `http://127.0.0.1:${address.port}`;
	/** @param {string[]} args @param {unknown} [input] @param {string} [state] */
	function start(args, input, state = "state") {
		const child = spawn(
			process.execPath,
			[
				script,
				...args,
				"--state",
				join(directory, state),
				...(input === undefined ? [] : ["--body", "-"]),
			],
			{
				env: {
					...process.env,
					BLABLA_PROFILE: undefined,
					BLABLA_API_URL: url,
					BLABLA_TOKEN: token,
					BLABLA_AGENT_URL: undefined,
					BLABLA_AGENT_TOKEN: undefined,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		const result = new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
		return { child, result };
	}
	return {
		directory,
		start,
		/** @param {string[]} args @param {unknown} [input] @param {string} [state] */
		async run(args, input, state) {
			return await start(args, input, state).result;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve(null)));
			await rm(directory, { recursive: true, force: true });
			const fingerprint = createHash("sha256")
				.update(`${url}\0${token}`)
				.digest("hex");
			await rm(
				join(
					tmpdir(),
					`blabla-agent-${process.getuid?.() ?? "user"}`,
					fingerprint,
				),
				{ recursive: true, force: true },
			);
		},
	};
}
/** @param {{code: number | null, stdout: string, stderr: string}} result @returns {Row} */
function ok(result) {
	assert.equal(result.code, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout);
}
/** @param {string} revisionId @param {string} [reviewToken] */
function context(revisionId, reviewToken = `token-${revisionId}`) {
	return {
		kind: "candidate",
		candidateRevisionId: revisionId,
		reviewToken,
		basisIsCurrent: true,
		candidate: { value: "Translated" },
	};
}
/** @param {string} revisionId @param {Row} decision */
function recorded(revisionId, decision) {
	return {
		kind: "recordedReview",
		candidateRevisionId: revisionId,
		latestReview: {
			decision,
			reviewer: { kind: "agent", name: "Independent reviewer" },
		},
	};
}
/** @param {string[]} revisionIds */
function assignment(...revisionIds) {
	return { revisions: revisionIds.map((revisionId) => ({ revisionId })) };
}

test("reviews require every exact verdict before writes; lost reject response recovers without acceptance or reposting", async (t) => {
	/** @type {Row[]} */ const posts = [];
	let committed = false;
	const server = await fixture("review", async (request, response) => {
		const revisionId = request.url?.split("/").at(-1) ?? "";
		if (request.method === "POST") {
			posts.push(await body(request));
			committed = true;
			response.destroy();
			return;
		}
		json(
			response,
			committed && revisionId === "rev1"
				? recorded("rev1", { kind: "reject", reason: "Wrong meaning" })
				: context(revisionId),
		);
	});
	t.after(() => server.close());
	const read = ok(
		await server.run(["review", "read"], assignment("rev1", "rev2")),
	);
	const template = JSON.parse(
		await readFile(String(read.decisionTemplate), "utf8"),
	);
	assert.equal(template.items[0].decision, null);
	const reject = {
		revisionId: "rev1",
		reviewToken: "token-rev1",
		decision: { kind: "reject", reason: "Wrong meaning" },
	};
	const incomplete = await server.run(["review", "submit"], {
		items: [reject, template.items[1]],
	});
	assert.equal(incomplete.code, 1);
	assert.equal(posts.length, 0);
	const wrongRevision = await server.run(["review", "submit"], {
		items: [{ ...reject, revisionId: "rev3" }],
	});
	assert.equal(wrongRevision.code, 1);
	assert.equal(posts.length, 0);
	assert.equal(
		ok(await server.run(["review", "submit"], { items: [reject] })).complete,
		true,
	);
	assert.equal(
		ok(await server.run(["review", "submit"], { items: [reject] })).complete,
		true,
	);
	assert.deepEqual(posts, [
		{ reviewToken: "token-rev1", decision: reject.decision },
	]);
	const conflict = await server.run(["review", "submit"], {
		items: [{ ...reject, decision: { kind: "accept" } }],
	});
	assert.equal(JSON.parse(conflict.stderr).error.code, "CONFLICTING_DECISION");
	assert.equal(posts.length, 1);
});

test("changed review evidence blocks the old verdict; reassessment and intentional-blank receipt work", async (t) => {
	let generation = "old";
	let accepted = false;
	let posts = 0;
	const server = await fixture("review", async (request, response) => {
		if (request.method === "POST") {
			posts++;
			assert.equal((await body(request)).reviewToken, "new");
			accepted = true;
			return json(response, { ok: true });
		}
		json(
			response,
			accepted
				? recorded("rev", {
						kind: "intentionalBlank",
						reason: "Hidden in this locale",
					})
				: {
						...context("rev", generation),
						candidate: {
							value: "",
							intentionalBlankReason: "Hidden in this locale",
						},
					},
		);
	});
	t.after(() => server.close());
	ok(await server.run(["review", "read"], assignment("rev")));
	generation = "new";
	const old = await server.run(["review", "submit"], {
		items: [
			{ revisionId: "rev", reviewToken: "old", decision: { kind: "accept" } },
		],
	});
	assert.equal(old.code, 1);
	assert.equal(JSON.parse(old.stdout).results[0].error.code, "REASSESS");
	assert.equal(posts, 0);
	ok(await server.run(["review", "read"], assignment("rev")));
	assert.equal(
		ok(
			await server.run(["review", "submit"], {
				items: [
					{
						revisionId: "rev",
						reviewToken: "new",
						decision: { kind: "accept" },
					},
				],
			}),
		).complete,
		true,
	);
	assert.equal(posts, 1);
});

test("candidate write survives a killed owner; resume recovers exact bytes and advances across an empty page", async (t) => {
	/** @type {Row | null} */ let candidate = null;
	let posts = 0;
	let wrote = () => {};
	const written = new Promise((resolve) => {
		wrote = () => resolve(null);
	});
	const server = await fixture("task", async (request, response) => {
		if (request.method === "POST") {
			posts++;
			const data = await body(request);
			const items = /** @type {{candidate: {value: string}}[]} */ (data.items);
			candidate = {
				revisionId: "rev",
				value: items[0].candidate.value,
				latestReview: null,
			};
			wrote();
			return; // Commit, then hold response until the worker is killed.
		}
		const position = new URL(
			request.url ?? "",
			"http://local",
		).searchParams.get("cursor");
		json(response, {
			task: { taskId: "task", localeCode: "de", targetCount: 1 },
			targets:
				position === "0"
					? []
					: [{ messageId: "message", sourceValue: "Text", candidate }],
			guidance: { voiceGuide: "Precise" },
			nextCursor: position === "0" ? 1 : null,
		});
	});
	t.after(() => server.close());
	assert.deepEqual(ok(await server.run(["task", "read", "task"])).work, []);
	assert.deepEqual(ok(await server.run(["task", "read", "task"])).work, [
		"message",
	]);
	const submission = {
		items: [
			{
				messageId: "message",
				candidate: { kind: "value", value: "Text\u00a0😀 {name}" },
			},
		],
	};
	const pending = server.start(["task", "submit", "task"], submission);
	t.after(() => pending.child.kill("SIGKILL"));
	await written;
	pending.child.kill("SIGKILL");
	await pending.result;
	assert.equal(
		JSON.parse((await server.run(["task", "read", "task"])).stderr).error.code,
		"UNKNOWN_WRITE",
	);
	const recovered = ok(
		await server.run(["task", "submit", "task"], submission),
	);
	assert.equal(recovered.submittedScopeComplete, true);
	assert.equal(posts, 1);
	const handoff = JSON.parse(
		await readFile(String(recovered.reviewHandoff), "utf8"),
	);
	assert.equal(handoff.revisions[0].revisionId, "rev");
	assert.equal(
		ok(await server.run(["task", "read", "task"])).submittedScopeComplete,
		true,
	);
	assert.equal(
		JSON.parse((await server.run(["task", "read", "different"])).stderr).error
			.code,
		"IDENTITY_MISMATCH",
	);
});

test("status counts blanks, rejected, pending and missing separately and resumes a bounded scan", async (t) => {
	/** @type {(Row | null)[]} */ const candidates = [
		{
			revisionId: "a",
			value: "yes",
			latestReview: { decision: { kind: "accept" } },
		},
		{
			revisionId: "b",
			value: "",
			intentionalBlankReason: "Hidden",
			latestReview: {
				decision: { kind: "intentionalBlank", reason: "Hidden" },
			},
		},
		{
			revisionId: "c",
			value: "bad",
			latestReview: { decision: { kind: "reject", reason: "Wrong" } },
		},
		{ revisionId: "d", value: "new", latestReview: null },
		null,
	];
	const server = await fixture("task", (request, response) => {
		const position = Number(
			new URL(request.url ?? "", "http://local").searchParams.get("cursor"),
		);
		json(response, {
			task: { taskId: "task", localeCode: "de", targetCount: 5 },
			targets: [
				{
					messageId: `m${position}`,
					sourceValue: "source",
					candidate: candidates[position],
				},
			],
			nextCursor: position === 4 ? null : position + 1,
		});
	});
	t.after(() => server.close());
	const partial = ok(
		await server.run(["task", "status", "task", "--max-pages", "2"]),
	);
	assert.equal(partial.complete, false);
	assert.equal(partial.cursor, 2);
	assert.deepEqual(partial.counts, {
		accepted: 1,
		intentionalBlank: 1,
		rejected: 0,
		pendingReview: 0,
		missing: 0,
	});
	const done = ok(await server.run(["task", "status", "task"]));
	assert.equal(done.complete, true);
	assert.equal(done.allLatestReviewed, false);
	assert.deepEqual(done.counts, {
		accepted: 1,
		intentionalBlank: 1,
		rejected: 1,
		pendingReview: 1,
		missing: 1,
	});
	assert.equal(
		ok(await server.run(["task", "status", "task"])).rows,
		undefined,
	);
});

test("shared credential pacing honors a 429 across concurrent reviewer states", async (t) => {
	/** @type {number[]} */ const times = [];
	const server = await fixture("review", (request, response) => {
		times.push(Date.now());
		if (times.length === 1) {
			response.setHeader("Retry-After", "1");
			return json(response, { code: "RATE_LIMITED" }, 429);
		}
		json(response, context(request.url?.split("/").at(-1) ?? ""));
	});
	t.after(() => server.close());
	const results = await Promise.all([
		server.run(["review", "read"], assignment("a"), "first"),
		server.run(["review", "read"], assignment("b"), "second"),
	]);
	for (const result of results) ok(result);
	assert.equal(times.length, 3);
	assert.ok(times[1] - times[0] >= 900, JSON.stringify(times));
	assert.ok(times[2] - times[1] >= 500, JSON.stringify(times));
});

test("candidate submissions stop on changed source, enforce Unicode limits, and preserve server contract failures", async (t) => {
	let sourceValue = "Original";
	let posts = 0;
	const server = await fixture("task", (request, response) => {
		if (request.method === "POST") {
			posts++;
			return json(
				response,
				{
					code: "CONTRACT_INVALID",
					error: "Unexpected ICU argument: otherName",
				},
				400,
			);
		}
		json(response, {
			task: { taskId: "task", localeCode: "de", targetCount: 1 },
			targets: [
				{
					messageId: "message",
					sourceValue,
					candidate: null,
					characterLimit: 4,
				},
			],
			nextCursor: null,
		});
	});
	t.after(() => server.close());
	ok(await server.run(["task", "read", "task"]));
	sourceValue = "Changed";
	const short = {
		items: [
			{ messageId: "message", candidate: { kind: "value", value: "😀😀😀😀" } },
		],
	};
	assert.equal(
		JSON.parse((await server.run(["task", "submit", "task"], short)).stderr)
			.error.code,
		"REASSESS",
	);
	assert.equal(posts, 0);
	ok(await server.run(["task", "read", "task"]));
	const long = {
		items: [
			{
				messageId: "message",
				candidate: { kind: "value", value: "😀😀😀😀😀" },
			},
		],
	};
	assert.equal(
		JSON.parse((await server.run(["task", "submit", "task"], long)).stderr)
			.error.code,
		"CHARACTER_LIMIT_EXCEEDED",
	);
	assert.equal(posts, 0);
	const invalid = await server.run(["task", "submit", "task"], short);
	assert.equal(JSON.parse(invalid.stderr).error.code, "CONTRACT_INVALID");
	assert.match(invalid.stderr, /Unexpected ICU argument/);
	assert.equal(posts, 1);
	assert.deepEqual(ok(await server.run(["task", "read", "task"])).work, [
		"message",
	]);
});

test("task reuse resumes a lost response with the same request key and saves exact pending-review handoffs", async () => {
	const requests = /** @type {Row[]} */ ([]);
	const receipts = /** @type {Map<unknown, Row>} */ (new Map());
	const longKey = `店铺.${"标题".repeat(100)}`;
	let loseResponse = true;
	const f = await fixture("task", async (request, response) => {
		assert.equal(
			request.url,
			"/api/agent/v1/translation-tasks/destination/reuse",
		);
		const input = await body(request);
		requests.push(input);
		const receipt = receipts.get(input.cursor) ?? {
			sourceTaskId: "source",
			destinationTaskId: "destination",
			clientReuseKey: input.clientReuseKey,
			items:
				Number(input.cursor) === 0
					? [
							{
								messageId: "store.subtitle",
								status: "copied",
								originRevisionId: "origin",
								revisionId: "fresh",
							},
							{
								messageId: longKey,
								status: "alreadyCopied",
								revisionId: "recovered",
							},
							{
								messageId: `跳过.${"長".repeat(200)}`,
								status: "incompatibleSource",
							},
						]
					: [{ messageId: "store.last", status: "unreviewed" }],
			nextCursor: Number(input.cursor) === 0 ? 16 : null,
		};
		// The server commits its exact receipt before the response is lost.
		receipts.set(input.cursor, receipt);
		if (loseResponse) {
			loseResponse = false;
			response.destroy();
			return;
		}
		json(response, receipt);
	});
	try {
		const args = [
			"task",
			"reuse",
			"destination",
			"--source",
			"source",
			"--max-pages",
			"1",
		];
		const failed = await f.run(args);
		assert.equal(failed.code, 1);
		assert.equal(
			JSON.parse(
				await readFile(join(f.directory, "state", "reuse.json"), "utf8"),
			).cursor,
			0,
		);
		const resumed = ok(await f.run(args));
		assert.equal(resumed.complete, false);
		assert.deepEqual(requests[0], requests[1]);
		assert.deepEqual(
			JSON.parse(
				await readFile(join(f.directory, "state", "reuse-page-0.json"), "utf8"),
			),
			receipts.get(0),
		);
		assert.equal(
			JSON.parse(
				await readFile(join(f.directory, "state", "reuse.json"), "utf8"),
			).cursor,
			16,
		);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(f.directory, "state", "reuse-handoff-0.json"),
					"utf8",
				),
			),
			{ revisions: [{ revisionId: "fresh" }, { revisionId: "recovered" }] },
		);
		const completed = ok(await f.run(args));
		assert.equal(completed.complete, true);
		assert.equal(requests[2].cursor, 16);
		assert.equal(requests[2].clientReuseKey, requests[0].clientReuseKey);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(f.directory, "state", "reuse-page-16.json"),
					"utf8",
				),
			),
			receipts.get(16),
		);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(f.directory, "state", "reuse-handoff-16.json"),
					"utf8",
				),
			),
			{ revisions: [] },
		);
		assert.equal(ok(await f.run(args)).complete, true);
		assert.equal(requests.length, 3);
		assert.equal(
			(await f.run(["task", "reuse", "destination", "--source", "different"]))
				.code,
			1,
		);
		assert.equal((await f.run(["task", "read", "destination"])).code, 1);
	} finally {
		await f.close();
	}
});
