// @ts-check
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export class CredentialError extends Error {}

/** Keep the token and destination together, regardless of their source.
 * @param {unknown} server @param {unknown} token */
function validate(server, token) {
	if (
		typeof token !== "string" ||
		!token ||
		token.length > 8192 ||
		/\s/.test(token)
	)
		throw new CredentialError(
			"Credentials require a non-empty token without whitespace (max 8192 characters).",
		);
	let origin;
	try {
		if (typeof server !== "string" || /\s/.test(server)) throw new Error();
		origin = new URL(server);
	} catch {
		throw new CredentialError("Credentials require an HTTPS origin.");
	}
	if (
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!(
			origin.protocol === "https:" ||
			(origin.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
		)
	)
		throw new CredentialError(
			"Credentials require an HTTPS origin; HTTP is allowed only on loopback.",
		);
	return { origin, token };
}

/** Read only the explicitly assigned profile. Never enumerate or fall back.
 * @param {string} profile @param {NodeJS.ProcessEnv} env */
async function readProfile(profile, env) {
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) || /\s/.test(profile))
		throw new CredentialError(
			"Profile names use 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
		);
	if (process.platform === "win32")
		throw new CredentialError(
			"Private credential profiles require macOS or Linux. Use an environment credential pair on this platform.",
		);
	if (!env.HOME || !isAbsolute(env.HOME))
		throw new CredentialError(
			"Set HOME to an absolute user directory to read a credential profile.",
		);
	const config = join(env.HOME, ".config");
	const root = join(config, "blabla");
	const directory = join(root, "profiles");
	try {
		for (const path of [config, root, directory]) {
			const info = await lstat(path);
			if (
				!info.isDirectory() ||
				info.uid !== process.getuid?.() ||
				(info.mode & (path === config ? 0o022 : 0o077)) !== 0
			)
				throw new CredentialError(
					"Credential directories must be owned by you, real directories, and private; .config must not be writable by others.",
				);
		}
		// Nonblocking open prevents special files from hanging before fstat.
		const file = await open(
			join(directory, `${profile}.json`),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = await file.stat();
			if (
				!info.isFile() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0 ||
				info.size > 16384
			)
				throw new CredentialError(
					"The credential profile must be a private regular file, owned by you, no larger than 16 KiB.",
				);
			const buffer = Buffer.alloc(16385);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const read = await file.read(
					buffer,
					bytesRead,
					buffer.length - bytesRead,
					bytesRead,
				);
				if (read.bytesRead === 0) break;
				bytesRead += read.bytesRead;
			}
			if (bytesRead > 16384)
				throw new CredentialError("The credential profile exceeds 16 KiB.");
			/** @type {unknown} */
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					buffer.subarray(0, bytesRead),
				),
			);
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				!("version" in value) ||
				value.version !== 1 ||
				!("server" in value) ||
				!("token" in value)
			)
				throw new CredentialError(
					"Unsupported credential profile. Create it with blabla login --profile.",
				);
			return validate(value.server, value.token);
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof CredentialError) throw error;
		throw new CredentialError(
			"Could not read the assigned credential profile. Check its existence, format and permissions, or run blabla login --profile again.",
		);
	}
}

/** A selected profile and environment credentials are mutually exclusive.
 * Legacy agent variable names remain supported as a complete pair.
 * @param {NodeJS.ProcessEnv} env @param {string | undefined} [profile] */
export async function resolveConnection(env, profile) {
	const selected = profile ?? env.BLABLA_PROFILE;
	const canonical =
		env.BLABLA_API_URL !== undefined || env.BLABLA_TOKEN !== undefined;
	const legacy =
		env.BLABLA_AGENT_URL !== undefined || env.BLABLA_AGENT_TOKEN !== undefined;
	if (selected !== undefined) {
		if (canonical || legacy)
			throw new CredentialError(
				"Choose a profile or environment credentials; do not combine them.",
			);
		return readProfile(selected, env);
	}
	if (canonical && legacy)
		throw new CredentialError(
			"Use only one environment credential pair: BLABLA_API_URL/BLABLA_TOKEN or the legacy BLABLA_AGENT_URL/BLABLA_AGENT_TOKEN.",
		);
	return canonical
		? validate(env.BLABLA_API_URL, env.BLABLA_TOKEN)
		: validate(env.BLABLA_AGENT_URL, env.BLABLA_AGENT_TOKEN);
}
