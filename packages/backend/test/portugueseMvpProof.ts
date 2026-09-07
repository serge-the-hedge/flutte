import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { authenticatedBackend, createBackend, createProject } from "./support";

const sourceCatalogPath = "packages/brickit_generated/lib/l10n/intl_en.arb";
const portugueseCatalogPath = "packages/brickit_generated/lib/l10n/intl_pt.arb";
const portugueseVariantCatalogPath =
	"packages/brickit_generated/lib/l10n/intl_pt_BR.arb";
const runtimeLocalePath = "packages/brickit/lib/constants/locale_const.dart";
const brickitRepository = "github.com/brickit-app/brickit-flutter";
const canonicalBrickitRemote = `https://${brickitRepository}.git`;

export type PortugueseMvpProof = {
	sourceMessageCount: number;
	artifactMessageCount: number;
	branchName: string;
	changedPaths: string[];
	requestPaths: string[];
	remoteGitCommands: string[];
};

/**
 * The test-only proof module hides the disposable Convex, HTTP, Git, and
 * Flutter setup behind one interface. Its caller only supplies a real Brickit
 * checkout and observes the completed developer branch.
 *
 * The public Agent API is given Source Echo fixture values deliberately: code
 * can prove provenance, complete Catalog Document construction, and contract
 * validity, but it cannot judge Portuguese writing quality. No output escapes
 * the disposable checkout.
 */
export async function provePortugueseMvp(
	brickitCheckout: string,
	options: { flutterSdk?: string } = {},
): Promise<PortugueseMvpProof> {
	const fixture = await DisposableBrickitCheckout.create(brickitCheckout);
	const backend = createBackend();
	const bridge = await AgentApiBridge.start(backend);
	const clock = new AgentRateLimitClock();

	try {
		const source = await ingestAcceptedSourceSnapshot(backend, fixture);
		const agent = new ProofAgent(bridge.baseUrl, source.token, clock);
		const prepared = await agent.prepareCompleteProposal();
		for (const candidate of prepared.candidates) {
			await source.user.mutation(api.localeProposals.reviewStagedValue, {
				projectId: source.projectId,
				proposalId: prepared.proposalId,
				messageId: candidate.messageId,
				decision:
					candidate.value === ""
						? {
								kind: "intentionalBlank",
								reason:
									"The pinned Source Catalog Document deliberately contains an empty fixture value.",
							}
						: { kind: "accept" },
			});
		}
		const artifact = await agent.finalizeProposal(prepared.proposalId);
		assertFaithfulPortugueseDocument(source.catalog, artifact.catalogContent);
		invariant(
			artifact.sourceSnapshotId === source.snapshotId,
			"The artifact was not pinned to the accepted Source Snapshot.",
		);
		invariant(
			artifact.sourceCommit === source.commit,
			"The artifact was not pinned to the Brickit commit it was prepared from.",
		);

		const transportGuard = await fixture.guardRemoteGitCommands();
		const flutterArguments = options.flutterSdk
			? ["--flutter-sdk", options.flutterSdk]
			: [];
		const delivery = await runCommand(
			"dart",
			[
				"run",
				"bin/blabla.dart",
				"deliver-portuguese",
				"--proposal",
				prepared.proposalId,
				"--checkout",
				fixture.checkout,
				"--server",
				bridge.baseUrl.toString(),
				"--token",
				source.token,
				...flutterArguments,
			],
			{
				workingDirectory: cliDirectory(),
				environment: { ...process.env, ...transportGuard.environment },
			},
		);
		if (delivery.exitCode !== 0) {
			throw new Error(
				`Repository Adapter failed.\nstdout:\n${delivery.stdout}\nstderr:\n${delivery.stderr}`,
			);
		}
		invariant(
			delivery.stdout.includes("Created local branch"),
			"The Repository Adapter did not report its local review branch.",
		);
		invariant(
			delivery.stdout.includes("gh pr create"),
			"The Repository Adapter did not print the developer-owned PR command.",
		);
		invariant(
			delivery.stdout.includes("git push -u origin"),
			"The Repository Adapter did not hand the push command to the developer.",
		);

		const branchName = await fixture.git(["branch", "--show-current"]);
		const changedPaths = await fixture.gitLines([
			"show",
			"--format=",
			"--name-only",
			"HEAD",
		]);
		const committedCatalog = await fixture.read(portugueseCatalogPath);
		invariant(
			committedCatalog === artifact.catalogContent,
			"The committed Portuguese Catalog Document differs from the immutable artifact.",
		);
		invariant(
			!(await fixture.exists(portugueseVariantCatalogPath)),
			"Flutter created a second Portuguese Catalog Document.",
		);
		invariant(
			(await fixture.read(runtimeLocalePath)).includes("Locale('pt', 'BR')"),
			"The committed runtime registration does not map Portuguese to pt-BR.",
		);
		invariant(
			(await fixture.git(["status", "--porcelain"])) === "",
			"The completed local review branch is not clean.",
		);

		return {
			sourceMessageCount: source.messageCount,
			artifactMessageCount: catalogMessageCount(committedCatalog),
			branchName,
			changedPaths,
			requestPaths: bridge.requestPaths,
			remoteGitCommands: await transportGuard.remoteGitCommands(),
		};
	} finally {
		clock.dispose();
		try {
			await bridge.close();
		} finally {
			await fixture.dispose();
		}
	}
}

