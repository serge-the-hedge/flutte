import { Button } from "@blabla/ui/components/button";
import { Card, CardContent } from "@blabla/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { AlertTriangle, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LocaleSelector } from "@/components/localization/locale-selector";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { ReleaseChanges } from "@/components/localization/release-changes";
import { ReleasePreparationScope } from "@/components/localization/release-preparation-scope";
import {
	PreparingCard,
	ReleaseDeliveryHandoff,
	ReleaseDeliveryScope,
	ReleaseRecordView,
} from "@/components/localization/release-record-view";
import { RepositoryProjectOnly } from "@/components/localization/repository-project-only";
import { api, convexId } from "@/lib/convex-api";
import {
	type ReleasePreparationSelection,
	releaseSelectionFromRecord,
	releaseSelectionFromSearch,
	releaseSelectionInvalid,
} from "@/lib/release-selection";

export const Route = createFileRoute("/projects/$projectId/release")({
	validateSearch: (
		search: Record<string, unknown>,
	): { selectedMessages?: string[]; excludedMessages?: string[] } => {
		const selection = releaseSelectionFromSearch(search);
		return {
			selectedMessages:
				selection?.mode === "selected"
					? selection.selectedMessageIds
					: undefined,
			excludedMessages:
				selection?.mode === "all" ? selection.excludedMessageIds : undefined,
		};
	},
	component: ReleaseRoute,
});

function ReleaseRoute() {
	const { projectId } = Route.useParams();
	return (
		<RepositoryProjectOnly projectId={projectId}>
			<RepositoryReleaseRoute key={projectId} />
		</RepositoryProjectOnly>
	);
}

function RepositoryReleaseRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/release" });
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	const release = useQuery(api.releaseRecords.current, {
		projectId: convexId<"projects">(projectId),
	});
	const prepare = useMutation(api.releaseRecords.prepare);
	const buildRelease = useMutation(api.releaseBundles.build);
	const [starting, setStarting] = useState(false);
	const [building, setBuilding] = useState(false);
	const record = release?.kind === "available" ? release.current : null;
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const selection =
		releaseSelectionFromSearch(search) ?? releaseSelectionFromRecord(record);
	const scopeInvalid = releaseSelectionInvalid(selection);
	const changeSelection = (next: ReleasePreparationSelection) => {
		void navigate({
			search: {
				selectedMessages:
					next.mode === "selected" ? next.selectedMessageIds : undefined,
				excludedMessages:
					next.mode === "all" ? next.excludedMessageIds : undefined,
			},
			replace: true,
		});
	};
	const scopeChanged =
		JSON.stringify(selection) !==
		JSON.stringify(releaseSelectionFromRecord(record));
	const bundle = useQuery(
		api.releaseBundles.forRecord,
		record?.status === "ready" ? { recordId: record.recordId } : "skip",
	);
	const introductions = useQuery(api.localeIntroductionTargets.list, {
		projectId: convexId<"projects">(projectId),
	});
	const [deliveryLocale, setDeliveryLocale] = useState<string | null>(null);
	const queriedLocaleProposal = useQuery(
		api.releaseBundles.readyLocaleProposalForRecord,
		record?.status === "ready" && deliveryLocale
			? { recordId: record.recordId, localeCode: deliveryLocale }
			: "skip",
	);
	const readyLocaleProposal = deliveryLocale ? queriedLocaleProposal : null;
	const history = useQuery(
		api.releaseRecords.history,
		release?.kind === "available" && record
			? {
					projectId: convexId<"projects">(projectId),
					paginationOpts: { cursor: release.historyCursor, numItems: 7 },
				}
			: "skip",
	);
	const evidence = usePaginatedQuery(
		api.releaseRecords.evidence,
		record?.status === "ready" ? { recordId: record.recordId } : "skip",
		{ initialNumItems: 50 },
	);

	const start = async (scope: ReleasePreparationSelection = selection) => {
		if (releaseSelectionInvalid(scope)) return;
		setStarting(true);
		try {
			await prepare({
				projectId: convexId<"projects">(projectId),
				...(scope.mode === "selected"
					? { selectedMessageIds: scope.selectedMessageIds }
					: { excludedMessageIds: scope.excludedMessageIds }),
			});
			changeSelection(scope);
			toast.success("Release assessment started.");
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Could not prepare the Release Record.",
			);
		} finally {
			setStarting(false);
		}
	};
	const build = async () => {
		if (!record) return;
		setBuilding(true);
		try {
			await buildRelease({ recordId: record.recordId });
			toast.success("Release Bundle construction started.");
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Could not build the Release Bundle.",
			);
		} finally {
			setBuilding(false);
		}
	};

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader title="Release" />
			{release?.kind === "available" && release.canPrepare ? (
				<ReleasePreparationScope
					selection={selection}
					onChange={changeSelection}
					onPrepare={() => void start()}
					preparing={starting || record?.status === "preparing"}
				/>
			) : null}
			{record?.status === "ready" &&
			release?.kind === "available" &&
			!release.basisCurrent ? (
				<div className="flex max-w-3xl flex-wrap items-center gap-3">
					<p role="status" className="text-muted-foreground text-sm">
						The workspace changed. This report shows the earlier assessment.
					</p>
					{release.canPrepare ? (
						<Button
							size="sm"
							variant="outline"
							disabled={starting}
							onClick={() => void start(releaseSelectionFromRecord(record))}
						>
							Refresh this report’s selection
						</Button>
					) : null}
				</div>
			) : null}
			{record?.status === "ready" &&
			introductions &&
			introductions.length > 0 ? (
				<div className="flex flex-col gap-2">
					<p className="text-muted-foreground text-sm">
						Include a new language (optional)
					</p>
					<LocaleSelector
						locales={introductions.map((target) => ({
							code: target.localeCode,
							label: target.label,
						}))}
						value={deliveryLocale}
						onChange={setDeliveryLocale}
						placeholder="Choose a new language to deliver"
					/>
					{deliveryLocale && readyLocaleProposal === null ? (
						<p className="text-muted-foreground text-sm">
							Finish this language’s translation task on the release’s source
							first.
						</p>
					) : null}
				</div>
			) : null}
			{release === undefined ? (
				<div className="flex max-w-3xl flex-col gap-3">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			) : release.kind === "noBaseline" ? (
				<Empty className="max-w-3xl border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<GitCommitHorizontal aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>Sync your source first</EmptyTitle>
						<EmptyDescription>
							Sync the checkout before preparing a release.
						</EmptyDescription>
						<Button
							nativeButton={false}
							render={
								<Link to="/projects/$projectId/sync" params={{ projectId }} />
							}
						>
							Open Sync
						</Button>
					</EmptyHeader>
				</Empty>
			) : record?.status === "preparing" ? (
				<PreparingCard record={record} />
			) : record?.status === "ready" ? (
				<ReleaseRecordView
					record={record}
					history={history?.records}
					evidence={evidence.results}
					evidenceStatus={evidence.status}
					onLoadMoreEvidence={() => evidence.loadMore(50)}
					changes={
						<ReleaseChanges
							key={record.recordId}
							record={record}
							projectId={projectId}
							prepareAction={
								release.canPrepare && release.basisCurrent ? (
									<Button
										size="sm"
										variant="outline"
										disabled={starting || scopeInvalid}
										onClick={() => void start()}
									>
										Prepare current release
									</Button>
								) : undefined
							}
						/>
					}
					workAction={
						<Button
							nativeButton={false}
							size="sm"
							render={
								<Link
									to="/projects/$projectId/strings"
									params={{ projectId }}
									search={{ release: record.recordId }}
								/>
							}
						>
							Work through in Strings
						</Button>
					}
					releaseAction={
						scopeChanged ? (
							<p className="text-muted-foreground text-xs">
								Prepare this selection to update the report before building or
								delivering.
							</p>
						) : !release.basisCurrent ? null : readyLocaleProposal ===
							undefined ? (
							<Skeleton className="h-12 w-full max-w-xl" />
						) : bundle?.status === "ready" ? (
							<ReleaseDeliveryHandoff
								recordId={record.recordId}
								changeKeyCount={bundle.changeKeyCount ?? 0}
								changedValueCount={record.changedValueCount}
								localeProposal={readyLocaleProposal}
							/>
						) : (
							<div className="flex flex-col gap-3">
								{record.changedKeyCount !== undefined ? (
									<ReleaseDeliveryScope
										changeKeyCount={record.changedKeyCount}
										changedValueCount={record.changedValueCount}
										localeProposal={readyLocaleProposal}
									/>
								) : null}
								<div className="flex flex-col items-start gap-1.5">
									<Button
										size="sm"
										disabled={
											building ||
											bundle === undefined ||
											bundle?.status === "building"
										}
										onClick={build}
									>
										{building || bundle?.status === "building" ? (
											<LoaderCircle
												aria-hidden="true"
												className="animate-spin"
											/>
										) : null}
										{bundle?.status === "failed"
											? "Retry build"
											: "Build release"}
									</Button>
									{bundle?.failure ? (
										<p className="text-destructive text-xs">
											{bundle.failure.message}
										</p>
									) : null}
								</div>
							</div>
						)
					}
				/>
			) : (
				<Card size="sm" className="max-w-3xl">
					<CardContent className="flex flex-col gap-3">
						<div className="flex items-start gap-2">
							<AlertTriangle
								aria-hidden="true"
								className="mt-0.5 size-4 text-muted-foreground"
							/>
							<div className="flex flex-col gap-0.5">
								<span className="font-medium text-sm">
									{record?.status === "failed"
										? "Release assessment stopped"
										: record
											? "The workspace changed"
											: "Prepare a release"}
								</span>
								<p className="text-muted-foreground text-xs">
									{record?.failure?.message ??
										"Check the current source and translations before release."}
								</p>
							</div>
						</div>
						{release.canPrepare ? (
							<div>
								<Button
									size="sm"
									disabled={starting || scopeInvalid}
									onClick={() => void start()}
								>
									{starting ? (
										<LoaderCircle aria-hidden="true" className="animate-spin" />
									) : null}
									Prepare current release
								</Button>
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								An editor must finish preparing the catalog in Strings first.
							</p>
						)}
					</CardContent>
				</Card>
			)}
		</ProjectShell>
	);
}
