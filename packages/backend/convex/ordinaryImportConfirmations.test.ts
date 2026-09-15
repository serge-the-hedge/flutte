import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel";
import { ordinaryImportConfirmationPlan } from "./ordinaryImportConfirmations";

const localeId = "locale-de" as Id<"locales">;
const secondLocaleId = "locale-fr" as Id<"locales">;
const sourceLocaleId = "locale-en" as Id<"locales">;

function row(input: {
	messageId: string;
	isSource: boolean;
	value: string;
	localeId?: Id<"locales">;
	localeCode?: string;
	valueFingerprint?: string;
	sourceFingerprint?: string;
}) {
	return {
		messageId: input.messageId,
		localeId: input.isSource ? sourceLocaleId : (input.localeId ?? localeId),
		localeCode: input.isSource ? "en" : (input.localeCode ?? "de"),
		isSource: input.isSource,
		value: input.value,
		valueFingerprint:
			input.valueFingerprint ??
			`${input.messageId}-${input.isSource ? "en" : "de"}`,
		sourceFingerprint: input.sourceFingerprint ?? `${input.messageId}-source`,
		gitValueFingerprint: `${input.messageId}-${input.isSource ? "en" : "de"}-git`,
		gitValueRevision: 0,
	};
}

describe("ordinary import confirmation policy", () => {
	test("does not treat text reused by unrelated keys as suspicious", () => {
		const messages = [
			["eligible", "Account", "Konto"],
			["empty", "Empty", ""],
			["source-identical", "Same", "Same"],
			["repeat-one", "First", "OK"],
			["repeat-two", "Second", "OK"],
			["modified", "Modified", "Bearbeitet"],
			["stale", "Stale", "Veraltet"],
			["confirmed", "Confirmed", "Bestätigt"],
			["pending-source", "Pending", "Ausstehend"],
		] as const;
		const rows = messages.flatMap(([messageId, source, target]) => [
			row({ messageId, isSource: true, value: source }),
			row({
				messageId,
				isSource: false,
				value: target,
				sourceFingerprint:
					messageId === "stale"
						? "stale-previous-source"
						: `${messageId}-source`,
			}),
		]);
		const plan = ordinaryImportConfirmationPlan({
			rows,
			heads: [
				{
					messageId: "modified",
					localeId,
					basisGitValueFingerprint: "modified-de-git",
					basisGitValueRevision: 0,
				},
			],
			decisions: [
				{
					kind: "translatorConfirmation",
					messageId: "stale",
					localeId,
					sourceFingerprint: "stale-previous-source",
					valueFingerprint: "stale-de",
					recordedBy: { kind: "user", id: "reviewer" },
					recordedAt: 1,
				},
				{
					kind: "translatorConfirmation",
					messageId: "confirmed",
					localeId,
					sourceFingerprint: "confirmed-source",
					valueFingerprint: "confirmed-de",
					recordedBy: { kind: "user", id: "reviewer" },
					recordedAt: 1,
				},
			],
			pendingSourceMessageIds: new Set(["pending-source"]),
		});

		expect(plan.counts).toEqual({
			total: 9,
			eligible: 3,
			empty: 1,
			sourceIdentical: 1,
			repeated: 0,
			modified: 1,
			stale: 1,
			alreadyConfirmed: 1,
			pendingSourceProposal: 1,
			introduced: 0,
		});
		expect(plan.candidates.map((candidate) => candidate.messageId)).toEqual([
			"eligible",
			"repeat-one",
			"repeat-two",
		]);
	});

	test("keeps equal target translations within one key for deliberate review", () => {
		const plan = ordinaryImportConfirmationPlan({
			rows: [
				row({ messageId: "same-key", isSource: true, value: "Continue" }),
				row({ messageId: "same-key", isSource: false, value: "Continue!" }),
				row({
					messageId: "same-key",
					isSource: false,
					localeId: secondLocaleId,
					localeCode: "fr",
					value: "Continue!",
					valueFingerprint: "same-key-fr",
				}),
			],
			heads: [],
			decisions: [],
			pendingSourceMessageIds: new Set(),
		});

		expect(plan.counts).toMatchObject({
			total: 2,
			eligible: 0,
			repeated: 2,
		});
		expect(plan.candidates).toEqual([]);
	});
});
