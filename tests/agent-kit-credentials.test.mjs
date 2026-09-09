// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	CredentialError,
	resolveConnection,
} from "../agent-kit/_blabla/scripts/credentials.mjs";

test("the terminal helper authenticates with the selected profile and fails closed before network access", {
	skip: process.platform === "win32",
}, async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const server = createServer((request, response) => {
		calls++;
		assert.equal(request.headers.authorization, `Bearer ${f.token}`);
		assert.equal(request.url, "/api/agent/v1/projects/current");
		response.end('{"project":"brickit"}');
	});
	await new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(null)),
	);
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(() => resolve(null)));
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected local server");
	await f.profile("brickit", {
		version: 1,
		token: f.token,
		server: `http://127.0.0.1:${address.port}`,
	});
	/** @param {string[]} flags @param {NodeJS.ProcessEnv} [extra] */
	async function run(flags, extra = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							"../agent-kit/_blabla/scripts/blabla-agent.mjs",
							import.meta.url,
						),
					),
					"request",
					"GET",
					"/projects/current",
					...flags,
				],
				{
					env: { HOME: f.home, ...extra },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
	}
	const success = await run(["--profile", "brickit"]);
	assert.equal(success.code, 0);
	assert.equal(success.stdout, '{"project":"brickit"}');
	assert.equal(success.stderr, "");
	const absent = await run(["--profile", "missing"]);
	assert.equal(absent.code, 1);
	assert.equal(JSON.parse(absent.stderr).error.code, "CONFIGURATION");
	const mixed = await run(["--profile", "brickit"], { BLABLA_TOKEN: f.token });
	assert.equal(mixed.code, 1);
	assert.ok(!mixed.stderr.includes(f.token));
	assert.equal(calls, 1);
});

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
	const home = await mkdtemp(join(tmpdir(), "blabla-profiles-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const directory = join(home, ".config", "blabla", "profiles");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const token = "PRIVATE_PROFILE_TOKEN";
	/** @param {string} name @param {unknown} [value] */
	async function profile(
		name,
		value = { version: 1, server: "https://example.convex.site", token },
	) {
		const path = join(directory, `${name}.json`);
		await writeFile(path, JSON.stringify(value), { mode: 0o600 });
		return path;
	}
	return { home, directory, profile, token };
}

test("selects only the assigned profile and keeps its destination paired", {
	skip: process.platform === "win32",
}, async (t) => {
	const f = await fixture(t);
	await f.profile("brickit-translator");
	// An inaccessible unrelated reviewer profile must never be read.
	await chmod(await f.profile("brickit-reviewer", "not a credential"), 0o000);
	const result = await resolveConnection({
		HOME: f.home,
		BLABLA_PROFILE: "brickit-translator",
	});
	assert.equal(result.origin.origin, "https://example.convex.site");
	assert.equal(result.token, f.token);
	const explicit = await resolveConnection(
		{ HOME: f.home, BLABLA_PROFILE: "brickit-reviewer" },
		"brickit-translator",
	);
	assert.equal(explicit.token, f.token);
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "missing"),
		CredentialError,
	);
});

test("credentials never mix profiles, canonical environment, or legacy environment pairs", async () => {
	for (const env of [
		{ BLABLA_PROFILE: "brickit", BLABLA_TOKEN: "secret" },
		{ BLABLA_PROFILE: "brickit", BLABLA_AGENT_URL: "https://wrong.example" },
		{ BLABLA_API_URL: "https://example.test", BLABLA_AGENT_TOKEN: "secret" },
		{ BLABLA_TOKEN: "secret" },
		{ BLABLA_API_URL: "https://example.test" },
	])
		await assert.rejects(resolveConnection(env), CredentialError);
	for (const env of [
		{ BLABLA_API_URL: "https://example.test", BLABLA_TOKEN: "canonical" },
		{ BLABLA_AGENT_URL: "https://example.test", BLABLA_AGENT_TOKEN: "legacy" },
	])
		assert.equal(
			(await resolveConnection(env)).origin.origin,
			"https://example.test",
		);
});

test("rejects unsafe profile paths, contents and permissions without exposing secrets", {
	skip: process.platform === "win32",
}, async (t) => {
	const f = await fixture(t);
	for (const name of [
		"",
		"../escape",
		"/absolute",
		"UPPER",
		"trailing\n",
		"a".repeat(65),
	])
		await assert.rejects(
			resolveConnection({ HOME: f.home }, name),
			CredentialError,
		);
	for (const value of [
		null,
		[],
		{ version: 2 },
		{ version: 1, server: "http://remote.example", token: f.token },
		{ version: 1, server: "https://example.test", token: "x".repeat(8193) },
		{ version: 1, server: "https://example.test", token: "two tokens" },
	]) {
		await f.profile("invalid", value);
		await assert.rejects(
			resolveConnection({ HOME: f.home }, "invalid"),
			(error) => {
				assert.ok(error instanceof CredentialError);
				assert.ok(!error.message.includes(f.token));
				return true;
			},
		);
	}
	const path = await f.profile("private");
	await chmod(path, 0o644);
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "private"),
		CredentialError,
	);
	await chmod(path, 0o600);
	await writeFile(path, " ".repeat(16385));
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "private"),
		CredentialError,
	);
	await f.profile("private");
	await symlink(path, join(f.directory, "linked.json"));
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "linked"),
		CredentialError,
	);
	await mkdir(join(f.directory, "folder.json"));
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "folder"),
		CredentialError,
	);
	await chmod(f.directory, 0o755);
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "private"),
		CredentialError,
	);
});

test("rejects linked credential directories and permits only HTTPS origins or loopback", {
	skip: process.platform === "win32",
}, async (t) => {
	const f = await fixture(t);
	await rm(f.directory, { recursive: true });
	const other = join(f.home, "other");
	await mkdir(other, { mode: 0o700 });
	await symlink(other, f.directory);
	await assert.rejects(
		resolveConnection({ HOME: f.home }, "private"),
		CredentialError,
	);
	for (const server of [
		"http://remote.test",
		" https://example.test",
		"https://user:password@example.test",
		"https://example.test/path",
		"https://example.test/?query",
		"https://example.test/#fragment",
	]) {
		await assert.rejects(
			resolveConnection({ BLABLA_API_URL: server, BLABLA_TOKEN: f.token }),
			CredentialError,
		);
	}
	for (const server of [
		"https://example.test",
		"http://127.0.0.1:8000",
		"http://localhost:8000",
		"http://[::1]:8000",
	])
		assert.equal(
			(
				await resolveConnection({
					BLABLA_API_URL: server,
					BLABLA_TOKEN: f.token,
				})
			).origin.origin,
			server,
		);
});
