#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{messageId: string, sourceSha256: string}} Message */
/** @typedef {{path: string, sha256: string, line: number}} Citation */
/** @typedef {{id: string, kind: 'caller' | 'verifiedAssembly' | 'semanticPairing', state: 'active' | 'retracted', messages: Message[], files: Citation[], statement: string, limitations: string[]}} Fact */
const INPUT_BYTES = 1024 * 1024;
const FILE_BYTES = 4 * 1024 * 1024;
const TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const OUTPUT_BYTES = 512 * 1024;

class EvidenceError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
	throw new EvidenceError(code, message);
}
/** @param {unknown} value @param {string} label @returns {Row} */
function row(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("INVALID_INPUT", `${label} must be an object.`);
	return /** @type {Row} */ (value);
}
/** @param {Row} value @param {string[]} allowed @param {string} label */
function fields(value, allowed, label) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		fail("INVALID_INPUT", `${label} contains unsupported fields.`);
}
/** @param {unknown} value @param {string} label @param {number} [maximum] */
function text(value, label, maximum = 4096) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		Buffer.byteLength(value, "utf8") > maximum ||
		Buffer.from(value, "utf8").toString("utf8") !== value
	)
		fail("INVALID_INPUT", `${label} must be bounded nonempty Unicode text.`);
	return value;
}
/** @param {unknown} value @param {string} label @param {number} maximum @returns {unknown[]} */
function list(value, label, maximum) {
	if (!Array.isArray(value) || value.length > maximum)
		fail("INVALID_INPUT", `${label} must be an array of at most ${maximum}.`);
	return value;
}
/** @param {string[]} values @param {string} label */
function unique(values, label) {
	if (new Set(values).size !== values.length)
		fail("INVALID_INPUT", `${label} contains duplicate identifiers.`);
}
/** @param {unknown} value @param {string} label */
function identifier(value, label) {
	const result = text(value, label, 200);
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(result))
		fail("INVALID_INPUT", `${label} is malformed.`);
	return result;
}
/** @param {unknown} value @param {string} label */
function digest(value, label) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail("INVALID_INPUT", `${label} must be a lowercase SHA256 digest.`);
	return value;
}
/** @param {unknown} value */
function commit(value) {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
	)
		fail("INVALID_INPUT", "Commit must be a full lowercase hash or null.");
	return value;
}
/** @param {string | Buffer} value */
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** Paths use repository-relative POSIX spelling, including on other hosts.
 * @param {unknown} value */
