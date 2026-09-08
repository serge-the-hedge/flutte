import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import { Card, CardContent } from "@blabla/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Skeleton } from "@blabla/ui/components/skeleton";
import {
	createFileRoute,
	Link,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowRight, Bot, KeyRound, Languages, PenLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LocaleSelector } from "@/components/localization/locale-selector";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/proposals/")({
	component: ProposalsIndexRoute,
});

function ProposalsIndexRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/proposals/" });
	const convexProjectId = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: convexProjectId });
	const createTask = useMutation(api.agentTranslationProposals.createTask);
	const navigate = useNavigate();
	const [isStartingLocale, setIsStartingLocale] = useState(false);
	const targets = useQuery(api.localeIntroductionTargets.list, {
		projectId: convexProjectId,
	});
	const locales = useQuery(api.locales.list, { projectId: convexProjectId });
	const [localeCode, setLocaleCode] = useState<string | null>(null);
	const [filterCode, setFilterCode] = useState<string | null>(null);
	const page = usePaginatedQuery(
		api.agentTranslationProposals.listForReview,
		{
			projectId: convexProjectId,
			...(filterCode ? { localeCode: filterCode } : {}),
		},
		{ initialNumItems: 25 },
	);
	const availableTargets = (targets ?? []).filter(
		(target) =>
			!(locales ?? []).some(
				(locale) =>
					locale.code === target.localeCode && locale.archivedAt === undefined,
			),
	);
	const filterLocales = new Map(
		(locales ?? []).map((locale) => [
			locale.code,
			{ code: locale.code, label: locale.label },
		]),
	);
	for (const target of targets ?? [])
		filterLocales.set(target.localeCode, {
			code: target.localeCode,
			label: target.label,
		});
	const prepareLocale = async () => {
		if (isStartingLocale || !localeCode) return;
		setIsStartingLocale(true);
		try {
			const task = await createTask({
				projectId: convexProjectId,
				title: `${localeCode} · complete catalog`,
				target: { kind: "newLocale", localeCode },
				scope: { kind: "completeCatalog" },
			});
			await navigate({
				to: "/projects/$projectId/proposals/$proposalId",
				params: { projectId, proposalId: task.taskId },
			});
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Could not prepare the translation task.",
			);
		} finally {
			setIsStartingLocale(false);
		}
	};

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title="Translation tasks"
				action={
					<Badge variant="secondary">
						{page.results.length} loaded task
						{page.results.length === 1 ? "" : "s"}
					</Badge>
				}
			/>
			<Card size="sm">
				<CardContent className="flex flex-col gap-3 py-4">
					<div>
						<p className="font-medium text-sm">Start a translation</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							nativeButton={false}
							size="sm"
							variant="outline"
							render={
								<Link
									to="/projects/$projectId/strings"
									params={{ projectId }}
								/>
							}
						>
							<PenLine data-icon="inline-start" />
							Select current values
						</Button>
						<LocaleSelector
							locales={availableTargets.map((target) => ({
								code: target.localeCode,
								label: target.label,
							}))}
							value={localeCode}
							onChange={setLocaleCode}
							disabled={isStartingLocale}
						/>
						<Button
							nativeButton={false}
							size="sm"
							variant="outline"
							render={
								<Link
									to="/projects/$projectId/settings/languages"
									params={{ projectId }}
								/>
							}
						>
							Configure languages
						</Button>
						<Button
							size="sm"
							onClick={() => void prepareLocale()}
							disabled={
								isStartingLocale || !localeCode || project?.role === "viewer"
							}
						>
							<Languages data-icon="inline-start" />
							{isStartingLocale ? "Preparing…" : "Prepare language"}
						</Button>
						<Button
							nativeButton={false}
							size="sm"
							variant="ghost"
							render={
								<Link
									to="/projects/$projectId/settings/api-tokens"
									params={{ projectId }}
								/>
							}
						>
							Ask an agent <ArrowRight data-icon="inline-end" />
						</Button>
					</div>
				</CardContent>
			</Card>
			<LocaleSelector
				locales={[...filterLocales.values()]}
				value={filterCode}
				onChange={setFilterCode}
				placeholder="Filter tasks by language"
			/>
			{page.status === "LoadingFirstPage" ? (
				<div
					className="flex flex-col gap-3"
					role="status"
					aria-label="Loading tasks"
				>
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
			) : page.results.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Bot />
						</EmptyMedia>
						<EmptyTitle>
							{filterCode
								? "No matching tasks in the loaded history"
								: "No translation tasks yet"}
						</EmptyTitle>
						<EmptyDescription>
							Select strings and a language in Strings to start a task.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							nativeButton={false}
							variant="outline"
							render={
								<Link
									to="/projects/$projectId/settings/api-tokens"
									params={{ projectId }}
								/>
							}
						>
							<KeyRound data-icon="inline-start" />
							Create API token
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<Card size="sm">
					<CardContent className="divide-y">
						{page.results.map((proposal) => (
							<div
								key={proposal._id}
								className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-3 first:pt-0 last:pb-0"
							>
								<span
									aria-hidden
									className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground"
								>
									<Bot className="size-4" />
								</span>
								<div className="flex min-w-0 flex-col gap-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium text-sm">
											{proposal.clientProposalKey}
										</span>
										<Badge variant="secondary">{proposal.status}</Badge>
									</div>
									<div className="text-muted-foreground text-xs">
										{proposal.localeProposalTaskScope
											? `${proposal.localeProposalTaskScope.localeCode} · new language · ${proposal.candidateCount} of ${proposal.localeProposalTaskScope.targetCount} candidates`
											: proposal.taskScope
												? `${proposal.taskScope.localeCode} · ${proposal.candidateCount} of ${proposal.taskScope.targetCount} candidates`
												: `${proposal.candidateCount} target${proposal.candidateCount === 1 ? "" : "s"}`}
										{proposal.localeProposalTaskScope ? null : (
											<>
												{" "}
												· {proposal.revisionCount} revision
												{proposal.revisionCount === 1 ? "" : "s"} ·{" "}
												{proposal.target.kind}
											</>
										)}
									</div>
								</div>
								<Button
									nativeButton={false}
									size="sm"
									variant="outline"
									render={
										<Link
											to="/projects/$projectId/proposals/$proposalId"
											params={{ projectId, proposalId: proposal._id }}
										/>
									}
								>
									Review
								</Button>
							</div>
						))}
					</CardContent>
				</Card>
			)}
			{page.status === "CanLoadMore" || page.status === "LoadingMore" ? (
				<Button
					variant="outline"
					disabled={page.status === "LoadingMore"}
					onClick={() => page.loadMore(25)}
				>
					{page.status === "LoadingMore" ? "Loading…" : "Load more tasks"}
				</Button>
			) : null}
		</ProjectShell>
	);
}
