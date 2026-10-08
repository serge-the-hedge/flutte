#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const entries = [
	"blabla-context",
	"blabla-translate",
	"blabla-review",
	"blabla-dictionary",
	"_blabla",
];
const help = `Install the complete portable Blabla skill bundle.
Usage: node scripts/install-agent-kit.mjs --to <agent-skills-directory> [--replace]
       node scripts/install-agent-kit.mjs --to <agent-skills-directory> --check

--to       Explicit destination, e.g. /path/to/app/.agents/skills
--replace  Replace these five existing bundle directories, including local edits.
           Other skills are untouched. Symlink destinations are rejected.
--check    Compare the five installed folders with this checkout, without writes.
           Cannot be combined with --replace. Unrelated sibling skills are ignored.
No credentials, global installation, or agent configuration are created.
`;

/** @param {string} path */
async function existing(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}

/** @param {string} path @param {string} directory */
function inside(path, directory) {
	const nested = relative(directory, path);
	return (
		!nested ||
		(nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
	);
}

/** @typedef {{kind: "directory" | "file", sha256?: string}} BundleEntry */

/** Inventory only the five bundle folders. Extra installed files are identified
 * without opening them; they may contain private consumer data.
 * @param {string} root @param {Map<string, BundleEntry>} [expected] */
async function bundle(root, expected) {
	/** @type {Map<string, BundleEntry>} */
	const result = new Map();
	/** @param {string} name @param {boolean} [top] */
	async function visit(name, top = false) {
		const path = join(root, name);
		const info = await existing(path);
		if (!info) return;
		if (info.isSymbolicLink() || (top && !info.isDirectory()))
			throw new Error(`Refusing symlink or invalid bundle entry: ${name}`);
		if (info.isDirectory()) {
			result.set(name, { kind: "directory" });
			for (const child of (await readdir(path)).sort())
				await visit(`${name}/${child}`);
		} else if (info.isFile()) {
			const entry = /** @type {BundleEntry} */ ({ kind: "file" });
			if (!expected || expected.get(name)?.kind === "file") {
				const handle = await open(
					path,
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				try {
					if (!(await handle.stat()).isFile())
						throw new Error(`Refusing special bundle file: ${name}`);
					entry.sha256 = createHash("sha256")
						.update(await handle.readFile())
						.digest("hex");
				} finally {
					await handle.close();
				}
			}
			result.set(name, entry);
		} else throw new Error(`Refusing special bundle file: ${name}`);
	}
	for (const name of entries) await visit(name, true);
	return result;
}

/** Paths, entry kinds and exact file hashes determine the bundle identity.
 * @param {Map<string, BundleEntry>} inventory */
function fingerprint(inventory) {
	if (
		[...inventory.values()].some(
			(entry) => entry.kind === "file" && !entry.sha256,
		)
	)
		return "unavailable (extra files were not read)";
	return createHash("sha256")
		.update(
			JSON.stringify(
				[...inventory].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
			),
		)
		.digest("hex");
}

/** @param {Map<string, BundleEntry>} expected @param {Map<string, BundleEntry>} actual */
function differences(expected, actual) {
	const changes = [];
	for (const name of [
		...new Set([...expected.keys(), ...actual.keys()]),
	].sort()) {
		const wanted = expected.get(name);
		const found = actual.get(name);
		if (!wanted) changes.push(`Extra: ${name}`);
		else if (!found) changes.push(`Missing: ${name}`);
		else if (wanted.kind !== found.kind || wanted.sha256 !== found.sha256)
			changes.push(`Changed: ${name}`);
	}
	return changes;
}

/** This branch never acquires locks, recovers stages, or creates directories.
 * @param {string} target @param {Map<string, BundleEntry>} expected */
async function checkBundle(target, expected) {
	try {
		const info = await existing(target);
		if (info && (!info.isDirectory() || info.isSymbolicLink()))
			throw new Error(
				`Refusing non-directory or symlink destination: ${target}`,
			);
		const selected = info ? await realpath(target) : target;
		if (info) {
			if (
				(await readdir(selected)).some((name) =>
					name.startsWith(".blabla-install"),
				)
			)
				throw new Error(
					"Installation or recovery evidence exists; preserve it and finish the ordinary installer at an idle boundary.",
				);
		}
		const actual = await bundle(selected, expected);
		const changes = differences(expected, actual);
		if (changes.length)
			throw new Error(
				`Bundle mismatch:\n${changes.join("\n")}\nSource SHA256: ${fingerprint(expected)}\nInstalled SHA256: ${fingerprint(actual)}`,
			);
		process.stdout.write(
			`Bundle matches this checkout in ${selected}\nBundle SHA256: ${fingerprint(actual)}\nShared support root: ${join(selected, "_blabla")}\n`,
		);
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : "Bundle check failed."}\nUse the matching reviewed checkout to check a pinned bundle, or install this reviewed source into a new directory. Update with --replace only at an idle boundary after backing up local edits.`,
			{ cause: error },
		);
	}
}

/** @typedef {{version: 1, state: "preparing" | "ready" | "committed", previous: string[]}} Journal */

/** @param {string} stage @param {Journal} journal */
async function saveJournal(stage, journal) {
	await writeFile(join(stage, "journal.next"), JSON.stringify(journal));
	await rename(join(stage, "journal.next"), join(stage, "journal.json"));
}

/** Recovering twice is safe: a missing backup means the original was never moved
 * or has already been restored. Never delete a previous entry without its backup.
 * @param {string} target @param {string} stage */
async function recover(target, stage) {
	const info = await lstat(stage);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Refusing invalid recovery directory: ${stage}`);
	const journalInfo = await existing(join(stage, "journal.json"));
	if (!journalInfo) {
		// Before the first journal is published, no copies or live moves start.
		const names = await readdir(stage);
		const pending = await existing(join(stage, "journal.next"));
		if (
			names.length === 0 ||
			(names.length === 1 &&
				names[0] === "journal.next" &&
				pending?.isFile() &&
				!pending.isSymbolicLink() &&
				pending.size <= 4096)
		) {
			await rm(stage, { recursive: true, force: true });
			return;
		}
	}
	if (
		!journalInfo?.isFile() ||
		journalInfo.isSymbolicLink() ||
		journalInfo.size > 4096
	)
		throw new Error(
			`Recovery journal is missing or invalid; preserve ${stage}`,
		);
	/** @type {unknown} */
	const raw = JSON.parse(await readFile(join(stage, "journal.json"), "utf8"));
	if (
		!raw ||
		typeof raw !== "object" ||
		!("version" in raw) ||
		raw.version !== 1 ||
		!("state" in raw) ||
		!["preparing", "ready", "committed"].includes(String(raw.state)) ||
		!("previous" in raw) ||
		!Array.isArray(raw.previous) ||
		raw.previous.some(
			(entry) => typeof entry !== "string" || !entries.includes(entry),
		) ||
		new Set(raw.previous).size !== raw.previous.length
	)
		throw new Error(`Recovery journal is invalid; preserve ${stage}`);
	const journal = /** @type {Journal} */ (raw);
	const allowed = new Set([
		"journal.json",
		"journal.next",
		...entries,
		...entries.map((entry) => `${entry}.previous`),
	]);
	for (const name of await readdir(stage)) {
		const child = await lstat(join(stage, name));
		if (
			!allowed.has(name) ||
			child.isSymbolicLink() ||
			(name.startsWith("journal.") ? !child.isFile() : !child.isDirectory())
		)
			throw new Error(`Unexpected recovery contents; preserve ${stage}`);
	}
	// Validate every live entry before making any recovery changes.
	for (const entry of entries) {
		const live = await existing(join(target, entry));
		if (live && (!live.isDirectory() || live.isSymbolicLink()))
			throw new Error(`Refusing invalid live recovery entry: ${entry}`);
		if (
			journal.state === "committed" &&
			(!live || (await existing(join(stage, entry))))
		)
			throw new Error(
				`Committed recovery evidence is incomplete; preserve ${stage}`,
			);
		if (
			journal.state === "ready" &&
			journal.previous.includes(entry) &&
			!live &&
			!(await existing(join(stage, `${entry}.previous`)))
		)
			throw new Error(`Recovery evidence is incomplete; preserve ${stage}`);
		if (
			(journal.state === "preparing" || !journal.previous.includes(entry)) &&
			(await existing(join(stage, `${entry}.previous`)))
		)
			throw new Error(`Recovery evidence is inconsistent; preserve ${stage}`);
	}
	if (journal.state === "ready") {
		for (const entry of entries) {
			const backup = join(stage, `${entry}.previous`);
			if (journal.previous.includes(entry)) {
				if (await existing(backup)) {
					await rm(join(target, entry), { recursive: true, force: true });
					await rename(backup, join(target, entry));
				}
			} else if (!(await existing(join(stage, entry)))) {
				await rm(join(target, entry), { recursive: true, force: true });
			}
		}
	}
	// Keep the recovery journal until every other staged item is gone. If cleanup
	// stops midway, the same rollback/committed recovery can run again safely.
	for (const name of await readdir(stage)) {
		if (name !== "journal.json")
			await rm(join(stage, name), { recursive: true, force: true });
	}
	await rm(join(stage, "journal.json"));
	await rmdir(stage);
}

/** Refuse active owners and ambiguous lock files rather than racing their writes.
 * @param {string} target */
async function acquireLock(target) {
	const path = join(target, ".blabla-install.lock");
	if (await existing(join(target, ".blabla-install.reclaim")))
		throw new Error(
			"Installer recovery guard exists; inspect it before retrying.",
		);
	if (await existing(path)) {
		// Serialize stale-owner removal so two recovery processes cannot unlink a
		// newly acquired lock. A crash here leaves an explicit recovery guard.
		const reclaimPath = join(target, ".blabla-install.reclaim");
		const reclaim = await open(reclaimPath, "wx");
		try {
			const info = await existing(path);
			if (info) {
				if (!info.isFile() || info.isSymbolicLink() || info.size > 64)
					throw new Error(
						"Installer lock is invalid; inspect it before retrying.",
					);
				const text = await readFile(path, "utf8");
				if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)))
					throw new Error(
						"Installer lock is incomplete; inspect it before retrying.",
					);
				try {
					process.kill(Number(text), 0);
					throw new Error("Another installer owns this destination.");
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ESRCH"
						)
					)
						throw error;
				}
				await rm(path);
			}
		} finally {
			await reclaim.close();
			await rm(reclaimPath);
		}
	}
	const handle = await open(path, "wx");
	try {
		await handle.writeFile(String(process.pid));
	} finally {
		await handle.close();
	}
	return path;
}

