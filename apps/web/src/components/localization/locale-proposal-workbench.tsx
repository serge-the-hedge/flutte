import { env } from "@blabla/env/web";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@blabla/ui/components/alert";
import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Checkbox } from "@blabla/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	ArrowLeft,
	Check,
	ChevronDown,
	Download,
	Languages,
	RefreshCw,
	Save,
	Search,
	Sparkles,
	TriangleAlert,
	X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AgentReviewEvidence } from "@/components/localization/agent-review-evidence";
import {
	CandidateReviewDelegation,
	candidateReviewUrl,
} from "@/components/localization/candidate-review-delegation";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { TranslationReviewEditor } from "@/components/localization/translation-review-value-editor";
import { WhitespaceFacts } from "@/components/localization/whitespace-facts";
import { blablaCommand } from "@/lib/blabla-command";
import { canRecordIntentionalBlank } from "@/lib/catalog-value-lifecycle";
import { api, convexId } from "@/lib/convex-api";
import { localeProposalReviewState } from "@/lib/locale-proposal-review-state";

type ReviewDecision =
	| { kind: "accept" }
	| { kind: "acceptWithEdits"; value: string }
	| { kind: "reject" }
	| { kind: "intentionalBlank"; reason: string };

type ReviewFocus =
	| "awaiting"
	| "attention"
	| "routine"
	| "reviewed"
	| "missing"
	| "all";

/** One new-Locale review surface, mounted either from the compatibility Locale
 * route or from a Translation Task whose private adapter is that proposal. */
