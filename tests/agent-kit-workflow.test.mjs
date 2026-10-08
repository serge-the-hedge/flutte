// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
/** @param {'task' | 'review'} role @param {import('node:http').RequestListener} handler @param {string} [preload] */
async function fixture(role, handler, preload) {
	const directory = await mkdtemp(join(tmpdir(), "blabla-workflow-test-"));
	const preloadPath = join(directory, "preload.mjs");
	if (preload) await writeFile(preloadPath, preload);
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
	const pacingDirectory = join(
		tmpdir(),
		`blabla-agent-${process.getuid?.() ?? "user"}`,
		createHash("sha256").update(`${url}\0${token}`).digest("hex"),
	);
	/** @param {string[]} args @param {unknown} [input] @param {string} [state] */
	function start(args, input, state = "state") {
		const child = spawn(
			process.execPath,
			[
				...(preload ? ["--import", preloadPath] : []),
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
		pacingDirectory,
		start,
		/** @param {string[]} args @param {unknown} [input] @param {string} [state] */
		async run(args, input, state) {
			return await start(args, input, state).result;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve(null)));
			await rm(directory, { recursive: true, force: true });
			await rm(pacingDirectory, { recursive: true, force: true });
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

test("review read recovers durable receipts without verdicts or writes, leaving undecided revisions pending", async (t) => {
	const recovered = recorded("reviewed", {
		kind: "reject",
		reason: "Changes the scanning limit",
	});
	const server = await fixture("review", (request, response) => {
		assert.equal(request.method, "GET");
		json(
			response,
			request.url?.endsWith("/reviewed") ? recovered : context("pending"),
		);
	});
	t.after(() => server.close());
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = ok(
			await server.run(["review", "read"], assignment("reviewed", "pending")),
		);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(server.directory, "state/receipt-reviewed.json"),
					"utf8",
				),
			),
			{
				revisionId: "reviewed",
				status: "recorded",
				review: recovered.latestReview,
			},
		);
		assert.deepEqual(
			JSON.parse(await readFile(String(result.decisionTemplate), "utf8")),
			{
				items: [
					{
						revisionId: "pending",
						reviewToken: "token-pending",
						decision: null,
					},
				],
			},
		);
		await assert.rejects(
			readFile(join(server.directory, "state/receipt-pending.json")),
			{ code: "ENOENT" },
		);
	}
});

test("review recovery preserves conflicting historical receipts and leaves equivalent observations byte-identical", async (t) => {
	const original = recorded("rev", { kind: "reject", reason: "Wrong limit" });
	let current = original;
	const server = await fixture("review", (request, response) => {
		assert.equal(request.method, "GET");
		json(response, current);
	});
	t.after(() => server.close());
	ok(await server.run(["review", "read"], assignment("rev")));
	const receiptPath = join(server.directory, "state/receipt-rev.json");
	const originalBytes = await readFile(receiptPath, "utf8");
	for (const decision of [
		{ kind: "accept" },
		{ kind: "reject", reason: "Different objection" },
	]) {
		current = recorded("rev", decision);
		const result = await server.run(["review", "read"], assignment("rev"));
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stderr).error.code, "CONFLICTING_RECEIPT");
		assert.equal(await readFile(receiptPath, "utf8"), originalBytes);
	}
	current = {
		...original,
		latestReview: {
			reviewer: original.latestReview.reviewer,
			decision: original.latestReview.decision,
		},
	};
	ok(await server.run(["review", "read"], assignment("rev")));
	assert.equal(await readFile(receiptPath, "utf8"), originalBytes);
});

test("submit recovery blocks conflicting receipt evidence without reposting or replacing history", async (t) => {
	let committed = false;
	const server = await fixture("review", (request, response) => {
		assert.equal(request.method, "GET");
		json(
			response,
			committed ? recorded("rev", { kind: "accept" }) : context("rev"),
		);
	});
	t.after(() => server.close());
	ok(await server.run(["review", "read"], assignment("rev")));
	const receiptPath = join(server.directory, "state/receipt-rev.json");
	const originalBytes = JSON.stringify({
		revisionId: "rev",
		status: "recorded",
		review: recorded("rev", { kind: "reject", reason: "Original objection" })
			.latestReview,
	});
	await writeFile(receiptPath, originalBytes);
	committed = true;
	const result = await server.run(["review", "submit"], {
		items: [
			{
				revisionId: "rev",
				reviewToken: "token-rev",
				decision: { kind: "accept" },
			},
		],
	});
	assert.equal(result.code, 1);
	const output = JSON.parse(result.stdout);
	assert.equal(output.complete, false);
	assert.equal(output.results[0].status, "blocked");
	assert.equal(output.results[0].error.code, "CONFLICTING_RECEIPT");
	assert.equal(await readFile(receiptPath, "utf8"), originalBytes);
});

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