async function ingestAcceptedSourceSnapshot(
	backend: ReturnType<typeof createBackend>,
	fixture: DisposableBrickitCheckout,
) {
	// The proof advances fake time to exercise the rate-limited public Agent API
	// without sleeping between its real-corpus pages.
	const user = await authenticatedBackend(
		backend,
		"portuguese-mvp-owner",
		10 * 60_000,
	);
	const projectId = await createProject(user, {
		name: "Portuguese MVP proof",
		slug: "portuguese-mvp-proof",
	});
	const [sourceLocale] = await user.query(api.locales.list, { projectId });
	invariant(
		sourceLocale !== undefined,
		"The proof project has no source Locale.",
	);
	await user.action(api.locales.bind, {
		localeId: sourceLocale._id,
		catalogPath: sourceCatalogPath,
	});

	const catalog = await fixture.read(sourceCatalogPath);
	const commit = await fixture.git(["rev-parse", "HEAD"]);
	const result = await user.action(api.snapshots.ingest, {
		projectId,
		repository: fixture.repository,
		commit,
		files: [{ catalogPath: sourceCatalogPath, content: catalog }],
	});
	invariant(
		result.snapshotId !== undefined,
		"The real Brickit English Catalog Document did not publish as a Baseline Snapshot.",
	);
	const token = await user.mutation(api.apiTokens.create, {
		projectId,
		name: "Portuguese MVP proof agent",
		scopes: ["read", "propose"],
	});
	return {
		catalog,
		commit,
		messageCount: catalogMessageCount(catalog),
		projectId,
		snapshotId: result.snapshotId,
		token: token.token,
		user,
	};
}

class AgentRateLimitClock {
	private now = Date.now();

	constructor() {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(this.now);
	}

	advance() {
		// Locale Proposal operations are deliberately rate-limited to 30/minute.
		// Move the test clock one token forward without making the real-corpus
		// proof wait several minutes.
		this.now += 2_100;
		vi.setSystemTime(this.now);
	}

	dispose() {
		vi.useRealTimers();
	}
}

class ProofAgent {
	constructor(
		private readonly baseUrl: URL,
		private readonly token: string,
		private readonly clock: AgentRateLimitClock,
	) {}

	async prepareCompleteProposal(): Promise<{
		proposalId: Id<"localeProposals">;
		candidates: Array<{ messageId: string; value: string }>;
	}> {
		const proposal = await this.request("/api/agent/v1/locale-proposals/pt", {
			method: "POST",
		});
		const proposalId = requiredString(
			proposal,
			"proposalId",
		) as Id<"localeProposals">;
		const candidates: Array<{ messageId: string; value: string }> = [];
		let cursor = 0;
		while (true) {
			const template = await this.template(proposalId, cursor);
			invariant(
				template.messages.length > 0 || template.isDone,
				"The Agent API returned an empty unfinished Portuguese template page.",
			);
			if (template.messages.length > 0) {
				candidates.push(
					...template.messages.map((message) => ({
						messageId: message.id,
						value: message.sourceValue,
					})),
				);
				await this.request("/api/agent/v1/locale-proposals/pt/values", {
					method: "POST",
					body: {
						proposalId,
						items: template.messages.map((message) => ({
							messageId: message.id,
							value: message.sourceValue,
							sourceFingerprint: message.sourceFingerprint,
							...(message.sourceValue === ""
								? {
										intentionalBlankReason:
											"The pinned Source Catalog Document deliberately contains an empty fixture value.",
									}
								: {}),
						})),
					},
				});
			}
			if (template.isDone) break;
			invariant(
				template.continueCursor !== null && template.continueCursor > cursor,
				"The Agent API did not advance the Portuguese template cursor.",
			);
			cursor = template.continueCursor;
		}

		return { proposalId, candidates };
	}

