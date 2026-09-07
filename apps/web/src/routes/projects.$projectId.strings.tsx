import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	createFileRoute,
	Link,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LocaleSelector } from "@/components/localization/locale-selector";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { StringsCatalogView } from "@/components/localization/strings-catalog-view";
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
import {
	previousStringsPages,
	type StringsPageHistory,
} from "@/lib/strings-page-history";
import {
	createStringsWindowCardCache,
	STRINGS_WINDOW_CARD_CACHE_CAP,
	type StringsWindowCards,
	sameStringsWindowMessageIds,
	updateStringsWindowCardCache,
} from "@/lib/strings-window";
import { useCatalogBrowsePage } from "@/lib/use-catalog-browse-page";
import { useCatalogNavigationGuard } from "@/lib/use-catalog-navigation-guard";
import { useCatalogWindow } from "@/lib/use-catalog-window";

type StringsSearch = {
	locale?: string;
	after?: number;
	q?: string;
	key?: string;
	scope?: CatalogValueScope;
	release?: string;
};
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
		locale: typeof search.locale === "string" ? search.locale : undefined,
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
	const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
	useCatalogNavigationGuard(hasUnsavedWork);
	const { projectId } = useParams({ from: "/projects/$projectId/strings" });
	const search = useSearch({ from: "/projects/$projectId/strings" });
	const navigate = useNavigate({ from: "/projects/$projectId/strings" });
	const convexProjectId = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: convexProjectId });
	const locales = useQuery(api.locales.list, { projectId: convexProjectId });
	const targets = (locales ?? []).filter(
		(locale) =>
			!locale.isSource && locale.archivedAt === undefined && locale.catalogPath,
	);
	const selectedLocale =
		targets.find((locale) => locale.code === search.locale) ?? targets[0];
	const overview = useQuery(api.catalogBrowse.overview, {
		projectId: convexProjectId,
	});
	const pageContext = JSON.stringify([
		projectId,
		overview?.kind === "ready" ? overview.projectionId : null,
		selectedLocale?._id,
		search.q,
		search.scope,
		search.release,
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
			locales !== undefined &&
			(!search.release || releaseHandoff !== undefined)
			? {
					projectId: convexProjectId,
					projectionId: overview.projectionId,
					localeId: selectedLocale?._id,
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
	);
	const navigation =
		overview?.kind === "ready"
			? page && !page.stale
				? {
						...overview,
						keys: page.keys,
						valueStateCounts: page.counts,
						serverFiltered: true,
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
			? `${navigation.projectionId}:${selectedLocale?._id ?? "source"}`
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
					localeIds: selectedLocale ? [selectedLocale._id] : [],
				}
			: ("skip" as const);
	const windowResult = useCatalogWindow(windowArgs);
	const windowCards = useMemo<StringsWindowCards | undefined>(() => {
		if (windowResult === undefined) return undefined;
		const cards = new Map<string, StringsCatalogKey>();
		for (const key of windowResult) {
			cards.set(key.id, readStringsCatalogKey(key));
		}
		return cards;
	}, [windowResult]);
	useEffect(() => {
		setWindowCardCache((current) =>
			updateStringsWindowCardCache(current, {
				projectionId: windowedProjectionId,
				cards: windowCards,
				maxCards: STRINGS_WINDOW_CARD_CACHE_CAP,
			}),
		);
	}, [windowedProjectionId, windowCards]);
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
				return await commitWorkspaceValue({
					projectId: convexProjectId,
					messageId: input.messageId,
					localeId: convexId<"locales">(input.localeId),
					intent: input.intent,
					expectedGitValueFingerprint: input.expectedGitValueFingerprint,
					expectedGitValueRevision: input.expectedGitValueRevision,
					expectedWorkspaceRevision: input.expectedWorkspaceRevision,
					expectedSourceFingerprint: input.expectedSourceFingerprint,
				});
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
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title="Strings"
				description="Your working catalog, composed from the accepted Baseline Snapshot."
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
					<LocaleSelector
						locales={targets}
						value={selectedLocale?.code ?? null}
						placeholder="Working language"
						onChange={(locale) => {
							void navigate({
								search: (previous) => ({
									...previous,
									locale: locale ?? undefined,
									after: undefined,
									key: undefined,
								}),
							});
						}}
					/>
				</div>
				<span className="text-muted-foreground text-sm">
					Source and selected language · counts for this page
				</span>
			</div>
			<StringsCatalogView
				key={`${projectId}:${selectedLocale?._id ?? "source"}`}
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
				<div className="mt-4 flex items-center justify-between gap-3">
					<Button
						variant="outline"
						disabled={page === undefined || search.after === undefined}
						onClick={() => {
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
					>
						Previous page
					</Button>
					<span className="text-muted-foreground text-sm">
						{page?.keys.length ?? 0} matching keys on this page
					</span>
					<Button
						variant="outline"
						disabled={page?.nextAfter == null}
						onClick={() => {
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
					>
						Next page
					</Button>
				</div>
			) : null}
		</ProjectShell>
	);
}