test("inspect corrects an observed final page with fresh evidence and unknown-write recovery while preserving scan and status", async (t) => {
	let sourceValue = "Source";
	let voiceGuide = "Precise";
	/** @type {Row | null} */ let candidate = {
		revisionId: "rejected",
		value: "Old",
		latestReview: { decision: { kind: "reject", reason: "Wrong wording" } },
	};
	let posts = 0;
	/** @type {string[]} */ const reads = [];
	const server = await fixture("task", async (request, response) => {
		if (request.method === "POST") {
			assert.equal(
				request.url,
				"/api/agent/v1/translation-tasks/task/candidates",
			);
			assert.deepEqual(await body(request), submission);
			posts++;
			candidate = {
				revisionId: "corrected",
				value: "Corrected",
				latestReview: null,
			};
			response.destroy(); // Commit, then lose the response.
			return;
		}
		const url = new URL(request.url ?? "", "http://local");
		assert.equal(url.pathname, "/api/agent/v1/translation-tasks/task");
		assert.equal(url.searchParams.get("limit"), "16");
		const position = url.searchParams.get("cursor") ?? "0";
		reads.push(position);
		json(response, {
			task: { taskId: "task", localeCode: "de", targetCount: 3 },
			targets: [
				{
					messageId: position === "23" ? "correction" : `m${position}`,
					sourceValue,
					candidate:
						position === "23"
							? candidate
							: position === "0"
								? { revisionId: "first", value: "First", latestReview: null }
								: null,
				},
			],
			guidance: { voiceGuide },
			nextCursor: position === "0" ? 7 : position === "7" ? 23 : null,
		});
	});
	t.after(() => server.close());
	const submission = {
		items: [
			{
				messageId: "correction",
				candidate: { kind: "value", value: "Corrected" },
			},
		],
	};
	ok(await server.run(["task", "read", "task"]));
	const scanPage = ok(await server.run(["task", "read", "task"]));
	assert.equal(scanPage.nextCursor, 23); // Observed continuation; not a fixed-size offset.
	ok(await server.run(["task", "status", "task", "--max-pages", "1"]));
	const cursorPath = join(server.directory, "state/cursor.json");
	const statusPath = join(server.directory, "state/status.json");
	const cursorBytes = await readFile(cursorPath, "utf8");
	const statusBytes = await readFile(statusPath, "utf8");
	const inspect = [
		"task",
		"inspect",
		"task",
		"--cursor",
		String(scanPage.nextCursor),
	];
	const selected = ok(await server.run(inspect));
	assert.deepEqual(selected.work, ["correction"]);
	assert.equal(selected.inspectionCursor, 23);
	assert.equal(selected.inspectedPageComplete, false);
	assert.equal(selected.submittedScopeComplete, false);
	assert.deepEqual(selected.scanCheckpoint, { cursor: 7, complete: false });
	for (const change of [
		() => {
			sourceValue = "Changed";
		},
		() => {
			voiceGuide = "Updated";
		},
	]) {
		change();
		const stale = await server.run(["task", "submit", "task"], submission);
		assert.equal(JSON.parse(stale.stderr).error.code, "REASSESS");
		assert.equal(posts, 0);
		ok(await server.run(inspect)); // Fresh evidence must be reassessed before submission.
	}
	const unknown = await server.run(["task", "submit", "task"], submission);
	assert.equal(unknown.code, 1);
	const pagePath = join(server.directory, "state/page.json");
	const pageBytes = await readFile(pagePath, "utf8");
	const readsBeforeRecovery = reads.length;
	for (const args of [
		inspect,
		["task", "inspect", "task", "--cursor", "7"],
		["task", "read", "task", "--restart"],
	]) {
		const blocked = await server.run(args);
		assert.equal(JSON.parse(blocked.stderr).error.code, "UNKNOWN_WRITE");
	}
	assert.equal(reads.length, readsBeforeRecovery);
	assert.equal(await readFile(pagePath, "utf8"), pageBytes);
	const recovered = ok(
		await server.run([
			"task",
			"submit",
			"task",
			"--body",
			join(server.directory, "state/submission.json"),
		]),
	);
	assert.equal(posts, 1);
	assert.deepEqual(reads.slice(readsBeforeRecovery), ["23", "23"]);
	assert.equal(recovered.inspectionCursor, 23);
	assert.equal(recovered.inspectedPageComplete, true);
	assert.equal(recovered.submittedScopeComplete, false);
	assert.deepEqual(recovered.scanCheckpoint, { cursor: 7, complete: false });
	assert.equal(
		JSON.parse(await readFile(String(recovered.reviewHandoff), "utf8"))
			.revisions[0].revisionId,
		"corrected",
	);
	assert.equal(JSON.parse(await readFile(pagePath, "utf8")).mode, "inspect");
	const finalPage = ok(await server.run(inspect));
	assert.equal(finalPage.nextCursor, null);
	assert.equal(finalPage.inspectedPageComplete, true);
	assert.equal(finalPage.submittedScopeComplete, false);
	assert.equal(await readFile(cursorPath, "utf8"), cursorBytes);
	assert.equal(await readFile(statusPath, "utf8"), statusBytes);
	assert.deepEqual(ok(await server.run(["task", "read", "task"])).work, ["m7"]);
	assert.equal(JSON.parse(await readFile(pagePath, "utf8")).mode, undefined);
});

