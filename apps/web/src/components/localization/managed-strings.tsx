import { characterCount } from "@blabla/backend/convex/characterLimits";
import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronLeft, ChevronRight, Copy, Download } from "lucide-react";
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
import type {
	CatalogWorkspaceCommit,
	StringsCatalogKey,
} from "@/lib/strings-catalog";
import type { StringsNavigationRead } from "@/lib/strings-catalog-navigation";
import type { StringsSearch } from "@/lib/strings-search";
import { useCatalogNavigationGuard } from "@/lib/use-catalog-navigation-guard";
import { useManagedPage } from "@/lib/use-managed-page";
import {
	CharacterCount,
	CharacterLimitField,
	parsedCharacterLimit,
} from "./character-limit";
import { ManagedLanguages } from "./managed-languages";
import { ManagedStringComposer } from "./managed-string-composer";
import { PageHeader } from "./project-shell";
import { StringsCatalogView } from "./strings-catalog-view";
import { StringsLanguageSelector } from "./strings-language-selector";

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
	const page = useManagedPage({
		...address,
		cursor: search.cursor,
		focusKey: search.cursor ? undefined : search.key,
		q: search.q,
	});
	const commitTarget = useMutation(api.managedContent.commit);
	const saveSource = useMutation(api.managedContent.saveSource);
	const createMessage = useMutation(api.managedContent.createMessage);
	const archive = useMutation(api.managedContent.archiveMessage);
	const createTask = useMutation(api.agentTranslationProposals.createTask);
	const convex = useConvex();
	const [hasUnsaved, setHasUnsaved] = useState(false);
	const [composerDirty, setComposerDirty] = useState(false);
	const [composerTargetDrafts, setComposerTargetDrafts] = useState<
		readonly string[]
	>([]);
	const [form, setForm] = useState<{
		messageId: string;
		sourceRevision: number;
		name: string;
		value: string;
		originalValue: string;
		context: string;
		limitText: string;
		expectedCharacterLimit: number | null;
	} | null>(null);
	const formLimit = form ? parsedCharacterLimit(form.limitText) : undefined;
	const invalidForm =
		!!form &&
		((form.limitText !== "" && formLimit === undefined) ||
			(form.value !== form.originalValue &&
				formLimit !== undefined &&
				characterCount(form.value) > formLimit));
	const [formDirty, setFormDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [languagesOpen, setLanguagesOpen] = useState(false);
	const [languageDirty, setLanguageDirty] = useState(false);
	const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
	const [exportMode, setExportMode] = useState<
		"reviewed" | "partial" | "draft"
	>("reviewed");
	const [exportNote, setExportNote] = useState("");
	const [previous, setPrevious] = useState<Array<string | undefined>>([]);
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
		setPrevious([]);
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
			const result = await convex.query(api.managedContent.exportSelection, {
				...address,
				messageIds: [
					...(selectedKeys.length
						? selectedKeys
						: (page?.items.map((item) => item.messageId) ?? [])),
				],
				localeIds: chosen.map((locale) => locale._id),
				mode: exportMode,
			});
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
				`${copy ? "Copied" : "Downloaded"} ${selectedKeys.length ? "selected strings" : "this page"}. ${result.omitted.length} values omitted.`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not export translations",
			);
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
							? enabled.map((locale) => locale._id)
							: composerTargetDrafts
					}
					disabled={busy || !canEdit}
					onUnsavedWorkChange={setLanguageDirty}
				/>
			)}
			{form && (
				<form
					className="mb-5 flex flex-col gap-3 rounded-md border p-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy || invalidForm) return;
						setBusy(true);
						try {
							await saveSource({
								...address,
								messageId: form.messageId,
								sourceValue: form.value,
								name: form.name.trim() || null,
								characterLimit: parsedCharacterLimit(form.limitText) ?? null,
								expectedCharacterLimit: form.expectedCharacterLimit,
								context: form.context,
								expectedSourceRevision: form.sourceRevision,
							});

							setForm(null);
							setFormDirty(false);
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: "Could not save string",
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					<fieldset disabled={busy || !canEdit} className="contents">
						<h2 className="font-medium">String details</h2>
						<label className="text-sm" htmlFor="managed-source-name">
							Name <span className="text-muted-foreground">(optional)</span>
							<Input
								id="managed-source-name"
								value={form.name}
								placeholder="App Store subtitle"
								onChange={(event) => {
									setForm({ ...form, name: event.target.value });
									setFormDirty(true);
								}}
							/>
						</label>
						<label className="text-sm" htmlFor="managed-source-text">
							Source text
							<Textarea
								id="managed-source-text"
								value={form.value}
								onChange={(event) => {
									setForm({ ...form, value: event.target.value });
									setFormDirty(true);
								}}
							/>
						</label>
						<label className="text-sm" htmlFor="managed-source-context">
							Context <span className="text-muted-foreground">(optional)</span>
							<Textarea
								id="managed-source-context"
								value={form.context}
								placeholder="Where this appears, intended meaning, or length guidance"
								onChange={(event) => {
									setForm({ ...form, context: event.target.value });
									setFormDirty(true);
								}}
							/>
						</label>
						<CharacterLimitField
							value={form.limitText}
							onChange={(limitText) => {
								setForm({ ...form, limitText });
								setFormDirty(true);
							}}
						/>
						<CharacterCount
							value={form.value}
							limit={parsedCharacterLimit(form.limitText)}
						/>
						<div className="flex gap-2">
							<Button type="submit" disabled={busy || invalidForm}>
								Save
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setForm(null);
									setFormDirty(false);
								}}
							>
								Cancel
							</Button>
							{form.messageId && form.sourceRevision !== undefined && (
								<Button
									type="button"
									variant="destructive"
									disabled={busy}
									onClick={async () => {
										if (!form.messageId || form.sourceRevision === undefined)
											return;
										if (
											!window.confirm(
												"Archive this string? Its history will be preserved.",
											)
										)
											return;
										setBusy(true);
										try {
											await archive({
												...address,
												messageId: form.messageId,
												expectedSourceRevision: form.sourceRevision,
											});
											setForm(null);
											setFormDirty(false);
										} catch (error) {
											toast.error(
												error instanceof Error
													? error.message
													: "Could not archive string",
											);
										} finally {
											setBusy(false);
										}
									}}
								>
									Archive
								</Button>
							)}
						</div>
					</fieldset>
				</form>
			)}
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="w-64">
					<StringsLanguageSelector
						locales={enabled}
						value={search.locales}
						onChange={(codes) => changeSearch({ ...search, locales: codes })}
					/>
				</div>
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
			<StringsCatalogView
				historyProjectId={address.projectId}
				key={`${collectionId}:${JSON.stringify(search.locales ?? "all")}`}
				searchPlaceholder="Search names and source text"
				emptyContent={
					<div className="rounded-md border p-6">
						<p>{search.q ? "No matching strings." : "No strings yet."}</p>
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
				onManageKey={
					canEdit && !busy
						? (key) => {
								if (
									formDirty &&
									!window.confirm("Discard unsaved string details?")
								)
									return;
								const basis = key.source.editBasis;
								if (basis?.kind !== "managedSource") return;
								setForm({
									messageId: key.id,
									sourceRevision: basis.sourceRevision,
									name: key.name === undefined ? key.id : (key.name ?? ""),
									value: key.source.value,
									originalValue: key.source.value,
									context: key.context ?? "",
									limitText: key.characterLimit?.toString() ?? "",
									expectedCharacterLimit: key.characterLimit ?? null,
								});
								setFormDirty(false);
							}
						: undefined
				}
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
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<div className="flex gap-2">
					<IconButton
						label="Previous page"
						icon={ChevronLeft}
						variant="outline"
						disabled={!search.cursor}
						onClick={() => {
							const cursor = previous.at(-1);
							setPrevious(previous.slice(0, -1));
							onSearch({ ...search, cursor });
						}}
					/>
					<IconButton
						label="Next page"
						icon={ChevronRight}
						variant="outline"
						disabled={!page?.nextCursor}
						onClick={() => {
							if (!page?.nextCursor) return;
							setPrevious([...previous, search.cursor]);
							onSearch({ ...search, cursor: page.nextCursor });
						}}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm">
						Export{" "}
						{selectedKeys.length
							? `${selectedKeys.length} selected`
							: "this page"}
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
							busy ||
							hasUnsaved ||
							formDirty ||
							!chosen.length ||
							!page?.items.length
						}
						onClick={() => void exportValues(true)}
					/>
					<IconButton
						label="Download JSON"
						icon={Download}
						variant="outline"
						disabled={
							busy ||
							hasUnsaved ||
							formDirty ||
							!chosen.length ||
							!page?.items.length
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
