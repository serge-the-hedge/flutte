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
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

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
	createStringsWindowCardCache,
	STRINGS_WINDOW_CARD_CACHE_CAP,
	type StringsWindowCards,
	sameStringsWindowMessageIds,
	updateStringsWindowCardCache,
} from "@/lib/strings-window";

import { useCatalogNavigationGuard } from "@/lib/use-catalog-navigation-guard";

type StringsSearch = {
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
	// Strings opens on the compact Navigation read once; only the visible card
	// window hydrates. Search and Catalog Scopes stay local over the digests.
	const navigation = useQuery(api.catalogWorkspaceNavigation.navigation, {
		projectId: convexProjectId,
	});
	const releaseHandoff = useQuery(
		api.releaseRecords.handoff,
		search.release
			? {
					projectId: convexProjectId,
					recordId: convexId<"releaseRecords">(search.release),
				}
			: "skip",
	);
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
		navigation?.kind === "ready" ? navigation.projectionId : undefined;
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
				}
			: ("skip" as const);
	const windowResult = useQuery(
		api.catalogWorkspaceNavigation.window,
		windowArgs,
	);
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

	const keyCount =
		navigation?.kind === "ready" ? (navigation.keys?.length ?? 0) : 0;
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
			<StringsCatalogView
				key={projectId}
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
		</ProjectShell>
	);
}