function repositoryPath(value) {
	const path = text(value, "Repository path", 1024);
	if (
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes(":") ||
		[...path].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		path.split("/").some((part) => ["", ".", ".."].includes(part))
	)
		fail("INVALID_PATH", "Use contained repository-relative file paths.");
	return path;
}
/** @param {unknown} value @param {string} label */
function limitations(value, label) {
	return list(value, label, 16).map((item) => text(item, label));
}
/** @param {unknown} value */
function registry(value) {
	const input = row(value, "Registry");
	fields(
		input,
		["version", "projectId", "provenance", "limitations", "facts"],
		"Registry",
	);
	if (input.version !== 1) fail("INVALID_INPUT", "Registry version must be 1.");
	const provenance = row(input.provenance, "Provenance");
	fields(provenance, ["repository", "commit", "dirtyFiles"], "Provenance");
	const dirtyFiles = list(provenance.dirtyFiles, "Dirty files", 256).map(
		repositoryPath,
	);
	unique(dirtyFiles, "Dirty files");
	const facts = list(input.facts, "Facts", 256).map((value) => {
		const fact = row(value, "Fact");
		fields(
			fact,
			["id", "kind", "state", "messages", "files", "statement", "limitations"],
			"Fact",
		);
		if (
			fact.kind !== "caller" &&
			fact.kind !== "verifiedAssembly" &&
			fact.kind !== "semanticPairing"
		)
			fail("INVALID_INPUT", "Unsupported evidence kind.");
		if (fact.state !== "active" && fact.state !== "retracted")
			fail("INVALID_INPUT", "Fact state must be active or retracted.");
		const messages = list(fact.messages, "Fact messages", 16).map((value) => {
			const message = row(value, "Fact message");
			fields(message, ["messageId", "sourceSha256"], "Fact message");
			return {
				messageId: identifier(message.messageId, "Message id"),
				sourceSha256: digest(message.sourceSha256, "Source SHA256"),
			};
		});
		unique(
			messages.map((message) => message.messageId),
			"Fact messages",
		);
		if (messages.length < (fact.kind === "caller" ? 1 : 2))
			fail(
				"INVALID_INPUT",
				"Caller evidence needs a message; groups need at least two.",
			);
		const files = list(fact.files, "Fact files", 8).map((value) => {
			const file = row(value, "Citation");
			fields(file, ["path", "sha256", "line"], "Citation");
			if (!Number.isSafeInteger(file.line) || Number(file.line) < 1)
				fail("INVALID_INPUT", "Citation line must be a positive integer.");
			return {
				path: repositoryPath(file.path),
				sha256: digest(file.sha256, "File SHA256"),
				line: Number(file.line),
			};
		});
		unique(
			files.map((file) => file.path),
			"Fact files",
		);
		if (fact.kind !== "semanticPairing" && !files.length)
			fail(
				"INVALID_INPUT",
				"Caller and verified assembly evidence require cited files.",
			);
		return /** @type {Fact} */ ({
			id: identifier(fact.id, "Fact id"),
			kind: fact.kind,
			state: fact.state,
			messages,
			files,
			statement: text(fact.statement, "Statement"),
			limitations: limitations(fact.limitations, "Fact limitations"),
		});
	});
	unique(
		facts.map((fact) => fact.id),
		"Facts",
	);
	/** @type {Map<string, string>} */ const sourceHashes = new Map();
	/** @type {Map<string, string>} */ const fileHashes = new Map();
	for (const fact of facts) {
		for (const message of fact.messages) {
			const prior = sourceHashes.get(message.messageId);
			if (prior && prior !== message.sourceSha256)
				fail(
					"INVALID_INPUT",
					"Registry has conflicting Sources for one message.",
				);
			sourceHashes.set(message.messageId, message.sourceSha256);
		}
		for (const file of fact.files) {
			const prior = fileHashes.get(file.path);
			if (prior && prior !== file.sha256)
				fail(
					"INVALID_INPUT",
					"Registry has conflicting hashes for one cited file.",
				);
			fileHashes.set(file.path, file.sha256);
		}
	}
	return {
		version: 1,
		projectId: identifier(input.projectId, "Project id"),
		provenance: {
			repository: text(provenance.repository, "Repository", 2048),
			commit: commit(provenance.commit),
			dirtyFiles,
		},
		limitations: limitations(input.limitations, "Registry limitations"),
		facts,
	};
}
/** Parse only the source portion of known read shapes; never echo tokens or verdicts.
 * @param {unknown} value @returns {Message[]} */
function contextMessages(value) {
	const input = row(value, "Context");
	const shapes = ["page", "targets", "messages", "kind"].filter((key) =>
		Object.hasOwn(input, key),
	);
	if (shapes.length !== 1)
		fail(
			"INVALID_INPUT",
			"Use exactly one supported task, reviewer, or messages context shape.",
		);
	/** @type {unknown[]} */ let raw;
	if (shapes[0] === "page") {
		const page = row(input.page, "Saved task page");
		if (["messages", "kind", "page"].some((key) => Object.hasOwn(page, key)))
			fail("INVALID_INPUT", "Saved page mixes context shapes.");
		raw = list(page.targets, "Targets", 50);
	} else if (shapes[0] === "targets") {
		raw = list(input.targets, "Targets", 50);
	} else if (shapes[0] === "messages") {
		raw = list(input.messages, "Messages", 50);
	} else {
		if (input.kind !== "candidate")
			fail(
				"INVALID_INPUT",
				"Reviewer context must be an exact candidate read.",
			);
		raw = [
			{
				messageId: input.messageId,
				sourceValue: row(input.source, "Reviewer Source").value,
			},
		];
	}
	const messages = raw.map((value) => {
		const message = row(value, "Context message");
		const hasValue = Object.hasOwn(message, "sourceValue");
		const hasHash = Object.hasOwn(message, "sourceSha256");
		if (hasValue === hasHash)
			fail(
				"INVALID_INPUT",
				"Supply exactly one exact Source value or Source SHA256.",
			);
		let sourceSha256;
		if (hasValue) {
			const value = message.sourceValue;
			if (
				typeof value !== "string" ||
				Buffer.byteLength(value) > 64 * 1024 ||
				Buffer.from(value).toString("utf8") !== value
			)
				fail(
					"INVALID_INPUT",
					"Source must be exact bounded Unicode text (empty is allowed).",
				);
			sourceSha256 = hash(value);
		} else sourceSha256 = digest(message.sourceSha256, "Source SHA256");
		return {
			messageId: identifier(message.messageId, "Message id"),
			sourceSha256,
		};
	});
	if (!messages.length)
		fail("INVALID_INPUT", "Supply at least one current Source.");
	unique(
		messages.map((message) => message.messageId),
		"Context messages",
	);
	return messages;
}
/** Read bounded regular files only. Opening resolved citation paths with NOFOLLOW
 * also prevents a replaced final symlink from being followed after containment.
 * @param {string} path @param {number} maximum @returns {Promise<Buffer>} */
