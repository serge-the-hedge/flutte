import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	createFileRoute,
	Link,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { RepositoryAdvancedValue } from "@/components/localization/advanced-string-values";
import { RepositoryCharacterLimit } from "@/components/localization/character-limit";
import { DiscoveredCatalogNotice } from "@/components/localization/discovered-catalogs";
import { LegacyContentLink } from "@/components/localization/legacy-content-projects";
import { ManagedStrings } from "@/components/localization/managed-strings";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { StringSelectionTools } from "@/components/localization/string-selection-tools";
import {
	StringTagFilter,
	StringTags,
} from "@/components/localization/string-tags";
import { StringsCatalogView } from "@/components/localization/strings-catalog-view";
import { StringsLanguageSelector } from "@/components/localization/strings-language-selector";
import { StringsPagination } from "@/components/localization/strings-pagination";
import { StringsSnapshotSelector } from "@/components/localization/strings-snapshot-selector";
import { api, convexId } from "@/lib/convex-api";
import {
	type CatalogWorkspaceCommit,
	readStringsCatalogKey,
	type StringsCatalogKey,
} from "@/lib/strings-catalog";
import type {
	CatalogValueScope,
	StringsCatalogNavigationState,
} from "@/lib/strings-catalog-navigation";
import { stringsLanguagesFromSearch } from "@/lib/strings-languages";
import { matchingRepositoryKeys } from "@/lib/strings-matching-keys";
import {
	previousStringsPages,
	type StringsPageHistory,
} from "@/lib/strings-page-history";
import type { StringsSearch } from "@/lib/strings-search";
import {
	createStringsWindowCardCache,
	type StringsWindowCards,
	sameStringsWindowMessageIds,
	stringsWindowKeyCap,
	updateStringsWindowCardCache,
} from "@/lib/strings-window";
import { useCatalogBrowsePage } from "@/lib/use-catalog-browse-page";
import { useCatalogNavigationGuard } from "@/lib/use-catalog-navigation-guard";
import { useCatalogScopeCounts } from "@/lib/use-catalog-scope-counts";
import { useCatalogWindow } from "@/lib/use-catalog-window";
import { useSnapshotOriginIndex } from "@/lib/use-snapshot-origin-index";

const EMPTY_STRINGS_WINDOW_CARDS: StringsWindowCards = new Map();
const EMPTY_STRINGS_WINDOW_MESSAGE_IDS: string[] = [];

function isCatalogValueScope(value: unknown): value is CatalogValueScope {
	return (
		value === "waiting" ||
		value === "unconfirmedImport" ||
		value === "stale" ||
		value === "introduced"
	);
}

export const Route = createFileRoute("/projects/$projectId/strings")({
	validateSearch: (search: Record<string, unknown>): StringsSearch => ({
		collection:
			typeof search.collection === "string" && search.collection !== "app"
				? search.collection
				: undefined,
		cursor: typeof search.cursor === "string" ? search.cursor : undefined,
		locales: stringsLanguagesFromSearch(search),
		tags:
			Array.isArray(search.tags) &&
			search.tags.every((id) => typeof id === "string")
				? [...new Set(search.tags as string[])].sort()
				: undefined,
		snapshots:
			search.snapshots === "unknown"
				? "unknown"
				: Array.isArray(search.snapshots) &&
						search.snapshots.length > 0 &&
						search.snapshots.every((id) => typeof id === "string")
					? [...new Set(search.snapshots as string[])].sort()
					: undefined,
		after:
			Number.isSafeInteger(Number(search.after)) && Number(search.after) >= -1
				? Number(search.after)
				: undefined,
		q: typeof search.q === "string" ? search.q : undefined,
		key: typeof search.key === "string" ? search.key : undefined,
		scope: isCatalogValueScope(search.scope) ? search.scope : undefined,
		release: typeof search.release === "string" ? search.release : undefined,
	}),
	component: StringsRoute,
});

