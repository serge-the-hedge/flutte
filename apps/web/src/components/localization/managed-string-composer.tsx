import { Button } from "@blabla/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import {
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CatalogValueRow, QUIET_CATALOG_FIELD } from "./catalog-value-row";

type ComposerLocale = { id: string; code: string };
type NewString = {
	sourceValue: string;
	name: string | null;
	context: string;
	translations: { localeId: string; value: string }[];
};

/** One unsaved string uses the same rows as saved content. Hiding a language does not discard its draft. */
export function ManagedStringComposer({
	sourceLocale,
	enabledLocales,
	visibleLocales,
	readOnly = false,
	onCreate,
	onUnsavedWorkChange,
	onTargetDraftsChange,
}: {
	sourceLocale: ComposerLocale;
	enabledLocales: readonly ComposerLocale[];
	visibleLocales: readonly ComposerLocale[];
	readOnly?: boolean;
	onCreate: (input: NewString) => Promise<string>;
	onUnsavedWorkChange: (dirty: boolean) => void;
	onTargetDraftsChange?: (localeIds: readonly string[]) => void;
}) {
	const [value, setValue] = useState("");
	const [translations, setTranslations] = useState<
		Record<string, { value: string; code: string }>
	>({});
	const [name, setName] = useState("");
	const [context, setContext] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [focused, setFocused] = useState(false);
	const sending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [saveCount, setSaveCount] = useState(0);
	const sourceInput = useRef<HTMLTextAreaElement>(null);
	const targetDraftIds = useMemo(
		() =>
			Object.keys(translations).filter((id) => translations[id]?.value.length),
		[translations],
	);
	const removedDrafts = targetDraftIds.filter(
		(id) => !enabledLocales.some((locale) => locale.id === id),
	);
	const hiddenDraftCount = targetDraftIds.filter(
		(id) =>
			!visibleLocales.some((locale) => locale.id === id) &&
			!removedDrafts.includes(id),
	).length;
	const rows = [
		...visibleLocales,
		...removedDrafts.map((id) => ({ id, code: translations[id]?.code ?? id })),
	];
	const dirty =
		value.length > 0 ||
		name.length > 0 ||
		context.length > 0 ||
		targetDraftIds.length > 0;
	useEffect(() => {
		onUnsavedWorkChange(dirty || pending);
	}, [dirty, pending, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange(false), [onUnsavedWorkChange]);
	useEffect(() => {
		onTargetDraftsChange?.(targetDraftIds);
	}, [targetDraftIds, onTargetDraftsChange]);
	useEffect(() => () => onTargetDraftsChange?.([]), [onTargetDraftsChange]);
	useEffect(() => {
		if (saveCount) sourceInput.current?.focus();
	}, [saveCount]);
	async function submit() {
		if (
			readOnly ||
			sending.current ||
			!value.trim() ||
			removedDrafts.length > 0
		)
			return;
		sending.current = true;
		setPending(true);
		setError(null);
		try {
			await onCreate({
				sourceValue: value,
				name: name.trim() || null,
				context,
				translations: targetDraftIds.map((localeId) => ({
					localeId,
					value: translations[localeId]?.value ?? "",
				})),
			});
			setValue("");
			setTranslations({});
			setName("");
			setContext("");
			setDetailsOpen(false);
			setSaveCount((count) => count + 1);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not add string. Try again.",
			);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	return (
		<form
			aria-label="Add a string"
			className="border-b py-4"
			style={
				{
					"--locale-gutter": `${Math.max(3, sourceLocale.code.length, ...rows.map((locale) => locale.code.length))}ch`,
				} as CSSProperties
			}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					setFocused(false);
			}}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			onKeyDown={(event) => {
				if (
					event.key === "Enter" &&
					(event.metaKey || event.ctrlKey) &&
					!event.nativeEvent.isComposing &&
					event.keyCode !== 229
				) {
					event.preventDefault();
					void submit();
				}
			}}
		>
			<fieldset disabled={pending} className="flex min-w-0 flex-col gap-2">
				<div className="-ml-0.5 flex flex-col">
					<CatalogValueRow localeCode={sourceLocale.code} tone="silent">
						<Textarea
							readOnly={readOnly}
							ref={sourceInput}
							id="new-string-text"
							aria-label="New source text"
							aria-describedby="new-string-shortcut"
							placeholder="Write a new string…"
							rows={1}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							className={QUIET_CATALOG_FIELD}
						/>
					</CatalogValueRow>
					{(focused || dirty ? rows : []).map((locale) => (
						<CatalogValueRow
							key={locale.id}
							localeCode={locale.code}
							tone="silent"
						>
							<Textarea
								readOnly={readOnly}
								aria-label={`New ${locale.code} translation`}
								data-composer-locale-id={locale.id}
								placeholder="Add a translation…"
								rows={1}
								value={translations[locale.id]?.value ?? ""}
								onChange={(event) =>
									setTranslations((current) => ({
										...current,
										[locale.id]: {
											code: locale.code,
											value: event.target.value,
										},
									}))
								}
								className={QUIET_CATALOG_FIELD}
							/>
							{removedDrafts.includes(locale.id) && (
								<p className="px-2 text-destructive text-xs">
									This language was removed. Add it again or clear this draft
									before saving.
								</p>
							)}
						</CatalogValueRow>
					))}
				</div>
				{(focused || dirty) && (
					<>
						<details
							open={detailsOpen}
							onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
						>
							<summary className="w-fit cursor-pointer text-muted-foreground text-xs">
								Details <span>(optional)</span>
							</summary>
							<FieldGroup className="mt-3 sm:grid sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor="new-string-name">Name</FieldLabel>
									<Input
										readOnly={readOnly}
										id="new-string-name"
										value={name}
										onChange={(event) => setName(event.target.value)}
										placeholder="App Store subtitle"
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="new-string-context">Context</FieldLabel>
									<Textarea
										readOnly={readOnly}
										id="new-string-context"
										value={context}
										onChange={(event) => setContext(event.target.value)}
										rows={2}
										placeholder="Where it appears, meaning, or length guidance"
									/>
								</Field>
							</FieldGroup>
						</details>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span
								id="new-string-shortcut"
								className="text-muted-foreground text-xs"
							>
								⌘/Ctrl + Enter to save
								{hiddenDraftCount > 0
									? ` · ${hiddenDraftCount} hidden translation${hiddenDraftCount === 1 ? "" : "s"} included`
									: ""}
							</span>
							<Button
								type="submit"
								size="xs"
								variant="ghost"
								disabled={
									readOnly ||
									pending ||
									!value.trim() ||
									removedDrafts.length > 0
								}
							>
								{pending ? "Saving…" : "Save string"}
							</Button>
						</div>
					</>
				)}
			</fieldset>
			{readOnly && (
				<p role="status" className="mt-2 text-muted-foreground text-xs">
					Editing access was removed. Your draft is kept here for copying.
				</p>
			)}
			{error && (
				<p role="alert" className="mt-2 text-destructive text-sm">
					{error}
				</p>
			)}
		</form>
	);
}
