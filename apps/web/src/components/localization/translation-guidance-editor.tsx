import { Alert, AlertDescription } from "@blabla/ui/components/alert";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Checkbox } from "@blabla/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@blabla/ui/components/select";
import { Textarea } from "@blabla/ui/components/textarea";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { type FormEvent, useEffect, useState } from "react";
import type { api } from "@/lib/convex-api";

type Guidance = FunctionReturnType<typeof api.translationGuidance.list>;
type TermInput = Omit<
	FunctionArgs<typeof api.dictionaries.saveTerm>,
	"dictionaryId"
>;
type VoiceInput = Omit<
	FunctionArgs<typeof api.translationGuidance.saveVoiceGuide>,
	"projectId"
>;
type ProjectVoiceInput = Omit<
	FunctionArgs<typeof api.translationGuidance.saveProjectVoiceGuide>,
	"projectId"
>;
type Term = TermInput["term"];
export type GuidanceLocale = { code: string; label?: string; active?: boolean };
type Locale = GuidanceLocale;
type TermGuidance = { revision: number; terms: readonly { term: Term }[] };
type DictionaryProps = {
	guidance: TermGuidance;
	locales: Locale[];
	canEdit: boolean;
	onSaveTerm: (input: TermInput) => Promise<unknown>;
	onRemoveTerm: (input: {
		expectedRevision: number;
		sourceTerm: string;
	}) => Promise<unknown>;
	allowCustomLocales?: boolean;
	onUnsavedWorkChange?: (hasUnsavedWork: boolean) => void;
};
type Props = {
	guidance: Guidance;
	locales: Locale[];
	canEdit: boolean;
	onSaveVoiceGuide: (input: VoiceInput) => Promise<unknown>;
	onSaveProjectVoiceGuide: (input: ProjectVoiceInput) => Promise<unknown>;
};

function errorText(error: unknown) {
	return error instanceof Error
		? error.message
		: "Could not save guidance. Your draft is still here.";
}

/** Editing starts with a captured revision. Subscription updates preserve the
 * draft; accepting a changed saved version requires a deliberate editor action. */
function DraftActions({
	currentRevision,
	canEdit,
	expectedRevision,
	onUseCurrent,
	onCancel,
	busy,
	error,
	label,
}: {
	currentRevision: number;
	canEdit: boolean;
	expectedRevision: number;
	onUseCurrent: () => void;
	onCancel: () => void;
	busy: boolean;
	error: string | null;
	label: string;
}) {
	const changed = currentRevision !== expectedRevision;
	return (
		<>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{changed ? (
				<Alert>
					<AlertDescription>
						Saved content changed while this draft was open. Compare the current
						saved entries below before keeping your draft.
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={onUseCurrent}
						>
							Keep my draft
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || !canEdit || changed}>
					{busy ? "Saving…" : label}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</>
	);
}

function LocalePicker({
	id,
	label,
	locales,
	value,
	onChange,
	disabled = false,
	configuredCodes = [],
}: {
	id: string;
	label: string;
	locales: Locale[];
	value: string | undefined;
	onChange: (value: string) => void;
	disabled?: boolean;
	configuredCodes?: string[];
}) {
	const configured = new Set(configuredCodes);
	const items = locales.map((locale) => ({
		value: locale.code,
		label: `${locale.label ?? locale.code} (${locale.code})${configured.has(locale.code) ? " · configured" : ""}${locale.active === false ? " · archived" : ""}`,
	}));
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				value={value ?? null}
				onValueChange={(value) => {
					if (value) onChange(value);
				}}
				disabled={disabled}
				items={items}
			>
				<SelectTrigger id={id}>
					<SelectValue placeholder="Choose a Locale" />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	);
}

