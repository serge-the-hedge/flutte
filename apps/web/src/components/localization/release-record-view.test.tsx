import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { convexId } from "@/lib/convex-api";

import {
	EvidenceLedger,
	PreparingCard,
	ReleaseDeliveryHandoff,
	ReleaseDeliveryScope,
	type ReleaseEvidence,
	ReleaseRecordView,
	type ReleaseSummary,
} from "./release-record-view";

function releaseSummary(
	posture: "blocked" | "needsDecisions" | "ready",
): ReleaseSummary {
	return {
		recordId: convexId<"releaseRecords">("release-record"),
		projectionId: convexId<"catalogProjections">("projection"),
		snapshotId: convexId<"sourceSnapshots">("snapshot"),
		commit: "4c6b65419745deadbeef",
		navigationRevision: 3,
		status: "ready",
		posture,
		progress: { cursor: 1433, expectedKeyCount: 1434 },
		deltaKeyCount: 2,
		scopeValueCount: 10,
		blockedCount: posture === "blocked" ? 1 : 0,
		needsDecisionCount: posture === "needsDecisions" ? 2 : 0,
		intentionalBlankCount: 1,
		sourceIdenticalCount: 1,
		unconfirmedImportCount: 4,
		localeSummaries: [
			{
				localeId: convexId<"locales">("german"),
				localeCode: "de",
				scopeValueCount: 2,
				blockedCount: posture === "blocked" ? 1 : 0,
				needsDecisionCount: posture === "needsDecisions" ? 2 : 0,
				intentionalBlankCount: 1,
				sourceIdenticalCount: 1,
				unconfirmedImportCount: 0,
			},
		],
		failure: null,
		createdAt: 1_787_000_000_000,
		completedAt: 1_787_000_001_000,
	};
}

const evidence: ReleaseEvidence[] = [
	{
		_id: convexId<"releaseEvidence">("blank"),
		catalogIndex: 1,
		messageId: "optional_hint",
		localeId: convexId<"locales">("german"),
		localeCode: "de",
		kind: "intentional_blank",
		reason: "Not shown on Android",
	},
	{
		_id: convexId<"releaseEvidence">("echo"),
		catalogIndex: 2,
		messageId: "brand_name",
		localeId: convexId<"locales">("french"),
		localeCode: "fr",
		kind: "source_identical",
	},
];

