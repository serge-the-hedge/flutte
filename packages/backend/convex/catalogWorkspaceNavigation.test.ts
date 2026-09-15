import { describe, expect, test } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import { materializeRepeatedGitContent } from "./catalogProjection";
import {
	deriveNavigationDigest,
	navigationDigestByteLength,
	ordinaryImportSummaryFromDigests,
} from "./catalogWorkspaceNavigation";
import { sha256Hex } from "./lib";
import { ordinaryImportConfirmationPlan } from "./ordinaryImportConfirmations";

const projectId = "projects:p1" as unknown as Id<"projects">;
const projectionId =
	"catalogProjections:proj1" as unknown as Id<"catalogProjections">;
const enId = "locales:en" as unknown as Id<"locales">;
const deId = "locales:de" as unknown as Id<"locales">;
const frId = "locales:fr" as unknown as Id<"locales">;

async function messageRow(input: {
	id: string;
	messageId: string;
	isSource: boolean;
	value: string;
	localeId?: Id<"locales">;
	localeCode?: string;
	catalogIndex?: number;
	sourceValue?: string;
	gitValueFingerprint?: string;
	valueFingerprint?: string;
}): Promise<Doc<"catalogProjectionMessages">> {
	const localeId = input.localeId ?? (input.isSource ? enId : deId);
	const localeCode = input.localeCode ?? (localeId === enId ? "en" : "de");
	const valueFingerprint =
		input.valueFingerprint ?? (await sha256Hex(input.value));
	return {
		_id: `catalogProjectionMessages:${input.id}` as Id<"catalogProjectionMessages">,
		_creationTime: 0,
		projectionId,
		localeId,
		localeCode,
		catalogPath: `${localeCode}.arb`,
		isSource: input.isSource,
		catalogIndex: input.catalogIndex ?? 0,
		messageId: input.messageId,
		value: input.value,
		valueFingerprint,
		sourceFingerprint: await sha256Hex(input.sourceValue ?? input.value),
		gitValueFingerprint: input.gitValueFingerprint,
		gitValueRevision: input.gitValueFingerprint === undefined ? undefined : 0,
		icuType: "plain",
		argumentNames: [],
		argumentNamesComplete: true,
		argumentNameCount: 0,
		materialized: false,
	} as unknown as Doc<"catalogProjectionMessages">;
}

async function valueHead(input: {
	sourceValue: string;
	id: string;
	messageId: string;
	localeId: Id<"locales">;
	value: string;
	basisGitValueFingerprint: string;
}): Promise<Doc<"catalogWorkspaceValueHeads">> {
	return {
		_id: `catalogWorkspaceValueHeads:${input.id}` as Id<"catalogWorkspaceValueHeads">,
		_creationTime: 0,
		projectId,
		messageId: input.messageId,
		localeId: input.localeId,
		value: input.value,
		valueFingerprint: await sha256Hex(input.value),
		sourceFingerprint: await sha256Hex(input.sourceValue),
		basisGitValueFingerprint: input.basisGitValueFingerprint,
		basisGitValueRevision: 0,
		revision: 1,
		reconciliationGeneration: 0,
		updatedBy: { kind: "user", id: "u1" },
		updatedAt: 0,
	} as unknown as Doc<"catalogWorkspaceValueHeads">;
}

async function decision(input: {
	id: string;
	kind: "translatorConfirmation" | "intentionalBlank";
	messageId: string;
	localeId: Id<"locales">;
	sourceValue: string;
	value: string;
	reason?: string;
}): Promise<Doc<"catalogWorkspaceDecisionRecords">> {
	return {
		_id: `catalogWorkspaceDecisionRecords:${input.id}` as Id<"catalogWorkspaceDecisionRecords">,
		_creationTime: 0,
		projectId,
		kind: input.kind,
		messageId: input.messageId,
		localeId: input.localeId,
		sourceFingerprint: await sha256Hex(input.sourceValue),
		valueFingerprint: await sha256Hex(input.value),
		...(input.kind === "intentionalBlank"
			? { reason: input.reason ?? "because" }
			: {}),
		recordedBy: { kind: "user", id: "u1" },
		recordedAt: 0,
	} as unknown as Doc<"catalogWorkspaceDecisionRecords">;
}

