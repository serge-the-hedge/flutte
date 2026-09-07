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
import { Textarea } from "@blabla/ui/components/textarea";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { type FormEvent, useState } from "react";
import type { api } from "@/lib/convex-api";

type Guidance = FunctionReturnType<typeof api.translationGuidance.list>;
type TermInput = Omit<
	FunctionArgs<typeof api.translationGuidance.saveTerm>,
	"projectId"
>;
type VoiceInput = Omit<
	FunctionArgs<typeof api.translationGuidance.saveVoiceGuide>,
	"projectId"
>;
type Term = TermInput["term"];
type Locale = { code: string; label?: string; active?: boolean };
type Props = {
	guidance: Guidance;
	locales: Locale[];
	canEdit: boolean;
	onSaveTerm: (input: TermInput) => Promise<unknown>;
	onRemoveTerm: (input: {
		expectedRevision: number;
		sourceTerm: string;
	}) => Promise<unknown>;
	onSaveVoiceGuide: (input: VoiceInput) => Promise<unknown>;
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
						Saved guidance changed while this draft was open. Compare the
						current saved entries below before keeping your draft.
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

function TermEditor({
	term,
	guidance,
	locales,
	canEdit,
	onSave,
	onCancel,
}: {
	term: Term | null;
	guidance: Guidance;
	locales: Locale[];
	canEdit: boolean;
	onSave: Props["onSaveTerm"];
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
	const [expectedRevision, setExpectedRevision] = useState(guidance.revision);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
					{!untranslatable
						? locales.map((locale) => (
								<Field key={locale.code}>
									<FieldLabel htmlFor={`term-${locale.code}`}>
										{locale.label ?? locale.code} ({locale.code}) rendering
										{locale.active === false ? " · archived" : ""}
									</FieldLabel>
									<Input
										id={`term-${locale.code}`}
										value={renderings[locale.code] ?? ""}
										onChange={(event) =>
											setRenderings((previous) => ({
												...previous,
												[locale.code]: event.target.value,
											}))
										}
									/>
								</Field>
							))
						: null}
					{!untranslatable ? (
						<FieldDescription>
							Provide at least one preferred rendering. Leave other Locales
							blank when no rendering has been decided.
						</FieldDescription>
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
	locale: Locale;
	guide: Guidance["guides"][number] | undefined;
	guidance: Guidance;
	canEdit: boolean;
	onSave: Props["onSaveVoiceGuide"];
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
				localeCode: locale.code,
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
		<form onSubmit={submit} aria-label={`Voice guide for ${locale.code}`}>
			<fieldset disabled={!canEdit || busy} className="min-w-0">
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="voice-text">
							Voice guidance · {locale.label ?? locale.code}
						</FieldLabel>
						<Textarea
							id="voice-text"
							value={text}
							onChange={(event) => setText(event.target.value)}
							rows={5}
						/>
						<FieldDescription>
							Describe the agreed tone, address, and writing conventions for
							this Locale.
						</FieldDescription>
					</Field>
					{examples.map((example, index) => (
						<FieldGroup key={example.id}>
							<Field>
								<FieldLabel htmlFor={`example-source-${example.id}`}>
									Example {index + 1} · Source
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
									Example {index + 1} · {locale.code}
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
						label="Save voice guide"
					/>
				</FieldGroup>
			</fieldset>
		</form>
	);
}

export function TranslationGuidanceEditor({
	guidance,
	locales,
	canEdit,
	onSaveTerm,
	onRemoveTerm,
	onSaveVoiceGuide,
}: Props) {
	const [editingTerm, setEditingTerm] = useState<Term | null | undefined>();
	const [editingLocale, setEditingLocale] = useState<string>();
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
						Editors and owners can manage translation guidance. You have read
						access.
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
					<CardTitle>Dictionary</CardTitle>
					<CardDescription>
						Agreed product terms and Locale renderings for translators and
						reviewers.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{editingTerm !== undefined ? (
						<TermEditor
							term={editingTerm}
							guidance={guidance}
							locales={locales}
							canEdit={canEdit}
							onSave={onSaveTerm}
							onCancel={() => setEditingTerm(undefined)}
						/>
					) : canEdit ? (
						<Button onClick={() => setEditingTerm(null)}>Add term</Button>
					) : null}
					{guidance.terms.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No Dictionary entries</EmptyTitle>
								<EmptyDescription>
									Add terms when the project has agreed how to use them.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						guidance.terms.map(({ term }) => (
							<article
								key={term.sourceTerm}
								className="flex flex-col gap-2 border-b pb-4 last:border-0 last:pb-0"
							>
								<strong>{term.sourceTerm}</strong>
								<p className="whitespace-pre-wrap">{term.definition}</p>
								{term.kind === "untranslatable" ? (
									<p>Keep unchanged in every Locale.</p>
								) : (
									<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
										{term.renderings.map((rendering) => (
											<div key={rendering.localeCode} className="contents">
												<dt>{rendering.localeCode}</dt>
												<dd className="whitespace-pre-wrap">
													{rendering.value}
												</dd>
											</div>
										))}
									</dl>
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
			<Card size="sm">
				<CardHeader>
					<CardTitle>Locale voice guidance</CardTitle>
					<CardDescription>
						Write the project’s agreed voice and up to five Source/target
						examples per Locale. Empty guides add no instructions.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{locales.map((locale) => {
						const guide = guidance.guides.find(
							(item) => item.localeCode === locale.code,
						);
						return (
							<article
								key={locale.code}
								className="flex flex-col gap-3 border-b pb-4 last:border-0 last:pb-0"
							>
								<strong>
									{locale.label ?? locale.code} ({locale.code})
									{locale.active === false ? " · archived" : ""}
								</strong>
								{editingLocale === locale.code ? (
									<VoiceEditor
										locale={locale}
										guide={guide}
										guidance={guidance}
										canEdit={canEdit}
										onSave={onSaveVoiceGuide}
										onCancel={() => setEditingLocale(undefined)}
									/>
								) : null}
								{guide ? (
									<>
										<p className="whitespace-pre-wrap">{guide.text}</p>
										{guide.examples.map((example, index) => (
											<dl
												// biome-ignore lint/suspicious/noArrayIndexKey: Saved examples have no local state and are replaced as one immutable guide revision.
												key={`${guide.revisionId}-${index}`}
												className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
											>
												<dt>Source</dt>
												<dd className="whitespace-pre-wrap">
													{example.source}
												</dd>
												<dt>{locale.code}</dt>
												<dd className="whitespace-pre-wrap">
													{example.target}
												</dd>
											</dl>
										))}
									</>
								) : (
									<p className="text-muted-foreground">
										No voice guidance yet.
									</p>
								)}
								{canEdit ? (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											disabled={
												busy ||
												editingLocale !== undefined ||
												locale.active === false
											}
											onClick={() => setEditingLocale(locale.code)}
										>
											{guide ? "Edit" : "Add"} {locale.code} voice guide
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
												Remove {locale.code} voice guide
											</Button>
										) : null}
									</div>
								) : null}
							</article>
						);
					})}
				</CardContent>
			</Card>
		</div>
	);
}
