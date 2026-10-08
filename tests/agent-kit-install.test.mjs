import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts/install-agent-kit.mjs");
/** @param {string} target @param {string[]} extra */
function install(target, extra = []) {
	return spawnSync(process.execPath, [installer, "--to", target, ...extra], {
		encoding: "utf8",
	});
}

/** @param {string} directory @returns {Promise<string[]>} */
async function files(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await files(path)));
		else result.push(path);
	}
	return result;
}

/** Capture bytes and filesystem identity without following symlinks.
 * @param {string} directory @returns {Promise<unknown[]>} */
async function snapshot(directory) {
	const result = [];
	for (const name of (await readdir(directory)).sort()) {
		const path = join(directory, name);
		const info = await lstat(path);
		result.push([
			path,
			info.ino,
			info.mode,
			info.mtimeMs,
			info.isSymbolicLink()
				? await readlink(path)
				: info.isFile()
					? await readFile(path)
					: await snapshot(path),
		]);
	}
	return result;
}

test("check fingerprints the complete installed bundle, ignores sibling skills, and makes no writes", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-check-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const target = join(temporary, "skills");
	const installed = install(target);
	assert.equal(installed.status, 0, installed.stderr);
	const digest = installed.stdout.match(/Bundle SHA256: ([a-f0-9]{64})/)?.[1];
	assert.ok(digest);
	await mkdir(join(target, "other-skill"));
	await writeFile(join(target, "other-skill/private-data"), "untouched");
	const preload = join(temporary, "read-only.cjs");
	await writeFile(
		preload,
		`
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
for (const method of ['cp', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'writeFile'])
  fs.promises[method] = async () => { throw new Error('Unexpected mutation: ' + method); };
const originalOpen = fs.promises.open;
fs.promises.open = async function(path, flags, ...args) {
  if (flags !== (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW))
    throw new Error('Unexpected write open');
  return originalOpen.call(this, path, flags, ...args);
};
syncBuiltinESMExports();
`,
	);
	const before = await snapshot(target);
	const checked = spawnSync(
		process.execPath,
		["--require", preload, installer, "--to", target, "--check"],
		{ encoding: "utf8" },
	);
	assert.equal(checked.status, 0, checked.stderr);
	assert.ok(checked.stdout.includes(`Bundle SHA256: ${digest}`));
	const support = join(await realpath(target), "_blabla");
	assert.ok(checked.stdout.includes(`Shared support root: ${support}`));
	assert.ok(installed.stdout.includes(`Shared support root: ${support}`));
	assert.deepEqual(await snapshot(target), before);
	const repeated = install(target, ["--check"]);
	assert.equal(repeated.stdout, checked.stdout);
});

