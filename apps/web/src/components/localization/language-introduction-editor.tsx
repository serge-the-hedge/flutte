import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { LocaleSelector } from "./locale-selector";

export type LocaleIntroductionTarget = {
	localeCode: string;
	label: string;
	catalogPath: string;
	runtimeLocale: string;
};
const EMPTY_TARGET: LocaleIntroductionTarget = {
	localeCode: "",
	label: "",
	catalogPath: "",
	runtimeLocale: "",
};
const FIELDS = [
	{
		name: "localeCode",
		label: "Catalog code",
		placeholder: "ja",
		description: "2–3 letter language code in the ARB file.",
	},
	{ name: "label", label: "Language name", placeholder: "Japanese" },
	{
		name: "catalogPath",
		label: "Catalog path",
		placeholder: "packages/brickit_generated/lib/l10n/intl_ja.arb",
		description: "Repository-relative path for the new catalog.",
	},
	{
		name: "runtimeLocale",
		label: "Runtime locale",
		placeholder: "ja-JP",
		description:
			"App language code, including script or region if needed: pt-BR, zh-Hant-TW.",
	},
] as const;

/** Drafts belong to their Locale, so browsing another configuration cannot erase an edit. */
export function LanguageIntroductionEditor({
	targets,
	activeLocaleCodes,
	canEdit,
	onSave,
	onRemove,
}: {
	targets: readonly LocaleIntroductionTarget[];
	activeLocaleCodes: readonly string[];
	canEdit: boolean;
	onSave: (target: LocaleIntroductionTarget) => Promise<unknown>;
	onRemove: (localeCode: string) => Promise<unknown>;
}) {
	const [selectedCode, setSelectedCode] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<
		Record<string, LocaleIntroductionTarget>
	>({});
	const [busy, setBusy] = useState<"save" | "remove" | null>(null);
	const pending = useRef(false);
	const selected = targets.find((target) => target.localeCode === selectedCode);
	const draftKey = selectedCode ?? "";
	const draft = drafts[draftKey] ?? selected ?? EMPTY_TARGET;
	const alreadyActive =
		selectedCode !== null && activeLocaleCodes.includes(selectedCode);
	const disabled = !canEdit || busy !== null || alreadyActive;
	const clearDraft = (key: string) =>
		setDrafts((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
	const save = async () => {
		if (pending.current || disabled) return;
		pending.current = true;
		setBusy("save");
		try {
			await onSave(draft);
			clearDraft(draftKey);
			setSelectedCode(draft.localeCode.trim().toLowerCase());
			toast.success("Language saved.");
		} catch (cause) {
			toast.error(
				cause instanceof Error ? cause.message : "Could not save the language.",
			);
		} finally {
			pending.current = false;
			setBusy(null);
		}
	};
	const remove = async () => {
		if (pending.current || disabled || !selectedCode) return;
		pending.current = true;
		setBusy("remove");
		try {
			await onRemove(selectedCode);
			clearDraft(selectedCode);
			setSelectedCode(null);
			toast.success(
				"Language configuration removed. Prepared proposals are preserved.",
			);
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Could not remove the language.",
			);
		} finally {
			pending.current = false;
			setBusy(null);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>{selected ? selected.label : "Add a language"}</CardTitle>
				<CardDescription>
					Changes apply only to future proposals.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				<div className="flex flex-wrap items-center gap-2">
					<LocaleSelector
						locales={targets.map((target) => ({
							code: target.localeCode,
							label: target.label,
						}))}
						value={selectedCode}
						onChange={setSelectedCode}
						disabled={busy !== null}
						placeholder="Find a configured language"
					/>
					<Button
						variant="outline"
						disabled={busy !== null}
						onClick={() => setSelectedCode(null)}
					>
						Add language
					</Button>
				</div>
				{alreadyActive ? (
					<p className="text-muted-foreground text-sm">
						Already added. Manage its catalog in Sync.
					</p>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<FieldGroup>
							{FIELDS.map((field) => (
								<Field key={field.name} data-disabled={disabled}>
									<FieldLabel htmlFor={`language-${field.name}`}>
										{field.label}
									</FieldLabel>
									<Input
										id={`language-${field.name}`}
										value={draft[field.name]}
										placeholder={field.placeholder}
										required
										disabled={
											disabled ||
											(field.name === "localeCode" && selectedCode !== null)
										}
										onChange={(event) =>
											setDrafts((current) => ({
												...current,
												[draftKey]: {
													...draft,
													[field.name]: event.target.value,
												},
											}))
										}
									/>
									{"description" in field ? (
										<FieldDescription>{field.description}</FieldDescription>
									) : null}
								</Field>
							))}
							<div className="flex flex-wrap gap-2">
								<Button type="submit" disabled={disabled}>
									{busy === "save" ? "Saving…" : "Save language"}
								</Button>
								{drafts[draftKey] ? (
									<Button
										type="button"
										variant="outline"
										disabled={disabled}
										onClick={() => clearDraft(draftKey)}
									>
										Discard draft
									</Button>
								) : null}
								{selected ? (
									<Button
										type="button"
										variant="ghost"
										disabled={disabled}
										onClick={() => void remove()}
									>
										{busy === "remove" ? "Removing…" : "Remove configuration"}
									</Button>
								) : null}
							</div>
							{selected ? (
								<FieldDescription>
									Prepared proposals and reviews are kept.
								</FieldDescription>
							) : null}
						</FieldGroup>
					</form>
				)}
			</CardContent>
		</Card>
	);
}
