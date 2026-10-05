// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
	new URL("../agent-kit/_blabla/scripts/blabla-evidence.mjs", import.meta.url),
);
const observedCommit = "a".repeat(40);
const firstSource = "Spread\nthe bricks on the table.";
const secondSource = "Tap the button.";
const code = "Text(localizations.first);\n";
/** @typedef {{code: number | null, stdout: string, stderr: string}} Result */
/** @typedef {{id: string, kind: string, state: string, status: string, statement: string, limitations: string[], messages: Array<{messageId: string, sourceSha256: string, sourceStatus: string}>, files: Array<{path: string, status: string, recordedDirty: boolean, actualSha256: string | null}>}} Fact */
/** @typedef {{kind: string, registrySha256: string, contextSha256: string, requestedMessages: string[], unavailableMessages: string[], limitations: string[], facts: Fact[], provenance: {commit: string | null, reportedCommit: string | null, commitStatus: string, commitVerification: string, dirtyFilesVerification: string, dirtyFiles: string[]}}} Packet */
/** @param {string | Buffer} value */
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** @param {Result} result @returns {Packet} */
function ok(result) {
	assert.equal(result.code, 0, result.stderr);
	return JSON.parse(result.stdout);
}
/** @param {Result} result @param {string} code */
function fails(result, code) {
	assert.equal(result.code, 1, result.stdout);
	assert.equal(result.stdout, "");
	assert.equal(JSON.parse(result.stderr).error.code, code);
}
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "blabla-evidence-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const checkout = join(directory, "checkout");
	await mkdir(join(checkout, "lib"), { recursive: true });
	await writeFile(join(checkout, "lib/app.dart"), code);
	const registryPath = join(directory, "registry.json");
	const contextPath = join(directory, "context.json");
	const member = { messageId: "first", sourceSha256: hash(firstSource) };
	const otherMember = { messageId: "second", sourceSha256: hash(secondSource) };
	const citation = { path: "lib/app.dart", sha256: hash(code), line: 1 };
	const registry = {
		version: 1,
		projectId: "project",
		provenance: {
			repository: "private/app",
			commit: /** @type {string | null} */ (observedCommit),
			dirtyFiles: /** @type {string[]} */ ([]),
		},
		limitations: [
			"Only inspected positive evidence; earlier search was incomplete.",
			"Available width and runtime dispatch were not established.",
		],
		facts: [
			{
				id: "caller",
				kind: "caller",
				state: "active",
				messages: [{ ...member }],
				files: [{ ...citation }],
				statement: "Inspected first access inside Text.",
				limitations: ["Immediate syntax only."],
			},
			{
				id: "assembly",
				kind: "verifiedAssembly",
				state: "active",
				messages: [{ ...member }, { ...otherMember }],
				files: [{ ...citation }],
				statement: "Inspected order: first, icon, second.",
				limitations: ["Recorded expression; rendering has not been inspected."],
			},
			{
				id: "pair",
				kind: "semanticPairing",
				state: "active",
				messages: [{ ...member }, { ...otherMember }],
				files: [],
				statement: "Assess the two source clauses jointly.",
				limitations: ["Current assembly and injected spacing are unverified."],
			},
		],
	};
	const context = {
		targets: [
			{ messageId: "first", sourceValue: firstSource },
			{ messageId: "second", sourceValue: secondSource },
		],
	};
	/** @param {unknown} [value] */
	async function saveRegistry(value = registry) {
		await writeFile(registryPath, JSON.stringify(value));
	}
	/** @param {unknown} [value] */
	async function saveContext(value = context) {
		await writeFile(contextPath, JSON.stringify(value));
	}
	await saveRegistry();
	await saveContext();
	return {
		directory,
		checkout,
		registry,
		context,
		registryPath,
		contextPath,
		saveRegistry,
		saveContext,
		/** @param {string[]} [extra] @param {boolean} [withCommit] @returns {Result} */
		run(extra = [], withCommit = true) {
			const result = spawnSync(
				process.execPath,
				[
					script,
					"select",
					"--registry",
					registryPath,
					"--context",
					contextPath,
					"--checkout",
					checkout,
					"--project",
					"project",
					...(withCommit ? ["--commit", observedCommit] : []),
					...extra,
				],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 10000,
					env: { PATH: process.env.PATH },
				},
			);
			return {
				code: result.status,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		},
	};
}