test("failed or killed inspection clears the old selection before fetching", async (t) => {
	let hold = false;
	let entered = () => {};
	const requested = new Promise((resolve) => {
		entered = () => resolve(null);
	});
	const server = await fixture("task", (request, response) => {
		const position = new URL(
			request.url ?? "",
			"http://local",
		).searchParams.get("cursor");
		if (position === "23") {
			if (hold) {
				entered();
				return;
			}
			return json(
				response,
				{ code: "VALIDATION", error: "Cannot read page" },
				400,
			);
		}
		json(response, {
			task: { taskId: "task", localeCode: "de", targetCount: 1 },
			targets: [{ messageId: "old", sourceValue: "Source", candidate: null }],
			nextCursor: null,
		});
	});
	t.after(() => server.close());
	const inspect = ["task", "inspect", "task", "--cursor", "23"];
	const submission = {
		items: [{ messageId: "old", candidate: { kind: "value", value: "Old" } }],
	};
	ok(await server.run(["task", "read", "task"]));
	assert.equal((await server.run(inspect)).code, 1);
	assert.equal(
		JSON.parse(
			await readFile(join(server.directory, "state/page.json"), "utf8"),
		).page,
		null,
	);
	assert.equal(
		JSON.parse(
			(await server.run(["task", "submit", "task"], submission)).stderr,
		).error.code,
		"INVALID_STATE",
	);
	ok(await server.run(["task", "read", "task"]));
	hold = true;
	const pending = server.start(inspect);
	t.after(() => pending.child.kill("SIGKILL"));
	await requested;
	pending.child.kill("SIGKILL");
	await pending.result;
	assert.equal(
		JSON.parse(
			await readFile(join(server.directory, "state/page.json"), "utf8"),
		).page,
		null,
	);
	assert.equal(
		JSON.parse(
			(await server.run(["task", "submit", "task"], submission)).stderr,
		).error.code,
		"INVALID_STATE",
	);
	ok(await server.run(["task", "read", "task"]));
});

test("inspection rejects missing, malformed and inappropriate flags before creating state or making requests", async (t) => {
	const server = await fixture("task", () =>
		assert.fail("Invalid inspection must not request task data"),
	);
	t.after(() => server.close());
	const inspect = ["task", "inspect", "task"];
	const invalid = [
		inspect,
		...[
			"",
			"-1",
			"1.5",
			"NaN",
			"Infinity",
			"9007199254740992",
			"opaque",
			"1e2",
			" 23 ",
		].map((value) => [...inspect, "--cursor", value]),
		[...inspect, "--cursor"],
		[...inspect, "--cursor", "23", "--restart"],
		[...inspect, "--cursor", "23", "--max-pages", "1"],
		[...inspect, "--cursor", "23", "--body", "-"],
		[...inspect, "--cursor", "23", "--source", "other"],
		[...inspect, "--cursor", "23", "--cursor", "23"],
		...["read", "submit", "status", "reuse"].map((command) => [
			"task",
			command,
			"task",
			"--cursor",
			"23",
		]),
		["review", "read", "--cursor", "23"],
	];
	for (const args of invalid) {
		const result = await server.run(args);
		assert.equal(result.code, 1, args.join(" "));
	}
	await assert.rejects(readFile(join(server.directory, "state/binding.json")), {
		code: "ENOENT",
	});
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
		prepared: 0,
		preparedIntentionalBlank: 0,
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
		prepared: 0,
		preparedIntentionalBlank: 0,
	});
	assert.equal(
		ok(await server.run(["task", "status", "task"])).rows,
		undefined,
	);
});

