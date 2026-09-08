import { Button } from "@blabla/ui/components/button";
import { Card, CardContent } from "@blabla/ui/components/card";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { cn } from "@blabla/ui/lib/utils";
import type { FunctionReturnType } from "convex/server";
import {
	CircleSlash,
	GitCommitHorizontal,
	LoaderCircle,
	ShieldAlert,
} from "lucide-react";
import type { ReactNode } from "react";

import { blablaCommand } from "@/lib/blabla-command";
import type { api } from "@/lib/convex-api";
import {
	releaseHistoryStatus,
	releasePresentationFor,
	releaseProgressFor,
} from "@/lib/release-presentation";

const NUMBER_FORMAT = new Intl.NumberFormat();
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

type ReleaseRead = FunctionReturnType<typeof api.releaseRecords.current>;
type AvailableRelease = Extract<ReleaseRead, { kind: "available" }>;
export type ReleaseSummary = NonNullable<AvailableRelease["current"]>;
export type ReleaseEvidence = FunctionReturnType<
	typeof api.releaseRecords.evidence
>["page"][number];
export type ReadyLocaleProposal = Exclude<
	FunctionReturnType<typeof api.releaseBundles.readyLocaleProposalForRecord>,
	null
>;
export type EvidenceStatus =
	| "LoadingFirstPage"
	| "CanLoadMore"
	| "LoadingMore"
	| "Exhausted";

export function ReleaseDeliveryScope({
	changeKeyCount,
	targetValueCount,
	localeProposal,
}: {
	changeKeyCount: number;
	targetValueCount: number;
	localeProposal: ReadyLocaleProposal | null;
}) {
	return (
		<div
			className={cn(
				"grid overflow-hidden rounded-md border bg-border",
				localeProposal && "sm:grid-cols-2",
			)}
		>
			<div className="bg-background p-3">
				<p className="font-medium text-sm">Existing languages</p>
				<p className="mt-0.5 text-muted-foreground text-xs tabular-nums">
					{NUMBER_FORMAT.format(changeKeyCount)} changed key
					{changeKeyCount === 1 ? "" : "s"} ·{" "}
					{NUMBER_FORMAT.format(targetValueCount)} target value
					{targetValueCount === 1 ? "" : "s"}
				</p>
			</div>
			{localeProposal ? (
				<div className="border-border border-t bg-background p-3 sm:border-t-0 sm:border-l">
					<p className="font-medium text-sm">
						{localeProposal.localeCode} · new language
					</p>
					<p className="mt-0.5 text-muted-foreground text-xs tabular-nums">
						{NUMBER_FORMAT.format(localeProposal.valueCount)} catalog values
					</p>
				</div>
			) : null}
		</div>
	);
}

function localeSpread(
	record: ReleaseSummary,
	kind: "blockedCount" | "needsDecisionCount",
) {
	return record.localeSummaries
		.filter((locale) => locale[kind] > 0)
		.map((locale) => `${locale.localeCode} ${locale[kind]}`)
		.join(", ");
}

function AssessmentRow({
	icon: Icon,
	count,
	title,
	spread,
	explanation,
	destructive,
}: {
	icon: typeof ShieldAlert;
	count: number;
	title: string;
	spread: string;
	explanation: string;
	destructive?: boolean;
}) {
	if (count === 0) return null;
	return (
		<div className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
			<Icon
				aria-hidden="true"
				className={cn(
					"mt-0.5 size-4 shrink-0",
					destructive ? "text-destructive" : "text-muted-foreground",
				)}
			/>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm">
					<span className="font-medium tabular-nums">
						{NUMBER_FORMAT.format(count)}
					</span>{" "}
					{title}{" "}
					{spread ? (
						<span className="text-muted-foreground">— {spread}</span>
					) : null}
				</span>
				<span className="text-muted-foreground text-xs">{explanation}</span>
			</div>
		</div>
	);
}