async function bytes(path, maximum) {
	if (!(await stat(path)).isFile())
		fail("INVALID_INPUT", "Evidence inputs must be regular files.");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > maximum)
			fail(
				"INPUT_TOO_LARGE",
				"Evidence file exceeds its regular-file byte bound.",
			);
		const stream = file.createReadStream({ autoClose: false });
		const timer = setTimeout(
			() =>
				stream.destroy(
					new EvidenceError("TIMEOUT", "Evidence read timed out."),
				),
			5000,
		);
		try {
			const chunks = [];
			let length = 0;
			for await (const chunk of stream) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += buffer.length;
				if (length > maximum)
					fail("INPUT_TOO_LARGE", "Evidence file exceeds its byte bound.");
				chunks.push(buffer);
			}
			return Buffer.concat(chunks);
		} finally {
			clearTimeout(timer);
			stream.destroy();
		}
	} finally {
		await file.close();
	}
}
/** @param {string} path */
async function jsonFile(path) {
	const content = await bytes(await realpath(path), INPUT_BYTES);
	try {
		return {
			value: /** @type {unknown} */ (
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content))
			),
			sha256: hash(content),
		};
	} catch {
		return fail("INVALID_INPUT", "Could not parse bounded UTF-8 JSON input.");
	}
}
/** @param {string} root @param {string} path */
function contained(root, path) {
	const inside = relative(root, path);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
		fail(
			"INVALID_PATH",
			"Cited file resolves outside the selected repository.",
		);
}
/** Resolve each ancestor before following it, including dangling escape links.
 * @param {string} root @param {string} path */
async function citationPath(root, path) {
	let current = root;
	for (const part of path.split("/")) {
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink())
			contained(root, resolve(dirname(current), await readlink(current)));
		current = await realpath(current);
		contained(root, current);
	}
	return current;
}
/** @param {ReturnType<typeof registry>} evidence @param {Message[]} messages @param {string} root @param {string | null} reportedCommit */
async function select(evidence, messages, root, reportedCommit) {
	const requested = new Map(
		messages.map((message) => [message.messageId, message.sourceSha256]),
	);
	const facts = evidence.facts.filter((fact) =>
		fact.messages.some((message) => requested.has(message.messageId)),
	);
	const paths = [
		...new Set(facts.flatMap((fact) => fact.files.map((file) => file.path))),
	];
	if (paths.length > 64)
		fail(
			"LIMIT_EXCEEDED",
			"Selection cites more than 64 files; request fewer messages.",
		);
	/** @type {Map<string, {status: 'matching' | 'changed' | 'missing' | 'unreadable', actualSha256: string | null}>} */ const files =
		new Map();
	let total = 0;
	for (const path of paths) {
		try {
			const resolved = await citationPath(root, path);
			const content = await bytes(
				resolved,
				Math.min(FILE_BYTES, TOTAL_FILE_BYTES - total),
			);
			total += content.length;
			files.set(path, { status: "matching", actualSha256: hash(content) });
		} catch (error) {
			if (error instanceof EvidenceError) throw error;
			const code = /** @type {NodeJS.ErrnoException} */ (error).code;
			if (!["ENOENT", "EACCES", "EPERM"].includes(code ?? "")) throw error;
			files.set(path, {
				status: code === "ENOENT" ? "missing" : "unreadable",
				actualSha256: null,
			});
		}
	}
	const commitStatus =
		!reportedCommit || !evidence.provenance.commit
			? "unknown"
			: reportedCommit === evidence.provenance.commit
				? "matchingReportedCommit"
				: "differentReportedCommit";
	return {
		requestedMessages: messages.map((message) => message.messageId),
		unavailableMessages: messages
			.filter(
				(message) =>
					!facts.some(
						(fact) =>
							fact.state === "active" &&
							fact.messages.some(
								(member) => member.messageId === message.messageId,
							),
					),
			)
			.map((message) => message.messageId),
		provenance: {
			...evidence.provenance,
			reportedCommit,
			commitStatus,
			commitVerification: "callerReportedOnly",
			dirtyFilesVerification: "recordedOnly",
		},
		limitations: evidence.limitations,
		facts: facts.map((fact) => {
			const members = fact.messages.map((message) => ({
				...message,
				sourceStatus: !requested.has(message.messageId)
					? "notSupplied"
					: requested.get(message.messageId) === message.sourceSha256
						? "matching"
						: "changed",
			}));
			const citations = fact.files.map((file) => {
				const observed = files.get(file.path);
				if (!observed)
					return fail(
						"INVALID_INPUT",
						"Citation verification was not recorded.",
					);
				return {
					...file,
					...observed,
					status:
						observed.actualSha256 !== null &&
						observed.actualSha256 !== file.sha256
							? "changed"
							: observed.status,
					recordedDirty: evidence.provenance.dirtyFiles.includes(file.path),
				};
			});
			const stale =
				commitStatus === "differentReportedCommit" ||
				members.some((message) => message.sourceStatus === "changed") ||
				citations.some((file) => ["changed", "missing"].includes(file.status));
			const unknown =
				commitStatus === "unknown" ||
				members.some((message) => message.sourceStatus === "notSupplied") ||
				citations.some((file) => file.status === "unreadable");
			return {
				...fact,
				messages: members,
				files: citations,
				status:
					fact.state === "retracted"
						? "retracted"
						: stale
							? "stale"
							: unknown
								? "unknown"
								: "matching",
			};
		}),
	};
}