	async finalizeProposal(proposalId: string): Promise<AgentArtifact> {
		const finalized = await this.request(
			"/api/agent/v1/locale-proposals/pt/finalize",
			{ method: "POST", body: { proposalId } },
		);
		invariant(
			requiredString(finalized, "status") === "ready",
			"The complete Portuguese proposal did not finalize.",
		);
		return await this.artifact(proposalId);
	}

	private async template(
		proposalId: string,
		cursor: number,
	): Promise<{
		messages: Array<{
			id: string;
			sourceValue: string;
			sourceFingerprint: string;
		}>;
		isDone: boolean;
		continueCursor: number | null;
	}> {
		const page = await this.request(
			`/api/agent/v1/locale-proposals/pt/template?proposalId=${encodeURIComponent(proposalId)}&cursor=${cursor}&limit=16`,
		);
		const messages = requiredArray(page, "messages").map((value) => {
			const message = requiredObject(value);
			return {
				id: requiredString(message, "id"),
				sourceValue: requiredString(message, "sourceValue"),
				sourceFingerprint: requiredString(message, "sourceFingerprint"),
			};
		});
		return {
			messages,
			isDone: requiredBoolean(page, "isDone"),
			continueCursor: requiredNumberOrNull(page, "continueCursor"),
		};
	}

	private async artifact(proposalId: string): Promise<AgentArtifact> {
		const artifact = await this.request(
			`/api/agent/v1/locale-proposals/pt/artifact?proposalId=${encodeURIComponent(proposalId)}`,
		);
		const sourceSnapshot = requiredObject(artifact.sourceSnapshot);
		const locale = requiredObject(artifact.locale);
		const catalog = requiredObject(artifact.catalog);
		invariant(
			requiredString(locale, "code") === "pt" &&
				requiredString(locale, "runtimeLocale") === "pt-BR" &&
				requiredString(catalog, "fileName") === "intl_pt.arb",
			"The Agent API returned an unexpected Locale Proposal artifact identity.",
		);
		return {
			sourceSnapshotId: requiredString(sourceSnapshot, "id"),
			sourceCommit: requiredString(sourceSnapshot, "commit"),
			catalogContent: requiredString(catalog, "content"),
		};
	}

	private async request(
		path: string,
		options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
	): Promise<Record<string, unknown>> {
		this.clock.advance();
		const response = await fetch(new URL(path, this.baseUrl), {
			method: options.method ?? "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
				"X-Blabla-CLI-Version": "mvp-proof",
				"X-Blabla-CLI-Protocol": "1",
			},
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body) }),
		});
		const body = await response.text();
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new Error(
				`Agent API returned invalid JSON at ${path} (${response.status}).`,
			);
		}
		if (!response.ok) {
			const error = requiredObject(decoded);
			throw new Error(
				`Agent API rejected ${path} (${response.status}): ${requiredString(error, "error")}`,
			);
		}
		return requiredObject(decoded);
	}
}

type AgentArtifact = {
	sourceSnapshotId: string;
	sourceCommit: string;
	catalogContent: string;
};

class AgentApiBridge {
	private constructor(
		readonly baseUrl: URL,
		readonly requestPaths: string[],
		private readonly server: ReturnType<typeof createServer>,
	) {}