function BaselineLine({ record }: { record: ReleaseSummary }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
			<span className="inline-flex items-center gap-1 font-mono">
				<GitCommitHorizontal aria-hidden="true" className="size-3.5" />
				{record.commit.slice(0, 12)}
			</span>
			<span>
				{NUMBER_FORMAT.format(record.deltaKeyCount)} changed key
				{record.deltaKeyCount === 1 ? "" : "s"} ·{" "}
				{NUMBER_FORMAT.format(record.scopeValueCount)} target values
			</span>
		</div>
	);
}

export function ReleaseDeliveryHandoff({
	recordId,
	changeKeyCount,
	targetValueCount,
	localeProposal,
}: {
	recordId: ReleaseSummary["recordId"];
	changeKeyCount: number;
	targetValueCount: number;
	localeProposal: ReadyLocaleProposal | null;
}) {
	if (changeKeyCount === 0 && !localeProposal) {
		return (
			<p className="text-muted-foreground text-xs">
				No reviewed changes to deliver.
			</p>
		);
	}
	const command = blablaCommand(
		`deliver --release ${recordId}${localeProposal ? ` --locale-proposal ${localeProposal.proposalId}` : ""}`,
	);

	return (
		<div className="flex flex-col gap-3">
			<ReleaseDeliveryScope
				changeKeyCount={changeKeyCount}
				targetValueCount={targetValueCount}
				localeProposal={localeProposal}
			/>
			<p className="text-muted-foreground text-xs">
				Run from a clean checkout:
			</p>
			<code className="w-fit max-w-full overflow-x-auto border bg-muted/30 px-2 py-1.5 text-xs">
				{command}
			</code>
		</div>
	);
}

export function PreparingCard({ record }: { record: ReleaseSummary }) {
	const progress = releaseProgressFor(record.progress);
	return (
		<Card size="sm" className="max-w-3xl">
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-start gap-2">
					<LoaderCircle
						aria-hidden="true"
						className="mt-0.5 size-4 animate-spin text-muted-foreground"
					/>
					<div className="flex flex-col gap-0.5">
						<span className="font-medium text-sm">Preparing release</span>
						<span className="text-muted-foreground text-xs">
							{NUMBER_FORMAT.format(progress)} of{" "}
							{NUMBER_FORMAT.format(record.progress.expectedKeyCount)} catalog
							keys checked. You can leave this page while preparation continues.
						</span>
					</div>
				</div>
				<div className="h-1 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full bg-foreground/45 transition-[width] duration-300"
						style={{
							width: `${record.progress.expectedKeyCount === 0 ? 100 : (progress / record.progress.expectedKeyCount) * 100}%`,
						}}
					/>
				</div>
			</CardContent>
		</Card>
	);
}

