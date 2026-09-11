import { Button } from "@blabla/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Copy, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import {
	advanceWindowBatches,
	type CatalogWindowBatch,
	initialWindowBatches,
	windowBatchKey,
} from "@/lib/catalog-window-requests";
import { api, convexId } from "@/lib/convex-api";
import { exportManagedKeys, matchingManagedKeys } from "@/lib/managed-export";
import type {
	CatalogWorkspaceCommit,
	StringsCatalogKey,
} from "@/lib/strings-catalog";
import type { StringsNavigationRead } from "@/lib/strings-catalog-navigation";
import {
	previousStringsPages,
	type StringsPageHistory,
} from "@/lib/strings-page-history";
import type { StringsSearch } from "@/lib/strings-search";
import { useCatalogNavigationGuard } from "@/lib/use-catalog-navigation-guard";
import { useManagedPage } from "@/lib/use-managed-page";
import { ManagedAdvancedValue } from "./advanced-string-values";
import { ManagedLanguages } from "./managed-languages";
import { ManagedStringComposer } from "./managed-string-composer";
import { PageHeader } from "./project-shell";
import { ManagedStringProperties } from "./string-properties";
import { StringSelectionTools } from "./string-selection-tools";
import { StringTagFilter, StringTags } from "./string-tags";
import { StringsCatalogView } from "./strings-catalog-view";
import { StringsLanguageSelector } from "./strings-language-selector";
import { StringsPagination } from "./strings-pagination";

type ContextResult = FunctionReturnType<typeof api.managedContent.context>;
const noop = () => {};

/** Each read fits the managed context envelope. Start four more only after the
 * current wave settles; completed batches stay subscribed for live edits. */
function useManagedContext(
	projectId: string,
	collectionId: string,
	messageIds: string[],
	localeIds: string[],
) {
	const requestKey = JSON.stringify({
		projectId,
		collectionId,
		messageIds,
		localeIds,
	});
	const args = useMemo(
		() =>
			JSON.parse(requestKey) as {
				projectId: string;
				collectionId: string;
				messageIds: string[];
				localeIds: string[];
			},
		[requestKey],
	);
	const [state, setState] = useState<{
		key: string;
		batches: CatalogWindowBatch[];
	} | null>(null);
	const batches = useMemo(
		() =>
			args.localeIds.length === 0
				? []
				: state?.key === requestKey
					? state.batches
					: initialWindowBatches({
							messageIds: args.messageIds,
							localeIds: args.localeIds.map((id) => convexId<"locales">(id)),
						}),
		[args, requestKey, state],
	);
	const queries = useMemo(
		() =>
			Object.fromEntries(
				batches
					.filter((batch) => batch.started)
					.map((batch) => [
						windowBatchKey(batch),
						{
							query: api.managedContent.context,
							args: {
								projectId: convexId<"projects">(args.projectId),
								collectionId: convexId<"contentCollections">(args.collectionId),
								messageIds: batch.messageIds,
								localeIds: batch.localeIds ?? [],
							},
						},
					]),
			),
		[args, batches],
	);
	const results = useQueries(queries) as Record<
		string,
		ContextResult | Error | undefined
	>;
	const advancement = useMemo(() => {
		try {
			return {
				next: advanceWindowBatches(batches, results, "LIMIT_EXCEEDED"),
				error: null,
			};
		} catch (error) {
			return {
				next: null,
				error:
					error instanceof Error
						? error
						: new Error("Could not load translations"),
			};
		}
	}, [batches, results]);
	useEffect(() => {
		if (advancement.next)
			setState({ key: requestKey, batches: advancement.next });
	}, [requestKey, advancement.next]);
	return useMemo(
		() => ({
			items: Object.values(results).flatMap((result) =>
				result && !(result instanceof Error) ? result.items : [],
			),
			loading: batches.some(
				(batch) =>
					!batch.started || results[windowBatchKey(batch)] === undefined,
			),
			error: advancement.error,
		}),
		[batches, results, advancement.error],
	);
}