function TermEditor({
	term,
	guidance,
	locales,
	canEdit,
	onSave,
	onCancel,
	allowCustomLocales = false,
	onUnsavedWorkChange,
}: {
	term: Term | null;
	guidance: TermGuidance;
	locales: Locale[];
	canEdit: boolean;
	onSave: DictionaryProps["onSaveTerm"];
	allowCustomLocales?: boolean;
	onUnsavedWorkChange?: (hasUnsavedWork: boolean) => void;
	onCancel: () => void;
}) {
	const [sourceTerm, setSourceTerm] = useState(term?.sourceTerm ?? "");
	const [definition, setDefinition] = useState(term?.definition ?? "");
	const [untranslatable, setUntranslatable] = useState(
		term?.kind === "untranslatable",
	);
	const [renderings, setRenderings] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			term?.kind === "translated"
				? term.renderings.map((item) => [item.localeCode, item.value])
				: [],
		),
	);
	const [renderingLocale, setRenderingLocale] = useState(
		term?.kind === "translated"
			? (term.renderings[0]?.localeCode ?? locales[0]?.code)
			: locales[0]?.code,
	);
	const [newLocale, setNewLocale] = useState("");
	const [addedLocales, setAddedLocales] = useState<Locale[]>([]);
	const renderingLocales = [
		...locales,
		...addedLocales.filter(
			(item) => !locales.some((locale) => locale.code === item.code),
		),
	];
	const [expectedRevision, setExpectedRevision] = useState(guidance.revision);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hasUnsavedWork =
		busy ||
		sourceTerm !== (term?.sourceTerm ?? "") ||
		definition !== (term?.definition ?? "") ||
		untranslatable !== (term?.kind === "untranslatable") ||
		newLocale.length > 0 ||
		Object.entries(renderings).some(
			([code, value]) =>
				value !==
				(term?.kind === "translated"
					? (term.renderings.find((item) => item.localeCode === code)?.value ??
						"")
					: ""),
		);
	useEffect(() => {
		onUnsavedWorkChange?.(hasUnsavedWork);
	}, [hasUnsavedWork, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange?.(false), [onUnsavedWorkChange]);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!canEdit || busy || expectedRevision !== guidance.revision) return;
		setBusy(true);
		setError(null);
		try {
			if (
				term === null &&
				guidance.terms.some(
					(entry) => entry.term.sourceTerm === sourceTerm.trim(),
				)
			) {
				throw new Error(
					`“${sourceTerm.trim()}” already exists. Cancel this draft and use Edit ${sourceTerm.trim()} to change it.`,
				);
			}
			await onSave({
				expectedRevision,
				term: untranslatable
					? { sourceTerm, definition, kind: "untranslatable" }
					: {
							sourceTerm,
							definition,
							kind: "translated",
							renderings: Object.entries(renderings)
								.filter(([, value]) => value.trim().length > 0)
								.map(([localeCode, value]) => ({ localeCode, value })),
						},
			});
			onCancel();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<form onSubmit={submit} aria-label="Dictionary entry">
			<fieldset disabled={!canEdit || busy} className="min-w-0">
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="guidance-term">Source term</FieldLabel>
						<Input
							id="guidance-term"
							value={sourceTerm}
							required
							readOnly={term !== null}
							onChange={(event) => setSourceTerm(event.target.value)}
						/>
						{term ? (
							<FieldDescription>
								To rename a term, remove it and add the new term.
							</FieldDescription>
						) : null}
					</Field>
					<Field>
						<FieldLabel htmlFor="guidance-definition">
							Meaning and usage
						</FieldLabel>
						<Textarea
							id="guidance-definition"
							value={definition}
							required
							onChange={(event) => setDefinition(event.target.value)}
						/>
					</Field>
					<Field orientation="horizontal">
						<Checkbox
							id="guidance-untranslatable"
							checked={untranslatable}
							onCheckedChange={(checked) => setUntranslatable(checked === true)}
						/>
						<FieldLabel htmlFor="guidance-untranslatable">
							Keep this term unchanged in every Locale
						</FieldLabel>
					</Field>
					{!untranslatable ? (
						<>
							<LocalePicker
								id="term-locale"
								configuredCodes={Object.entries(renderings)
									.filter(([, value]) => value.trim().length > 0)
									.map(([code]) => code)}
								label="Rendering Locale"
								locales={renderingLocales}
								value={renderingLocale}
								onChange={setRenderingLocale}
							/>
							{allowCustomLocales ? (
								<Field>
									<FieldLabel htmlFor="term-new-locale">
										Add rendering language
									</FieldLabel>
									<div className="flex gap-2">
										<Input
											id="term-new-locale"
											placeholder="e.g. pt-BR"
											value={newLocale}
											onChange={(event) => setNewLocale(event.target.value)}
										/>
										<Button
											type="button"
											variant="outline"
											disabled={!newLocale.trim()}
											onClick={() => {
												try {
													const code = Intl.getCanonicalLocales(
														newLocale.trim().replaceAll("_", "-"),
													)[0];
													if (!code) throw new Error("Enter a locale code.");
													setAddedLocales((previous) =>
														previous.some((item) => item.code === code)
															? previous
															: [...previous, { code, label: code }],
													);
													setRenderingLocale(code);
													setNewLocale("");
													setError(null);
												} catch {
													setError(
														"Enter a valid language code, such as fr or pt-BR.",
													);
												}
											}}
										>
											Add language
										</Button>
									</div>
								</Field>
							) : null}
							{renderingLocale ? (
								<Field>
									<FieldLabel htmlFor={`term-${renderingLocale}`}>
										Preferred translation · {renderingLocale}
									</FieldLabel>
									<Input
										id={`term-${renderingLocale}`}
										value={renderings[renderingLocale] ?? ""}
										onChange={(event) =>
											setRenderings((previous) => ({
												...previous,
												[renderingLocale]: event.target.value,
											}))
										}
									/>
								</Field>
							) : null}
							<FieldDescription>
								Add at least one translation. Switching languages keeps edits;
								clearing a translation removes it.
							</FieldDescription>
						</>
					) : null}
					<DraftActions
						currentRevision={guidance.revision}
						expectedRevision={expectedRevision}
						onUseCurrent={() => {
							setExpectedRevision(guidance.revision);
							setError(null);
						}}
						onCancel={onCancel}
						busy={busy}
						canEdit={canEdit}
						error={error}
						label="Save term"
					/>
				</FieldGroup>
			</fieldset>
		</form>
	);
}