/** @param {string} messageId @param {string} [value] */
function preparedTarget(messageId, value = "Reviewed") {
	const sourceFingerprint = createHash("sha256").update("Source").digest("hex");
	return {
		messageId,
		sourceValue: "Source",
		sourceFingerprint,
		targetValue: value,
		staged: true,
		candidate: null,
		preparedValue: {
			valueFingerprint: createHash("sha256").update(value).digest("hex"),
			...(value === ""
				? { intentionalBlankReason: "Reviewed hidden label" }
				: {}),
			basis: {
				kind: "localeProposal",
				localeProposalId: "proposal",
				snapshotId: "snapshot",
				sourceFingerprint,
			},
			provenance: {
				valueId: `value-${messageId}`,
				updatedBy: { kind: "user", id: "human" },
				updatedAt: 1,
			},
		},
	};
}

test("prepared values complete authoring and target coverage without inventing candidate reviews", async (t) => {
	const targets = [preparedTarget("value"), preparedTarget("blank", "")].map(
		(target, index) => ({
			...target,
			preparedValue: {
				...target.preparedValue,
				provenance: {
					...target.preparedValue.provenance,
					updatedBy: { kind: "agent", id: "reviewer" },
					reviewAuthorization: {
						reviewerTokenId: "reviewer",
						candidateRevisionId: "original-revision",
						authorizedByUserId: "human",
						authorizedAt: 1,
						...(index === 0
							? { kind: "projectPolicy", policyRevision: 1 }
							: { kind: "candidateGrant", grantId: "grant", grantRevision: 1 }),
					},
				},
			},
		}),
	);
	const server = await fixture("task", (_request, response) =>
		json(response, {
			task: {
				taskId: "task",
				localeCode: "de",
				targetCount: 2,
				localeProposalId: "proposal",
				sourceSnapshotId: "snapshot",
			},
			targets,
			nextCursor: null,
		}),
	);
	t.after(() => server.close());
	const read = ok(await server.run(["task", "read", "task"]));
	assert.deepEqual(read.work, []);
	assert.equal(read.reviewHandoff, null);
	assert.equal(read.submittedScopeComplete, true);
	const coverage = ok(await server.run(["task", "status", "task"]));
	assert.equal(coverage.allLatestReviewed, false);
	assert.equal(coverage.allTargetsReviewed, true);
	assert.deepEqual(coverage.counts, {
		accepted: 0,
		intentionalBlank: 0,
		rejected: 0,
		pendingReview: 0,
		missing: 0,
		prepared: 1,
		preparedIntentionalBlank: 1,
	});
	const saved = JSON.parse(
		await readFile(join(server.directory, "state", "status.json"), "utf8"),
	);
	assert.equal(saved.rows.value.revisionId, null);
	assert.deepEqual(saved.rows.value.preparedValue, targets[0].preparedValue);
});

test("candidate feedback takes precedence over prepared values; legacy staging remains work", async (t) => {
	const targets = [
		{
			...preparedTarget("pending"),
			candidate: { revisionId: "pending", value: "New", latestReview: null },
		},
		{
			...preparedTarget("rejected"),
			candidate: {
				revisionId: "rejected",
				value: "Bad",
				latestReview: { decision: { kind: "reject" } },
			},
		},
		{
			messageId: "legacy",
			sourceValue: "Source",
			targetValue: "Staged",
			staged: true,
			candidate: null,
		},
	];
	const server = await fixture("task", (_request, response) =>
		json(response, {
			task: {
				taskId: "task",
				localeCode: "de",
				targetCount: 3,
				localeProposalId: "proposal",
				sourceSnapshotId: "snapshot",
			},
			targets,
			nextCursor: null,
		}),
	);
	t.after(() => server.close());
	const read = ok(await server.run(["task", "read", "task"]));
	assert.deepEqual(read.work, ["rejected", "legacy"]);
	const coverage = ok(await server.run(["task", "status", "task"]));
	assert.equal(coverage.allTargetsReviewed, false);
	const counts = /** @type {Row} */ (coverage.counts);
	assert.equal(counts.prepared, 0);
	assert.equal(counts.pendingReview, 1);
	assert.equal(counts.rejected, 1);
	assert.equal(counts.missing, 1);
	const binding = JSON.parse(
		await readFile(join(server.directory, "state", "binding.json"), "utf8"),
	);
	assert.equal(binding.version, 1);
	await writeFile(
		join(server.directory, "state", "status.json"),
		JSON.stringify({
			complete: true,
			counts: {
				accepted: 1,
				intentionalBlank: 0,
				rejected: 0,
				pendingReview: 0,
				missing: 0,
			},
			allLatestReviewed: true,
		}),
	);
	assert.equal(
		ok(await server.run(["task", "status", "task"])).allTargetsReviewed,
		true,
	);
});