test("check identifies missing and changed files and extra paths without reading extra contents", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-drift-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const target = join(temporary, "skills");
	assert.equal(install(target).status, 0);
	await rm(join(target, "blabla-context/SKILL.md"));
	await writeFile(join(target, "blabla-review/SKILL.md"), "local change");
	const privateFile = join(target, "_blabla/credentials.json");
	await writeFile(privateFile, "private credential sentinel");
	await mkdir(join(target, "_blabla/extra-directory"));
	const preload = join(temporary, "protect-private.cjs");
	await writeFile(
		preload,
		`
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalOpen = fs.promises.open;
fs.promises.open = async function(path, ...args) {
  if (path === process.env.PROTECTED_PATH) throw new Error('Private file was opened');
  return originalOpen.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
	);
	const before = await snapshot(target);
	const checked = spawnSync(
		process.execPath,
		["--require", preload, installer, "--to", target, "--check"],
		{ encoding: "utf8", env: { ...process.env, PROTECTED_PATH: privateFile } },
	);
	assert.notEqual(checked.status, 0);
	assert.match(checked.stderr, /Bundle mismatch/);
	assert.match(checked.stderr, /Missing: blabla-context\/SKILL.md/);
	assert.match(checked.stderr, /Changed: blabla-review\/SKILL.md/);
	assert.match(checked.stderr, /Extra: _blabla\/credentials.json/);
	assert.match(checked.stderr, /Extra: _blabla\/extra-directory/);
	assert.match(checked.stderr, /Source SHA256: [a-f0-9]{64}/);
	assert.match(checked.stderr, /extra files were not read/);
	assert.doesNotMatch(
		checked.stderr,
		/Private file was opened|private credential sentinel/,
	);
	assert.match(checked.stderr, /matching reviewed checkout|new directory/);
	assert.deepEqual(await snapshot(target), before);
	await rm(join(target, "_blabla/credentials.json"));
	await rm(join(target, "_blabla/extra-directory"), { recursive: true });
	assert.match(
		install(target, ["--check"]).stderr,
		/Installed SHA256: [a-f0-9]{64}/,
	);
	await rm(join(target, "blabla-dictionary"), { recursive: true });
	assert.match(
		install(target, ["--check"]).stderr,
		/Missing: blabla-dictionary/,
	);
});

test("check requires an explicit destination, preserves missing directories, and rejects replacement", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-missing-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const target = join(temporary, "missing/skills");
	const before = await snapshot(temporary);
	assert.match(install(target, ["--check"]).stderr, /Missing: _blabla/);
	assert.deepEqual(await snapshot(temporary), before);
	assert.match(
		install(target, ["--check", "--replace"]).stderr,
		/cannot be combined/,
	);
	const missingDestination = spawnSync(
		process.execPath,
		[installer, "--check"],
		{ encoding: "utf8" },
	);
	assert.match(missingDestination.stderr, /explicit destination/);
	assert.deepEqual(await snapshot(temporary), before);
});

test("check refuses symlink roots and bundle entries and special files, while allowing ancestor aliases", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-unsafe-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const target = join(temporary, "skills");
	assert.equal(install(target).status, 0);
	const alias = join(temporary, "alias");
	await symlink(target, alias, "dir");
	assert.match(install(alias, ["--check"]).stderr, /symlink destination/);
	const parentAlias = join(temporary, "parent-alias");
	await symlink(temporary, parentAlias, "dir");
	assert.equal(install(join(parentAlias, "skills"), ["--check"]).status, 0);
	const file = join(target, "blabla-context/SKILL.md");
	await rm(file);
	await symlink(join(root, "agent-kit/blabla-context/SKILL.md"), file);
	const before = await snapshot(target);
	assert.match(
		install(target, ["--check"]).stderr,
		/symlink or invalid bundle entry/,
	);
	assert.deepEqual(await snapshot(target), before);
	await rm(file);
	await cp(join(root, "agent-kit/blabla-context/SKILL.md"), file);
	await rm(join(target, "blabla-dictionary"), { recursive: true });
	await symlink(
		join(root, "agent-kit/blabla-dictionary"),
		join(target, "blabla-dictionary"),
		"dir",
	);
	assert.match(
		install(target, ["--check"]).stderr,
		/symlink or invalid bundle entry/,
	);
	await rm(join(target, "blabla-dictionary"));
	await cp(
		join(root, "agent-kit/blabla-dictionary"),
		join(target, "blabla-dictionary"),
		{ recursive: true },
	);
	const fifo = join(target, "_blabla/private-pipe");
	const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	assert.match(install(target, ["--check"]).stderr, /special bundle file/);
});

test("installed bundle runs outside the checkout, resolves references, and replaces only its own folders", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-"));
	try {
		const target = join(temporary, "skills");
		const first = install(target);
		assert.equal(first.status, 0, first.stderr);
		assert.deepEqual((await readdir(target)).sort(), [
			"_blabla",
			"blabla-context",
			"blabla-dictionary",
			"blabla-review",
			"blabla-translate",
		]);
		const helper = join(target, "_blabla/scripts/blabla-agent.mjs");
		const help = spawnSync(process.execPath, [helper, "--help"], {
			cwd: temporary,
			encoding: "utf8",
			env: { PATH: process.env.PATH },
		});
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /request/);
		const workflow = spawnSync(
			process.execPath,
			[join(target, "_blabla/scripts/blabla-workflow.mjs"), "--help"],
			{
				cwd: temporary,
				encoding: "utf8",
				env: { PATH: process.env.PATH },
			},
		);
		assert.equal(workflow.status, 0, workflow.stderr);
		assert.match(workflow.stdout, /review submit/);
		for (const [name, argument] of [
			["blabla-campaign.mjs", "--manifest"],
			["blabla-evidence.mjs", "--registry"],
		]) {
			const helper = spawnSync(
				process.execPath,
				[join(target, "_blabla/scripts", name), "--help"],
				{
					cwd: temporary,
					encoding: "utf8",
					env: { PATH: process.env.PATH },
				},
			);
			assert.equal(helper.status, 0, helper.stderr);
			assert.ok(helper.stdout.includes(argument));
		}
		for (const file of await files(target)) {
			if (!file.endsWith(".md")) continue;
			const content = await readFile(file, "utf8");
			for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
				const link = match[1];
				if (!link || link.startsWith("https://") || link.startsWith("#"))
					continue;
				const [path] = link.split("#");
				if (path) await readFile(resolve(dirname(file), path));
			}
		}
		await writeFile(join(target, "unrelated.txt"), "keep");
		const skill = join(target, "blabla-context/SKILL.md");
		await writeFile(skill, "local edit");
		const refused = install(target);
		assert.notEqual(refused.status, 0);
		assert.equal(await readFile(skill, "utf8"), "local edit");
		const replaced = install(target, ["--replace"]);
		assert.equal(replaced.status, 0, replaced.stderr);
		assert.match(await readFile(skill, "utf8"), /name: blabla-context/);
		assert.equal(await readFile(join(target, "unrelated.txt"), "utf8"), "keep");
		assert.equal(
			(await readdir(target)).some((name) =>
				name.startsWith(".blabla-install-"),
			),
			false,
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("installer rejects symlinks and source-tree destinations before replacing anything", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-"));
	try {
		const alias = join(temporary, "source");
		await symlink(root, alias, "dir");
		for (const target of [
			join(root, "agent-kit"),
			join(alias, "agent-kit"),
			join(alias, "agent-kit/nested"),
			join(root, "agent-kit/nested"),
		]) {
			assert.notEqual(install(target, ["--replace"]).status, 0);
		}
		const target = join(temporary, "skills");
		assert.equal(install(target).status, 0);
		await rm(join(target, "blabla-context"), { recursive: true });
		await symlink(
			join(root, "agent-kit/blabla-context"),
			join(target, "blabla-context"),
			"dir",
		);
		assert.notEqual(install(target, ["--replace"]).status, 0);
		assert.match(
			await readFile(join(root, "agent-kit/blabla-context/SKILL.md"), "utf8"),
			/name: blabla-context/,
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("replacing a destination cannot remove a checkout nested in one of its bundle folders", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-"));
	try {
		const target = join(temporary, "skills");
		const checkout = join(target, "blabla-context/checkout");
		await mkdir(join(checkout, "scripts"), { recursive: true });
		await cp(installer, join(checkout, "scripts/install-agent-kit.mjs"));
		await cp(join(root, "agent-kit"), join(checkout, "agent-kit"), {
			recursive: true,
		});
		const result = spawnSync(
			process.execPath,
			[
				join(checkout, "scripts/install-agent-kit.mjs"),
				"--to",
				target,
				"--replace",
			],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(
			await readFile(
				join(checkout, "agent-kit/blabla-context/SKILL.md"),
				"utf8",
			),
			/name: blabla-context/,
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("interrupted swaps restore the previous bundle before overwrite permission is checked", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-crash-"));
	try {
		const preload = join(temporary, "kill-rename.cjs");
		await writeFile(
			preload,
			`
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.promises.rename;
const originalCopy = fs.promises.cp;
const originalMkdtemp = fs.promises.mkdtemp;
fs.promises.mkdtemp = async function(prefix) {
  const result = await originalMkdtemp.call(this, prefix);
  if (process.env.KILL_PHASE === 'empty-stage') process.kill(process.pid, 'SIGKILL');
  return result;
};
fs.promises.cp = async function(from, to, options) {
  const result = await originalCopy.call(this, from, to, options);
  if (process.env.KILL_PHASE === 'staging') process.kill(process.pid, 'SIGKILL');
  return result;
};
fs.promises.rename = async function(from, to) {
  if (process.env.KILL_PHASE === 'initial-journal' && to.endsWith('/journal.json')) process.kill(process.pid, 'SIGKILL');
  const result = await original.call(this, from, to);
  const hit = process.env.KILL_PHASE === 'backup'
    ? to.endsWith('blabla-translate.previous')
    : from.includes('.blabla-install-') && from.endsWith('/blabla-translate');
  if (hit) process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`,
		);
		for (const phase of [
			"empty-stage",
			"initial-journal",
			"staging",
			"backup",
			"install",
		]) {
			const target = join(temporary, phase);
			assert.equal(install(target).status, 0);
			const bundle = [
				"blabla-context",
				"blabla-translate",
				"blabla-review",
				"blabla-dictionary",
				"_blabla",
			];
			for (const entry of bundle)
				await writeFile(join(target, entry, "old-version"), entry);
			await writeFile(join(target, "unrelated.txt"), "keep");
			const killed = spawnSync(
				process.execPath,
				["--require", preload, installer, "--to", target, "--replace"],
				{
					encoding: "utf8",
					env: { ...process.env, KILL_PHASE: phase },
				},
			);
			assert.equal(killed.signal, "SIGKILL", killed.stderr);
			const interrupted = await snapshot(target);
			const checked = install(target, ["--check"]);
			assert.notEqual(checked.status, 0);
			assert.match(checked.stderr, /Installation or recovery evidence exists/);
			assert.deepEqual(await snapshot(target), interrupted);
			const resumed = install(target);
			assert.notEqual(resumed.status, 0);
			assert.match(resumed.stderr, /already exists/);
			for (const entry of bundle)
				assert.equal(
					await readFile(join(target, entry, "old-version"), "utf8"),
					entry,
				);
			assert.equal(
				await readFile(join(target, "unrelated.txt"), "utf8"),
				"keep",
			);
			assert.equal(
				(await readdir(target)).some((name) =>
					name.startsWith(".blabla-install"),
				),
				false,
			);
			assert.equal(install(target, ["--replace"]).status, 0);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("a committed interrupted cleanup retains the new bundle; invalid recovery evidence is preserved", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-skills-commit-"));
	try {
		const target = join(temporary, "skills");
		assert.equal(install(target).status, 0);
		await writeFile(join(target, "blabla-context/old-version"), "old");
		const preload = join(temporary, "kill-commit.cjs");
		await writeFile(
			preload,
			`
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.promises.rename;
fs.promises.rename = async function(from, to) {
  const result = await original.call(this, from, to);
  if (to.endsWith('/journal.json') && JSON.parse(fs.readFileSync(to, 'utf8')).state === 'committed')
    process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`,
		);
		const killed = spawnSync(
			process.execPath,
			["--require", preload, installer, "--to", target, "--replace"],
			{ encoding: "utf8" },
		);
		assert.equal(killed.signal, "SIGKILL", killed.stderr);
		const interrupted = await snapshot(target);
		assert.match(
			install(target, ["--check"]).stderr,
			/Installation or recovery evidence exists/,
		);
		assert.deepEqual(await snapshot(target), interrupted);
		assert.match(install(target).stderr, /already exists/);
		assert.equal(
			(await readdir(join(target, "blabla-context"))).includes("old-version"),
			false,
		);
		assert.equal(
			(await readdir(target)).some((name) =>
				name.startsWith(".blabla-install"),
			),
			false,
		);
		const stage = join(target, ".blabla-install-invalid");
		await mkdir(stage);
		await writeFile(
			join(stage, "journal.json"),
			JSON.stringify({ version: 1, state: "ready", previous: ["../outside"] }),
		);
		const refused = install(target, ["--replace"]);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /journal is invalid/);
		assert.match(
			await readFile(join(stage, "journal.json"), "utf8"),
			/outside/,
		);
		assert.match(
			await readFile(join(target, "blabla-context/SKILL.md"), "utf8"),
			/name: blabla-context/,
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("interrupted rollback and committed cleanup retain recoverable evidence", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "blabla-cleanup-"));
	try {
		const preload = join(temporary, "kill-cleanup.cjs");
		await writeFile(
			preload,
			`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.promises.rm;
fs.promises.rm = async function(location, options) {
  if (path.basename(location).startsWith('.blabla-install-')) {
    // Reproduce a permitted recursive deletion order: journal first.
    await original(path.join(location, 'journal.json'), { force: true });
    process.kill(process.pid, 'SIGKILL');
  }
  const result = await original.call(this, location, options);
  if (path.basename(path.dirname(location)).startsWith('.blabla-install-'))
    process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`,
		);
		for (const state of ["ready", "committed"]) {
			const target = join(temporary, state);
			assert.equal(install(target).status, 0);
			const stage = join(target, ".blabla-install-fixture");
			await mkdir(stage);
			const bundle = [
				"blabla-context",
				"blabla-translate",
				"blabla-review",
				"blabla-dictionary",
				"_blabla",
			];
			await writeFile(
				join(stage, "journal.json"),
				JSON.stringify({ version: 1, state, previous: bundle }),
			);
			for (const entry of bundle) {
				await writeFile(join(target, entry, "version"), "new");
				await mkdir(join(stage, `${entry}.previous`));
				await writeFile(join(stage, `${entry}.previous`, "version"), "old");
				if (state === "ready") await mkdir(join(stage, entry));
			}
			await writeFile(join(target, "unrelated.txt"), "keep");
			const killed = spawnSync(
				process.execPath,
				["--require", preload, installer, "--to", target],
				{ encoding: "utf8" },
			);
			assert.equal(killed.signal, "SIGKILL", killed.stderr);
			const resumed = install(target);
			assert.match(resumed.stderr, /already exists/);
			for (const entry of bundle)
				assert.equal(
					await readFile(join(target, entry, "version"), "utf8"),
					state === "ready" ? "old" : "new",
				);
			assert.equal(
				await readFile(join(target, "unrelated.txt"), "utf8"),
				"keep",
			);
			assert.equal(
				(await readdir(target)).some((name) =>
					name.startsWith(".blabla-install"),
				),
				false,
			);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