/** Stage the complete bundle before touching existing installations.
 * @param {string[]} args */
async function install(args) {
	if (args.length === 0 || args.includes("--help")) {
		process.stdout.write(help);
		return;
	}
	let destination;
	let replace = false;
	let check = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--to" && destination === undefined) {
			destination = args[++index];
			if (!destination || destination.startsWith("--"))
				throw new Error("--to requires an agent skills directory.");
		} else if (arg === "--replace" && !replace) replace = true;
		else if (arg === "--check" && !check) check = true;
		else throw new Error("Unknown or repeated option. Use --help.");
	}
	if (!destination)
		throw new Error("Choose an explicit destination with --to.");
	if (check && replace)
		throw new Error("--check cannot be combined with --replace.");
	const target = resolve(destination);
	const source = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../agent-kit",
	);
	const expected = await bundle(source);
	if (entries.some((name) => expected.get(name)?.kind !== "directory"))
		throw new Error("The source checkout is missing a complete bundle folder.");
	if (check) return checkBundle(target, expected);
	const targetInfo = await existing(target);
	let parent = target;
	const missing = [];
	while (!(await existing(parent))) {
		missing.unshift(basename(parent));
		parent = dirname(parent);
	}
	const physicalTarget = join(await realpath(parent), ...missing);
	const physicalSource = await realpath(source);
	if (inside(physicalTarget, physicalSource))
		throw new Error("Install outside the source bundle.");
	if (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()))
		throw new Error("The destination must be a real directory.");
	for (const entry of entries) {
		const path = join(target, entry);
		const info = await existing(path);
		if (inside(physicalSource, join(physicalTarget, entry)))
			throw new Error(
				"The destination cannot replace an ancestor of the source bundle.",
			);
		if (info && (!info.isDirectory() || info.isSymbolicLink()))
			throw new Error(
				`Refusing non-directory or symlink destination: ${entry}`,
			);
	}
	await mkdir(target, { recursive: true });
	const lock = await acquireLock(target);
	try {
		for (const name of await readdir(target)) {
			if (!name.startsWith(".blabla-install-")) continue;
			const stage = join(target, name);
			if (inside(physicalSource, join(physicalTarget, name)))
				throw new Error(
					"Recovery cannot remove an ancestor of the source bundle.",
				);
			await recover(target, stage);
		}
		const previous = [];
		for (const entry of entries) {
			if (await existing(join(target, entry))) {
				if (!replace)
					throw new Error(
						`${entry} already exists. Back up edits or use --replace.`,
					);
				previous.push(entry);
			}
		}
		const stage = await mkdtemp(join(target, ".blabla-install-"));
		/** @type {Journal} */
		const journal = { version: 1, state: "preparing", previous };
		await saveJournal(stage, journal);
		try {
			for (const entry of entries)
				await cp(join(source, entry), join(stage, entry), { recursive: true });
			if (differences(expected, await bundle(stage, expected)).length)
				throw new Error(
					"The source bundle changed while staging; retry from the reviewed checkout.",
				);
			journal.state = "ready";
			await saveJournal(stage, journal);
			for (const entry of entries) {
				if (previous.includes(entry))
					await rename(join(target, entry), join(stage, `${entry}.previous`));
				await rename(join(stage, entry), join(target, entry));
			}
			journal.state = "committed";
			await saveJournal(stage, journal);
		} catch (error) {
			await recover(target, stage);
			throw error;
		}
		await recover(target, stage);
	} finally {
		await rm(lock);
	}
	process.stdout.write(
		`Installed four Blabla skills and shared support in ${physicalTarget}\nBundle SHA256: ${fingerprint(expected)}\nShared support root: ${join(physicalTarget, "_blabla")}\n`,
	);
}

install(process.argv.slice(2)).catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Installation failed."}\n`,
	);
	process.exitCode = 1;
});
