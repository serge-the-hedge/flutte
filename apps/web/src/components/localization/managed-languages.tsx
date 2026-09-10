import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { useMutation } from "convex/react";
import { Pencil, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "@/components/icon-button";
import { api, convexId } from "@/lib/convex-api";

import {
	type EditableLanguage,
	LanguageMetadataEditor,
} from "./language-metadata-editor";

/** Each action updates one language immediately; removed translations remain available on re-add. */
export function ManagedLanguages({
	projectId,
	collectionId,
	locales,
	enabledLocaleIds,
	blockedLocaleIds = [],
	disabled = false,
	onUnsavedWorkChange,
}: {
	projectId: string;
	collectionId: string;
	locales: readonly EditableLanguage[];
	enabledLocaleIds: readonly string[];
	blockedLocaleIds?: readonly string[];
	disabled?: boolean;
	onUnsavedWorkChange?: (dirty: boolean) => void;
}) {
	const addLocale = useMutation(api.contentCollections.addLocale);
	const removeLocale = useMutation(api.contentCollections.removeLocale);
	const [code, setCode] = useState("");
	const [label, setLabel] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editDirty, setEditDirty] = useState(false);
	const [pending, setPending] = useState(false);
	const sending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const optionsId = useId();
	const dirty = code.length > 0 || label.length > 0;
	useEffect(() => {
		onUnsavedWorkChange?.(dirty || pending || editDirty);
	}, [dirty, pending, editDirty, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange?.(false), [onUnsavedWorkChange]);
	const enabled = new Set(enabledLocaleIds);
	const blocked = new Set(blockedLocaleIds);
	async function update(work: () => Promise<unknown>, after?: () => void) {
		if (sending.current || disabled) return;
		sending.current = true;
		setPending(true);
		setError(null);
		try {
			await work();
			after?.();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not update languages. Try again.",
			);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	return (
		<section
			aria-label="Project languages"
			className="mb-5 rounded-md border p-4"
		>
			<h2 className="font-medium text-sm">Languages</h2>
			<p className="mt-1 text-muted-foreground text-xs">
				Removed languages keep their translations. Re-add to restore them.
			</p>
			<div className="mt-3 flex flex-col gap-2">
				{locales
					.filter(
						(locale) =>
							locale.archivedAt === undefined &&
							(locale.isSource || enabled.has(locale._id)),
					)
					.map((locale) => (
						<div
							key={locale._id}
							className="flex flex-wrap items-center justify-between gap-2"
						>
							{editingId === locale._id ? (
								<LanguageMetadataEditor
									projectId={projectId}
									locale={locale}
									disabled={disabled || pending}
									codeRestriction={
										blocked.has(locale._id)
											? "Finish or clear this language’s drafts before changing its code."
											: undefined
									}
									onClose={() => setEditingId(null)}
									onUnsavedWorkChange={setEditDirty}
								/>
							) : (
								<>
									<span className="text-sm">
										{locale.label}{" "}
										<span className="text-muted-foreground">
											· {locale.code}
											{locale.isSource ? " · Source" : ""}
										</span>
									</span>
									<div className="flex items-center gap-1">
										<IconButton
											icon={Pencil}
											label={`Edit ${locale.label}`}
											disabled={disabled || pending || editingId !== null}
											onClick={() => setEditingId(locale._id)}
										/>
										{!locale.isSource ? (
											<IconButton
												icon={X}
												label={`Remove ${locale.label}`}
												disabled={
													disabled ||
													pending ||
													editingId !== null ||
													blocked.has(locale._id)
												}
												title={
													blocked.has(locale._id)
														? "Finish or clear this draft before removing its language."
														: undefined
												}
												aria-label={`Remove ${locale.label}`}
												onClick={() => {
													if (blocked.has(locale._id)) return;
													void update(() =>
														removeLocale({
															projectId: convexId<"projects">(projectId),
															collectionId:
																convexId<"contentCollections">(collectionId),
															localeId: convexId<"locales">(locale._id),
														}),
													);
												}}
											/>
										) : null}
									</div>
								</>
							)}
						</div>
					))}
			</div>
			{blockedLocaleIds.some((id) => enabled.has(id)) && (
				<p className="mt-2 text-muted-foreground text-xs">
					Finish or clear a language’s draft before removing it.
				</p>
			)}
			<form
				className="mt-4 flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!code.trim() || editingId !== null) return;
					void update(
						() =>
							addLocale({
								projectId: convexId<"projects">(projectId),
								collectionId: convexId<"contentCollections">(collectionId),
								code: code.trim(),
								label: label.trim() || undefined,
							}),
						() => {
							setCode("");
							setLabel("");
						},
					);
				}}
			>
				<label
					htmlFor={`${optionsId}-code`}
					className="flex min-w-0 flex-1 flex-col gap-1 text-xs"
				>
					Language code
					<Input
						id={`${optionsId}-code`}
						list={optionsId}
						placeholder="e.g. fr or pt-BR"
						value={code}
						disabled={disabled || pending || editingId !== null}
						onChange={(event) => setCode(event.target.value)}
					/>
				</label>
				<datalist id={optionsId}>
					{locales
						.filter((locale) => !locale.isSource && !enabled.has(locale._id))
						.map((locale) => (
							<option key={locale._id} value={locale.code}>
								{locale.label}
							</option>
						))}
				</datalist>
				<label
					htmlFor={`${optionsId}-name`}
					className="flex min-w-0 flex-1 flex-col gap-1 text-xs"
				>
					Name (optional)
					<Input
						id={`${optionsId}-name`}
						placeholder="e.g. French"
						value={label}
						disabled={disabled || pending || editingId !== null}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</label>
				<Button
					type="submit"
					size="sm"
					disabled={disabled || pending || editingId !== null || !code.trim()}
				>
					{pending ? "Updating…" : "Add language"}
				</Button>
			</form>
			{error && (
				<p role="alert" className="mt-2 text-destructive text-sm">
					{error}
				</p>
			)}
		</section>
	);
}