test("selects complete explicit groups, preserves limitations and exact LF/NBSP hashing without credentials", async (t) => {
	const f = await fixture(t);
	const beforeRegistry = await readFile(f.registryPath);
	const beforeContext = await readFile(f.contextPath);
	const packet = ok(f.run());
	assert.equal(packet.kind, "localSupplementaryEvidence");
	assert.equal(packet.registrySha256, hash(beforeRegistry));
	assert.equal(packet.contextSha256, hash(beforeContext));
	assert.deepEqual(
		packet.facts.map((fact) => [fact.id, fact.status]),
		[
			["caller", "matching"],
			["assembly", "matching"],
			["pair", "matching"],
		],
	);
	assert.deepEqual(
		packet.facts[1].messages.map((message) => message.messageId),
		["first", "second"],
	);
	assert.deepEqual(packet.limitations, f.registry.limitations);
	assert.equal(packet.facts[2].kind, "semanticPairing");
	assert.deepEqual(packet.facts[2].limitations, [
		"Current assembly and injected spacing are unverified.",
	]);
	assert.deepEqual(await readFile(f.registryPath), beforeRegistry);
	assert.deepEqual(await readFile(f.contextPath), beforeContext);
	assert.equal(await readFile(join(f.checkout, "lib/app.dart"), "utf8"), code);
});

test("helper entry runs through a symlinked path outside the source checkout", async (t) => {
	const f = await fixture(t);
	const alias = join(f.directory, "evidence.mjs");
	await symlink(script, alias);
	const result = spawnSync(process.execPath, [alias, "--help"], {
		cwd: f.directory,
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--registry/);
});

test("group selection retains outside-page members as notSupplied, while a caller can match", async (t) => {
	const f = await fixture(t);
	await f.saveContext({ page: { targets: [f.context.targets[0]] }, cursor: 0 });
	const packet = ok(f.run());
	assert.equal(packet.facts[0].status, "matching");
	for (const fact of packet.facts.slice(1)) {
		assert.equal(fact.status, "unknown");
		assert.equal(fact.messages[1].sourceStatus, "notSupplied");
	}
});

test("changed Source makes associated caller and whole group stale even with matching file hashes", async (t) => {
	const f = await fixture(t);
	f.context.targets[0].sourceValue = firstSource.replace(" ", " ");
	await f.saveContext();
	const packet = ok(f.run());
	assert.ok(packet.facts.every((fact) => fact.status === "stale"));
	assert.equal(packet.facts[1].messages[0].sourceStatus, "changed");
	assert.equal(packet.facts[0].files[0].status, "matching");
});

test("changed and missing cited files retain historical positive facts but invalidate matching status", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.checkout, "lib/app.dart"), `${code}changed`);
	let packet = ok(f.run());
	assert.equal(packet.facts[0].status, "stale");
	assert.equal(packet.facts[0].files[0].status, "changed");
	assert.equal(packet.facts[2].status, "matching");
	await rm(join(f.checkout, "lib/app.dart"));
	packet = ok(f.run());
	assert.equal(packet.facts[1].status, "stale");
	assert.equal(packet.facts[1].files[0].status, "missing");
	assert.equal(packet.facts[1].statement, f.registry.facts[1].statement);
});

test("reported matching commit and file hashes keep recorded dirty provenance without claiming clean runtime", async (t) => {
	const f = await fixture(t);
	f.registry.provenance.dirtyFiles = ["lib/app.dart"];
	await f.saveRegistry();
	const packet = ok(f.run());
	assert.equal(packet.facts[0].status, "matching");
	assert.equal(packet.facts[0].files[0].recordedDirty, true);
	assert.deepEqual(packet.provenance.dirtyFiles, ["lib/app.dart"]);
	assert.equal(packet.provenance.commitStatus, "matchingReportedCommit");
	assert.equal(packet.provenance.commitVerification, "callerReportedOnly");
	assert.equal(packet.provenance.dirtyFilesVerification, "recordedOnly");
});

