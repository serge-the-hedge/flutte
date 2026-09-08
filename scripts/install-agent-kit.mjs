#!/usr/bin/env node
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
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

--to       Explicit destination, e.g. /path/to/app/.agents/skills
--replace  Replace these five existing bundle directories, including local edits.
           Other skills are untouched. Symlink destinations are rejected.
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

/** Stage the complete bundle before touching existing installations.
 * @param {string[]} args */
async function install(args) {
	if (args.length === 0 || args.includes("--help")) {
		process.stdout.write(help);
		return;
	}
	let destination;
	let replace = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--to" && destination === undefined) {
			destination = args[++index];
			if (!destination || destination.startsWith("--"))
				throw new Error("--to requires an agent skills directory.");
		} else if (arg === "--replace" && !replace) replace = true;
		else throw new Error("Unknown or repeated option. Use --help.");
	}
	if (!destination)
		throw new Error("Choose an explicit destination with --to.");
	const target = resolve(destination);
	const source = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../agent-kit",
	);
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
		if (info && !replace)
			throw new Error(
				`${entry} already exists. Back up edits or use --replace.`,
			);
	}
	await mkdir(target, { recursive: true });
	const stage = await mkdtemp(join(target, ".blabla-install-"));
	/** @type {string[]} */
	const backedUp = [];
	/** @type {string[]} */
	const installed = [];
	let cleanup = true;
	try {
		for (const entry of entries)
			await cp(join(source, entry), join(stage, entry), { recursive: true });
		for (const entry of entries) {
			const path = join(target, entry);
			if (await existing(path)) {
				await rename(path, join(stage, `${entry}.previous`));
				backedUp.push(entry);
			}
			await rename(join(stage, entry), path);
			installed.push(entry);
		}
	} catch (error) {
		try {
			for (const entry of installed)
				await rm(join(target, entry), { recursive: true, force: true });
			for (const entry of backedUp)
				await rename(join(stage, `${entry}.previous`), join(target, entry));
		} catch {
			cleanup = false;
			throw new Error(
				`Installation and rollback failed. Recover previous folders from ${stage}`,
			);
		}
		throw error;
	} finally {
		if (cleanup) await rm(stage, { recursive: true, force: true });
	}
	process.stdout.write(
		`Installed four Blabla skills and shared support in ${target}\n`,
	);
}

install(process.argv.slice(2)).catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Installation failed."}\n`,
	);
	process.exitCode = 1;
});