function VoiceEditor({
	locale,
	guide,
	guidance,
	canEdit,
	onSave,
	onCancel,
}: {
	locale?: Locale;
	guide:
		| { text: string; examples: { source: string; target: string }[] }
		| null
		| undefined;
	guidance: Guidance;
	canEdit: boolean;
	onSave: Props["onSaveProjectVoiceGuide"];
	onCancel: () => void;
}) {
	const [text, setText] = useState(guide?.text ?? "");
	const [examples, setExamples] = useState(() =>
		(guide?.examples ?? []).map((example) => ({
			...example,
			id: crypto.randomUUID(),
		})),
	);
	const [expectedRevision, setExpectedRevision] = useState(guidance.revision);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!canEdit || busy || expectedRevision !== guidance.revision) return;
		setBusy(true);
		setError(null);
		try {
			await onSave({
				expectedRevision,
				text,
				examples: examples.map(({ source, target }) => ({ source, target })),
			});
			onCancel();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<form
			onSubmit={submit}
			aria-label={
				locale ? `Voice guide for ${locale.code}` : "Project voice guide"
			}
		>
			<fieldset disabled={!canEdit || busy} className="min-w-0">
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="voice-text">
							{locale
								? `Language add-on · ${locale.label ?? locale.code}`
								: "Project voice guidance"}
						</FieldLabel>
						<Textarea
							id="voice-text"
							value={text}
							onChange={(event) => setText(event.target.value)}
							rows={5}
						/>
						<FieldDescription>
							{locale
								? "Language-specific conventions. The project voice still applies."
								: "Applies to every language."}
						</FieldDescription>
					</Field>
					{examples.map((example, index) => (
						<FieldGroup key={example.id}>
							<Field>
								<FieldLabel htmlFor={`example-source-${example.id}`}>
									Example {index + 1} · {locale ? "Source" : "Before"}
								</FieldLabel>
								<Textarea
									id={`example-source-${example.id}`}
									value={example.source}
									required
									onChange={(event) =>
										setExamples((previous) =>
											previous.map((item) =>
												item.id === example.id
													? { ...item, source: event.target.value }
													: item,
											),
										)
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`example-target-${example.id}`}>
									Example {index + 1} · {locale?.code ?? "Preferred wording"}
								</FieldLabel>
								<Textarea
									id={`example-target-${example.id}`}
									value={example.target}
									required
									onChange={(event) =>
										setExamples((previous) =>
											previous.map((item) =>
												item.id === example.id
													? { ...item, target: event.target.value }
													: item,
											),
										)
									}
								/>
							</Field>
							<Button
								type="button"
								variant="outline"
								onClick={() =>
									setExamples((previous) =>
										previous.filter((item) => item.id !== example.id),
									)
								}
							>
								Remove example {index + 1}
							</Button>
						</FieldGroup>
					))}
					<Button
						type="button"
						variant="outline"
						disabled={examples.length >= 5}
						onClick={() =>
							setExamples((previous) => [
								...previous,
								{ id: crypto.randomUUID(), source: "", target: "" },
							])
						}
					>
						Add example
					</Button>
					<DraftActions
						currentRevision={guidance.revision}
						expectedRevision={expectedRevision}
						onUseCurrent={() => {
							setExpectedRevision(guidance.revision);
							setError(null);
						}}
						onCancel={onCancel}
						busy={busy}
						canEdit={canEdit}
						error={error}
						label={locale ? "Save language add-on" : "Save project voice guide"}
					/>
				</FieldGroup>
			</fieldset>
		</form>
	);
}