export function EvidenceLedger({
	evidence,
	status,
	onLoadMore,
}: {
	evidence: ReleaseEvidence[];
	status: EvidenceStatus;
	onLoadMore: () => void;
}) {
	if (status === "LoadingFirstPage") {
		return <Skeleton className="h-4 w-64" />;
	}
	return (
		<div className="flex flex-col gap-2 pt-1">
			<div className="flex flex-col gap-1">
				{evidence.map((item) => (
					<span key={item._id} className="text-xs">
						<span className="font-mono">{item.messageId}</span>{" "}
						<span className="font-mono text-muted-foreground">
							{item.localeCode}
						</span>{" "}
						<span className="text-muted-foreground">
							—{" "}
							{item.kind === "intentional_blank"
								? item.reason
								: "confirmed as Source wording"}
						</span>
					</span>
				))}
			</div>
			{status === "CanLoadMore" || status === "LoadingMore" ? (
				<div>
					<Button
						variant="outline"
						size="xs"
						disabled={status === "LoadingMore"}
						onClick={onLoadMore}
					>
						{status === "LoadingMore" ? (
							<LoaderCircle aria-hidden="true" className="animate-spin" />
						) : null}
						Show more evidence
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function ReleaseRecordView({
	record,
	history,
	evidence,
	evidenceStatus,
	onLoadMoreEvidence,
	workAction,
	releaseAction,
}: {
	record: ReleaseSummary;
	history: ReleaseSummary[] | undefined;
	evidence: ReleaseEvidence[];
	evidenceStatus: EvidenceStatus;
	onLoadMoreEvidence: () => void;
	workAction?: ReactNode;
	releaseAction?: ReactNode;
}) {
	const presentation = releasePresentationFor(record.posture);
	const hasEvidence =
		record.intentionalBlankCount + record.sourceIdenticalCount > 0;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<span
					className={cn(
						"font-medium text-sm",
						presentation.posture === "blocked"
							? "text-destructive"
							: presentation.posture === "needsDecisions"
								? "text-amber-600 dark:text-amber-500"
								: "text-emerald-600 dark:text-emerald-500",
					)}
				>
					{presentation.label}
				</span>
				<BaselineLine record={record} />
			</div>

			<Card size="sm" className="max-w-3xl">
				<CardContent className="flex flex-col gap-3">
					<span className="font-medium text-sm">{presentation.heading}</span>
					{presentation.needsWork ? (
						<div className="divide-y">
							<AssessmentRow
								icon={ShieldAlert}
								count={record.blockedCount}
								title="invalid for the contract"
								spread={localeSpread(record, "blockedCount")}
								explanation="Fix the value or source contract. These errors cannot be waived."
								destructive
							/>
							<AssessmentRow
								icon={CircleSlash}
								count={record.needsDecisionCount}
								title="values still needing a decision"
								spread={localeSpread(record, "needsDecisionCount")}
								explanation="Translate, confirm the source wording, record a blank reason, or review a source change."
							/>
						</div>
					) : null}
					{presentation.needsWork && workAction ? (
						<div>{workAction}</div>
					) : null}
					{!presentation.needsWork && releaseAction ? (
						<div>{releaseAction}</div>
					) : null}
				</CardContent>
			</Card>

			<Card size="sm" className="max-w-3xl">
				<CardContent className="flex flex-col gap-2">
					<span className="font-medium text-sm">
						{presentation.needsWork ? "Release scope" : "Release contents"}
					</span>
					<p className="text-muted-foreground text-xs">
						{NUMBER_FORMAT.format(record.scopeValueCount)} target{" "}
						{presentation.needsWork ? "slots" : "values"} across{" "}
						{NUMBER_FORMAT.format(record.deltaKeyCount)} changed keys.
					</p>
					<ul className="flex flex-col gap-1 text-muted-foreground text-xs">
						<li>
							<span className="text-foreground tabular-nums">
								{NUMBER_FORMAT.format(record.sourceIdenticalCount)}
							</span>{" "}
							confirmed source wording
						</li>
						<li>
							<span className="text-foreground tabular-nums">
								{NUMBER_FORMAT.format(record.intentionalBlankCount)}
							</span>{" "}
							intentional blanks with reasons
						</li>
						<li>
							<span className="text-foreground tabular-nums">
								{NUMBER_FORMAT.format(record.unconfirmedImportCount)}
							</span>{" "}
							untouched imports (do not block this release)
						</li>
					</ul>
					{hasEvidence ? (
						<>
							<span className="pt-1 font-medium text-xs">
								Recorded evidence
							</span>
							<EvidenceLedger
								evidence={evidence}
								status={evidenceStatus}
								onLoadMore={onLoadMoreEvidence}
							/>
						</>
					) : null}
				</CardContent>
			</Card>

			<Card size="sm" className="max-w-3xl">
				<CardContent className="flex flex-col gap-2">
					<span className="font-medium text-sm">Earlier records</span>
					{history === undefined ? (
						<Skeleton className="h-4 w-56" />
					) : history.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							No earlier releases.
						</p>
					) : (
						<ul className="flex flex-col gap-1">
							{history.map((item) => (
								<li
									key={item.recordId}
									className="flex flex-wrap items-baseline gap-x-2 text-xs"
								>
									<span className="w-28 text-muted-foreground">
										{DATE_FORMAT.format(item.createdAt)}
									</span>
									<span className="font-mono">{item.commit.slice(0, 10)}</span>
									<span
										className={cn(
											item.posture === "blocked"
												? "text-destructive"
												: "text-muted-foreground",
										)}
									>
										{releaseHistoryStatus(item)}
									</span>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
