import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
	readWorkspaceKeyCards,
} from "../test/support";
import { api } from "./_generated/api";
import { sha256Hex } from "./lib";

async function fixture() {
	const t = createBackend();
	const user = await authenticatedBackend(t, "delivery-history-owner");
	const projectId = await createProject(user);
	const [source] = await user.query(api.locales.list, { projectId });
	if (!source) throw new Error("Missing Source");
	await user.action(api.locales.bind, {
		localeId: source._id,
		catalogPath: "intl_en.arb",
	});
	await user.mutation(api.localeIntroductionTargets.save, {
		projectId,
		localeCode: "pt",
		label: "Portuguese",
		catalogPath: "intl_pt.arb",
		runtimeLocale: "pt-BR",
	});
	let previousCommit: string | undefined;
	async function ingest(commit: string, greeting: string, target?: string) {
		const result = await user.action(api.snapshots.ingest, {
			projectId,
			repository: "repo",
			commit,
			...(previousCommit
				? {
						lineage: {
							baselineCommit: previousCommit,
							relationship: "descendant" as const,
							mergeBase: previousCommit,
						},
					}
				: {}),
			files: [
				{
					catalogPath: "intl_en.arb",
					content: JSON.stringify({
						"@@locale": "en",
						greeting,
						quiet: "Hidden",
					}),
				},
				...(target ? [{ catalogPath: "intl_pt.arb", content: target }] : []),
			],
		});
		previousCommit = commit;
		return result;
	}
	async function prepare(greeting: string, reason: string) {
		const { proposalId } = await user.mutation(
			api.localeProposals.ensureForReview,
			{ projectId, localeCode: "pt" },
		);
		await user.mutation(api.localeProposals.stageForReview, {
			projectId,
			proposalId,
			items: [
				{
					messageId: "greeting",
					value: "Começar",
					sourceFingerprint: await sha256Hex(greeting),
				},
				{
					messageId: "quiet",
					value: "",
					sourceFingerprint: await sha256Hex("Hidden"),
					intentionalBlankReason: reason,
				},
			],
		});
		await user.action(api.localeProposals.finalizeForReview, {
			projectId,
			proposalId,
		});
		const artifact = await user.action(api.localeProposals.artifactForReview, {
			projectId,
			proposalId,
		});
		return { proposalId, artifact };
	}
	async function bind() {
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "pt",
		});
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "intl_pt.arb",
		});
		return localeId;
	}
	return { user, projectId, ingest, prepare, bind };
}

describe("Locale delivery history", () => {
	test("keeps the completed binding receipt after later catalog edits, but not after the catalog disappears", async () => {
		const { user, ingest, prepare, bind } = await fixture();
		await ingest("baseline", "Start");
		const { proposalId, artifact } = await prepare(
			"Start",
			"Deliberately hidden.",
		);
		const delivered = await ingest(
			"delivered",
			"Start",
			artifact.catalog.content,
		);
		await bind();
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "bound", snapshotId: delivered.snapshotId });
		await ingest(
			"edited",
			"Start",
			JSON.stringify({ "@@locale": "pt", greeting: "Iniciar", quiet: "" }),
		);
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toMatchObject({ status: "bound", snapshotId: delivered.snapshotId });
		await ingest("removed", "Start");
		expect(
			await user.query(api.localeDelivery.forProposal, { proposalId }),
		).toBeNull();
	});

	test("finds the older reviewed Source Contract when a newer artifact has identical target bytes", async () => {
		const { user, projectId, ingest, prepare, bind } = await fixture();
		await ingest("baseline", "Start");
		const older = await prepare("Start", "Original intentional blank.");
		await ingest("changed-source", "Begin");
		const newer = await prepare("Begin", "Newer intentional blank.");
		expect(newer.artifact.catalog.content).toBe(older.artifact.catalog.content);
		await ingest("reverted-delivery", "Start", older.artifact.catalog.content);
		expect(
			await user.query(api.localeDelivery.forProposal, {
				proposalId: older.proposalId,
			}),
		).toMatchObject({ status: "observed" });
		expect(
			await user.query(api.localeDelivery.forProposal, {
				proposalId: newer.proposalId,
			}),
		).toBeNull();
		const localeId = await bind();
		const cards = await readWorkspaceKeyCards(user, projectId);
		expect(
			cards.keys
				.find((key) => key.id === "quiet")
				?.values.find((value) => value.localeId === localeId),
		).toMatchObject({
			value: "",
			valueState: "settled",
			intentionalBlankReason: "Original intentional blank.",
		});
	});
});