test("different reported commit makes facts stale; omitted or unknown observed commit stays unknown", async (t) => {
	const f = await fixture(t);
	assert.ok(
		ok(f.run(["--commit", "b".repeat(40)], false)).facts.every(
			(fact) => fact.status === "stale",
		),
	);
	const omitted = ok(f.run([], false));
	assert.equal(omitted.provenance.reportedCommit, null);
	assert.ok(omitted.facts.every((fact) => fact.status === "unknown"));
	f.registry.provenance.commit = null;
	await f.saveRegistry();
	assert.ok(ok(f.run()).facts.every((fact) => fact.status === "unknown"));
});

test("incomplete research preserves positive observations and retracted facts remain retracted", async (t) => {
	const f = await fixture(t);
	f.registry.facts[1].state = "retracted";
	f.registry.facts[1].limitations = [
		"Former grouping assertion withdrawn after caller inspection.",
	];
	await f.saveRegistry();
	const packet = ok(f.run());
	assert.equal(packet.facts[0].status, "matching");
	assert.equal(packet.facts[1].status, "retracted");
	assert.match(packet.facts[1].limitations[0], /withdrawn/);
	assert.match(packet.limitations[0], /incomplete/);
	assert.equal(Object.hasOwn(packet, "unreferenced"), false);
	f.registry.facts.forEach((fact) => {
		fact.state = "retracted";
	});
	await f.saveRegistry();
	assert.deepEqual(ok(f.run()).unavailableMessages, ["first", "second"]);
});

test("missing registry evidence is unavailable, without inventing an absence claim", async (t) => {
	const f = await fixture(t);
	await f.saveContext({ messages: [{ messageId: "other", sourceValue: "" }] });
	const packet = ok(f.run());
	assert.deepEqual(packet.facts, []);
	assert.deepEqual(packet.unavailableMessages, ["other"]);
});

test("accepts exact reviewer Source without echoing tokens; accepts empty text and explicit hashes", async (t) => {
	const f = await fixture(t);
	await f.saveContext({
		kind: "candidate",
		messageId: "first",
		source: { value: firstSource },
		reviewToken: "secret-review-token",
		candidateRevisionId: "revision",
	});
	const result = f.run();
	assert.equal(ok(result).facts[0].messages[0].sourceStatus, "matching");
	assert.equal(result.stdout.includes("secret-review-token"), false);
	f.registry.facts = [f.registry.facts[0]];
	f.registry.facts[0].messages = [
		{ messageId: "empty", sourceSha256: hash("") },
	];
	await f.saveRegistry();
	await f.saveContext({ messages: [{ messageId: "empty", sourceValue: "" }] });
	assert.equal(ok(f.run()).facts[0].status, "matching");
	await f.saveContext({
		messages: [{ messageId: "empty", sourceSha256: hash("") }],
	});
	assert.equal(ok(f.run()).facts[0].status, "matching");
});

test("rejects traversal, absolute paths, outside symlink ancestors and dangling escape links", async (t) => {
	const f = await fixture(t);
	for (const path of [
		"../outside.dart",
		"/outside.dart",
		"lib/../../outside.dart",
		"lib\\outside.dart",
	]) {
		f.registry.facts[0].files[0].path = path;
		await f.saveRegistry();
		fails(f.run(), "INVALID_PATH");
	}
	f.registry.facts = [f.registry.facts[0]];
	await mkdir(join(f.directory, "outside"));
	await writeFile(join(f.directory, "outside/app.dart"), code);
	await symlink(join(f.directory, "outside"), join(f.checkout, "escape"));
	f.registry.facts[0].files[0].path = "escape/app.dart";
	await f.saveRegistry();
	fails(f.run(), "INVALID_PATH");
	await symlink(
		join(f.directory, "missing.dart"),
		join(f.checkout, "dangling.dart"),
	);
	f.registry.facts[0].files[0].path = "dangling.dart";
	await f.saveRegistry();
	fails(f.run(), "INVALID_PATH");
});

test("contained symlinks verify only their target bytes", async (t) => {
	const f = await fixture(t);
	f.registry.facts = [f.registry.facts[0]];
	await symlink("app.dart", join(f.checkout, "lib/alias.dart"));
	f.registry.facts[0].files[0].path = "lib/alias.dart";
	await f.saveRegistry();
	assert.equal(ok(f.run()).facts[0].files[0].status, "matching");
});