describe("Release Record UI", () => {
	test("shows complete new-Locale scope before bundle construction", () => {
		const markup = renderToStaticMarkup(
			<ReleaseDeliveryScope
				changeKeyCount={72}
				targetValueCount={380}
				localeProposal={{
					proposalId: convexId<"localeProposals">("portuguese-proposal"),
					localeCode: "pt",
					runtimeLocale: "pt-BR",
					valueCount: 1549,
				}}
			/>,
		);

		expect(markup).toContain("72 changed keys · 380 target values");
		expect(markup).toContain("pt · new locale");
		expect(markup).toContain("1,549 catalog values");
		expect(markup).not.toContain("deliver --release");
	});

	test("presents one combined delivery for existing and new-Locale work", () => {
		const markup = renderToStaticMarkup(
			<ReleaseDeliveryHandoff
				recordId={convexId<"releaseRecords">("release-record")}
				changeKeyCount={72}
				targetValueCount={380}
				localeProposal={{
					proposalId: convexId<"localeProposals">("portuguese-proposal"),
					localeCode: "pt",
					runtimeLocale: "pt-BR",
					valueCount: 1549,
				}}
			/>,
		);

		expect(markup).toContain("72 changed keys · 380 target values");
		expect(markup).toContain("1,549 catalog values");
		expect(markup).toContain(
			"deliver --release release-record --locale-proposal portuguese-proposal",
		);
		expect(markup).toContain("one combined delivery");
	});

	test("still delivers a ready new Locale when the existing-Locale delta is empty", () => {
		const markup = renderToStaticMarkup(
			<ReleaseDeliveryHandoff
				recordId={convexId<"releaseRecords">("release-record")}
				changeKeyCount={0}
				targetValueCount={0}
				localeProposal={{
					proposalId: convexId<"localeProposals">("portuguese-proposal"),
					localeCode: "pt",
					runtimeLocale: "pt-BR",
					valueCount: 1549,
				}}
			/>,
		);

		expect(markup).toContain(
			"deliver --release release-record --locale-proposal portuguese-proposal",
		);
		expect(markup).not.toContain("No reviewed catalog changes need delivery");
	});

	test("keeps the existing-Locale-only delivery command when no new Locale is ready", () => {
		const markup = renderToStaticMarkup(
			<ReleaseDeliveryHandoff
				recordId={convexId<"releaseRecords">("release-record")}
				changeKeyCount={3}
				targetValueCount={12}
				localeProposal={null}
			/>,
		);

		expect(markup).toContain("deliver --release release-record");
		expect(markup).not.toContain("--locale-proposal");
	});

	test("renders durable preparation progress", () => {
		const record = {
			...releaseSummary("ready"),
			status: "preparing" as const,
			posture: null,
			progress: { cursor: 63, expectedKeyCount: 1434 },
		};
		const markup = renderToStaticMarkup(<PreparingCard record={record} />);

		expect(markup).toContain("Preparing Release Record");
		expect(markup).toContain("64 of 1,434 catalog keys assessed");
		expect(markup).toContain("progress is durable");
	});

	test.each([
		["blocked", "Blocked", "Before this can be built", "target slots"],
		[
			"needsDecisions",
			"Needs decisions",
			"Before this can be built",
			"target slots",
		],
		["ready", "Ready", "This release is ready", "target values"],
	] as const)(
		"renders the %s release posture",
		(posture, label, heading, scope) => {
			const record = releaseSummary(posture);
			const markup = renderToStaticMarkup(
				<ReleaseRecordView
					record={record}
					history={[]}
					evidence={evidence}
					evidenceStatus="Exhausted"
					onLoadMoreEvidence={() => undefined}
					workAction={
						<a href={`/projects/project/strings?release=${record.recordId}`}>
							Work through in Strings
						</a>
					}
				/>,
			);

			expect(markup).toContain(`>${label}<`);
			expect(markup).toContain(heading);
			expect(markup).toContain(scope);
			if (posture === "ready") {
				expect(markup).not.toContain("Work through in Strings");
			} else {
				expect(markup).toContain(
					`href="/projects/project/strings?release=${record.recordId}"`,
				);
			}
		},
	);

	test("renders every evidence kind and an explicit pagination action", () => {
		const markup = renderToStaticMarkup(
			<EvidenceLedger
				evidence={evidence}
				status="CanLoadMore"
				onLoadMore={() => undefined}
			/>,
		);

		expect(markup).toContain("optional_hint");
		expect(markup).toContain("Not shown on Android");
		expect(markup).toContain("brand_name");
		expect(markup).toContain("confirmed as Source wording");
		expect(markup).toContain("Show more evidence");
	});

	test("shows the Release Bundle action only for a ready posture", () => {
		const ready = renderToStaticMarkup(
			<ReleaseRecordView
				record={releaseSummary("ready")}
				history={[]}
				evidence={evidence}
				evidenceStatus="Exhausted"
				onLoadMoreEvidence={() => undefined}
				releaseAction={<button type="button">Build release</button>}
			/>,
		);
		const blocked = renderToStaticMarkup(
			<ReleaseRecordView
				record={releaseSummary("blocked")}
				history={[]}
				evidence={evidence}
				evidenceStatus="Exhausted"
				onLoadMoreEvidence={() => undefined}
				releaseAction={<button type="button">Build release</button>}
			/>,
		);

		expect(ready).toContain("Build release");
		expect(blocked).not.toContain("Build release");
	});

	test("keeps history loading independent from the current assessment", () => {
		const markup = renderToStaticMarkup(
			<ReleaseRecordView
				record={releaseSummary("ready")}
				history={undefined}
				evidence={evidence}
				evidenceStatus="LoadingFirstPage"
				onLoadMoreEvidence={() => undefined}
			/>,
		);

		expect(markup).toContain("This release is ready");
		expect(markup).toContain("Earlier records");
		expect(markup).toContain("Recorded evidence");
	});
});
