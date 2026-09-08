import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
	const page = useQuery(api.managedContent.page, {
		...address,
		cursor: search.cursor,
		focusKey: search.cursor ? undefined : search.key,
		q: search.q,
		limit: 16,
	});
	const commitTarget = useMutation(api.managedContent.commit);
	const saveSource = useMutation(api.managedContent.saveSource);
	const createMessage = useMutation(api.managedContent.createMessage);
	const archive = useMutation(api.managedContent.archiveMessage);
	const setLocales = useMutation(api.contentCollections.setLocales);
	const createLocale = useMutation(api.locales.create);
	const createTask = useMutation(api.agentTranslationProposals.createTask);
	const convex = useConvex();
	const [hasUnsaved, setHasUnsaved] = useState(false);
	const [form, setForm] = useState<{
		messageId?: string;
		sourceRevision?: number;
		key: string;
		value: string;
		context: string;
	} | null>(null);
	const [formDirty, setFormDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [languagesOpen, setLanguagesOpen] = useState(false);
	const [languageDraft, setLanguageDraft] = useState<string[] | null>(null);
	const [languageRevision, setLanguageRevision] = useState<number | null>(null);
	const [newCode, setNewCode] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
	const [exportMode, setExportMode] = useState<
		"reviewed" | "partial" | "draft"
	>("reviewed");
	const [exportNote, setExportNote] = useState("");
	const [previous, setPrevious] = useState<Array<string | undefined>>([]);
	const hasUnsavedForms =
		formDirty ||
		languageDraft !== null ||
		newCode.length > 0 ||
		newLabel.length > 0;
	useCatalogNavigationGuard(hasUnsaved || hasUnsavedForms);
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
			context: item.context,
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
			throw new Error("The string belongs to another collection.");
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
			collection: collectionId,
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
				link.download = `${collection?.name ?? "translations"}-${exportMode}.json`;
				link.click();
				URL.revokeObjectURL(url);
			}
			setExportNote(
				`${copy ? "Copied" : "Downloaded"} ${selectedKeys.length ? "selected keys" : "this page"}. ${result.omitted.length} values omitted.`,
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
				title={collection?.name ?? "Strings"}
				description="Write source text here, translate, and review it in one place."
				action={
					canEdit ? (
						<div className="flex gap-2">
							<Button
								disabled={busy}
								variant="outline"
								onClick={() => {
									if (
										languageDraft !== null &&
										!window.confirm("Discard unsaved language choices?")
									)
										return;
									setLanguagesOpen(!languagesOpen);
									setLanguageDraft(null);
									setLanguageRevision(collection?.membershipRevision ?? null);
								}}
							>
								Languages
							</Button>
							<Button
								disabled={busy}
								onClick={() => {
									if (
										formDirty &&
										!window.confirm("Discard unsaved string details?")
									)
										return;
									setForm({ key: "", value: "", context: "" });
									setFormDirty(false);
								}}
							>
								Add string
							</Button>
						</div>
					) : undefined
				}
			/>
			{languagesOpen && collection && (
				<section className="mb-5 rounded-md border p-4">
					<fieldset disabled={busy || !canEdit}>
						<h2 className="mb-3 font-medium">Languages in this collection</h2>
						<div className="flex flex-wrap gap-4">
							{(locales ?? [])
								.filter(
									(locale) =>
										!locale.isSource && locale.archivedAt === undefined,
								)
								.map((locale) => (
									<label
										key={locale._id}
										className="flex items-center gap-2 text-sm"
									>
										<input
											type="checkbox"
											checked={(languageDraft ?? collection.localeIds).includes(
												locale._id,
											)}
											onChange={(event) => {
												const ids = languageDraft ?? collection.localeIds;
												setLanguageDraft(
													event.target.checked
														? [...ids, locale._id]
														: ids.filter((id) => id !== locale._id),
												);
											}}
										/>
										{locale.label} · {locale.code}
									</label>
								))}
						</div>
						<div className="mt-4 flex flex-wrap gap-2">
							<Input
								aria-label="New language code"
								placeholder="Locale code, e.g. pt-BR"
								value={newCode}
								onChange={(event) => setNewCode(event.target.value)}
							/>
							<Input
								aria-label="New language name"
								placeholder="Language name"
								value={newLabel}
								onChange={(event) => setNewLabel(event.target.value)}
							/>
							<Button
								variant="outline"
								disabled={busy || !newCode.trim() || !newLabel.trim()}
								onClick={async () => {
									setBusy(true);
									try {
										const id = await createLocale({
											projectId: address.projectId,
											code: newCode.trim(),
											label: newLabel.trim(),
										});
										setLanguageDraft([
											...(languageDraft ?? collection.localeIds),
											id,
										]);
										setNewCode("");
										setNewLabel("");
									} catch (error) {
										toast.error(
											error instanceof Error
												? error.message
												: "Could not add language",
										);
									} finally {
										setBusy(false);
									}
								}}
							>
								Add language
							</Button>
							<Button
								disabled={busy || languageDraft === null}
								onClick={async () => {
									if (!languageDraft) return;
									setBusy(true);
									try {
										await setLocales({
											...address,
											localeIds: languageDraft.map((id) =>
												convexId<"locales">(id),
											),
											expectedMembershipRevision:
												languageRevision ?? collection.membershipRevision,
										});
										setLanguageDraft(null);
										setLanguagesOpen(false);
									} catch (error) {
										toast.error(
											error instanceof Error
												? error.message
												: "Could not save languages",
										);
									} finally {
										setBusy(false);
									}
								}}
							>
								Save languages
							</Button>
						</div>
					</fieldset>
				</section>
			)}
			{form && (
				<form
					className="mb-5 flex flex-col gap-3 rounded-md border p-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy) return;
						setBusy(true);
						try {
							if (form.messageId && form.sourceRevision !== undefined)
								await saveSource({
									...address,
									messageId: form.messageId,
									sourceValue: form.value,
									context: form.context,
									expectedSourceRevision: form.sourceRevision,
								});
							else {
								const messageId = await createMessage({
									...address,
									key: form.key.trim(),
									sourceValue: form.value,
									context: form.context,
								});
								onSearch({
									collection: collectionId,
									key: messageId,
									locales: search.locales,
								});
							}

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
						<h2 className="font-medium">
							{form.messageId ? "String details" : "Add string"}
						</h2>
						<label className="text-sm" htmlFor="managed-source-key">
							Key
							<Input
								id="managed-source-key"
								value={form.key}
								required
								disabled={!!form.messageId}
								onChange={(event) => {
									setForm({ ...form, key: event.target.value });
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
						<div className="flex gap-2">
							<Button type="submit" disabled={busy}>
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
				<span className="text-muted-foreground text-sm">
					Source always shown{context.loading ? " · Loading languages…" : ""}
				</span>
			</div>
			{context.error && (
				<p role="alert" className="text-destructive text-sm">
					{context.error.message}
				</p>
			)}
			<StringsCatalogView
				key={`${collectionId}:${JSON.stringify(search.locales ?? "all")}`}
				searchPlaceholder="Search keys and source text"
				emptyContent={
					<div className="rounded-md border p-6">
						<p>
							{search.q
								? "No matching strings."
								: "This collection has no strings yet."}
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
									key: key.id,
									value: key.source.value,
									context: key.context ?? "",
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
					<Button
						variant="outline"
						disabled={!search.cursor}
						onClick={() => {
							const cursor = previous.at(-1);
							setPrevious(previous.slice(0, -1));
							onSearch({ ...search, cursor });
						}}
					>
						Previous
					</Button>
					<Button
						variant="outline"
						disabled={!page?.nextCursor}
						onClick={() => {
							if (!page?.nextCursor) return;
							setPrevious([...previous, search.cursor]);
							onSearch({ ...search, cursor: page.nextCursor });
						}}
					>
						Next
					</Button>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm">
						Export{" "}
						{selectedKeys.length
							? `${selectedKeys.length} selected keys`
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
						<option value="reviewed">Reviewed only (complete)</option>
						<option value="partial">Reviewed only (allow omissions)</option>
						<option value="draft">Include drafts and stale values</option>
					</select>
					<Button
						variant="outline"
						disabled={
							busy ||
							hasUnsaved ||
							formDirty ||
							!chosen.length ||
							!page?.items.length
						}
						onClick={() => void exportValues(true)}
					>
						Copy JSON
					</Button>
					<Button
						variant="outline"
						disabled={
							busy ||
							hasUnsaved ||
							formDirty ||
							!chosen.length ||
							!page?.items.length
						}
						onClick={() => void exportValues(false)}
					>
						Download JSON
					</Button>
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