export function ManagedStrings({
	projectId,
	collectionId,
	search,
	onSearch,
}: {
	projectId: string;
	collectionId: string;
	search: StringsSearch;
	onSearch: (search: StringsSearch) => void;
}) {
	const navigate = useNavigate();
	const address = {
		projectId: convexId<"projects">(projectId),
		collectionId: convexId<"contentCollections">(collectionId),
	};
	const project = useQuery(api.projects.get, { projectId: address.projectId });
	const collection = useQuery(api.contentCollections.get, address);
	const locales = useQuery(api.locales.list, { projectId: address.projectId });
	const tagOptions = useQuery(api.messageTags.list, {
		projectId: address.projectId,
	});
	const page = useManagedPage(
		{
			...address,
			cursor: search.cursor,
			expectedTagRevision: tagOptions?.revision,
			q: search.q,
			focusKey: search.cursor ? undefined : search.key,
			tagIds: search.tags?.map((id) => convexId<"tags">(id)),
		},
		() => onSearch({ ...search, cursor: undefined }),
	);
	const tagMembership = useQuery(
		api.messageTags.forMessages,
		page?.items.length
			? { ...address, messageIds: page.items.map((item) => item.messageId) }
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
	const commitTarget = useMutation(api.managedContent.commit);
	const saveSource = useMutation(api.managedContent.saveSource);
	const createMessage = useMutation(api.managedContent.createMessage);
	const createTask = useMutation(api.agentTranslationProposals.createTask);
	const convex = useConvex();
	const [hasUnsaved, setHasUnsaved] = useState(false);
	const [composerDirty, setComposerDirty] = useState(false);
	const [composerTargetDrafts, setComposerTargetDrafts] = useState<
		readonly string[]
	>([]);
	const [formDirty, setFormDirty] = useState(false);
	const [propertiesBusy, setPropertiesBusy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [languagesOpen, setLanguagesOpen] = useState(false);
	const [languageDirty, setLanguageDirty] = useState(false);
	const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
	const [exportMode, setExportMode] = useState<
		"reviewed" | "partial" | "draft"
	>("reviewed");
	const [exportNote, setExportNote] = useState("");
	const pageContext = JSON.stringify([
		projectId,
		collectionId,
		search.q,
		search.tags,
		search.locales,
		tagOptions?.revision,
	]);
	const [pageHistory, setPageHistory] = useState<StringsPageHistory>({
		context: pageContext,
		pages: [],
	});
	const previousPages = previousStringsPages(pageHistory, pageContext, {
		cursor: search.cursor,
		key: search.key,
	});
	const hasUnsavedForms = composerDirty || formDirty || languageDirty;
	useCatalogNavigationGuard(
		hasUnsaved || hasUnsavedForms,
		!hasUnsaved && !formDirty && !languageDirty,
	);
	useEffect(() => {
		if (!hasUnsavedForms) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [hasUnsavedForms]);

	const canEdit = project?.role === "owner" || project?.role === "editor";
	const enabled = (locales ?? []).filter(
		(locale) =>
			collection?.localeIds.includes(locale._id) &&
			!locale.isSource &&
			locale.archivedAt === undefined,
	);
	const chosen =
		search.locales === undefined
			? enabled
			: enabled.filter((locale) => search.locales?.includes(locale.code));
	const context = useManagedContext(
		projectId,
		collectionId,
		page?.items.map((item) => item.messageId) ?? [],
		chosen.map((locale) => locale._id),
	);
	const cards = new Map<string, StringsCatalogKey>();
	const sourceLocale = project?.sourceLocale;
	for (const item of page?.items ?? []) {
		if (!sourceLocale || !collection) continue;
		cards.set(item.messageId, {
			id: item.messageId,
			name: item.name,
			context: item.context,
			characterLimit: item.characterLimit,
			source: {
				localeId: sourceLocale._id,
				localeCode: sourceLocale.code,
				isSource: true,
				value: item.sourceValue,
				materialized: false,
				editBasis: {
					kind: "managedSource",
					collectionId,
					sourceRevision: item.sourceRevision,
					sourceFingerprint: item.sourceFingerprint,
					membershipRevision: collection.membershipRevision,
				},
			},
			targets: chosen.map((locale) => {
				const target = context.items.find(
					(entry) =>
						entry.messageId === item.messageId &&
						entry.localeId === locale._id &&
						entry.basis.sourceRevision === item.sourceRevision &&
						entry.basis.membershipRevision === collection.membershipRevision,
				);
				return {
					localeId: locale._id,
					localeCode: locale.code,
					isSource: false,
					value: target?.value ?? "",
					materialized: !target,
					editBasis: target?.basis,
					valueState: target?.valueState,
					intentionalBlankReason: target?.intentionalBlank ?? undefined,
				};
			}),
		});
	}
	const navigation: StringsNavigationRead | undefined =
		page && collection
			? {
					kind: "ready",
					projectionId: `managed:${collectionId}`,
					keyCount: page.items.length,
					canEdit,
					keys: [...cards.values()].map((card, index) => ({
						messageId: card.id,
						catalogIndex: index,
						introductionReviewPending: 0,
						source: { localeId: sourceLocale?._id ?? "" },
						targets: card.targets.map((target) => ({
							localeId: target.localeId ?? "",
							localeCode: target.localeCode,
							valueState: target.valueState,
							touched:
								target.editBasis?.kind === "managed" &&
								target.editBasis.targetRevision > 0,
							confirmedGitContent: false,
							confirmedContentPreviously: target.valueState === "settled",
							firstReviewPending: false,
						})),
					})),
				}
			: undefined;
	const commit = async (input: CatalogWorkspaceCommit) => {
		const basis = input.basis;
		if (basis.kind === "repository" || basis.collectionId !== collectionId)
			throw new Error("The string belongs to another project.");
		if (basis.kind === "managedSource") {
			if (input.intent.kind !== "save")
				throw new Error("Source values are edited directly.");
			const result = await saveSource({
				...address,
				messageId: input.messageId,
				sourceValue: input.intent.value,
				expectedSourceRevision: basis.sourceRevision,
			});
			return { basis: { ...basis, ...result } };
		}
		const result = await commitTarget({
			...address,
			messageId: input.messageId,
			localeId: convexId<"locales">(input.localeId),
			basis: { ...basis, collectionId: address.collectionId },
			intent: input.intent,
		});
		return { basis: result.basis };
	};
	const changeSearch = (next: StringsSearch) => {
		setPageHistory({ context: pageContext, pages: [] });
		setSelectedKeys([]);
		onSearch({
			...next,
			key:
				next.key && next.key !== search.key
					? next.key
					: next.q !== search.q
						? undefined
						: next.key,
			collection: undefined,
			cursor: undefined,
		});
	};
	const exportValues = async (copy: boolean) => {
		if (busy) return;
		setBusy(true);
		setExportNote("");
		try {
			const expectedTagRevision = tagOptions?.revision;
			const messageIds = selectedKeys.length
				? [...selectedKeys]
				: await matchingManagedKeys(
						convex,
						{
							...address,
							q: search.q,
							focusKey: search.key,
							tagIds: search.tags?.map((id) => convexId<"tags">(id)),
							expectedTagRevision,
						},
						!search.cursor && !search.key ? page : undefined,
						(count) => setExportNote(`Finding strings… ${count}`),
					);
			const result = await exportManagedKeys(
				convex,
				{
					...address,
					messageIds,
					localeIds: chosen.map((locale) => locale._id),
					mode: exportMode,
					...(expectedTagRevision === undefined ? {} : { expectedTagRevision }),
				},
				(count) =>
					setExportNote(`Exporting ${count} / ${messageIds.length} strings…`),
			);

			if (copy) await navigator.clipboard.writeText(result.text);
			else {
				const url = URL.createObjectURL(
					new Blob([result.text], { type: "application/json" }),
				);
				const link = document.createElement("a");
				link.href = url;
				link.download = `${project?.name ?? "translations"}-${exportMode}.json`;
				link.click();
				URL.revokeObjectURL(url);
			}
			setExportNote(
				`${copy ? "Copied" : "Downloaded"} ${messageIds.length} strings. ${result.omitted} values omitted.`,
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Could not export translations";
			setExportNote(message);
			toast.error(message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<PageHeader
				title="Strings"
				action={
					canEdit ? (
						<div className="flex gap-2">
							<Button
								disabled={busy}
								variant="outline"
								onClick={() => {
									if (
										languageDirty &&
										!window.confirm("Discard unsaved language choices?")
									)
										return;
									setLanguagesOpen(!languagesOpen);
								}}
							>
								Languages
							</Button>
						</div>
					) : undefined
				}
			/>
			{languagesOpen && collection && locales && (
				<ManagedLanguages
					projectId={projectId}
					collectionId={collectionId}
					locales={locales}
					enabledLocaleIds={collection.localeIds}
					blockedLocaleIds={
						hasUnsaved
							? [
									...enabled.map((locale) => locale._id),
									sourceLocale?._id ?? "",
								]
							: [
									...composerTargetDrafts,
									...(composerDirty || formDirty
										? [sourceLocale?._id ?? ""]
										: []),
								]
					}
					disabled={busy || !canEdit}
					onUnsavedWorkChange={setLanguageDirty}
				/>
			)}
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="w-64">
					<StringsLanguageSelector
						locales={enabled}
						value={search.locales}
						onChange={(codes) => changeSearch({ ...search, locales: codes })}
					/>
				</div>
				{tagOptions ? (
					<StringTagFilter
						tags={tagOptions.items}
						value={search.tags ?? []}
						onChange={(tags) =>
							changeSearch({
								...search,
								tags: tags.length ? tags : undefined,
								key: undefined,
							})
						}
					/>
				) : null}
				{context.loading && (
					<span className="text-muted-foreground text-sm" role="status">
						Loading languages…
					</span>
				)}
			</div>
			{(canEdit || composerDirty) && sourceLocale && collection && (
				<ManagedStringComposer
					readOnly={!canEdit}
					sourceLocale={{ id: sourceLocale._id, code: sourceLocale.code }}
					enabledLocales={enabled.map((locale) => ({
						id: locale._id,
						code: locale.code,
					}))}
					visibleLocales={chosen.map((locale) => ({
						id: locale._id,
						code: locale.code,
					}))}
					onCreate={({ translations, ...input }) =>
						createMessage({
							...address,
							...input,
							translations: translations.map((translation) => ({
								...translation,
								localeId: convexId<"locales">(translation.localeId),
							})),
						})
					}
					onUnsavedWorkChange={setComposerDirty}
					onTargetDraftsChange={setComposerTargetDrafts}
				/>
			)}
			{context.error && (
				<p role="alert" className="text-destructive text-sm">
					{context.error.message}
				</p>
			)}
			{page ? (
				<StringSelectionTools
					projectId={projectId}
					collectionId={collectionId}
					tags={tagOptions?.items ?? []}
					selected={selectedKeys}
					onSelectionChange={setSelectedKeys}
					canEdit={canEdit}
					selectAll={(progress) =>
						matchingManagedKeys(
							convex,
							{
								...address,
								q: search.q,
								focusKey: search.key,
								tagIds: search.tags?.map((id) => convexId<"tags">(id)),
								expectedTagRevision: tagOptions?.revision,
							},
							!search.cursor && !search.key ? page : undefined,
							progress,
						)
					}
				/>
			) : null}
			<StringsCatalogView
				hideSearchCount
				selectedMessageIds={selectedKeys}
				tagNamesByMessage={tagNamesByMessage}
				historyProjectId={address.projectId}
				key={`${collectionId}:${JSON.stringify(search.locales ?? "all")}`}
				searchPlaceholder="Search names and source text"
				showFocusControls={false}
				emptyContent={
					<div className="rounded-md border p-6">
						<p>
							{search.q || search.tags?.length
								? "No matching strings on this page."
								: "No strings yet."}
						</p>
						{search.q && (
							<Button
								variant="ghost"
								onClick={() => changeSearch({ ...search, q: undefined })}
							>
								Clear search
							</Button>
						)}
					</div>
				}
				navigation={navigation}
				hydratedCards={cards}
				navigationState={{ query: search.q ?? "", key: search.key }}
				onNavigationChange={(next) =>
					changeSearch({ ...search, q: next.query, key: next.key })
				}
				onConnectCheckout={noop}
				onWindowMessageIdsChange={noop}
				onCommitValue={commit}
				onUnsavedWorkChange={setHasUnsaved}
				onSelectionChange={setSelectedKeys}
				sourceLocaleId={sourceLocale?._id}
				availableLocales={
					sourceLocale
						? [sourceLocale, ...enabled].map((locale) => ({
								id: locale._id,
								code: locale.code,
								label: locale.label,
							}))
						: []
				}
				onBeforeCloseAdvanced={() =>
					!propertiesBusy &&
					(!formDirty || window.confirm("Discard unsaved string properties?"))
				}
				renderProperties={(key, close) => (
					<div className="flex flex-col gap-5">
						<ManagedStringProperties
							key={key.id}
							projectId={projectId}
							collectionId={collectionId}
							catalogKey={key}
							canEdit={canEdit}
							onDirtyChange={setFormDirty}
							onBusyChange={setPropertiesBusy}
							onArchived={close}
						/>
						<StringTags
							projectId={projectId}
							collectionId={collectionId}
							messageId={key.id}
							canEdit={canEdit}
						/>
					</div>
				)}
				renderAdvancedValue={(key, localeId) => (
					<ManagedAdvancedValue
						key={`${key.id}:${localeId}`}
						projectId={projectId}
						collectionId={collectionId}
						catalogKey={key}
						localeId={localeId}
						canEdit={canEdit}
						onCommitValue={commit}
					/>
				)}
				onCreateTranslationTask={
					canEdit
						? async (input) => {
								const task = await createTask({
									projectId: address.projectId,
									title: input.title,
									target: {
										kind: "managedLocale",
										collectionId: address.collectionId,
										localeId: convexId<"locales">(input.localeId),
									},
									scope: {
										kind: "selectedMessages",
										messageIds: [...input.messageIds],
									},
								});
								toast.success("Translation task created");
								await navigate({
									to: "/projects/$projectId/proposals/$proposalId",
									params: { projectId, proposalId: task.taskId },
								});
							}
						: undefined
				}
			/>
			<StringsPagination
				count={page?.items.length}
				hasPrevious={search.cursor !== undefined}
				hasNext={page?.nextCursor != null}
				onPrevious={() => {
					const previous = previousPages.at(-1);
					setPageHistory({
						context: pageContext,
						pages: previousPages.slice(0, -1),
					});
					onSearch({ ...search, cursor: previous?.cursor, key: previous?.key });
				}}
				onNext={() => {
					if (!page?.nextCursor) return;
					setPageHistory({
						context: pageContext,
						pages: [
							...previousPages,
							{ cursor: search.cursor, key: search.key },
						],
					});
					onSearch({ ...search, cursor: page.nextCursor, key: undefined });
				}}
			/>
			<div className="mt-3 flex flex-wrap items-center justify-end gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm">
						Export{" "}
						{selectedKeys.length
							? `${selectedKeys.length} selected`
							: "all matching"}
					</span>
					<select
						aria-label="Export content"
						value={exportMode}
						onChange={(event) =>
							setExportMode(event.target.value as typeof exportMode)
						}
						className="h-9 rounded-md border bg-background px-2 text-sm"
					>
						<option value="reviewed">Reviewed · complete</option>
						<option value="partial">Reviewed · allow omissions</option>
						<option value="draft">All values · drafts and stale</option>
					</select>
					<IconButton
						label="Copy JSON"
						icon={Copy}
						variant="outline"
						disabled={
							busy || hasUnsaved || formDirty || !chosen.length || !page
						}
						onClick={() => void exportValues(true)}
					/>
					<IconButton
						label="Download JSON"
						icon={Download}
						variant="outline"
						disabled={
							busy || hasUnsaved || formDirty || !chosen.length || !page
						}
						onClick={() => void exportValues(false)}
					/>
				</div>
			</div>
			{exportNote && (
				<p role="status" className="mt-2 text-sm">
					{exportNote}
				</p>
			)}
		</>
	);
}
