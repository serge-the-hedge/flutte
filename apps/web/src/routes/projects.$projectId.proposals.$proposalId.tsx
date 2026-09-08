import { env } from "@blabla/env/web";
import { Alert, AlertDescription } from "@blabla/ui/components/alert";
import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowLeft, Bot, Check, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentReviewEvidence } from "@/components/localization/agent-review-evidence";
import {
	CandidateReviewDelegation,
	candidateReviewUrl,
} from "@/components/localization/candidate-review-delegation";
import { LocaleProposalWorkbench } from "@/components/localization/locale-proposal-workbench";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { TranslationReviewEditor } from "@/components/localization/translation-review-value-editor";
import { WhitespaceFacts } from "@/components/localization/whitespace-facts";
import { canRecordIntentionalBlank } from "@/lib/catalog-value-lifecycle";
import { api, convexId } from "@/lib/convex-api";
import {
	convexApplicationErrorMessage,
	exactTaskBatchRevisionIds,
	type TranslationTaskBasisState,
} from "@/lib/translation-task-review";
import { useCanonicalTaskProject } from "@/lib/use-canonical-task-project";

export const Route = createFileRoute(
	"/projects/$projectId/proposals/$proposalId",
)({
	component: ProposalDetailRoute,
});

function CandidateReviewContext({
	revisionId,
	onContextChange,
}: {
	revisionId: string;
	onContextChange: (
		revisionId: string,
		context: {
			basisState: TranslationTaskBasisState;
			sourceValue: string;
			localeCode: string;
		},
	) => void;
}) {
	const context = useQuery(api.agentTranslationProposals.contextForReview, {
		revisionId: convexId<"agentTranslationCandidateRevisions">(revisionId),
	});
	useEffect(() => {
		if (context === undefined) return;
		const basisState =
			context === null || !context.available
				? "unavailable"
				: (context.reviewBasisIsCurrent ?? context.basisIsCurrent)
					? "current"
					: "changed";
		onContextChange(revisionId, {
			basisState,
			sourceValue: context?.available ? context.source.value : "",
			localeCode: context?.available ? context.localeCode : "target",
		});
	}, [context, onContextChange, revisionId]);
	if (context === undefined) {
		return <Skeleton className="h-28 w-full" />;
	}
	if (context === null || !context.available) {
		return (
			<Alert>
				<AlertDescription>
					The live source or target is no longer available. The candidate is
					kept as evidence, but it cannot be accepted against this stale basis.
				</AlertDescription>
			</Alert>
		);
	}
	const argumentsLabel = context.source.argumentNames.length
		? context.source.argumentNames.join(", ")
		: "none";
	const placeholdersLabel = context.source.declaredPlaceholderNames.length
		? context.source.declaredPlaceholderNames.join(", ")
		: "none";
	return (
		<div className="flex flex-col gap-2">
			<div className="grid gap-3 md:grid-cols-2">
				<div className="rounded-md border bg-muted/20 p-3">
					<div className="mb-1 flex flex-wrap items-center gap-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Source Contract
						<Badge variant="outline" className="normal-case tracking-normal">
							{context.source.icuType === "icu" ? "ICU" : "Plain text"}
						</Badge>
					</div>
					<p className="whitespace-pre-wrap text-sm">{context.source.value}</p>
					<WhitespaceFacts value={context.source.value} />
					{"context" in context.source && context.source.context ? (
						<p className="mt-2 text-muted-foreground text-sm">
							{context.source.context}
						</p>
					) : null}
				</div>
				<div className="rounded-md border bg-muted/20 p-3">
					<div className="mb-1 flex flex-wrap items-center gap-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Current {context.localeCode} value
						<Badge
							variant={context.basisIsCurrent ? "outline" : "destructive"}
							className="normal-case tracking-normal"
						>
							{context.basisIsCurrent ? "Basis current" : "Basis changed"}
						</Badge>
					</div>
					<p className="whitespace-pre-wrap text-sm">
						{context.target.value || "No value yet"}
					</p>
					<WhitespaceFacts value={context.target.value} />
					{context.target.catalogPath ? (
						<code className="mt-2 block break-all text-[11px] text-muted-foreground">
							{context.target.catalogPath}
						</code>
					) : null}
				</div>
			</div>
			{context.kind !== "managedCollection" ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
					<span>Arguments: {argumentsLabel}</span>
					<span>Declared placeholders: {placeholdersLabel}</span>
					{!context.source.argumentNamesComplete ||
					!context.source.declaredPlaceholderNamesComplete ? (
						<span>
							Facts are truncated; server validation remains authoritative.
						</span>
					) : null}
				</div>
			) : null}
			{!context.basisIsCurrent ? (
				<Alert>
					<AlertDescription>
						{context.reviewBasisIsCurrent
							? "The agent authored this candidate against an earlier basis; your saved review is current."
							: "The source or target changed after this candidate was authored. Review the live Source Contract, then save this value if it still fits or edit it first."}
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	);
}

function reviewDecisionLabel(kind: string) {
	if (kind === "accept") return "review saved";
	if (kind === "keepForCurrentSource") return "saved for current source";
	if (kind === "acceptWithEdits") return "edited review saved";
	if (kind === "reject") return "rejected";
	if (kind === "intentionalBlank") return "intentional blank";
	return kind;
}

function ProposalDetailRoute() {
	const { projectId, proposalId } = useParams({
		from: "/projects/$projectId/proposals/$proposalId",
	});
	return <ProposalDetailContent key={`${projectId}:${proposalId}`} />;
}

function ProposalDetailContent() {
	const { projectId, proposalId } = useParams({
		from: "/projects/$projectId/proposals/$proposalId",
	});
	const [pageCursors, setPageCursors] = useState([0]);
	const detail = useQuery(api.agentTranslationProposals.getForReview, {
		cursor: pageCursors[pageCursors.length - 1],
		limit: 8,
		proposalId: convexId<"agentTranslationProposals">(proposalId),
	});
	const relocating = useCanonicalTaskProject(
		projectId,
		proposalId,
		detail?.proposal.projectId,
	);
	const project = useQuery(
		api.projects.get,
		detail === undefined || relocating
			? "skip"
			: { projectId: convexId<"projects">(projectId) },
	);
	const reviewerTokens = useQuery(
		api.apiTokens.list,
		!relocating &&
			detail?.candidates.some(({ reviews }) =>
				reviews.some((review) => review.reviewer.kind === "agent"),
			)
			? { projectId: convexId<"projects">(projectId) }
			: "skip",
	);
	const reviewTaskValue = useMutation(
		api.agentTranslationProposals.reviewTaskValue,
	);
	const saveTaskValue = useMutation(
		api.agentTranslationProposals.saveTaskValue,
	);
	const reviewCandidate = useMutation(
		api.agentTranslationProposals.reviewCandidate,
	);
	const acceptTaskCandidates = useMutation(
		api.agentTranslationProposals.acceptTaskCandidates,
	);
	const finalizeTask = useAction(api.agentTranslationProposals.finalizeTask);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [blankReasons, setBlankReasons] = useState<Record<string, string>>({});
	const [rejectArmed, setRejectArmed] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [isBatchAccepting, setIsBatchAccepting] = useState(false);
	const [reviewingMessageId, setReviewingMessageId] = useState<string | null>(
		null,
	);
	const [isFinalizing, setIsFinalizing] = useState(false);
	const [reviewContext, setReviewContext] = useState<
		Record<
			string,
			| {
					basisState: TranslationTaskBasisState;
					sourceValue: string;
					localeCode: string;
			  }
			| undefined
		>
	>({});
	const recordReviewContext = useCallback(
		(
			revisionId: string,
			context: {
				basisState: TranslationTaskBasisState;
				sourceValue: string;
				localeCode: string;
			},
		) => {
			setReviewContext((previous) =>
				previous[revisionId]?.basisState === context.basisState &&
				previous[revisionId]?.sourceValue === context.sourceValue &&
				previous[revisionId]?.localeCode === context.localeCode
					? previous
					: { ...previous, [revisionId]: context },
			);
		},
		[],
	);

	if (detail === undefined || relocating) {
		return (
			<div
				className="p-5"
				role="status"
				aria-label={
					relocating ? "Opening the task’s current project" : "Loading task"
				}
			>
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (detail === null) {
		return (
			<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
				<Alert variant="destructive">
					<AlertDescription>Proposal not found.</AlertDescription>
				</Alert>
			</ProjectShell>
		);
	}
	if (detail.proposal.localeProposalTaskScope) {
		return (
			<LocaleProposalWorkbench
				projectId={projectId}
				taskId={detail.proposal._id}
				initialProposalId={
					detail.proposal.localeProposalTaskScope.localeProposalId
				}
				title={detail.proposal.clientProposalKey}
				showTaskNavigation
			/>
		);
	}

	const proposal = detail.proposal;
	const managed = proposal.target.kind === "managedCollection";
	const pageHasDrafts = detail.candidates.some(
		({ revision, reviews }) =>
			revision &&
			drafts[revision._id] !== undefined &&
			drafts[revision._id] !== (reviews[0]?.finalValue ?? revision.value),
	);
	const isEditor = project?.role === "owner" || project?.role === "editor";
	const canReview = proposal.status === "open" && isEditor;
	const exactBatchRevisionIds = exactTaskBatchRevisionIds({
		candidates: detail.candidates,
		drafts,
		blankReasons,
		basisState: Object.fromEntries(
			Object.entries(reviewContext).map(([revisionId, context]) => [
				revisionId,
				context?.basisState,
			]),
		),
	});
	const acceptExactBatch = async () => {
		if (!canReview || exactBatchRevisionIds.length === 0 || isBatchAccepting) {
			return;
		}
		setError(null);
		setNotice(null);
		setIsBatchAccepting(true);
		try {
			const result = await acceptTaskCandidates({
				proposalId: convexId<"agentTranslationProposals">(proposal._id),
				candidateRevisionIds: exactBatchRevisionIds.map((revisionId) =>
					convexId<"agentTranslationCandidateRevisions">(revisionId),
				),
			});
			setNotice(
				`${result.accepted} exact candidate${result.accepted === 1 ? "" : "s"} approved.`,
			);
		} catch (cause) {
			setError(convexApplicationErrorMessage(cause, "Batch review failed."));
		} finally {
			setIsBatchAccepting(false);
		}
	};
	const decide = async (
		messageId: string,
		candidateToken: string,
		decision:
			| { kind: "accept" }
			| { kind: "keepForCurrentSource" }
			| { kind: "acceptWithEdits"; value: string }
			| { kind: "reject"; reason?: string }
			| { kind: "intentionalBlank"; reason: string },
	) => {
		if (isBatchAccepting || reviewingMessageId !== null) return;
		setError(null);
		setNotice(null);
		setReviewingMessageId(messageId);
		try {
			if (proposal.taskScope) {
				await reviewTaskValue({
					taskId: convexId<"agentTranslationProposals">(proposalId),
					messageId,
					candidateToken,
					decision,
				});
			} else {
				await reviewCandidate({
					candidateRevisionId:
						convexId<"agentTranslationCandidateRevisions">(candidateToken),
					decision,
				});
			}
			setRejectArmed(null);
		} catch (cause) {
			setError(convexApplicationErrorMessage(cause, "Review failed."));
		} finally {
			setReviewingMessageId(null);
		}
	};
	const blankReasonFor = (revisionId: string) =>
		blankReasons[revisionId]?.trim() ?? "";
	const saveReview = async (
		messageId: string,
		candidateToken: string,
		value: string,
		basis: TranslationTaskBasisState | undefined,
		candidateValue: string,
	) => {
		if (isBatchAccepting || reviewingMessageId !== null) return;
		setError(null);
		setNotice(null);
		setReviewingMessageId(messageId);
		try {
			if (proposal.taskScope) {
				await saveTaskValue({
					taskId: convexId<"agentTranslationProposals">(proposal._id),
					messageId,
					candidateToken,
					value,
				});
			} else {
				await reviewCandidate({
					candidateRevisionId:
						convexId<"agentTranslationCandidateRevisions">(candidateToken),
					decision:
						value !== candidateValue
							? { kind: "acceptWithEdits", value }
							: basis === "changed"
								? { kind: "keepForCurrentSource" }
								: { kind: "accept" },
				});
			}
			setDrafts((previous) => {
				const next = { ...previous };
				delete next[candidateToken];
				return next;
			});
			setNotice("Review saved.");
		} catch (cause) {
			setError(convexApplicationErrorMessage(cause, "Review save failed."));
		} finally {
			setReviewingMessageId(null);
		}
	};
	const taskScope = proposal.taskScope;
	const finalize = async () => {
		if (!taskScope || managed || proposal.status === "open" || isFinalizing)
			return;
		setError(null);
		setNotice(null);
		setIsFinalizing(true);
		try {
			const result = await finalizeTask({
				taskId: convexId<"agentTranslationProposals">(proposal._id),
			});
			setNotice(
				result.kind === "existingLocale"
					? `Release ${result.releaseRecordId} is ${result.releaseStatus}. Open Release for its assessment and bundle hand-off.`
					: "The new-Locale artifact is ready.",
			);
		} catch (cause) {
			setError(
				convexApplicationErrorMessage(cause, "Task finalization failed."),
			);
		} finally {
			setIsFinalizing(false);
		}
	};
	const candidateMessageIds = new Set(
		detail.candidates.map(({ candidate }) => candidate.messageId),
	);
	const waitingTaskTargets = detail.taskTargets.filter(
		(target) => !candidateMessageIds.has(target.messageId),
	);

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title={proposal.clientProposalKey}
				description={
					taskScope
						? `${taskScope.localeCode} · ${proposal.candidateCount} of ${taskScope.targetCount} candidates prepared · ${proposal.revisionCount} immutable revision${proposal.revisionCount === 1 ? "" : "s"}`
						: `${proposal.candidateCount} target${proposal.candidateCount === 1 ? "" : "s"} · ${proposal.revisionCount} immutable revision${proposal.revisionCount === 1 ? "" : "s"}`
				}
				action={
					<Button
						nativeButton={false}
						size="sm"
						variant="outline"
						render={
							<Link
								to="/projects/$projectId/proposals"
								params={{ projectId }}
							/>
						}
					>
						<ArrowLeft data-icon="inline-start" />
						All tasks
					</Button>
				}
			/>
			{error ? (
				<Alert variant="destructive" className="mb-4">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{notice ? (
				<Alert className="mb-4">
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			) : null}
			{taskScope && proposal.status === "open" ? (
				<Alert className="mb-4">
					<AlertDescription className="flex flex-wrap items-center gap-3">
						<span className="min-w-0 flex-1">
							This task has a frozen {taskScope.localeCode} scope. Give an agent
							with this project’s read/propose token the task id{" "}
							<code className="break-all">{proposal._id}</code>. Agent
							candidates remain inert until you or an authorized independent
							reviewer decide them.
						</span>
						{exactBatchRevisionIds.length > 0 ? (
							<Button
								type="button"
								size="sm"
								disabled={!canReview || isBatchAccepting}
								onClick={() => void acceptExactBatch()}
							>
								<Check data-icon="inline-start" />
								{isBatchAccepting
									? "Approving…"
									: `Approve next ${exactBatchRevisionIds.length} exact`}
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}
			{taskScope && !managed && proposal.status !== "open" ? (
				<Alert className="mb-4">
					<AlertDescription className="flex flex-wrap items-center gap-3">
						<span className="min-w-0 flex-1">
							Review is complete. Finalize this task to prepare its durable
							Release hand-off; Git delivery remains a separate local command.
						</span>
						<Button
							type="button"
							size="sm"
							disabled={isFinalizing}
							onClick={() => void finalize()}
						>
							{isFinalizing ? "Preparing…" : "Prepare release"}
						</Button>
						<Button
							nativeButton={false}
							size="sm"
							variant="outline"
							render={
								<Link
									to="/projects/$projectId/release"
									params={{ projectId }}
								/>
							}
						>
							Open Release
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{taskScope ? (
				<div className="mb-4 flex flex-wrap items-center gap-3">
					<span className="text-muted-foreground text-sm">
						Page {pageCursors.length} ·{" "}
						{detail.candidates.length + waitingTaskTargets.length} of{" "}
						{taskScope.targetCount} task messages. Batch review applies to this
						page.
					</span>
					<Button
						variant="outline"
						size="sm"
						disabled={
							pageCursors.length === 1 ||
							pageHasDrafts ||
							isBatchAccepting ||
							reviewingMessageId !== null
						}
						onClick={() => setPageCursors((previous) => previous.slice(0, -1))}
					>
						Previous
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={
							detail.nextCursor === null ||
							pageHasDrafts ||
							isBatchAccepting ||
							reviewingMessageId !== null
						}
						onClick={() => {
							const cursor = detail.nextCursor;
							if (cursor !== null)
								setPageCursors((previous) => [...previous, cursor]);
						}}
					>
						Next
					</Button>
					{pageHasDrafts ? (
						<span className="text-muted-foreground text-xs">
							Save or revert edits before changing pages.
						</span>
					) : null}
					{proposal.target.kind === "managedCollection" ? (
						<Link
							to="/projects/$projectId/strings"
							params={{ projectId }}
							search={{}}
							className="text-sm underline"
						>
							Back to Strings
						</Link>
					) : null}
				</div>
			) : null}
			<div className="flex flex-col gap-4">
				{waitingTaskTargets.map((target) => (
					<Card key={target._id} className="border-dashed">
						<CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
							<CardTitle className="truncate text-sm">
								{target.messageId}
							</CardTitle>
							<Badge variant="outline">awaiting candidate</Badge>
						</CardHeader>
						<CardContent className="grid gap-3 md:grid-cols-2">
							<div className="rounded-md border bg-muted/20 p-3">
								<div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Source Contract
								</div>
								<p className="whitespace-pre-wrap text-sm">
									{target.sourceValue}
								</p>
							</div>
							<div className="rounded-md border bg-muted/20 p-3">
								<div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Current {target.localeCode} value
								</div>
								<p className="whitespace-pre-wrap text-sm">
									{target.targetValue || "No value yet"}
								</p>
							</div>
						</CardContent>
					</Card>
				))}
				{detail.candidates.map(({ candidate, revision, reviews }) => {
					if (!revision) return null;
					const review = reviews[0];
					const savedValue = review?.finalValue ?? revision.value;
					const draft = drafts[revision._id] ?? savedValue;
					const isReviewed = review !== undefined;
					const revisionContext = reviewContext[revision._id];
					const revisionBasisState = revisionContext?.basisState;
					const revisionBasisIsCurrent = revisionBasisState === "current";
					const isDirty = draft !== savedValue;
					const canEditValue = proposal.taskScope ? isEditor : canReview;
					const reviewBusy = isBatchAccepting || reviewingMessageId !== null;
					return (
						<Card key={candidate._id}>
							<CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div className="flex min-w-0 items-center gap-2">
									<Bot aria-hidden className="size-4 text-muted-foreground" />
									<CardTitle className="truncate text-sm">
										{revision.messageId}
									</CardTitle>
								</div>
								<Badge
									variant={
										isDirty ? "secondary" : isReviewed ? "default" : "secondary"
									}
								>
									{isDirty
										? "unsaved changes"
										: review
											? reviewDecisionLabel(review.decision.kind)
											: "waiting"}
								</Badge>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<AgentReviewEvidence
									reviewer={review?.reviewer}
									authorization={review?.reviewAuthorization}
									tokens={reviewerTokens}
								/>
								<CandidateReviewContext
									revisionId={revision._id}
									onContextChange={recordReviewContext}
								/>
								<div className="grid gap-3 md:grid-cols-2">
									<div className="rounded-md border bg-muted/20 p-3">
										<div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Agent candidate · revision {revision.revision}
										</div>
										<p className="whitespace-pre-wrap text-sm">
											{revision.intentionalBlankReason
												? `Renders nothing — ${revision.intentionalBlankReason}`
												: revision.value}
										</p>
										<WhitespaceFacts value={revision.value} />
									</div>
									<div className="rounded-md border p-3">
										<div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Your final value
										</div>
										<TranslationReviewEditor.Provider
											state={{
												draftValue: draft,
												savedValue,
												phase:
													!isReviewed || !revisionBasisIsCurrent
														? "needsReview"
														: "saved",
												disabled:
													!canEditValue ||
													revisionBasisState === "unavailable" ||
													reviewBusy,
												isSaving: reviewingMessageId === revision.messageId,
											}}
											actions={{
												update: (value) =>
													setDrafts((previous) => ({
														...previous,
														[revision._id]: value,
													})),
												save: () =>
													void saveReview(
														revision.messageId,
														revision._id,
														draft,
														revisionBasisState,
														revision.value,
													),
											}}
											meta={{
												format: managed ? "plain" : "icu",
												messageId: revision.messageId,
												localeId: revision.localeId ?? "target",
												localeCode: revisionContext?.localeCode ?? "target",
												sourceValue: revisionContext?.sourceValue ?? "",
											}}
										>
											<TranslationReviewEditor.Field />
											<TranslationReviewEditor.Status />
											<TranslationReviewEditor.Actions>
												<TranslationReviewEditor.SaveReview />
												<TranslationReviewEditor.RevertChanges />
											</TranslationReviewEditor.Actions>
										</TranslationReviewEditor.Provider>
										{canRecordIntentionalBlank(draft) ? (
											<Input
												aria-label={`Reason for intentionally blank ${revision.messageId}`}
												placeholder="Reason for an intentional blank"
												value={blankReasons[revision._id] ?? ""}
												onChange={(event) =>
													setBlankReasons((previous) => ({
														...previous,
														[revision._id]: event.target.value,
													}))
												}
												disabled={!canReview || reviewBusy || isReviewed}
											/>
										) : null}
									</div>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									{rejectArmed === revision._id ? (
										<>
											<Button
												size="sm"
												variant="destructive"
												disabled={isReviewed || !canReview || reviewBusy}
												onClick={() =>
													void decide(revision.messageId, revision._id, {
														kind: "reject",
													})
												}
											>
												<X data-icon="inline-start" />
												Confirm reject
											</Button>
											<Button
												size="sm"
												variant="ghost"
												disabled={reviewBusy}
												onClick={() => setRejectArmed(null)}
											>
												Keep
											</Button>
										</>
									) : (
										<Button
											size="sm"
											variant="outline"
											disabled={isReviewed || !canReview || reviewBusy}
											onClick={() => setRejectArmed(revision._id)}
										>
											Reject
										</Button>
									)}
									{canRecordIntentionalBlank(draft) ? (
										<Button
											size="sm"
											variant="outline"
											disabled={
												isReviewed ||
												!canReview ||
												reviewBusy ||
												!revisionBasisIsCurrent ||
												blankReasonFor(revision._id).length === 0
											}
											onClick={() =>
												void decide(revision.messageId, revision._id, {
													kind: "intentionalBlank",
													reason: blankReasonFor(revision._id),
												})
											}
										>
											Mark intentional blank
										</Button>
									) : null}
								</div>
								{!isReviewed ? (
									<CandidateReviewDelegation
										revisionId={revision._id}
										reviewUrl={candidateReviewUrl(
											env.VITE_CONVEX_SITE_URL,
											revision._id,
										)}
										disabled={
											!canReview ||
											reviewBusy ||
											isDirty ||
											(blankReasons[revision._id] !== undefined &&
												blankReasons[revision._id] !==
													(revision.intentionalBlankReason ?? "")) ||
											!revisionBasisIsCurrent
										}
									/>
								) : null}
							</CardContent>
						</Card>
					);
				})}
			</div>
		</ProjectShell>
	);
}