export function LocaleProposalWorkbench({
	projectId,
	initialProposalId,
	taskId,
	title = "New Locale",
	showTaskNavigation = false,
}: {
	projectId: string;
	initialProposalId?: string;
	taskId?: string;
	title?: string;
	showTaskNavigation?: boolean;
}) {
	const convexProjectId = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: convexProjectId });
	const currentProposalId = useQuery(
		api.localeProposals.currentForReview,
		initialProposalId ? "skip" : { projectId: convexProjectId },
	);
	const ensureForReview = useMutation(api.localeProposals.ensureForReview);
	const stageForReview = useMutation(api.localeProposals.stageForReview);
	const reviewStagedValue = useMutation(api.localeProposals.reviewStagedValue);
	const reviewTaskValue = useMutation(
		api.agentTranslationProposals.reviewTaskValue,
	);
	const saveTaskValue = useMutation(
		api.agentTranslationProposals.saveTaskValue,
	);
	const acceptTaskCandidates = useMutation(
		api.agentTranslationProposals.acceptTaskCandidates,
	);
	const finalizeForReview = useAction(api.localeProposals.finalizeForReview);
	const finalizeTask = useAction(api.agentTranslationProposals.finalizeTask);
	const artifactForReview = useAction(api.localeProposals.artifactForReview);
	const carryForwardForReview = useAction(
		api.localeProposals.carryForwardForReview,
	);
	const continueNewLocaleTask = useAction(
		api.agentTranslationProposals.continueNewLocaleTask,
	);
	const navigate = useNavigate();
	const [proposalId, setProposalId] = useState<string | null>(null);
	const activeProposalId = initialProposalId ?? proposalId ?? currentProposalId;
	const [cursor, setCursor] = useState(0);
	const [pendingCursor, setPendingCursor] = useState<string | undefined>();
	const [cursorHistory, setCursorHistory] = useState<number[]>([]);
	const [focus, setFocus] = useState<ReviewFocus>(taskId ? "awaiting" : "all");
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);
	const queriedDetail = useQuery(
		api.localeProposals.getForReview,
		activeProposalId
			? {
					proposalId: convexId<"localeProposals">(activeProposalId),
					...(taskId
						? {
								taskId: convexId<"agentTranslationProposals">(taskId),
							}
						: {}),
					cursor,
					...(pendingCursor ? { pendingCursor } : {}),
					limit: 48,
					focus,
					...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}),
				}
			: "skip",
	);
	const [stableDetail, setStableDetail] = useState<{
		proposalId: string;
		value: Exclude<typeof queriedDetail, undefined>;
	} | null>(null);
	const sparseQueueTransition =
		queriedDetail !== undefined &&
		queriedDetail !== null &&
		queriedDetail.messages.length === 0 &&
		queriedDetail.continueCursor !== null;
	const detail =
		queriedDetail === undefined || sparseQueueTransition
			? stableDetail && stableDetail.proposalId === activeProposalId
				? stableDetail.value
				: queriedDetail
			: queriedDetail;
	const queueIsLoading = queriedDetail === undefined || sparseQueueTransition;
	const delivery = useQuery(
		api.localeDelivery.forProposal,
		activeProposalId
			? { proposalId: convexId<"localeProposals">(activeProposalId) }
			: "skip",
	);
	const binding = useQuery(
		api.localeDelivery.bindingForProposal,
		activeProposalId
			? { proposalId: convexId<"localeProposals">(activeProposalId) }
			: "skip",
	);
	const languageIsBound = binding != null || delivery?.status === "bound";
	const createLocale = useMutation(api.locales.create);
	const bindLocale = useAction(api.locales.bind);
	const locales = useQuery(api.locales.list, { projectId: convexProjectId });
	const reviewerTokens = useQuery(
		api.apiTokens.list,
		detail?.messages.some(
			(message) =>
				(message.candidate?.review?.reviewer ?? message.review?.reviewer)
					?.kind === "agent",
		)
			? { projectId: convexProjectId }
			: "skip",
	);
	const reviewState = detail
		? localeProposalReviewState({
				status: detail.proposal.status,
				isBound: languageIsBound,
				isCurrentBaseline: detail.isCurrentBaseline,
				remaining: detail.proposal.progress.remaining,
				pendingReview: detail.pendingReview,
			})
		: null;
	const proposalReadOnly =
		detail === null ||
		detail === undefined ||
		!detail.isCurrentBaseline ||
		detail.proposal.status === "ready";
	const showWorkflowEmptyState =
		focus === "awaiting" && deferredSearch.trim().length === 0;
	const continuousReviewQueue =
		(focus === "awaiting" || focus === "attention" || focus === "routine") &&
		deferredSearch.trim().length === 0;
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [blankReasons, setBlankReasons] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [selectedCandidateTokens, setSelectedCandidateTokens] = useState<
		Record<string, string>
	>({});
	const [expandedMessageId, setExpandedMessageId] = useState<string | null>(
		null,
	);

	useEffect(() => {
		if (
			activeProposalId &&
			queriedDetail !== undefined &&
			!sparseQueueTransition
		) {
			setStableDetail({ proposalId: activeProposalId, value: queriedDetail });
		}
	}, [activeProposalId, queriedDetail, sparseQueueTransition]);

	useEffect(() => {
		if (detail && !detail.isCurrentBaseline && focus === "awaiting") {
			setFocus("all");
		}
	}, [detail, focus]);

	// A different proposal is a different editing session, even though this
	// effect only writes local state and the dependency is not read in its body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on proposal identity
	useEffect(() => {
		setCursor(0);
		setPendingCursor(undefined);
		setCursorHistory([]);
		setDrafts({});
		setBlankReasons({});
		setSelectedCandidateTokens({});
		setExpandedMessageId(null);
		setBusy(null);
		setError(null);
		setNotice(null);
	}, [activeProposalId]);

	// Review filters are server-backed catalog scans. Reset their cursor so a
	// new question always starts at the beginning of Catalog Order.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter identity
	useEffect(() => {
		setCursor(0);
		setPendingCursor(undefined);
		setCursorHistory([]);
		setSelectedCandidateTokens({});
		setExpandedMessageId(null);
	}, [focus, deferredSearch]);

	const dirtyItems = useMemo(() => {
		if (!detail) return [];
		return detail.messages.flatMap((message) => {
			const draft = drafts[message.messageId];
			const currentValue =
				message.candidate?.review?.finalValue ??
				message.review?.finalValue ??
				(message.facts.state === "reviewedDraft"
					? message.value?.value
					: (message.candidate?.value ?? message.value?.value)) ??
				"";
			if (draft === undefined || draft === currentValue) return [];
			if (draft.trim().length === 0) return [];
			return [
				{
					messageId: message.messageId,
					value: draft,
					sourceFingerprint: message.sourceFingerprint,
				},
			];
		});
	}, [detail, drafts]);
	const selectableAgentCandidates = useMemo(() => {
		if (!detail) return [];
		return detail.messages.filter((message) => {
			const taskCandidateValue = message.candidate?.value;
			const legacyAgentValue =
				message.value?.updatedBy.kind === "agent"
					? message.value.value
					: undefined;
			const value = taskCandidateValue ?? legacyAgentValue;
			const candidateToken =
				message.candidate?.revisionId ??
				(message.value?.updatedBy.kind === "agent"
					? message.value.reviewToken
					: undefined);
			return (
				message.facts.state === "awaiting" &&
				value !== undefined &&
				value.length > 0 &&
				candidateToken !== undefined &&
				!message.facts.staleSource &&
				(drafts[message.messageId] ?? value) === value
			);
		});
	}, [detail, drafts]);
	const routineAgentCandidates = selectableAgentCandidates.filter(
		(message) =>
			!message.facts.sourceIdentical &&
			!message.facts.sourceEmpty &&
			!message.facts.blankCandidate &&
			!message.facts.icu &&
			!message.facts.edgeWhitespaceMismatch,
	);
	const selectedAgentCandidates = selectableAgentCandidates.filter(
		(message) => {
			const currentToken =
				message.candidate?.revisionId ??
				(message.value?.updatedBy.kind === "agent"
					? message.value.reviewToken
					: undefined);
			return selectedCandidateTokens[message.messageId] === currentToken;
		},
	);

	const run = async (label: string, task: () => Promise<void>) => {
		setBusy(label);
		setError(null);
		setNotice(null);
		try {
			await task();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The operation failed.",
			);
		} finally {
			setBusy(null);
		}
	};

	const prepare = () =>
		run("prepare", async () => {
			const result = await ensureForReview({ projectId: convexProjectId });
			setProposalId(result.proposalId);
			setNotice(
				"The catalog is ready for manual editing or agent-assisted review.",
			);
		});

	const continueOnCurrentSource = () =>
		run("continue-source", async () => {
			if (!activeProposalId) return;
			if (dirtyItems.length > 0) {
				setError(
					"Resolve the unsaved visible edits before continuing on the current source.",
				);
				return;
			}
			if (taskId) {
				const result = await continueNewLocaleTask({
					taskId: convexId<"agentTranslationProposals">(taskId),
				});
				await navigate({
					to: "/projects/$projectId/proposals/$proposalId",
					params: { projectId, proposalId: result.taskId },
				});
				return;
			}
			const result = await carryForwardForReview({
				projectId: convexProjectId,
				proposalId: convexId<"localeProposals">(activeProposalId),
			});
			setProposalId(result.localeProposalId);
			setNotice(
				`${result.carriedValueCount.toLocaleString()} compatible value${result.carriedValueCount === 1 ? "" : "s"} carried forward; ${result.remainingValueCount.toLocaleString()} need work on the current source.`,
			);
		});

	const saveVisible = () =>
		run("save", async () => {
			if (!activeProposalId || proposalReadOnly || dirtyItems.length === 0)
				return;
			for (let offset = 0; offset < dirtyItems.length; offset += 16) {
				await stageForReview({
					projectId: convexProjectId,
					proposalId: convexId<"localeProposals">(activeProposalId),
					items: dirtyItems.slice(offset, offset + 16),
				});
			}
			setNotice(
				`${dirtyItems.length} manual value${dirtyItems.length === 1 ? "" : "s"} saved.`,
			);
		});

	const reviewValue = async (
		messageId: string,
		candidateToken: string,
		decision: ReviewDecision,
		kind: "taskCandidate" | "stagedValue",
	) => {
		if (!activeProposalId) return;
		if (taskId && kind === "taskCandidate") {
			await reviewTaskValue({
				taskId: convexId<"agentTranslationProposals">(taskId),
				messageId,
				candidateToken,
				decision,
			});
			return;
		}
		await reviewStagedValue({
			projectId: convexProjectId,
			proposalId: convexId<"localeProposals">(activeProposalId),
			messageId,
			expectedValueFingerprint: candidateToken,
			decision,
		});
	};

	const decide = (
		messageId: string,
		candidateToken: string,
		decision: ReviewDecision,
		kind: "taskCandidate" | "stagedValue",
	) =>
		run(`review:${messageId}`, async () => {
			await reviewValue(messageId, candidateToken, decision, kind);
			setNotice("Human review recorded.");
		});

	const saveMessageReview = (
		message: NonNullable<typeof detail>["messages"][number],
		value: string,
		candidateToken: string | undefined,
		kind: "taskCandidate" | "stagedValue",
	) =>
		run(`review:${message.messageId}`, async () => {
			if (!activeProposalId) return;
			if (taskId && kind === "taskCandidate" && candidateToken) {
				await saveTaskValue({
					taskId: convexId<"agentTranslationProposals">(taskId),
					messageId: message.messageId,
					candidateToken,
					value,
				});
			} else if (candidateToken && message.facts.state === "awaiting") {
				const candidateValue =
					message.candidate?.value ?? message.value?.value ?? "";
				await reviewValue(
					message.messageId,
					candidateToken,
					value === candidateValue
						? { kind: "accept" }
						: { kind: "acceptWithEdits", value },
					kind,
				);
			} else {
				await stageForReview({
					projectId: convexProjectId,
					proposalId: convexId<"localeProposals">(activeProposalId),
					items: [
						{
							messageId: message.messageId,
							value,
							sourceFingerprint: message.sourceFingerprint,
						},
					],
				});
			}
			setDrafts((previous) => {
				const next = { ...previous };
				delete next[message.messageId];
				return next;
			});
			setNotice("Review saved.");
		});

	const acceptSelectedAgentCandidates = () =>
		run("accept-selected", async () => {
			if (!activeProposalId || selectedAgentCandidates.length === 0) return;
			let accepted = 0;
			if (taskId) {
				const candidateRevisionIds = selectedAgentCandidates.flatMap(
					(message) => {
						const selectedToken = selectedCandidateTokens[message.messageId];
						return selectedToken && message.candidate ? [selectedToken] : [];
					},
				);
				for (
					let offset = 0;
					offset < candidateRevisionIds.length;
					offset += 16
				) {
					const result = await acceptTaskCandidates({
						proposalId: convexId<"agentTranslationProposals">(taskId),
						candidateRevisionIds: candidateRevisionIds
							.slice(offset, offset + 16)
							.map((revisionId) =>
								convexId<"agentTranslationCandidateRevisions">(revisionId),
							),
					});
					accepted += result.accepted;
				}
			}
			for (const message of selectedAgentCandidates) {
				if (message.candidate) continue;
				const selectedToken = selectedCandidateTokens[message.messageId];
				if (!selectedToken) continue;
				await reviewValue(
					message.messageId,
					selectedToken,
					{
						kind: "accept",
					},
					"stagedValue",
				);
				accepted += 1;
			}
			setSelectedCandidateTokens({});
			setNotice(
				`${accepted} selected candidate${accepted === 1 ? "" : "s"} approved.`,
			);
		});

	const selectRoutinePage = () => {
		setSelectedCandidateTokens(
			Object.fromEntries(
				routineAgentCandidates.flatMap((message) => {
					const token =
						message.candidate?.revisionId ??
						(message.value?.updatedBy.kind === "agent"
							? message.value.reviewToken
							: undefined);
					return token ? [[message.messageId, token]] : [];
				}),
			),
		);
	};

	const goNext = (nextCursor: number) => {
		setCursorHistory((history) => [...history, cursor]);
		setCursor(nextCursor);
		setSelectedCandidateTokens({});
		setExpandedMessageId(null);
	};

	const continuePendingQueue = (nextCursor: string) => {
		setPendingCursor(nextCursor);
		setSelectedCandidateTokens({});
		setExpandedMessageId(null);
	};

	const goPrevious = () => {
		const previousCursor = cursorHistory.at(-1);
		if (previousCursor === undefined) return;
		setCursorHistory((history) => history.slice(0, -1));
		setCursor(previousCursor);
		setSelectedCandidateTokens({});
		setExpandedMessageId(null);
	};

	// Sparse server-side filters can produce an empty bounded scan window. Walk
	// it automatically without recording that invisible window in page history.
	useEffect(() => {
		if (
			queriedDetail &&
			queriedDetail.messages.length === 0 &&
			queriedDetail.continueCursor !== null &&
			busy === null
		) {
			setCursor(queriedDetail.continueCursor);
			setSelectedCandidateTokens({});
			setExpandedMessageId(null);
		}
	}, [queriedDetail, busy]);

	const markIntentionalBlank = (
		message: NonNullable<typeof detail>["messages"][number],
	) =>
		run(`blank:${message.messageId}`, async () => {
			if (!activeProposalId) return;
			const reason = (
				blankReasons[message.messageId] ??
				message.candidate?.intentionalBlankReason ??
				message.value?.intentionalBlankReason ??
				""
			).trim();
			if (!reason) {
				throw new Error(
					"Add a reason before marking a value intentionally blank.",
				);
			}
			if (!message.value) {
				await stageForReview({
					projectId: convexProjectId,
					proposalId: convexId<"localeProposals">(activeProposalId),
					items: [
						{
							messageId: message.messageId,
							value: "",
							sourceFingerprint: message.sourceFingerprint,
							intentionalBlankReason: reason,
						},
					],
				});
			}
			if (taskId && message.candidate) {
				await reviewValue(
					message.messageId,
					message.candidate.revisionId,
					{
						kind: "intentionalBlank",
						reason,
					},
					"taskCandidate",
				);
			} else {
				await reviewStagedValue({
					projectId: convexProjectId,
					proposalId: convexId<"localeProposals">(activeProposalId),
					messageId: message.messageId,
					decision: { kind: "intentionalBlank", reason },
				});
			}
			setNotice("Intentional Blank recorded with human review.");
		});

	const finalize = () =>
		run("finalize", async () => {
			if (!activeProposalId) return;
			if (taskId) {
				await finalizeTask({
					taskId: convexId<"agentTranslationProposals">(taskId),
				});
			} else {
				await finalizeForReview({
					projectId: convexProjectId,
					proposalId: convexId<"localeProposals">(activeProposalId),
				});
			}
			setNotice(
				"The reviewed Locale Proposal is ready as an immutable artifact.",
			);
		});

	const downloadArtifact = () =>
		run("download", async () => {
			if (!activeProposalId) return;
			const artifact = await artifactForReview({
				projectId: convexProjectId,
				proposalId: convexId<"localeProposals">(activeProposalId),
			});
			const blob = new Blob([JSON.stringify(artifact, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${detail?.proposal.locale.code ?? "new"}-locale-proposal.json`;
			anchor.click();
			URL.revokeObjectURL(url);
		});

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title={title}
				action={
					<div className="flex flex-wrap items-center gap-2">
						{showTaskNavigation ? (
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
						) : null}
						{reviewState ? (
							<Badge
								variant={
									reviewState.phase === "readyToFinalize"
										? "default"
										: "secondary"
								}
							>
								{reviewState.badgeLabel}
							</Badge>
						) : null}
						{detail?.proposal.status === "ready" ? (
							<Button
								size="sm"
								variant="outline"
								onClick={downloadArtifact}
								disabled={busy !== null}
							>
								<Download data-icon="inline-start" />
								Download artifact
							</Button>
						) : null}
					</div>
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
			{detail?.proposal.status === "ready" &&
			delivery !== undefined &&
			binding !== undefined &&
			(languageIsBound || delivery !== null || detail.isCurrentBaseline) ? (
				<Alert>
					<AlertTitle>
						{languageIsBound
							? "Language is available in Strings"
							: delivery?.status === "observed"
								? "Delivered catalog found in Git"
								: "Ready to deliver"}
					</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						{languageIsBound ? (
							<>
								<p>
									This task is complete. Review current translations and any
									changed source values in Strings.
								</p>
								<Button
									nativeButton={false}
									variant="outline"
									render={
										<Link
											to="/projects/$projectId/strings"
											params={{ projectId }}
										/>
									}
								>
									Open Strings
								</Button>
							</>
						) : delivery?.status === "observed" ? (
							<>
								<p>
									Bind {delivery.localeCode} at {delivery.catalogPath} to add it
									to the current workspace.
								</p>
								<Button
									disabled={
										busy !== null || !locales || project?.role === "viewer"
									}
									onClick={() =>
										void run("bind", async () => {
											const code = delivery.localeCode;
											const existing = locales?.find(
												(locale) =>
													locale.code === code &&
													locale.archivedAt === undefined,
											);
											const localeId =
												existing?._id ??
												(await createLocale({
													projectId: convexProjectId,
													code,
													label: detail.proposal.locale.label,
												}));
											await bindLocale({
												localeId,
												catalogPath: delivery.catalogPath,
											});
											setNotice(
												"The language is bound. Its reviewed translations are available in Strings.",
											);
										})
									}
								>
									{busy === "bind" ? "Binding…" : "Bind language"}
								</Button>
							</>
						) : (
							<>
								<p>
									Run this in your app checkout to create a local review branch.
								</p>
								<code className="max-w-full overflow-x-auto text-xs">
									{blablaCommand(
										`deliver-locale --proposal ${detail.proposal.proposalId}`,
									)}
								</code>
								<p>
									After you push and merge the branch, run{" "}
									<code>{blablaCommand("sync")}</code>. Return here to bind the
									delivered language.
								</p>
							</>
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{detail && reviewState?.phase === "readyToFinalize" ? (
				<Alert className="mb-4 rounded-lg border-primary/40 bg-primary/5 p-4 text-sm">
					<Check aria-hidden className="size-4" />
					<AlertTitle className="text-sm">Review complete</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<span>
							All {detail.proposal.progress.total.toLocaleString()} values are
							reviewed. Finalize the catalog to prepare it for delivery.
						</span>
						<Button
							size="sm"
							className="shrink-0"
							onClick={finalize}
							disabled={
								busy !== null ||
								!reviewState.canFinalize ||
								dirtyItems.length > 0
							}
						>
							<Check data-icon="inline-start" />
							{busy === "finalize"
								? "Finalizing…"
								: dirtyItems.length > 0
									? "Save edits first"
									: "Finalize catalog"}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{!languageIsBound &&
			!delivery &&
			delivery !== undefined &&
			binding !== undefined &&
			(reviewState?.phase === "stale" ||
				reviewState?.phase === "previousSource") ? (
				<Alert className="mb-4">
					<RefreshCw aria-hidden className="size-4" />
					<AlertTitle>Continue on the current source</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<span>
							Keep reviewed values whose source is unchanged. Continue with only
							changed or new source values; this proposal stays available.
							{dirtyItems.length > 0
								? " Copy any unsaved edits you need before discarding them."
								: ""}
						</span>
						<div className="flex shrink-0 flex-wrap gap-2">
							{dirtyItems.length > 0 ? (
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										setDrafts({});
										setBlankReasons({});
									}}
									disabled={busy !== null}
								>
									Discard unsaved edits
								</Button>
							) : null}
							<Button
								size="sm"
								onClick={continueOnCurrentSource}
								disabled={busy !== null || dirtyItems.length > 0}
							>
								<RefreshCw data-icon="inline-start" />
								{busy === "continue-source"
									? "Carrying work forward…"
									: dirtyItems.length > 0
										? "Resolve unsaved edits"
										: "Continue on current source"}
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{taskId && detail && detail.pendingReview.count > 0 ? (
				<Alert className="mb-4">
					<TriangleAlert aria-hidden className="size-4" />
					<AlertTitle>
						{detail.pendingReview.count}
						{detail.pendingReview.hasMore ? "+" : ""} earlier agent value
						{detail.pendingReview.count === 1 ? " needs" : "s need"} review
					</AlertTitle>
					<AlertDescription>
						Review these values before finalizing the catalog.
					</AlertDescription>
				</Alert>
			) : null}
			{initialProposalId === undefined &&
			currentProposalId === undefined &&
			proposalId === null ? (
				<Skeleton className="h-48 w-full" />
			) : !activeProposalId ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Languages />
						</EmptyMedia>
						<EmptyTitle>Prepare a language</EmptyTitle>
						<EmptyDescription>
							Start from the accepted source, then translate here or ask an
							agent.
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => void prepare()} disabled={busy !== null}>
						<Sparkles data-icon="inline-start" />
						Prepare proposal
					</Button>
				</Empty>
			) : detail === undefined ? (
				<Skeleton className="h-64 w-full" />
			) : detail === null ? (
				<Alert variant="destructive">
					<AlertDescription>Language proposal not found.</AlertDescription>
				</Alert>
			) : (
				<div className="flex flex-col gap-4">
					<Card>
						<CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div>
								<CardTitle className="text-base">
									{detail.proposal.locale.label} ·{" "}
									{detail.proposal.locale.runtimeLocale}
								</CardTitle>
								<p className="mt-1 text-muted-foreground text-sm">
									Source commit{" "}
									<code title={detail.proposal.sourceSnapshot.commit}>
										{detail.proposal.sourceSnapshot.commit.slice(0, 12)}
									</code>
								</p>
							</div>
							{taskId ? null : (
								<div className="flex flex-wrap gap-2">
									<Button
										size="sm"
										onClick={saveVisible}
										disabled={
											busy !== null ||
											dirtyItems.length === 0 ||
											proposalReadOnly
										}
									>
										<Save data-icon="inline-start" />
										Save visible edits
										{dirtyItems.length ? ` (${dirtyItems.length})` : ""}
									</Button>
								</div>
							)}
						</CardHeader>
						<CardContent className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
							<div className="bg-background p-3">
								<p className="text-muted-foreground text-xs">
									Agent candidates received
								</p>
								<p className="mt-1 font-medium text-lg tabular-nums">
									{detail.task
										? detail.task.candidateCount.toLocaleString()
										: detail.proposal.progress.staged}
								</p>
							</div>
							<div className="bg-background p-3">
								<p className="text-muted-foreground text-xs">
									Applied to locale draft
								</p>
								<p className="mt-1 font-medium text-lg tabular-nums">
									{detail.proposal.progress.staged} /{" "}
									{detail.proposal.progress.total}
								</p>
							</div>
							<div className="bg-background p-3">
								<p className="text-muted-foreground text-xs">Review queue</p>
								<p className="mt-1 font-medium text-lg tabular-nums">
									{detail.messages.length === 0
										? reviewState?.phase === "readyToFinalize"
											? "Clear"
											: "No matches"
										: `${detail.messages.length} value${detail.messages.length === 1 ? "" : "s"}`}
								</p>
							</div>
						</CardContent>
					</Card>

					<Card size="sm">
						<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
							<div className="relative min-w-0 flex-1">
								<Search
									aria-hidden
									className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								/>
								<Input
									aria-label="Search review values"
									placeholder="Search key, source, or candidate"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									className="pl-9"
								/>
							</div>
							<label className="flex items-center gap-2 text-muted-foreground text-xs">
								Show
								<select
									aria-label="Review focus"
									value={focus}
									onChange={(event) =>
										setFocus(event.currentTarget.value as ReviewFocus)
									}
									className="h-9 rounded-md border bg-background px-3 text-foreground text-sm"
								>
									<option value="awaiting">Awaiting review</option>
									<option value="attention">Needs attention</option>
									<option value="routine">Routine candidates</option>
									<option value="reviewed">Reviewed</option>
									<option value="missing">Missing candidates</option>
									<option value="all">Everything</option>
								</select>
							</label>
							<div className="flex flex-wrap items-center gap-2">
								{queueIsLoading ? (
									<span
										className="text-muted-foreground text-xs"
										aria-live="polite"
									>
										Loading next review items…
									</span>
								) : null}
								<Button
									size="sm"
									variant="outline"
									onClick={selectRoutinePage}
									disabled={
										busy !== null ||
										queueIsLoading ||
										proposalReadOnly ||
										routineAgentCandidates.length === 0
									}
								>
									Select routine ({routineAgentCandidates.length})
								</Button>
								<Button
									size="sm"
									onClick={acceptSelectedAgentCandidates}
									disabled={
										busy !== null ||
										queueIsLoading ||
										selectedAgentCandidates.length === 0 ||
										proposalReadOnly
									}
								>
									<Check data-icon="inline-start" />
									Approve selected ({selectedAgentCandidates.length})
								</Button>
							</div>
						</CardContent>
					</Card>

					<div
						className={`overflow-hidden rounded-lg border bg-background transition-opacity ${queueIsLoading ? "opacity-60" : ""}`}
						aria-busy={queueIsLoading}
					>
						{detail.messages.map((message) => {
							const candidateValue =
								message.candidate?.value ?? message.value?.value ?? "";
							const savedValue =
								message.candidate?.review?.finalValue ??
								message.review?.finalValue ??
								(message.facts.state === "reviewedDraft"
									? message.value?.value
									: candidateValue) ??
								"";
							const draft = drafts[message.messageId] ?? savedValue;
							const reviewed = message.facts.state === "reviewed";
							const reviewToken =
								message.candidate?.revisionId ??
								(message.value?.updatedBy.kind === "agent"
									? message.value.reviewToken
									: undefined);
							const reviewKind = message.candidate
								? "taskCandidate"
								: "stagedValue";
							const selectable = selectableAgentCandidates.some(
								(candidate) => candidate.messageId === message.messageId,
							);
							const expanded = expandedMessageId === message.messageId;
							return (
								<div
									key={message.messageId}
									className="border-b last:border-b-0"
								>
									<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-3">
										<Checkbox
											aria-label={`Select ${message.messageId}`}
											checked={
												reviewToken !== undefined &&
												selectedCandidateTokens[message.messageId] ===
													reviewToken
											}
											disabled={
												!selectable ||
												busy !== null ||
												queueIsLoading ||
												proposalReadOnly
											}
											onCheckedChange={(checked) =>
												setSelectedCandidateTokens((current) => {
													const next = { ...current };
													if (checked === true && reviewToken) {
														next[message.messageId] = reviewToken;
													} else {
														delete next[message.messageId];
													}
													return next;
												})
											}
										/>
										<button
											type="button"
											className="min-w-0 text-left"
											disabled={queueIsLoading}
											onClick={() =>
												setExpandedMessageId(
													expanded ? null : message.messageId,
												)
											}
											aria-expanded={expanded}
										>
											<div className="flex flex-wrap items-center gap-2">
												<code className="truncate text-sm">
													{message.messageId}
												</code>
												<Badge variant={reviewed ? "default" : "secondary"}>
													{message.facts.state === "reviewedDraft"
														? "reviewed draft"
														: message.facts.state === "needsEdit"
															? "needs replacement"
															: message.facts.state}
												</Badge>
												{message.facts.sourceIdentical ? (
													<Badge variant="outline">Matches source</Badge>
												) : null}
												{message.facts.icu ? (
													<Badge variant="outline">ICU</Badge>
												) : null}
												{message.facts.blankCandidate ? (
													<Badge variant="outline">blank candidate</Badge>
												) : null}
												{message.facts.sourceEmpty ? (
													<Badge variant="outline">Empty source</Badge>
												) : null}
												{message.facts.edgeWhitespaceMismatch ? (
													<Badge variant="outline">edge whitespace</Badge>
												) : null}
												{message.facts.staleSource ? (
													<Badge
														variant={
															message.candidate?.review?.reviewBasisIsCurrent
																? "outline"
																: "destructive"
														}
													>
														{message.candidate?.review?.reviewBasisIsCurrent
															? "Earlier source"
															: "Source changed"}
													</Badge>
												) : null}
											</div>
											<div className="mt-2 grid gap-2 text-sm md:grid-cols-2">
												<p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">
													{message.sourceValue || "Empty source value"}
												</p>
												<p className="line-clamp-2 whitespace-pre-wrap">
													{savedValue || "No candidate value"}
												</p>
											</div>
										</button>
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label={`${expanded ? "Collapse" : "Expand"} ${message.messageId}`}
											onClick={() =>
												setExpandedMessageId(
													expanded ? null : message.messageId,
												)
											}
											disabled={queueIsLoading}
										>
											<ChevronDown
												aria-hidden
												className={
													expanded
														? "rotate-180 transition-transform"
														: "transition-transform"
												}
											/>
										</Button>
									</div>
									{expanded ? (
										<div className="grid gap-4 border-t bg-muted/10 p-4 md:grid-cols-2">
											<div className="rounded-md border bg-muted/20 p-3">
												<div className="mb-1 flex items-center gap-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
													Source
													{message.sourceIcuType === "icu" ? (
														<Badge variant="outline">ICU</Badge>
													) : null}
												</div>
												<p className="whitespace-pre-wrap text-sm">
													{message.sourceValue}
												</p>
												<WhitespaceFacts value={message.sourceValue} />
											</div>
											<div className="flex flex-col gap-2">
												<div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
													Translation review value
												</div>
												<TranslationReviewEditor.Provider
													state={{
														draftValue: draft,
														savedValue,
														phase:
															message.facts.state === "awaiting" ||
															(message.facts.staleSource &&
																!message.candidate?.review
																	?.reviewBasisIsCurrent)
																? "needsReview"
																: "saved",
														disabled:
															proposalReadOnly ||
															queueIsLoading ||
															busy !== null,
														isSaving: busy === `review:${message.messageId}`,
													}}
													actions={{
														update: (value) =>
															setDrafts((previous) => ({
																...previous,
																[message.messageId]: value,
															})),
														save: () =>
															void saveMessageReview(
																message,
																draft,
																reviewToken,
																reviewKind,
															),
													}}
													meta={{
														messageId: message.messageId,
														localeId: activeProposalId,
														localeCode: detail.locale.runtimeLocale,
														sourceValue: message.sourceValue,
													}}
												>
													<TranslationReviewEditor.Field />
													<TranslationReviewEditor.Status />
													<TranslationReviewEditor.Actions>
														<TranslationReviewEditor.SaveReview />
														<TranslationReviewEditor.RevertChanges />
													</TranslationReviewEditor.Actions>
												</TranslationReviewEditor.Provider>
												<AgentReviewEvidence
													reviewer={
														message.candidate?.review?.reviewer ??
														message.review?.reviewer
													}
													authorization={
														message.candidate?.review?.reviewAuthorization ??
														message.review?.reviewAuthorization
													}
													tokens={reviewerTokens}
												/>
												{message.candidate && !message.candidate.review ? (
													<CandidateReviewDelegation
														revisionId={message.candidate.revisionId}
														reviewUrl={candidateReviewUrl(
															env.VITE_CONVEX_SITE_URL,
															message.candidate.revisionId,
														)}
														disabled={
															proposalReadOnly ||
															queueIsLoading ||
															busy !== null ||
															draft !== savedValue ||
															(blankReasons[message.messageId] !== undefined &&
																blankReasons[message.messageId] !==
																	(message.candidate.intentionalBlankReason ??
																		"")) ||
															message.facts.staleSource
														}
													/>
												) : null}
												<div className="flex flex-col gap-2">
													{canRecordIntentionalBlank(draft) ? (
														<div className="flex flex-col gap-2 sm:flex-row">
															<Input
																aria-label={`Reason for intentionally blank ${message.messageId}`}
																placeholder="Reason for an intentional blank"
																value={
																	blankReasons[message.messageId] ??
																	message.candidate?.intentionalBlankReason ??
																	message.value?.intentionalBlankReason ??
																	""
																}
																onChange={(event) =>
																	setBlankReasons((previous) => ({
																		...previous,
																		[message.messageId]: event.target.value,
																	}))
																}
																disabled={proposalReadOnly}
															/>
															<Button
																size="sm"
																variant="outline"
																onClick={() =>
																	void markIntentionalBlank(message)
																}
																disabled={
																	busy !== null ||
																	reviewed ||
																	message.facts.staleSource ||
																	proposalReadOnly ||
																	!(
																		blankReasons[message.messageId] ??
																		message.candidate?.intentionalBlankReason ??
																		message.value?.intentionalBlankReason ??
																		""
																	).trim()
																}
															>
																Mark intentional blank
															</Button>
														</div>
													) : null}
													{reviewToken && message.facts.state === "awaiting" ? (
														<div className="flex flex-wrap gap-2">
															<Button
																size="sm"
																variant="outline"
																onClick={() =>
																	void decide(
																		message.messageId,
																		reviewToken,
																		{
																			kind: "reject",
																		},
																		reviewKind,
																	)
																}
																disabled={
																	busy !== null ||
																	reviewed ||
																	message.facts.staleSource ||
																	proposalReadOnly
																}
															>
																<X data-icon="inline-start" /> Reject
															</Button>
														</div>
													) : null}
													{message.facts.state === "needsEdit" ? (
														<p className="flex items-center gap-2 text-muted-foreground text-xs">
															<TriangleAlert aria-hidden className="size-4" />
															This candidate was rejected. Replace it above,
															then save the review.
														</p>
													) : null}
												</div>
												{message.facts.staleSource ? (
													<p
														className={`flex items-center gap-2 text-xs ${
															message.candidate?.review?.reviewBasisIsCurrent
																? "text-muted-foreground"
																: "text-destructive"
														}`}
													>
														<TriangleAlert aria-hidden className="size-4" />
														{message.candidate?.review?.reviewBasisIsCurrent
															? "This candidate predates the source change; your saved review is current."
															: "The source changed. Check this value before saving the review."}
													</p>
												) : null}
											</div>
										</div>
									) : null}
								</div>
							);
						})}
						{detail.messages.length === 0 && detail.continueCursor === null ? (
							<div className="px-4 py-12 text-center">
								<p className="font-medium text-sm">
									{showWorkflowEmptyState && reviewState
										? reviewState.emptyTitle
										: "No values match this view"}
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									{showWorkflowEmptyState && reviewState
										? reviewState.emptyDescription
										: "Try another review focus or clear the search."}
								</p>
							</div>
						) : null}
					</div>
					{continuousReviewQueue ? (
						(detail.pendingQueueContinueCursor !== null ||
							detail.continueCursor !== null) &&
						detail.messages.length > 0 ? (
							<div className="flex items-center justify-end gap-3">
								<span className="text-muted-foreground text-xs">
									More values load as you review.
								</span>
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										if (detail.pendingQueueContinueCursor !== null) {
											continuePendingQueue(detail.pendingQueueContinueCursor);
										} else if (detail.continueCursor !== null) {
											goNext(detail.continueCursor);
										}
									}}
									disabled={busy !== null || queueIsLoading}
								>
									Show next review items
								</Button>
							</div>
						) : null
					) : detail.messages.length > 0 || cursorHistory.length > 0 ? (
						<div className="flex items-center justify-between">
							<Button
								size="sm"
								variant="outline"
								onClick={goPrevious}
								disabled={cursorHistory.length === 0 || busy !== null}
							>
								Previous
							</Button>
							<span className="text-muted-foreground text-xs">
								{detail.messages.length} matching value
								{detail.messages.length === 1 ? "" : "s"} in Catalog positions{" "}
								{cursor + 1}–{detail.windowEnd + 1}
							</span>
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									detail.continueCursor === null
										? undefined
										: goNext(detail.continueCursor)
								}
								disabled={detail.continueCursor === null || busy !== null}
							>
								Next
							</Button>
						</div>
					) : null}
				</div>
			)}
		</ProjectShell>
	);
}