	static async start(backend: ReturnType<typeof createBackend>) {
		const requestPaths: string[] = [];
		const server = createServer((request, response) => {
			void forwardAgentRequest(backend, request, response, requestPaths);
		});
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});
		const address = server.address();
		if (address === null || typeof address === "string") {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
			throw new Error("Could not bind the Agent API proof server.");
		}
		return new AgentApiBridge(
			new URL(`http://127.0.0.1:${address.port}/`),
			requestPaths,
			server,
		);
	}

	async close() {
		await new Promise<void>((resolveClose, rejectClose) => {
			this.server.close((error) =>
				error ? rejectClose(error) : resolveClose(),
			);
		});
	}
}

async function forwardAgentRequest(
	backend: ReturnType<typeof createBackend>,
	request: IncomingMessage,
	response: ServerResponse,
	requestPaths: string[],
) {
	try {
		const body = await requestBody(request);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(request.headers)) {
			if (value !== undefined) {
				headers[name] = Array.isArray(value) ? value.join(", ") : value;
			}
		}
		const result = await backend.fetch(request.url ?? "/", {
			method: request.method ?? "GET",
			headers,
			...(body === "" ? {} : { body }),
		});
		requestPaths.push(
			new URL(request.url ?? "/", "http://proof.local").pathname,
		);
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(Buffer.from(await result.arrayBuffer()));
	} catch (error) {
		response.writeHead(500, { "Content-Type": "application/json" });
		response.end(
			JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}

async function requestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

class DisposableBrickitCheckout {
	private constructor(
		readonly root: string,
		readonly checkout: string,
		readonly repository: string,
	) {}

	static async create(sourceCheckout: string) {
		const source = await sourceCheckoutOrigin(sourceCheckout);
		const root = await mkdtemp(join(tmpdir(), "blabla-portuguese-mvp-"));
		const checkout = join(root, "brickit-flutter");
		try {
			await runCommand("git", [
				"clone",
				"--shared",
				resolve(sourceCheckout),
				checkout,
			]);
			const fixture = new DisposableBrickitCheckout(
				root,
				checkout,
				source.repository,
			);
			await fixture.git([
				"remote",
				"set-url",
				"origin",
				canonicalBrickitRemote,
			]);
			// A local clone preserves the source checkout's current branch. Reset the
			// disposable integration branch whether it already exists or not.
			await fixture.git(["switch", "-C", "develop"]);
			await fixture.git(["config", "user.name", "Blabla MVP proof"]);
			await fixture.git(["config", "user.email", "blabla@example.test"]);
			return fixture;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async read(path: string) {
		return await readFile(join(this.checkout, path), "utf8");
	}

	async exists(path: string) {
		try {
			await readFile(join(this.checkout, path));
			return true;
		} catch {
			return false;
		}
	}

	async git(arguments_: string[]) {
		const result = await runCommand("git", arguments_, {
			workingDirectory: this.checkout,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`git ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout.trim();
	}

	async gitLines(arguments_: string[]) {
		const output = await this.git(arguments_);
		return output === "" ? [] : output.split("\n").filter(Boolean);
	}

	async guardRemoteGitCommands() {
		const bin = join(this.root, "git-guard");
		const log = join(this.root, "remote-git-commands.log");
		await mkdir(bin);
		await writeFile(log, "");
		const realGit = (await runCommand("which", ["git"])).stdout.trim();
		invariant(realGit !== "", "Could not resolve the real git executable.");
		const shim = join(bin, "git");
		await writeFile(
			shim,
			`#!/bin/sh
reject_remote_transport() {
  printf '%s\\n' "$*" >> "$BLABLA_REMOTE_GIT_LOG"
  exit 97
}
case "$1" in
  push|fetch|pull|ls-remote|clone|submodule)
    reject_remote_transport "$@"
    ;;
  remote)
    if [ "$2" != "get-url" ]; then
      reject_remote_transport "$@"
    fi
    ;;
  archive)
    case "$2" in
      --remote=*) reject_remote_transport "$@" ;;
    esac
    ;;
esac
exec "$BLABLA_REAL_GIT" "$@"
`,
		);
		await chmod(shim, 0o700);
		return {
			environment: {
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				BLABLA_REAL_GIT: realGit,
				BLABLA_REMOTE_GIT_LOG: log,
			},
			remoteGitCommands: async () => {
				const output = (await readFile(log, "utf8")).trim();
				return output === "" ? [] : output.split("\n");
			},
		};
	}

	async dispose() {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function sourceCheckoutOrigin(sourceCheckout: string) {
	const result = await runCommand(
		"git",
		["remote", "get-url", "--all", "origin"],
		{ workingDirectory: resolve(sourceCheckout) },
	);
	if (result.exitCode !== 0) {
		throw new Error("BRICKIT_CHECKOUT needs an origin remote.");
	}
	const remote = result.stdout
		.split("\n")
		.map((value) => value.trim())
		.find((value) => normalizeRepository(value) === brickitRepository);
	invariant(
		remote !== undefined,
		`BRICKIT_CHECKOUT must have a ${brickitRepository} origin.`,
	);
	return { repository: normalizeRepository(remote) };
}

function normalizeRepository(value: string) {
	let normalized = value.trim().replace(/^[a-z]+:\/\//i, "");
	normalized = normalized.replace(/^[^@]+@/, "");
	normalized = normalized.replace(":", "/");
	normalized = normalized.replace(/^\/+/, "");
	normalized = normalized.replace(/\.git\/?$/, "");
	return normalized.toLowerCase();
}

function cliDirectory() {
	return fileURLToPath(new URL("../../../cli/", import.meta.url));
}

async function runCommand(
	command: string,
	arguments_: string[],
	options: { workingDirectory?: string; environment?: NodeJS.ProcessEnv } = {},
) {
	return await new Promise<{
		exitCode: number | null;
		stdout: string;
		stderr: string;
	}>((resolveCommand, rejectCommand) => {
		const process = spawn(command, arguments_, {
			cwd: options.workingDirectory,
			env: options.environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		process.stdout.setEncoding("utf8");
		process.stderr.setEncoding("utf8");
		process.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		process.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		process.once("error", rejectCommand);
		process.once("close", (exitCode) => {
			resolveCommand({ exitCode, stdout, stderr });
		});
	});
}

function assertFaithfulPortugueseDocument(
	sourceText: string,
	targetText: string,
) {
	const source = parseCatalogObject(sourceText, "source");
	const target = parseCatalogObject(targetText, "Portuguese artifact");
	const sourceKeys = Object.keys(source);
	const targetKeys = Object.keys(target);
	invariant(
		JSON.stringify(sourceKeys) === JSON.stringify(targetKeys),
		"The Portuguese artifact did not retain the source Catalog Document member order.",
	);
	for (const key of sourceKeys) {
		if (key === "@@locale") {
			invariant(
				target[key] === "pt",
				"The Portuguese artifact has the wrong Catalog Document locale.",
			);
			continue;
		}
		if (!key.startsWith("@") && typeof source[key] === "string") {
			invariant(
				typeof target[key] === "string",
				`The Portuguese artifact lost message ${key}.`,
			);
			continue;
		}
		invariant(
			JSON.stringify(target[key]) === JSON.stringify(source[key]),
			`The Portuguese artifact changed source-owned member ${key}.`,
		);
	}
}

function catalogMessageCount(catalogText: string) {
	return Object.entries(parseCatalogObject(catalogText, "catalog")).filter(
		([key, value]) => !key.startsWith("@") && typeof value === "string",
	).length;
}

function parseCatalogObject(text: string, name: string) {
	try {
		return requiredObject(JSON.parse(text));
	} catch (error) {
		throw new Error(
			`${name} is not a JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function requiredObject(value: unknown): Record<string, unknown> {
	invariant(
		value !== null && typeof value === "object" && !Array.isArray(value),
		"Expected a JSON object.",
	);
	return value as Record<string, unknown>;
}

function requiredArray(object: Record<string, unknown>, key: string) {
	const value = object[key];
	invariant(Array.isArray(value), `Expected ${key} to be an array.`);
	return value;
}

function requiredString(object: Record<string, unknown>, key: string) {
	const value = object[key];
	invariant(typeof value === "string", `Expected ${key} to be a string.`);
	return value;
}

function requiredBoolean(object: Record<string, unknown>, key: string) {
	const value = object[key];
	invariant(typeof value === "boolean", `Expected ${key} to be a boolean.`);
	return value;
}

function requiredNumberOrNull(object: Record<string, unknown>, key: string) {
	const value = object[key];
	invariant(
		value === null || (typeof value === "number" && Number.isInteger(value)),
		`Expected ${key} to be an integer or null.`,
	);
	return value;
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
