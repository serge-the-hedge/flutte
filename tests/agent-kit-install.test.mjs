import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
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