const help = `Select local supplementary evidence (Node.js 22+)
node blabla-evidence.mjs select --registry FILE --context FILE --checkout DIR --project ID [--commit SHA]
Reads an immutable registry, current task/reviewer Sources and cited files only.
Commit is caller-reported; hashes do not establish clean checkout or runtime/fit.
Output retains full explicit groups, limitations, stale, unknown and retracted facts.
See ../references/evidence.md for input shapes and fixed bounds.
`;
/** @param {string[]} argv */
export async function main(argv) {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0]))
		return process.stdout.write(help);
	if (argv[0] !== "select") fail("USAGE", help);
	/** @type {Map<string, string>} */ const flags = new Map();
	for (let index = 1; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (
			![
				"--registry",
				"--context",
				"--checkout",
				"--project",
				"--commit",
			].includes(flag) ||
			!value ||
			flags.has(flag)
		)
			fail(
				"INVALID_ARGUMENT",
				"Unknown, repeated, or incomplete evidence option.",
			);
		flags.set(flag, value);
	}
	for (const flag of ["--registry", "--context", "--checkout", "--project"])
		if (!flags.has(flag)) fail("INVALID_ARGUMENT", `${flag} is required.`);
	const registryInput = await jsonFile(
		resolve(text(flags.get("--registry"), "Registry file")),
	);
	const contextInput = await jsonFile(
		resolve(text(flags.get("--context"), "Context file")),
	);
	const evidence = registry(registryInput.value);
	const projectId = identifier(flags.get("--project"), "Project id");
	if (projectId !== evidence.projectId)
		fail("IDENTITY_MISMATCH", "Registry belongs to another project.");
	const context = row(contextInput.value, "Context");
	if (Object.hasOwn(context, "projectId") && context.projectId !== projectId)
		fail("IDENTITY_MISMATCH", "Context belongs to another project.");
	const root = await realpath(
		resolve(text(flags.get("--checkout"), "Checkout path")),
	);
	if (!(await stat(root)).isDirectory())
		fail("INVALID_INPUT", "Checkout must be a directory.");
	const packet = {
		kind: "localSupplementaryEvidence",
		version: 1,
		projectId,
		registrySha256: registryInput.sha256,
		contextSha256: contextInput.sha256,
		...(await select(
			evidence,
			contextMessages(context),
			root,
			flags.has("--commit") ? commit(flags.get("--commit")) : null,
		)),
	};
	const output = `${JSON.stringify(packet, null, 2)}\n`;
	if (Buffer.byteLength(output) > OUTPUT_BYTES)
		fail(
			"LIMIT_EXCEEDED",
			"Evidence packet exceeds 512 KiB; request fewer messages.",
		);
	process.stdout.write(output);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	main(process.argv.slice(2)).catch((error) => {
		const failure =
			error instanceof EvidenceError
				? error
				: new EvidenceError(
						"READ_FAILED",
						"Could not read evidence inputs or cited files.",
					);
		process.stderr.write(
			`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`,
		);
		process.exitCode = 1;
	});
}