async function proposalHead(input: {
	id: string;
	messageId: string;
	sourceValue: string;
	basisGitValueFingerprint: string;
}): Promise<Doc<"catalogWorkspaceSourceProposalHeads">> {
	return {
		_id: `catalogWorkspaceSourceProposalHeads:${input.id}` as Id<"catalogWorkspaceSourceProposalHeads">,
		_creationTime: 0,
		projectId,
		messageId: input.messageId,
		proposalId: `sourceProposals:${input.id}` as Id<"sourceProposals">,
		sourceValue: input.sourceValue,
		sourceFingerprint: await sha256Hex(input.sourceValue),
		basisGitValueFingerprint: input.basisGitValueFingerprint,
		basisGitValueRevision: 0,
		revision: 1,
		updatedBy: { kind: "user", id: "u1" },
		updatedAt: 0,
	} as unknown as Doc<"catalogWorkspaceSourceProposalHeads">;
}

async function keyRows(input: {
	messageId: string;
	catalogIndex: number;
	sourceValue: string;
	targetValue: string;
}): Promise<Doc<"catalogProjectionMessages">[]> {
	return [
		await messageRow({
			id: `${input.messageId}-src`,
			messageId: input.messageId,
			isSource: true,
			value: input.sourceValue,
			catalogIndex: input.catalogIndex,
			gitValueFingerprint: await sha256Hex(input.sourceValue),
		}),
		await messageRow({
			id: `${input.messageId}-tgt`,
			messageId: input.messageId,
			isSource: false,
			value: input.targetValue,
			catalogIndex: input.catalogIndex,
			sourceValue: input.sourceValue,
			gitValueFingerprint: await sha256Hex(input.targetValue),
		}),
	];
}

function digestInput(input: {
	rows: readonly Doc<"catalogProjectionMessages">[];
	heads?: readonly Doc<"catalogWorkspaceValueHeads">[];
	decisions?: readonly Doc<"catalogWorkspaceDecisionRecords">[];
	sourceProposalHead?: Doc<"catalogWorkspaceSourceProposalHeads"> | null;
}) {
	return {
		projectId,
		projectionId,
		rows: input.rows,
		heads: input.heads ?? [],
		decisions: input.decisions ?? [],
		sourceProposalHead: input.sourceProposalHead ?? null,
		sourceProposalResolution: null,
	};
}