function StringsRoute() {
	const { projectId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			{search.collection ? (
				<LegacyContentLink
					projectId={projectId}
					collectionId={search.collection}
					search={search}
				/>
			) : !project ? (
				<p role="status">Loading project…</p>
			) : project.migrationPending ? (
				<p role="status" className="text-muted-foreground text-sm">
					Moving content into this project. Strings will be available when the
					move finishes.
				</p>
			) : project.type === "basic" ? (
				project.managedCollectionId ? (
					<ManagedStrings
						key={projectId}
						projectId={projectId}
						collectionId={project.managedCollectionId}
						search={search}
						onSearch={(next) => {
							void navigate({ search: next });
						}}
					/>
				) : (
					<p role="alert">
						This project’s content is unavailable. Reload to try again.
					</p>
				)
			) : (
				<>
					<DiscoveredCatalogNotice projectId={projectId} />
					<RepositoryStrings />
				</>
			)}
		</ProjectShell>
	);
}

function RepositoryStrings() {
	const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
	const convex = useConvex();
	const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
	const [detailsDirty, setDetailsDirty] = useState(false);
	const [detailsBusy, setDetailsBusy] = useState(false);
	useCatalogNavigationGuard(hasUnsavedWork || detailsDirty);
	const { projectId } = useParams({ from: "/projects/$projectId/strings" });
	const search = useSearch({ from: "/projects/$projectId/strings" });
	const navigate = useNavigate({ from: "/projects/$projectId/strings" });
	const convexProjectId = convexId<"projects">(projectId);
	const locales = useQuery(api.locales.list, { projectId: convexProjectId });
	const tagOptions = useQuery(api.messageTags.list, {
		projectId: convexProjectId,
	});
	const targets = (locales ?? []).filter(
		(locale) =>
			!locale.isSource && locale.archivedAt === undefined && locale.catalogPath,
	);
	const selectedLocales =
		search.locales === undefined
			? targets
			: targets.filter((locale) => search.locales?.includes(locale.code));
	const selectedLocaleIds = selectedLocales.map((locale) => locale._id);
	const selectionKey = JSON.stringify(search.locales ?? "all");
	const overview = useQuery(api.catalogBrowse.overview, {
		projectId: convexProjectId,
	});
	const snapshotIndex = useSnapshotOriginIndex(
		overview?.kind === "ready" &&
			Array.isArray(search.snapshots) &&
			search.snapshots.length
			? {
					projectId,
					projectionId: overview.projectionId,
					snapshotIds: search.snapshots,
				}
			: "skip",
	);
	const pageContext = JSON.stringify([
		projectId,
		overview?.kind === "ready" ? overview.projectionId : null,
		selectionKey,
		search.q,
		search.scope,
		search.release,
		search.snapshots,
		search.tags,
	]);
	const [pageHistory, setPageHistory] = useState<StringsPageHistory>({
		context: pageContext,
		pages: [],
	});
	const previousPages = previousStringsPages(pageHistory, pageContext, {
		after: search.after,
		key: search.key,
	});
	const observedProjection = useRef<
		{ projectId: string; projectionId: string } | undefined
	>(undefined);
	useEffect(() => {
		if (overview?.kind !== "ready") return;
		const previous = observedProjection.current;
		observedProjection.current = {
			projectId,
			projectionId: overview.projectionId,
		};
		if (
			previous?.projectId === projectId &&
			previous.projectionId !== overview.projectionId
		)
			void navigate({
				search: (current) => ({ ...current, after: undefined }),
				replace: true,
			});
	}, [overview, navigate, projectId]);
	const releaseHandoff = useQuery(
		api.releaseRecords.handoff,
		search.release
			? {
					projectId: convexProjectId,
					recordId: convexId<"releaseRecords">(search.release),
				}
			: "skip",
	);
	const page = useCatalogBrowsePage(
		overview?.kind === "ready" &&
			snapshotIndex.ready &&
			locales !== undefined &&
			(!search.release || releaseHandoff !== undefined)
			? {
					projectId: convexProjectId,
					projectionId: overview.projectionId,
					localeIds: selectedLocaleIds,
					tagIds: search.tags?.map((id) => convexId<"tags">(id)),
					introducedSnapshotIds: Array.isArray(search.snapshots)
						? search.snapshots.map((id) => convexId<"sourceSnapshots">(id))
						: undefined,
					introducedOriginUnknown: search.snapshots === "unknown" || undefined,
					after: search.after,
					q: search.q,
					scope: search.scope,
					focusKey: search.key,
					messageIds:
						releaseHandoff?.status === "published" && releaseHandoff.keys.length
							? releaseHandoff.keys.map((key) => key.messageId)
							: undefined,
				}
			: "skip",
		overview?.kind === "ready" ? overview.revision : undefined,
		tagOptions?.revision,
	);
	const scopeCounts = useCatalogScopeCounts(
		overview?.kind === "ready" && locales !== undefined && snapshotIndex.ready
			? {
					projectId: convexProjectId,
					projectionId: overview.projectionId,
					revision: overview.revision,
					expectedTagRevision: tagOptions?.revision,
					localeIds: selectedLocaleIds,
					tagIds: search.tags?.map((id) => convexId<"tags">(id)),
					introducedSnapshotIds: Array.isArray(search.snapshots)
						? search.snapshots.map((id) => convexId<"sourceSnapshots">(id))
						: undefined,
					introducedOriginUnknown: search.snapshots === "unknown" || undefined,
				}
			: "skip",
	);
	const tagMembership = useQuery(
		api.messageTags.forMessages,
		page?.keys.length
			? {
					projectId: convexProjectId,
					messageIds: page.keys.map((key) => key.messageId),
				}
			: "skip",
	);
	const tagNamesByMessage = new Map(
		(tagMembership ?? []).map((item) => [
			item.messageId,
			(tagOptions?.items ?? [])
				.filter((tag) => item.tagIds.includes(tag.id))
				.map((tag) => tag.name),
		]),
	);
	const navigation =
		overview?.kind === "ready"
			? page && !page.stale
				? {
						...overview,
						keys: page.keys,
						valueStateCounts: scopeCounts,
						introducedMessageCount: scopeCounts?.introduced,
					}
				: undefined
			: overview;

	const [windowRequest, setWindowRequest] = useState<{
		projectionId: string | undefined;
		messageIds: string[];
	}>({ projectionId: undefined, messageIds: [] });
	const [windowCardCache, setWindowCardCache] = useState(
		createStringsWindowCardCache,
	);
	// The Window read binds to one exact projection. When the Baseline advances
	// under an open Strings page, the old window's message ids would fail the
	// read's STALE_BASIS check, so the window is dropped at once and rebuilt
	// from the new Navigation read on the next scroll or focus.
	const windowedProjectionId =
		navigation?.kind === "ready"
			? `${navigation.projectionId}:${JSON.stringify(selectedLocaleIds)}`
			: undefined;
	const windowMessageIds =
		windowRequest.projectionId === windowedProjectionId
			? windowRequest.messageIds
			: EMPTY_STRINGS_WINDOW_MESSAGE_IDS;
	const onWindowMessageIdsChange = useCallback(
		(messageIds: string[]) => {
			setWindowRequest((current) =>
				current.projectionId === windowedProjectionId &&
				sameStringsWindowMessageIds(current.messageIds, messageIds)
					? current
					: { projectionId: windowedProjectionId, messageIds },
			);
		},
		[windowedProjectionId],
	);
	const windowArgs =
		navigation?.kind === "ready" &&
		navigation.projectionId !== undefined &&
		windowMessageIds.length > 0
			? {
					projectId: convexProjectId,
					expectedProjectionId: navigation.projectionId,
					messageIds: windowMessageIds,
					localeIds: selectedLocaleIds,
				}
			: ("skip" as const);
	const { cards: windowResult, isLoading: loadingLanguages } =
		useCatalogWindow(windowArgs);
	const windowCards = useMemo<StringsWindowCards | undefined>(() => {
		if (windowResult === undefined) return undefined;
		const cards = new Map<string, StringsCatalogKey>();
		for (const key of windowResult) {
			cards.set(key.id, readStringsCatalogKey(key));
		}
		return cards;
	}, [windowResult]);
	const windowCacheCap = 2 * stringsWindowKeyCap(selectedLocaleIds.length);
	useEffect(() => {
		setWindowCardCache((current) =>
			updateStringsWindowCardCache(current, {
				projectionId: windowedProjectionId,
				cards: windowCards,
				maxCards: windowCacheCap,
				requestedMessageIds: windowMessageIds,
			}),
		);
	}, [windowedProjectionId, windowCards, windowCacheCap, windowMessageIds]);
	const hydratedCards =
		windowCardCache.projectionId === windowedProjectionId
			? windowCardCache.cards
			: EMPTY_STRINGS_WINDOW_CARDS;
	const commitWorkspaceValue = useMutation(api.catalogWorkspace.commit);
	const startOrdinaryImportRun = useMutation(
		api.ordinaryImportRuns.startOrdinaryImportRun,
	);
	const startNavigationBackfill = useMutation(
		api.catalogWorkspaceNavigation.startNavigationIndexBackfill,
	);
	const createTranslationTask = useMutation(
		api.agentTranslationProposals.createTask,
	);
	const releaseHandoffMessageIds =
		releaseHandoff?.status === "published"
			? releaseHandoff.keys.map((key) => key.messageId)
			: undefined;
	const activeReleaseHandoffMessageIds =
		releaseHandoffMessageIds && releaseHandoffMessageIds.length > 0
			? releaseHandoffMessageIds
			: undefined;
	const navigationState: StringsCatalogNavigationState = {
		query: search.q ?? "",
		key: search.key,
		scope: search.scope,
		handoffMessageIds: activeReleaseHandoffMessageIds,
	};
	const onNavigationChange = useCallback(
		(next: StringsCatalogNavigationState) => {
			void navigate({
				search: (previous) => ({
					...previous,
					q: next.query || undefined,
					key: next.key,
					scope: next.scope,
					after:
						next.query !== (previous.q ?? "") ||
						next.scope !== previous.scope ||
						next.key !== previous.key
							? undefined
							: previous.after,
				}),
				replace: true,
			});
		},
		[navigate],
	);
	const onConnectCheckout = useCallback(() => {
		void navigate({
			to: "/projects/$projectId/sync",
			params: { projectId },
			search: {},
		});
	}, [navigate, projectId]);
	const onClearReleaseHandoff = useCallback(() => {
		void navigate({
			search: (previous) => ({
				...previous,
				release: undefined,
				after: undefined,
				key: undefined,
			}),
			replace: true,
		});
	}, [navigate]);
	useEffect(() => {
		if (releaseHandoff?.status !== "stale") return;
		toast.info(
			"The catalog changed after this release was assessed. Prepare a current Release Record before using its work scope.",
		);
		onClearReleaseHandoff();
	}, [onClearReleaseHandoff, releaseHandoff?.status]);
	const onCommitValue = useCallback(
		async (input: CatalogWorkspaceCommit) => {
			try {
				if (input.basis.kind !== "repository")
					throw new Error("This value does not belong to the repository.");
				const receipt = await commitWorkspaceValue({
					projectId: convexProjectId,
					messageId: input.messageId,
					localeId: convexId<"locales">(input.localeId),
					intent: input.intent,
					expectedGitValueFingerprint: input.basis.expectedGitValueFingerprint,
					expectedGitValueRevision: input.basis.expectedGitValueRevision,
					expectedWorkspaceRevision: input.basis.expectedWorkspaceRevision,
					expectedSourceFingerprint: input.basis.expectedSourceFingerprint,
				});
				return {
					basis: {
						...input.basis,
						expectedWorkspaceRevision: receipt.workspaceRevision,
						expectedSourceFingerprint: receipt.sourceFingerprint,
					},
				};
			} catch (cause) {
				toast.error(
					cause instanceof Error ? cause.message : "Could not save value.",
				);
				throw cause;
			}
		},
		[commitWorkspaceValue, convexProjectId],
	);
	const onStartOrdinaryImportRun = useCallback(
		async (expectedProjectionId: string, policy: "ordinary-v1") => {
			try {
				const run = await startOrdinaryImportRun({
					projectId: convexProjectId,
					expectedProjectionId:
						convexId<"catalogProjections">(expectedProjectionId),
					policy,
				});
				if (run.status === "running") {
					toast.success("Confirming ordinary imports in the background.");
				}
			} catch (cause) {
				toast.error(
					cause instanceof Error
						? cause.message
						: "Could not start the confirmation run.",
				);
			}
		},
		[convexProjectId, startOrdinaryImportRun],
	);
	const onStartNavigationBackfill = useCallback(async () => {
		try {
			await startNavigationBackfill({ projectId: convexProjectId });
			toast.success("Catalog preparation started.");
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Could not prepare the catalog.",
			);
		}
	}, [convexProjectId, startNavigationBackfill]);
	const onCreateTranslationTask = useCallback(
		async (input: {
			title: string;
			localeId: string;
			messageIds: readonly string[];
		}) => {
			const task = await createTranslationTask({
				projectId: convexProjectId,
				title: input.title,
				target: {
					kind: "existingLocale",
					localeId: convexId<"locales">(input.localeId),
				},
				scope: {
					kind: "selectedMessages",
					messageIds: [...input.messageIds],
				},
			});
			toast.success(
				`Translation Task created for ${task.targetCount} ${task.targetCount === 1 ? "key" : "keys"}.`,
			);
			void navigate({
				to: "/projects/$projectId/proposals/$proposalId",
				params: { projectId, proposalId: task.taskId },
			}).catch((cause) => {
				toast.error(
					cause instanceof Error
						? cause.message
						: "Task created, but its review page could not be opened.",
				);
			});
		},
		[createTranslationTask, convexProjectId, navigate, projectId],
	);

	const keyCount = overview?.kind === "ready" ? overview.keyCount : 0;
	return (
		<>
			<PageHeader
				title="Strings"
				action={
					<div className="flex flex-wrap items-center gap-2">
						{navigation?.kind === "ready" ? (
							<Badge variant="secondary">
								{keyCount} active key
								{keyCount === 1 ? "" : "s"}
							</Badge>
						) : null}
						<Button
							nativeButton={false}
							size="sm"
							render={
								<Link
									to="/projects/$projectId/proposals"
									params={{ projectId }}
								/>
							}
						>
							Start translation
						</Button>
					</div>
				}
			/>
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="w-64">
					<StringsLanguageSelector
						locales={targets}
						value={search.locales}
						onChange={(codes) => {
							void navigate({
								search: (previous) => ({
									...previous,
									locales: codes,
									after: undefined,
									key: undefined,
								}),
							});
						}}
					/>
				</div>
				{tagOptions ? (
					<StringTagFilter
						tags={tagOptions.items}
						value={search.tags ?? []}
						onChange={(tags) =>
							void navigate({
								search: (previous) => ({
									...previous,
									tags: tags.length ? tags : undefined,
									after: undefined,
									key: undefined,
								}),
							})
						}
					/>
				) : null}
				<StringsSnapshotSelector
					projectId={projectId}
					value={search.snapshots}
					onChange={(snapshots) => {
						void navigate({
							search: (previous) => ({
								...previous,
								snapshots,
								after: undefined,
								key: undefined,
							}),
						});
					}}
				/>
			</div>
			{!snapshotIndex.ready ? (
				<div
					className="mb-3 flex items-center gap-3 text-muted-foreground text-sm"
					role={snapshotIndex.error ? "alert" : "status"}
				>
					<span>
						{snapshotIndex.error ??
							`Preparing snapshot filter${snapshotIndex.expected ? ` · ${snapshotIndex.processed} / ${snapshotIndex.expected}` : "…"}`}
					</span>
					{snapshotIndex.error ? (
						<Button
							size="xs"
							variant="outline"
							onClick={() => void snapshotIndex.retry()}
						>
							Retry
						</Button>
					) : null}
				</div>
			) : null}
			{loadingLanguages && navigation?.kind === "ready" ? (
				<p role="status" className="mb-2 text-muted-foreground text-sm">
					Loading languages…
				</p>
			) : null}
			{overview?.kind === "ready" && page && !page.stale ? (
				<StringSelectionTools
					projectId={projectId}
					tags={tagOptions?.items ?? []}
					selected={selectedKeys}
					onSelectionChange={setSelectedKeys}
					canEdit={!!overview.canEdit}
					selectAll={(progress) =>
						matchingRepositoryKeys(
							convex,
							{
								projectId: convexProjectId,
								projectionId: overview.projectionId,
								localeIds: selectedLocaleIds,
								q: search.q,
								focusKey: search.key,
								scope: search.scope,
								tagIds: search.tags?.map((id) => convexId<"tags">(id)),
								expectedTagRevision: tagOptions?.revision,
								introducedSnapshotIds: Array.isArray(search.snapshots)
									? search.snapshots.map((id) =>
											convexId<"sourceSnapshots">(id),
										)
									: undefined,
								introducedOriginUnknown:
									search.snapshots === "unknown" || undefined,
								messageIds:
									releaseHandoff?.status === "published" &&
									releaseHandoff.keys.length
										? releaseHandoff.keys.map((key) => key.messageId)
										: undefined,
							},
							progress,
						)
					}
				/>
			) : null}
			<StringsCatalogView
				hideSearchCount
				selectedMessageIds={selectedKeys}
				onSelectionChange={setSelectedKeys}
				tagNamesByMessage={tagNamesByMessage}
				historyProjectId={convexProjectId}
				sourceLocaleId={locales?.find((locale) => locale.isSource)?._id}
				availableLocales={(locales ?? [])
					.filter(
						(locale) =>
							locale.archivedAt === undefined &&
							(locale.isSource || locale.catalogPath),
					)
					.map((locale) => ({
						id: locale._id,
						code: locale.code,
						label: locale.label,
					}))}
				onBeforeCloseAdvanced={() =>
					!detailsBusy &&
					(!detailsDirty ||
						window.confirm("Discard unsaved string properties?"))
				}
				renderProperties={(key) => (
					<div className="flex flex-col gap-5">
						{key.context ? (
							<p className="whitespace-pre-wrap text-muted-foreground text-sm">
								{key.context}
							</p>
						) : null}
						<RepositoryCharacterLimit
							embedded
							key={key.id}
							projectId={projectId}
							messageId={key.id}
							limit={key.characterLimit}
							disabled={navigation?.kind !== "ready" || !navigation.canEdit}
							onClose={() => {}}
							onUnsavedWorkChange={setDetailsDirty}
							onBusyChange={setDetailsBusy}
						/>
						<StringTags
							projectId={projectId}
							messageId={key.id}
							canEdit={navigation?.kind === "ready" && !!navigation.canEdit}
						/>
					</div>
				)}
				renderAdvancedValue={(key, localeId) =>
					overview?.kind === "ready" ? (
						<RepositoryAdvancedValue
							key={`${key.id}:${localeId}`}
							projectId={projectId}
							projectionId={overview.projectionId}
							catalogKey={key}
							localeId={localeId}
							canEdit={!!overview.canEdit}
							onCommitValue={onCommitValue}
						/>
					) : null
				}
				key={`${projectId}:${selectionKey}`}
				onUnsavedWorkChange={setHasUnsavedWork}
				navigation={
					search.release && releaseHandoff === undefined
						? undefined
						: navigation
				}
				hydratedCards={hydratedCards}
				onWindowMessageIdsChange={onWindowMessageIdsChange}
				navigationState={navigationState}
				onNavigationChange={onNavigationChange}
				onConnectCheckout={onConnectCheckout}
				onCommitValue={onCommitValue}
				ordinaryImports={
					navigation?.kind === "ready" ? navigation.ordinaryImports : undefined
				}
				onStartOrdinaryImportRun={onStartOrdinaryImportRun}
				onStartNavigationBackfill={onStartNavigationBackfill}
				workHandoff={
					search.release && activeReleaseHandoffMessageIds
						? {
								keyCount: activeReleaseHandoffMessageIds.length,
								onClear: onClearReleaseHandoff,
							}
						: undefined
				}
				onCreateTranslationTask={onCreateTranslationTask}
			/>
			{overview?.kind === "ready" ? (
				<StringsPagination
					count={page?.stale ? undefined : page?.keys.length}
					hasPrevious={search.after !== undefined}
					hasNext={page?.nextAfter != null}
					onPrevious={() => {
						const previous = previousPages.at(-1);
						setPageHistory({
							context: pageContext,
							pages: previousPages.slice(0, -1),
						});
						void navigate({
							search: (current) => ({
								...current,
								after: previous?.after,
								key: previous?.key,
							}),
						});
					}}
					onNext={() => {
						if (page?.nextAfter == null) return;
						setPageHistory({
							context: pageContext,
							pages: [
								...previousPages,
								{ after: search.after, key: search.key },
							],
						});
						void navigate({
							search: (current) => ({
								...current,
								after: page.nextAfter ?? undefined,
								key: undefined,
							}),
						});
					}}
				/>
			) : null}
		</>
	);
}