test("malformed prepared authority, value, Source and destination evidence fail closed", async (t) => {
	let target = preparedTarget("value");
	const server = await fixture("task", (_request, response) =>
		json(response, {
			task: {
				taskId: "task",
				localeCode: "de",
				targetCount: 1,
				localeProposalId: "proposal",
				sourceSnapshotId: "snapshot",
			},
			targets: [target],
			nextCursor: null,
		}),
	);
	t.after(() => server.close());
	const broken = [
		{
			...preparedTarget("value"),
			preparedValue: {
				...preparedTarget("value").preparedValue,
				provenance: {
					valueId: "value",
					updatedBy: { kind: "agent", id: "author" },
					updatedAt: 1,
				},
			},
		},
		{
			...preparedTarget("value"),
			preparedValue: {
				...preparedTarget("value").preparedValue,
				valueFingerprint: "wrong",
			},
		},
		{ ...preparedTarget("value"), sourceValue: "Changed" },
		{
			...preparedTarget("value"),
			preparedValue: {
				...preparedTarget("value").preparedValue,
				basis: {
					...preparedTarget("value").preparedValue.basis,
					localeProposalId: "other",
				},
			},
		},
		{
			...preparedTarget("blank", ""),
			preparedValue: {
				...preparedTarget("blank", "").preparedValue,
				intentionalBlankReason: "",
			},
		},
	];
	for (const [index, value] of broken.entries()) {
		target = /** @type {ReturnType<typeof preparedTarget>} */ (value);
		const result = await server.run(
			["task", "read", "task"],
			undefined,
			`invalid-${index}`,
		);
		assert.notEqual(result.code, 0);
		assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
	}
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

/** Reproduce the readlink failure observed during real macOS lock contention.
 * Only the shared pacing lock is affected; state locks, HTTP, and checkpoints
 * still use the real runner with a fixture credential and isolated state.
 * @param {'released' | 'symlink' | 'persistent' | 'file' | 'malformed'} mode */
function lockReadFailure(mode) {
	return `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = { symlink: fs.symlink, readlink: fs.readlink };
let installed = false;
let failed = false;
let failures = 0;
fs.symlink = async (owner, path, ...options) => {
  if (!installed && path.endsWith('/read.lock')) {
    installed = true;
    if (${JSON.stringify(mode)} === 'file') await fs.writeFile(path, 'preserve this file');
    else await original.symlink(${JSON.stringify(mode)} === 'malformed' ? 'not-json' : owner, path);
  }
  return original.symlink(owner, path, ...options);
};
fs.readlink = async (path, ...options) => {
  if (path.endsWith('/read.lock') && !['file', 'malformed'].includes(${JSON.stringify(mode)}) && (!failed || ${JSON.stringify(mode)} === 'persistent')) {
    if (++failures > 4) throw Object.assign(new Error('retry bound exceeded'), { code: 'EIO' });
    failed = true;
    if (${JSON.stringify(mode)} === 'released') await fs.rm(path);
    if (${JSON.stringify(mode)} === 'symlink') setTimeout(() => fs.rm(path), 100);
    throw Object.assign(new Error('simulated readlink handoff'), { code: 'EINVAL' });
  }
  return original.readlink(path, ...options);
};
syncBuiltinESMExports();
`;
}

test("status survives a pacing lock handoff with readlink EINVAL", async (t) => {
	for (const mode of /** @type {const} */ (["released", "symlink"])) {
		await t.test(mode, async (t) => {
			let reads = 0;
			const f = await fixture(
				"task",
				(_request, response) => {
					reads++;
					json(response, {
						task: { taskId: "task", localeCode: "de", targetCount: 1 },
						targets: [
							{ messageId: "m", sourceValue: "Source", candidate: null },
						],
						nextCursor: null,
					});
				},
				lockReadFailure(mode),
			);
			t.after(() => f.close());
			const status = ok(await f.run(["task", "status", "task"]));
			assert.equal(status.complete, true);
			assert.equal(status.scanned, 1);
			assert.equal(reads, 1);
		});
	}
});

test("invalid pacing locks fail closed and repeated handoff errors are bounded", async (t) => {
	for (const mode of /** @type {const} */ ([
		"file",
		"malformed",
		"persistent",
	])) {
		await t.test(mode, async (t) => {
			const f = await fixture(
				"task",
				() => assert.fail("invalid lock must stop before task requests"),
				lockReadFailure(mode),
			);
			t.after(() => f.close());
			const result = await f.run(["task", "status", "task"]);
			assert.equal(result.code, 1);
			assert.equal(
				JSON.parse(result.stderr).error.code,
				mode === "persistent" ? "BUSY" : "INVALID_STATE",
			);
			const lock = join(f.pacingDirectory, "read.lock");
			if (mode === "file") {
				assert.equal(await readFile(lock, "utf8"), "preserve this file");
				assert.match(JSON.parse(result.stderr).error.message, /EINVAL/);
			} else if (mode === "malformed") {
				assert.equal(await readlink(lock), "not-json");
			} else {
				assert.equal(typeof JSON.parse(await readlink(lock)).nonce, "string");
			}
		});
	}
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

test("reuse contention retry does not replay a review write", async (t) => {
	let posts = 0;
	const f = await fixture("review", (request, response) => {
		if (request.method === "POST") {
			posts++;
			return json(response, { code: "WRITE_CONTENTION", retryAfter: 1 }, 503);
		}
		json(response, context("revision"));
	});
	t.after(() => f.close());
	ok(await f.run(["review", "read"], assignment("revision")));
	const submitted = await f.run(["review", "submit"], {
		items: [
			{
				revisionId: "revision",
				reviewToken: "token-revision",
				decision: { kind: "accept" },
			},
		],
	});
	assert.equal(submitted.code, 1);
	assert.equal(posts, 1);
});

test("task reuse retries explicit contention within a bound and preserves the saved page", async () => {
	const requests = /** @type {Row[]} */ ([]);
	let remainingFailures = 5;
	const f = await fixture("task", async (request, response) => {
		assert.equal(
			request.url,
			"/api/agent/v1/translation-tasks/destination/reuse",
		);
		const input = await body(request);
		requests.push(input);
		if (remainingFailures-- > 0) {
			return json(response, { code: "WRITE_CONTENTION", retryAfter: 1 }, 503);
		}
		json(response, {
			sourceTaskId: "source",
			destinationTaskId: "destination",
			clientReuseKey: input.clientReuseKey,
			items: [{ messageId: "greeting", status: "copied", revisionId: "fresh" }],
			nextCursor: null,
		});
	});
	try {
		const args = ["task", "reuse", "destination", "--source", "source"];
		const failed = await f.run(args);
		assert.equal(failed.code, 1);
		assert.equal(requests.length, 4);
		const saved = JSON.parse(
			await readFile(join(f.directory, "state", "reuse.json"), "utf8"),
		);
		assert.equal(saved.cursor, 0);
		assert.ok(
			requests.every(
				(input) => JSON.stringify(input) === JSON.stringify(requests[0]),
			),
		);
		assert.equal(ok(await f.run(args)).complete, true);
		assert.equal(requests.length, 6);
		assert.ok(
			requests.every(
				(input) => JSON.stringify(input) === JSON.stringify(requests[0]),
			),
		);
		assert.equal(requests[5].clientReuseKey, saved.clientReuseKey);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(f.directory, "state", "reuse-handoff-0.json"),
					"utf8",
				),
			),
			{
				revisions: [{ revisionId: "fresh" }],
			},
		);
	} finally {
		await f.close();
	}
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
			nextCursor: Number(input.cursor) === 0 ? 3 : null,
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
			3,
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
		assert.equal(requests[2].cursor, 3);
		assert.equal(requests[2].clientReuseKey, requests[0].clientReuseKey);
		assert.deepEqual(
			JSON.parse(
				await readFile(join(f.directory, "state", "reuse-page-3.json"), "utf8"),
			),
			receipts.get(3),
		);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					join(f.directory, "state", "reuse-handoff-3.json"),
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