test("rejects duplicate facts, members, context IDs, conflicting Sources, and ambiguous context shapes", async (t) => {
	const f = await fixture(t);
	const original = structuredClone(f.registry);
	f.registry.facts.push(f.registry.facts[0]);
	await f.saveRegistry();
	fails(f.run(), "INVALID_INPUT");
	await f.saveRegistry(original);
	await f.saveContext({
		targets: [f.context.targets[0], f.context.targets[0]],
	});
	fails(f.run(), "INVALID_INPUT");
	await f.saveContext({ targets: f.context.targets, messages: [] });
	fails(f.run(), "INVALID_INPUT");
	await f.saveContext({
		page: { targets: f.context.targets, kind: "candidate" },
	});
	fails(f.run(), "INVALID_INPUT");
	await f.saveContext({
		messages: [{ ...f.context.targets[0], sourceSha256: hash(firstSource) }],
	});
	fails(f.run(), "INVALID_INPUT");
	await f.saveContext();
	const conflict = structuredClone(original);
	conflict.facts[1].messages[0].sourceSha256 = hash("changed");
	await f.saveRegistry(conflict);
	fails(f.run(), "INVALID_INPUT");
	const duplicate = structuredClone(original);
	duplicate.facts[1].messages.push(duplicate.facts[1].messages[0]);
	await f.saveRegistry(duplicate);
	fails(f.run(), "INVALID_INPUT");
});

test("rejects malformed hashes and identifiers, unsupported claims and group evidence without citations", async (t) => {
	const f = await fixture(t);
	const original = structuredClone(f.registry);
	f.registry.facts[0].messages[0].sourceSha256 = "invalid";
	await f.saveRegistry();
	fails(f.run(), "INVALID_INPUT");
	const id = structuredClone(original);
	id.facts[0].id = "bad id";
	await f.saveRegistry(id);
	fails(f.run(), "INVALID_INPUT");
	await f.saveRegistry({ ...original, completeScan: true });
	fails(f.run(), "INVALID_INPUT");
	const assembly = structuredClone(original);
	assembly.facts[1].files = [];
	await f.saveRegistry(assembly);
	fails(f.run(), "INVALID_INPUT");
	await f.saveRegistry(original);
	fails(f.run(["--commit", "short"], false), "INVALID_INPUT");
	fails(f.run(["--project", "other"]), "INVALID_ARGUMENT");
	await f.saveContext({ projectId: "other", targets: f.context.targets });
	fails(f.run(), "IDENTITY_MISMATCH");
});

test("fixed input, message, fact and citation-file bounds reject oversized work before output", async (t) => {
	const f = await fixture(t);
	await writeFile(f.contextPath, " ".repeat(1024 * 1024 + 1));
	fails(f.run(), "INPUT_TOO_LARGE");
	await f.saveContext({
		messages: Array.from({ length: 51 }, (_, index) => ({
			messageId: `message${index}`,
			sourceValue: "",
		})),
	});
	fails(f.run(), "INVALID_INPUT");
	await f.saveContext();
	await f.saveRegistry({
		...f.registry,
		facts: Array.from({ length: 257 }, (_, index) => ({
			...f.registry.facts[0],
			id: `fact${index}`,
		})),
	});
	fails(f.run(), "INVALID_INPUT");
	await f.saveRegistry();
	await writeFile(
		join(f.checkout, "lib/app.dart"),
		Buffer.alloc(4 * 1024 * 1024 + 1),
	);
	fails(f.run(), "INPUT_TOO_LARGE");
});

test("selection bounds cited-file count and expanded output independently of input size", async (t) => {
	const f = await fixture(t);
	await f.saveRegistry({
		...f.registry,
		facts: Array.from({ length: 65 }, (_, index) => ({
			...f.registry.facts[0],
			id: `fact${index}`,
			files: [{ path: `lib/file${index}.dart`, sha256: hash(code), line: 1 }],
		})),
	});
	fails(f.run(), "LIMIT_EXCEEDED");
	await f.saveRegistry({
		...f.registry,
		facts: Array.from({ length: 230 }, (_, index) => ({
			...f.registry.facts[0],
			id: `fact${index}`,
			statement: "x".repeat(2000),
		})),
	});
	assert.ok((await readFile(f.registryPath)).byteLength < 1024 * 1024);
	fails(f.run(), "LIMIT_EXCEEDED");
});