describe("deriveNavigationDigest", () => {
	test("marks repeated visible content after Contract Transforms", async () => {
		const rows = await Promise.all([
			messageRow({
				id: "first",
				messageId: "first",
				isSource: false,
				value: "Transformed",
				gitValueFingerprint: "raw-first",
				catalogIndex: 0,
			}),
			messageRow({
				id: "second",
				messageId: "second",
				isSource: false,
				value: "Transformed",
				gitValueFingerprint: "raw-second",
				catalogIndex: 1,
			}),
		]);
		const materialized = materializeRepeatedGitContent(rows);

		expect(materialized.map((row) => row.repeatedGitContent)).toEqual([
			true,
			true,
		]);
	});

	test("derives the folded corpus and untouched target facts", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 3,
			sourceValue: "Hello {name}",
			targetValue: "Hallo {name}",
		});
		const digest = await deriveNavigationDigest(digestInput({ rows }));
		expect(digest.messageId).toBe("greeting");
		expect(digest.catalogIndex).toBe(3);
		expect(digest.searchCorpus).toEqual([
			"greeting",
			"hello {name}",
			"hallo {name}",
		]);
		expect(digest.pendingSourceProposal).toBe(false);
		expect(digest.source).toEqual({
			localeId: enId,
			gitValueFingerprint: await sha256Hex("Hello {name}"),
			valueFingerprint: await sha256Hex("Hello {name}"),
		});
		expect(digest.targets).toEqual([
			{
				localeId: deId,
				localeCode: "de",
				valueState: "unconfirmedImport",
				touched: false,
				confirmedGitContent: false,
				confirmedContentPreviously: false,
				firstReviewPending: false,
				changedInGitPending: false,
				valueFingerprint: await sha256Hex("Hallo {name}"),
				gitValueFingerprint: await sha256Hex("Hallo {name}"),
			},
		]);
	}, 20_000);

	test("overlays a current Workspace head into the corpus and marks the target touched", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "Hallo {name}",
		});
		const head = await valueHead({
			id: "h1",
			sourceValue: "Hello {name}",
			messageId: "greeting",
			localeId: deId,
			value: "Hallo, {name}!",
			basisGitValueFingerprint: await sha256Hex("Hallo {name}"),
		});
		const digest = await deriveNavigationDigest(
			digestInput({ rows, heads: [head] }),
		);
		expect(digest.searchCorpus).toContain("hallo, {name}!");
		expect(digest.targets[0]).toMatchObject({
			valueState: "unconfirmedImport",
			touched: true,
		});
	}, 20_000);

	test("settles a confirmed target through its exact content decision", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "Hallo {name}",
		});
		const record = await decision({
			id: "d1",
			kind: "translatorConfirmation",
			messageId: "greeting",
			localeId: deId,
			sourceValue: "Hello {name}",
			value: "Hallo {name}",
		});
		const digest = await deriveNavigationDigest(
			digestInput({ rows, decisions: [record] }),
		);
		expect(digest.targets[0]).toMatchObject({
			valueState: "settled",
			confirmedGitContent: true,
			confirmedContentPreviously: false,
		});
	}, 20_000);

	test("marks a target stale when a prior confirmation met an older Source Contract", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello there {name}",
			targetValue: "Hallo {name}",
		});
		const record = await decision({
			id: "d1",
			kind: "translatorConfirmation",
			messageId: "greeting",
			localeId: deId,
			sourceValue: "Hello {name}",
			value: "Hallo {name}",
		});
		const digest = await deriveNavigationDigest(
			digestInput({ rows, decisions: [record] }),
		);
		expect(digest.targets[0]).toMatchObject({
			valueState: "stale",
			confirmedGitContent: false,
			confirmedContentPreviously: true,
		});
	}, 20_000);

	test("settles an Intentional Blank and keeps its empty value in the corpus", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "",
		});
		const record = await decision({
			id: "d1",
			kind: "intentionalBlank",
			messageId: "greeting",
			localeId: deId,
			sourceValue: "Hello {name}",
			value: "",
			reason: "Brand name stays English",
		});
		const digest = await deriveNavigationDigest(
			digestInput({ rows, decisions: [record] }),
		);
		expect(digest.searchCorpus).toContain("");
		expect(digest.targets[0]).toMatchObject({
			valueState: "settled",
			touched: false,
			confirmedGitContent: true,
		});
	}, 20_000);

	test("applies a pending Source Proposal to the corpus and marks the key pending", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "Hallo {name}",
		});
		const head = await proposalHead({
			id: "p1",
			messageId: "greeting",
			sourceValue: "Hi there {name}",
			basisGitValueFingerprint: await sha256Hex("Hello {name}"),
		});
		const digest = await deriveNavigationDigest(
			digestInput({ rows, sourceProposalHead: head }),
		);
		expect(digest.pendingSourceProposal).toBe(true);
		expect(digest.searchCorpus).toContain("hi there {name}");
		expect(digest.searchCorpus).not.toContain("hello {name}");
		expect(digest.targets[0]).toMatchObject({
			valueState: "unconfirmedImport",
			touched: false,
		});
	}, 20_000);

	test("accounts digest bytes deterministically", async () => {
		const rows = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "Hallo {name}",
		});
		const first = await deriveNavigationDigest(digestInput({ rows }));
		const second = await deriveNavigationDigest(digestInput({ rows }));
		expect(navigationDigestByteLength(first)).toBe(
			navigationDigestByteLength(second),
		);
		const edited = await keyRows({
			messageId: "greeting",
			catalogIndex: 0,
			sourceValue: "Hello {name}",
			targetValue: "Hallo auch, {name}!",
		});
		const changed = await deriveNavigationDigest(digestInput({ rows: edited }));
		expect(navigationDigestByteLength(changed)).not.toBe(
			navigationDigestByteLength(first),
		);
	}, 20_000);

	test("derives the ordinary summary equal to the canonical plan", async () => {
		const spec: {
			messageId: string;
			sourceValue: string;
			targetValue: string;
		}[] = [
			{ messageId: "apples", sourceValue: "Apples", targetValue: "Aepfel" },
			{ messageId: "empty_key", sourceValue: "Empty", targetValue: "" },
			{ messageId: "same", sourceValue: "Same", targetValue: "Same" },
			{ messageId: "dup1", sourceValue: "Dup one", targetValue: "Twin" },
			{ messageId: "dup2", sourceValue: "Dup two", targetValue: "Twin" },
			{
				messageId: "touched",
				sourceValue: "Touched",
				targetValue: "Touched value",
			},
			{
				messageId: "confirmed",
				sourceValue: "Confirmed",
				targetValue: "Confirmed value",
			},
			{
				messageId: "stale_key",
				sourceValue: "New wording",
				targetValue: "Stale value",
			},
			{
				messageId: "pending_key",
				sourceValue: "Pending",
				targetValue: "Pending value",
			},
		];
		const allRows: Doc<"catalogProjectionMessages">[] = [];
		const heads: Doc<"catalogWorkspaceValueHeads">[] = [];
		const decisions: Doc<"catalogWorkspaceDecisionRecords">[] = [];
		let proposal: Doc<"catalogWorkspaceSourceProposalHeads"> | null = null;
		for (const [index, entry] of spec.entries()) {
			const rows = await keyRows({
				messageId: entry.messageId,
				catalogIndex: index,
				sourceValue: entry.sourceValue,
				targetValue: entry.targetValue,
			});
			allRows.push(...rows);
			const targetGitValueFingerprint =
				rows[1]?.gitValueFingerprint ?? "missing";
			if (entry.messageId === "touched") {
				heads.push(
					await valueHead({
						id: "h-touched",
						sourceValue: entry.sourceValue,
						messageId: entry.messageId,
						localeId: deId,
						value: "Locally edited",
						basisGitValueFingerprint: targetGitValueFingerprint,
					}),
				);
			}
			if (entry.messageId === "confirmed") {
				decisions.push(
					await decision({
						id: "d-confirmed",
						kind: "translatorConfirmation",
						messageId: entry.messageId,
						localeId: deId,
						sourceValue: entry.sourceValue,
						value: entry.targetValue,
					}),
				);
			}
			if (entry.messageId === "stale_key") {
				decisions.push(
					await decision({
						id: "d-stale",
						kind: "translatorConfirmation",
						messageId: entry.messageId,
						localeId: deId,
						sourceValue: "Old wording",
						value: entry.targetValue,
					}),
				);
			}
			if (entry.messageId === "pending_key") {
				proposal = await proposalHead({
					id: "p-pending",
					messageId: entry.messageId,
					sourceValue: "Candidate wording",
					basisGitValueFingerprint: await sha256Hex(entry.sourceValue),
				});
			}
		}
		const plan = ordinaryImportConfirmationPlan({
			rows: allRows as unknown as Parameters<
				typeof ordinaryImportConfirmationPlan
			>[0]["rows"],
			heads,
			decisions,
			pendingSourceMessageIds: new Set(["pending_key"]),
		});
		const digests = await Promise.all(
			spec.map(async (entry) => {
				const rows = allRows.filter((row) => row.messageId === entry.messageId);
				return await deriveNavigationDigest(
					digestInput({
						rows,
						heads,
						decisions,
						sourceProposalHead: proposal,
					}),
				);
			}),
		);
		expect(ordinaryImportSummaryFromDigests(digests)).toEqual(plan.counts);
		expect(plan.counts.eligible).toBe(3);
		expect(plan.counts.empty).toBe(1);
		expect(plan.counts.sourceIdentical).toBe(1);
		expect(plan.counts.repeated).toBe(0);
		expect(plan.counts.modified).toBe(1);
		expect(plan.counts.alreadyConfirmed).toBe(1);
		expect(plan.counts.stale).toBe(1);
		expect(plan.counts.pendingSourceProposal).toBe(1);
	}, 30_000);

	test("counts equal target text only when it repeats within one key", async () => {
		const sourceValue = "Continue";
		const targetValue = "Continuer";
		const rows = [
			await messageRow({
				id: "same-key-en",
				messageId: "same-key",
				isSource: true,
				value: sourceValue,
				gitValueFingerprint: await sha256Hex(sourceValue),
			}),
			await messageRow({
				id: "same-key-de",
				messageId: "same-key",
				isSource: false,
				value: targetValue,
				sourceValue,
				gitValueFingerprint: await sha256Hex(targetValue),
			}),
			await messageRow({
				id: "same-key-fr",
				messageId: "same-key",
				isSource: false,
				localeId: frId,
				localeCode: "fr",
				value: targetValue,
				sourceValue,
				gitValueFingerprint: await sha256Hex(targetValue),
			}),
		];
		const digest = await deriveNavigationDigest(digestInput({ rows }));

		expect(ordinaryImportSummaryFromDigests([digest])).toMatchObject({
			total: 2,
			eligible: 0,
			repeated: 2,
		});
	});
});
