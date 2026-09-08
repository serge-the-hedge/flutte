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