function SavedVoice({
	guide,
	localeCode,
}: {
	guide: {
		text: string;
		examples: { source: string; target: string }[];
		revisionId: string;
	};
	localeCode?: string;
}) {
	return (
		<div className="flex flex-col gap-3">
			<p className="whitespace-pre-wrap">{guide.text}</p>
			{guide.examples.map((example, index) => (
				<dl
					// biome-ignore lint/suspicious/noArrayIndexKey: Immutable saved examples have no local state.
					key={`${guide.revisionId}-${index}`}
					className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
				>
					<dt>{localeCode ? "Source" : "Before"}</dt>
					<dd className="min-w-0 whitespace-pre-wrap break-words">
						{example.source}
					</dd>
					<dt>{localeCode ?? "Preferred wording"}</dt>
					<dd className="min-w-0 whitespace-pre-wrap break-words">
						{example.target}
					</dd>
				</dl>
			))}
		</div>
	);
}

export function TranslationGuidanceEditor({
	guidance,
	locales,
	canEdit,
	onSaveVoiceGuide,
	onSaveProjectVoiceGuide,
}: Props) {
	const [editingLocale, setEditingLocale] = useState<string>();
	const [editingProjectGuide, setEditingProjectGuide] = useState(false);
	const [selectedLocale, setSelectedLocale] = useState(
		guidance.guides[0]?.localeCode ?? locales[0]?.code,
	);
	const locale = locales.find((item) => item.code === selectedLocale);
	const guide = guidance.guides.find(
		(item) => item.localeCode === selectedLocale,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function remove(action: () => Promise<unknown>) {
		if (!canEdit || busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="flex flex-col gap-4">
			{!canEdit ? (
				<Alert>
					<AlertDescription>
						Read-only. Project editors and owners can change guidance.
					</AlertDescription>
				</Alert>
			) : null}
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<Card size="sm">
				<CardHeader>
					<CardTitle>Project voice guide</CardTitle>
					<CardDescription>
						Audience, tone, and writing conventions for every language.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{editingProjectGuide ? (
						<VoiceEditor
							guidance={guidance}
							guide={guidance.projectGuide}
							canEdit={canEdit}
							onSave={onSaveProjectVoiceGuide}
							onCancel={() => setEditingProjectGuide(false)}
						/>
					) : null}
					{guidance.projectGuide ? (
						<SavedVoice guide={guidance.projectGuide} />
					) : (
						<p className="text-muted-foreground">
							No project voice guidance yet.
						</p>
					)}
					{canEdit ? (
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								disabled={
									busy || editingProjectGuide || editingLocale !== undefined
								}
								onClick={() => setEditingProjectGuide(true)}
							>
								{guidance.projectGuide ? "Edit" : "Add"} project voice guide
							</Button>
							{guidance.projectGuide ? (
								<Button
									variant="ghost"
									disabled={busy || editingProjectGuide}
									onClick={() =>
										void remove(() =>
											onSaveProjectVoiceGuide({
												expectedRevision: guidance.revision,
												text: "",
												examples: [],
											}),
										)
									}
								>
									Remove project voice guide
								</Button>
							) : null}
						</div>
					) : null}
					<details>
						<summary className="cursor-pointer text-muted-foreground text-sm">
							Language add-ons · {guidance.guides.length}
						</summary>
						<div className="flex flex-col gap-4 pt-4">
							<p className="text-muted-foreground text-sm">
								Optional language-specific guidance.
							</p>
							<LocalePicker
								id="voice-locale"
								configuredCodes={guidance.guides.map((item) => item.localeCode)}
								label="Language add-on"
								locales={locales}
								value={selectedLocale}
								onChange={setSelectedLocale}
								disabled={editingLocale !== undefined}
							/>
							{locale ? (
								<>
									{editingLocale === locale.code ? (
										<VoiceEditor
											key={locale.code}
											locale={locale}
											guide={guide}
											guidance={guidance}
											canEdit={canEdit && locale.active !== false}
											onSave={(input) =>
												onSaveVoiceGuide({ ...input, localeCode: locale.code })
											}
											onCancel={() => setEditingLocale(undefined)}
										/>
									) : null}
									{guide ? (
										<SavedVoice guide={guide} localeCode={locale.code} />
									) : (
										<p className="text-muted-foreground">
											No add-on for {locale.code}. The project voice guide
											applies.
										</p>
									)}
									{canEdit ? (
										<div className="flex flex-wrap gap-2">
											<Button
												variant="outline"
												disabled={
													busy ||
													editingProjectGuide ||
													editingLocale !== undefined ||
													locale.active === false
												}
												onClick={() => setEditingLocale(locale.code)}
											>
												{guide ? "Edit" : "Add"} {locale.code} add-on
											</Button>
											{guide ? (
												<Button
													variant="ghost"
													disabled={busy || editingLocale !== undefined}
													onClick={() =>
														void remove(() =>
															onSaveVoiceGuide({
																expectedRevision: guidance.revision,
																localeCode: locale.code,
																text: "",
																examples: [],
															}),
														)
													}
												>
													Remove {locale.code} add-on
												</Button>
											) : null}
										</div>
									) : null}
								</>
							) : null}
						</div>
					</details>
				</CardContent>
			</Card>
		</div>
	);
}

export function DictionaryEditor({
	guidance,
	locales,
	canEdit,
	onSaveTerm,
	onRemoveTerm,
	allowCustomLocales = false,
	onUnsavedWorkChange,
}: DictionaryProps) {
	const [editingTerm, setEditingTerm] = useState<Term | null | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function remove(action: () => Promise<unknown>) {
		if (!canEdit || busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="flex flex-col gap-4">
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<Card size="sm">
				<CardHeader>
					<CardTitle>Dictionary</CardTitle>
					<CardDescription>Agreed terms and translations.</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{editingTerm !== undefined ? (
						<TermEditor
							term={editingTerm}
							guidance={guidance}
							locales={locales}
							canEdit={canEdit}
							allowCustomLocales={allowCustomLocales}
							onUnsavedWorkChange={onUnsavedWorkChange}
							onSave={onSaveTerm}
							onCancel={() => setEditingTerm(undefined)}
						/>
					) : canEdit ? (
						<Button disabled={busy} onClick={() => setEditingTerm(null)}>
							Add term
						</Button>
					) : null}
					{guidance.terms.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No terms yet</EmptyTitle>
								<EmptyDescription>
									Add terms and preferred translations.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						guidance.terms.map(({ term }) => (
							<article
								key={term.sourceTerm}
								className="flex flex-col gap-2 border-b pb-4 last:border-0 last:pb-0"
							>
								<strong className="break-words">{term.sourceTerm}</strong>
								<p className="whitespace-pre-wrap break-words">
									{term.definition}
								</p>
								{term.kind === "untranslatable" ? (
									<p>Keep unchanged in every language.</p>
								) : (
									<details>
										<summary className="cursor-pointer text-muted-foreground text-sm">
											{term.renderings.length} translation
											{term.renderings.length === 1 ? "" : "s"}
										</summary>
										<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
											{term.renderings.map((rendering) => (
												<div key={rendering.localeCode} className="contents">
													<dt>{rendering.localeCode}</dt>
													<dd className="min-w-0 whitespace-pre-wrap break-words">
														{rendering.value}
													</dd>
												</div>
											))}
										</dl>
									</details>
								)}
								{canEdit ? (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											disabled={busy || editingTerm !== undefined}
											onClick={() => setEditingTerm(term)}
										>
											Edit {term.sourceTerm}
										</Button>
										<Button
											variant="ghost"
											disabled={busy || editingTerm !== undefined}
											onClick={() =>
												void remove(() =>
													onRemoveTerm({
														expectedRevision: guidance.revision,
														sourceTerm: term.sourceTerm,
													}),
												)
											}
										>
											Remove {term.sourceTerm}
										</Button>
									</div>
								) : null}
							</article>
						))
					)}
				</CardContent>
			</Card>
		</div>
	);
}
