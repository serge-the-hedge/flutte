// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { campaign } from "../agent-kit/_blabla/scripts/blabla-campaign.mjs";

/** @typedef {{revisionId: string, taskId: string, messageId: string, localeCode: string, supersedes?: string}} Revision */
/** @typedef {{path: string, sha256: string}} Reference */
/** @typedef {{id: string, owner: string, handoff: Reference, reviewState: string, brief: Reference, evidence?: Reference[]}} Round */
/** @typedef {Record<string, unknown>} Row */
/** @param {string} value */
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** @param {string} path @param {unknown} value */
async function save(path, value) {
	await writeFile(path, `${JSON.stringify(value)}\n`);
}
/** @param {string} revisionId @param {string} [messageId] @param {string} [taskId] @param {string} [supersedes] @returns {Revision} */
function revision(
	revisionId,
	messageId = revisionId,
	taskId = "task",
	supersedes = /** @type {string | undefined} */ (undefined),
) {
	return {
		revisionId,
		messageId,
		taskId,
		localeCode: "de",
		...(supersedes === undefined ? {} : { supersedes }),
	};
}
/** @param {import('node:test').TestContext} t @param {Revision[][]} groups */
async function fixture(t, groups = [[revision("a"), revision("b")]]) {
	const directory = await mkdtemp(join(tmpdir(), "blabla-campaign-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const brief = "Pinned human requirements.\n";
	await writeFile(join(directory, "brief.md"), brief);
	const revisions = groups.flat();
	/** @type {Round[]} */
	const rounds = [];
	for (const [index, group] of groups.entries()) {
		const handoff = `${JSON.stringify({ revisions: group })}\n`;
		const handoffPath = `handoff-${index}.json`;
		await writeFile(join(directory, handoffPath), handoff);
		const reviewState = `review-${index}`;
		await mkdir(join(directory, reviewState));
		await save(join(directory, reviewState, "binding.json"), {
			version: 1,
			role: "review",
			projectId: "project",
			taskId: null,
		});
		rounds.push({
			id: `round-${index}`,
			owner: "A",
			handoff: { path: handoffPath, sha256: digest(handoff) },
			reviewState,
			brief: { path: "brief.md", sha256: digest(brief) },
		});
	}
	const messageIds = [...new Set(revisions.map((entry) => entry.messageId))];
	const manifest = {
		version: 1,
		projectId: "project",
		scope: [{ localeCode: "de", messageIds }],
		latest: messageIds.map((messageId) => ({
			messageId,
			localeCode: "de",
			revisionId: /** @type {string | null} */ (
				revisions.filter((entry) => entry.messageId === messageId).at(-1)
					?.revisionId ?? null
			),
		})),
		revisions,
		reviewers: [{ owner: "A", tokenId: "reviewer" }],
		rounds,
	};
	const path = join(directory, "campaign-v1.json");
	await save(path, manifest);
	/** @param {string} revisionId @param {'accept' | 'reject' | 'intentionalBlank'} kind @param {number} [roundIndex] @param {Row} [patch] */
	async function receipt(revisionId, kind, roundIndex = 0, patch = {}) {
		const review = {
			reviewId: `review_${revisionId}`,
			createdAt:
				1000 + revisions.findIndex((entry) => entry.revisionId === revisionId),
			decision: {
				kind,
				...(kind === "accept" ? {} : { reason: "Exact preserved reason" }),
			},
			reviewer: { kind: "agent", id: "reviewer" },
			finalValueFingerprint: "fingerprint",
			reviewAuthorization: {
				candidateRevisionId: revisionId,
				kind: "projectPolicy",
				policyRevision: 1,
				reviewerTokenId: "reviewer",
				authorizedByUserId: "human",
				authorizedAt: 900,
			},
			...patch,
		};
		await save(
			join(
				directory,
				rounds[roundIndex].reviewState,
				`receipt-${revisionId}.json`,
			),
			{ revisionId, status: "recorded", review },
		);
		return review;
	}
	return {
		directory,
		path,
		manifest,
		receipt,
		persist: () => save(path, manifest),
	};
}

test("partial receipts resume the same exact round and derive counts despite stale summaries", async (t) => {
	const f = await fixture(t);
	await save(join(f.directory, "review-0", "summary.json"), {
		complete: true,
		accepted: 999,
	});
	const before = await campaign(f.path, { owner: "A" });
	assert.ok("round" in before && before.round);
	assert.equal(before.status, "ready");
	assert.deepEqual(
		before.round.pendingRevisions.map((entry) => entry.revisionId),
		["a", "b"],
	);
	await f.receipt("a", "accept");
	const resumed = await campaign(f.path, {
		owner: "A",
		expectManifest: before.manifestHash,
	});
	assert.ok("round" in resumed && resumed.round);
	assert.equal(resumed.round.handoff, before.round.handoff);
	assert.equal(resumed.round.reviewState, before.round.reviewState);
	assert.deepEqual(resumed.round.reviewHandoff, {
		revisions: [{ revisionId: "b" }],
	});
	const partial = await campaign(f.path);
	assert.ok("counts" in partial);
	assert.deepEqual(partial.counts, {
		accepted: 1,
		intentionalBlank: 0,
		rejected: 0,
		pendingReview: 1,
		missing: 0,
	});
	await f.receipt("b", "intentionalBlank");
	const done = await campaign(f.path);
	assert.ok("counts" in done);
	assert.equal(done.allLatestRecordedAcceptance, true);
	assert.equal(done.counts.intentionalBlank, 1);
	assert.deepEqual(done.recordedAt, { earliest: 1000, latest: 1001 });
	const next = await campaign(f.path, { owner: "A" });
	assert.ok("status" in next);
	assert.equal(next.status, "complete");
});

test("explicit cross-task correction resolves historical rejection and is prioritized", async (t) => {
	const f = await fixture(t, [
		[revision("old", "greeting")],
		[revision("ordinary")],
		[revision("new", "greeting", "correction_task", "old")],
	]);
	const original = await f.receipt("old", "reject");
	const pending = await campaign(f.path, { owner: "A" });
	assert.ok("round" in pending && pending.round);
	assert.equal(pending.round.id, "round-2");
	assert.equal(pending.round.correction, true);
	const unresolved = await campaign(f.path, { details: true });
	assert.ok("counts" in unresolved && unresolved.details);
	assert.equal(unresolved.openFindingCount, 0);
	assert.equal(unresolved.pendingCorrectionCount, 1);
	assert.equal(unresolved.unresolvedFindingCount, 1);
	assert.equal(unresolved.historicalCounts.supersededPendingRejections, 1);
	assert.equal(
		unresolved.details.history.find((entry) => entry.revisionId === "old")
			?.rejectionResolution,
		"superseded-pending",
	);
	await f.receipt("new", "accept", 2);
	const report = await campaign(f.path, { details: true });
	assert.ok("counts" in report);
	assert.equal(report.counts.rejected, 0);
	assert.equal(report.unresolvedFindingCount, 0);
	assert.equal(report.historicalCounts.resolvedAcceptedRejections, 1);
	assert.deepEqual(report.openFindings, []);
	assert.ok(report.details);
	const historical = report.details.history.find(
		(entry) => entry.revisionId === "old",
	);
	assert.equal(historical?.status, "rejected");
	assert.equal(historical?.supersededBy, "new");
	assert.equal(historical?.rejectionResolution, "resolved-accepted");
	assert.deepEqual(historical?.receipt?.decision, original.decision);
	assert.equal(
		JSON.parse(
			await readFile(join(f.directory, "review-0", "receipt-old.json"), "utf8"),
		).review.decision.reason,
		original.decision.reason,
	);
	const next = await campaign(f.path, { owner: "A" });
	assert.ok("round" in next && next.round);
	assert.equal(next.round.id, "round-1");
});

test("large campaigns print bounded summaries and export detailed history only to a new file", async (t) => {
	const revisions = Array.from({ length: 9360 }, (_, index) =>
		revision(`rev_${index}`),
	);
	const groups = [];
	for (let index = 0; index < revisions.length; index += 16)
		groups.push(revisions.slice(index, index + 16));
	const f = await fixture(t, groups);
	for (let index = 0; index < 40; index++)
		await f.receipt(`rev_${index}`, "reject", Math.floor(index / 16));
	await f.receipt("rev_40", "accept", 2);
	const script = fileURLToPath(
		new URL(
			"../agent-kit/_blabla/scripts/blabla-campaign.mjs",
			import.meta.url,
		),
	);
	const args = [script, "status", "--manifest", f.path];
	const compact = spawnSync(process.execPath, args, { encoding: "utf8" });
	assert.equal(compact.status, 0, compact.stderr);
	assert.ok(Buffer.byteLength(compact.stdout) < 32_000);
	const report = JSON.parse(compact.stdout);
	assert.equal(report.scopeCount, 9360);
	assert.deepEqual(report.counts, {
		accepted: 1,
		intentionalBlank: 0,
		rejected: 40,
		pendingReview: 9319,
		missing: 0,
	});
	assert.equal(report.openFindingCount, 40);
	assert.equal(report.openFindings.length, 16);
	assert.equal(report.byOwner.A.pendingReview, 9319);
	assert.equal(report.details, undefined);
	assert.equal(report.current, undefined);
	const detailsPath = join(f.directory, "report-v1.json");
	const exported = spawnSync(
		process.execPath,
		[...args, "--details", detailsPath],
		{ encoding: "utf8" },
	);
	assert.equal(exported.status, 0, exported.stderr);
	assert.ok(Buffer.byteLength(exported.stdout) < 32_000);
	assert.equal(JSON.parse(exported.stdout).detailsFile, detailsPath);
	const saved = JSON.parse(await readFile(detailsPath, "utf8"));
	assert.equal(saved.details.history.length, 9360);
	assert.equal(saved.details.current.length, 9360);
	assert.equal(saved.details.rounds.length, 585);
	assert.equal(saved.details.history[0].roundId, "round-0");
	assert.equal(saved.details.history[0].round, undefined);
	const manifestBefore = await readFile(f.path, "utf8");
	assert.equal(
		spawnSync(process.execPath, [...args, "--details", f.path]).status,
		1,
	);
	assert.equal(await readFile(f.path, "utf8"), manifestBefore);
	const next = spawnSync(
		process.execPath,
		[script, "next", "--manifest", f.path, "--owner", "A"],
		{ encoding: "utf8" },
	);
	assert.equal(next.status, 0, next.stderr);
	assert.ok(Buffer.byteLength(next.stdout) < 16_000);
	assert.equal(JSON.parse(next.stdout).round.pendingRevisions.length, 7);
});

test("recorded latest rejection is an open finding, never pending acceptance", async (t) => {
	const f = await fixture(t, [[revision("a")]]);
	await f.receipt("a", "reject");
	const report = await campaign(f.path);
	assert.ok("counts" in report);
	assert.equal(report.counts.rejected, 1);
	assert.equal(report.counts.pendingReview, 0);
	assert.equal(report.openFindings.length, 1);
	assert.equal(report.allLatestRecordedAcceptance, false);
});

/** @param {'projectPolicy' | 'candidateGrant'} kind @returns {Row} */
function authorization(kind) {
	return {
		kind,
		candidateRevisionId: "a",
		reviewerTokenId: "reviewer",
		authorizedByUserId: "human",
		authorizedAt: 900,
		...(kind === "projectPolicy"
			? { policyRevision: 1 }
			: { grantId: "grant_a", grantRevision: 1 }),
	};
}

test("both complete historical authorization variants count as recorded acceptance", async (t) => {
	for (const kind of /** @type {const} */ ([
		"projectPolicy",
		"candidateGrant",
	])) {
		await t.test(kind, async (t) => {
			const f = await fixture(t, [[revision("a")]]);
			await f.receipt("a", "accept", 0, {
				reviewAuthorization: authorization(kind),
			});
			const report = await campaign(f.path);
			assert.ok("counts" in report);
			assert.equal(report.valid, true);
			assert.equal(report.counts.accepted, 1);
			assert.equal(report.allLatestRecordedAcceptance, true);
			assert.equal(report.sourceCurrency, "notObserved");
			assert.equal(report.releaseReady, null);
			const next = await campaign(f.path, { owner: "A" });
			assert.ok("status" in next);
			assert.equal(next.status, "complete");
		});
	}
});

test("incomplete or malformed historical authorization blocks acceptance and preserves receipt evidence", async (t) => {
	for (const kind of /** @type {const} */ ([
		"projectPolicy",
		"candidateGrant",
	])) {
		const valid = authorization(kind);
		/** @type {Array<{name: string, field: string, value?: unknown}>} */
		const cases = Object.keys(valid).map((field) => ({
			name: `missing ${field}`,
			field,
		}));
		const invalidFields = {
			kind: [null, "unknown"],
			candidateRevisionId: [null, "other"],
			reviewerTokenId: [null, "other", "bad id"],
			authorizedByUserId: [null, 1, "", "   "],
			authorizedAt: [null, "900", -1, Number.POSITIVE_INFINITY],
			...(kind === "projectPolicy"
				? { policyRevision: [null, "1", 0, -1, 1.5, 2 ** 53] }
				: {
						grantId: [null, 1, "", "bad id"],
						grantRevision: [null, "1", 0, -1, 1.5, 2 ** 53],
					}),
		};
		for (const [field, values] of Object.entries(invalidFields)) {
			for (const value of values)
				cases.push({
					name: `invalid ${field}: ${String(value)}`,
					field,
					value,
				});
		}
		for (const field of kind === "projectPolicy"
			? ["grantId", "grantRevision", "unexpected"]
			: ["policyRevision", "unexpected"])
			cases.push({ name: `unexpected ${field}`, field, value: 1 });
		for (const entry of cases) {
			await t.test(`${kind}: ${entry.name}`, async (t) => {
				const f = await fixture(t, [[revision("a")]]);
				const changed = { ...valid };
				if ("value" in entry) changed[entry.field] = entry.value;
				else delete changed[entry.field];
				await f.receipt("a", "accept", 0, { reviewAuthorization: changed });
				const receiptPath = join(f.directory, "review-0", "receipt-a.json");
				// JSON.stringify turns Infinity into null; an overflowing JSON number
				// exercises the non-finite value that JSON.parse can actually return.
				if (entry.value === Number.POSITIVE_INFINITY)
					await writeFile(
						receiptPath,
						(await readFile(receiptPath, "utf8")).replace(
							'"authorizedAt":null',
							'"authorizedAt":1e400',
						),
					);
				const before = await readFile(receiptPath, "utf8");
				const report = await campaign(f.path);
				assert.ok("counts" in report);
				assert.equal(report.valid, false);
				assert.equal(report.counts.accepted, 0);
				assert.equal(report.counts.pendingReview, 1);
				assert.equal(report.allLatestRecordedAcceptance, false);
				assert.equal(report.problemCount, 1);
				assert.equal(report.problems[0].path, await realpath(receiptPath));
				const next = await campaign(f.path, { owner: "A" });
				assert.ok("status" in next);
				assert.equal(next.status, "blocked");
				assert.equal(next.round, null);
				assert.equal(await readFile(receiptPath, "utf8"), before);
			});
		}
	}
});

test("mixed original handoffs omit superseded revisions and owners consume only their assignment", async (t) => {
	const f = await fixture(t, [
		[revision("old", "greeting"), revision("ordinary")],
		[revision("new", "greeting", "correction_task", "old")],
		[revision("other")],
	]);
	f.manifest.reviewers.push({ owner: "B", tokenId: "other_reviewer" });
	f.manifest.rounds[2].owner = "B";
	await f.persist();
	await f.receipt("new", "accept", 1);
	const next = await campaign(f.path, { owner: "A" });
	assert.ok("round" in next && next.round);
	assert.equal(next.round.id, "round-0");
	assert.deepEqual(next.round.supersededRevisions, ["old"]);
	assert.deepEqual(next.round.reviewHandoff, {
		revisions: [{ revisionId: "ordinary" }],
	});
	assert.equal(next.pendingReview, 1);
	const other = await campaign(f.path, { owner: "B" });
	assert.ok("round" in other && other.round);
	assert.equal(other.round.id, "round-2");
	await assert.rejects(
		campaign(f.path, { owner: "translator" }),
		/not assigned/,
	);
});

test("wrong exact revision, authorization, reviewer, or state evidence stops queue consumption", async (t) => {
	for (const mode of [
		"revision",
		"authorization",
		"reviewer",
		"state",
		"fingerprint",
	]) {
		await t.test(mode, async (t) => {
			const f = await fixture(t, [[revision("a")]]);
			await f.receipt(
				"a",
				"accept",
				0,
				mode === "authorization"
					? {
							reviewAuthorization: {
								kind: "projectPolicy",
								candidateRevisionId: "other",
								reviewerTokenId: "reviewer",
							},
						}
					: mode === "reviewer"
						? { reviewer: { kind: "agent", id: "other" } }
						: mode === "fingerprint"
							? { finalValueFingerprint: null }
							: {},
			);
			if (mode === "revision")
				await save(join(f.directory, "review-0", "receipt-a.json"), {
					revisionId: "other",
					status: "recorded",
					review: {},
				});
			if (mode === "state")
				await save(join(f.directory, "review-0", "binding.json"), {
					version: 1,
					role: "review",
					projectId: "other",
					taskId: null,
				});
			const report = await campaign(f.path);
			assert.ok("counts" in report);
			assert.equal(report.valid, false);
			assert.equal(report.counts.accepted, 0);
			const next = await campaign(f.path, { owner: "A" });
			assert.ok("status" in next);
			assert.equal(next.status, "blocked");
			assert.equal(next.round, null);
		});
	}
});

test("ownership and correction ambiguity fail before issuing a handoff", async (t) => {
	for (const mode of [
		"duplicate-owner",
		"missing-owner",
		"duplicate-head",
		"wrong-pair",
		"cycle",
		"missing-latest",
		"state-alias",
	]) {
		await t.test(mode, async (t) => {
			const f = await fixture(t, [[revision("a")], [revision("b")]]);
			if (mode === "duplicate-owner") {
				f.manifest.rounds[1].handoff = f.manifest.rounds[0].handoff;
			} else if (mode === "missing-owner") f.manifest.rounds.pop();
			else if (mode === "duplicate-head") {
				f.manifest.revisions.push(revision("extra", "a"));
			} else if (mode === "wrong-pair")
				f.manifest.revisions[1].supersedes = "a";
			else if (mode === "cycle") {
				f.manifest.revisions[1].messageId = "a";
				f.manifest.revisions[0].supersedes = "b";
				f.manifest.revisions[1].supersedes = "a";
			} else if (mode === "missing-latest") f.manifest.latest.pop();
			else {
				await symlink(
					join(f.directory, "review-0"),
					join(f.directory, "alias"),
				);
				f.manifest.rounds[1].reviewState = "alias";
			}
			await f.persist();
			await assert.rejects(
				campaign(f.path, { owner: "A" }),
				/exactly one|chain|same pair|every expected|disjoint/,
			);
		});
	}
});

test("foreign conflicting receipts remain visible and block next", async (t) => {
	const f = await fixture(t, [[revision("a")], [revision("b")]]);
	await f.receipt("a", "accept");
	await f.receipt("a", "reject", 1);
	const report = await campaign(f.path);
	assert.ok("counts" in report);
	assert.equal(report.valid, false);
	assert.ok(
		report.problems.some((entry) => entry.code === "CONFLICTING_RECEIPT"),
	);
	assert.equal(report.counts.accepted, 0);
});

test("evidence and manifest pins stop changed assignments; locks retain the recoverable round", async (t) => {
	const f = await fixture(t, [[revision("a")]]);
	const first = await campaign(f.path, { owner: "A" });
	assert.ok("round" in first && first.round);
	await writeFile(
		join(f.directory, "review-0", "worker.lock"),
		"Existing lock evidence",
	);
	const busy = await campaign(f.path, { owner: "A" });
	assert.ok("round" in busy && busy.round);
	assert.equal(busy.status, "busy");
	assert.equal(busy.round.reviewState, first.round.reviewState);
	await writeFile(join(f.directory, "brief.md"), "Changed requirements\n");
	await assert.rejects(
		campaign(f.path, { owner: "A" }),
		/Pinned evidence changed/,
	);
	await f.persist();
	await writeFile(f.path, `${await readFile(f.path, "utf8")} `);
	await assert.rejects(
		campaign(f.path, { owner: "A", expectManifest: first.manifestHash }),
		/hash assigned/,
	);
});

test("accepted receipts and stale local context cannot establish live currency or release readiness", async (t) => {
	const f = await fixture(t, [[revision("a")]]);
	await f.receipt("a", "accept");
	await save(join(f.directory, "review-0", "context-a-historical.json"), {
		basisIsCurrent: false,
		sourceValue: "Changed source",
	});
	f.manifest.scope.push({ localeCode: "fr", messageIds: ["missing"] });
	f.manifest.latest.push({
		localeCode: "fr",
		messageId: "missing",
		revisionId: null,
	});
	await f.persist();
	const report = await campaign(f.path);
	assert.ok("counts" in report);
	assert.equal(report.counts.missing, 1);
	assert.equal(report.sourceCurrency, "notObserved");
	assert.equal(report.releaseReady, null);
	assert.equal(report.allLatestRecordedAcceptance, false);
	const script = fileURLToPath(
		new URL(
			"../agent-kit/_blabla/scripts/blabla-campaign.mjs",
			import.meta.url,
		),
	);
	const result = spawnSync(
		process.execPath,
		[script, "status", "--manifest", f.path],
		{
			encoding: "utf8",
			env: {
				...process.env,
				BLABLA_PROFILE: "nonexistent",
				BLABLA_API_URL: "http://127.0.0.1:1",
				BLABLA_TOKEN: "never-use-this",
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).releaseReady, null);
	assert.equal(
		spawnSync(process.execPath, [
			script,
			"next",
			"--manifest",
			f.path,
			"--owner",
			"A",
			"--profile",
			"reviewer",
		]).status,
		1,
	);
});
