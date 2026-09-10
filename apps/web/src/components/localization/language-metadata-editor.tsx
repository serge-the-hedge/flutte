import { Alert, AlertDescription } from "@blabla/ui/components/alert";
import { Button } from "@blabla/ui/components/button";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { useMutation } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { api, convexId } from "@/lib/convex-api";

export type EditableLanguage = {
	_id: string;
	code: string;
	label: string;
	isSource: boolean;
	archivedAt?: number;
};

/** Keeps the original metadata as the save precondition while a draft is open. */
export function LanguageMetadataEditor({
	projectId,
	locale,
	codeRestriction,
	disabled = false,
	onClose,
	onUnsavedWorkChange,
}: {
	projectId: string;
	locale: EditableLanguage;
	codeRestriction?: string;
	disabled?: boolean;
	onClose: () => void;
	onUnsavedWorkChange: (dirty: boolean) => void;
}) {
	const updateMetadata = useMutation(api.locales.updateMetadata);
	const [original] = useState(locale);
	const [code, setCode] = useState(locale.code);
	const [label, setLabel] = useState(locale.label);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sending = useRef(false);
	const id = useId();
	const dirty =
		code.trim() !== original.code || label.trim() !== original.label;
	const blockedCodeChange =
		Boolean(codeRestriction) && code.trim() !== original.code;
	useEffect(() => {
		onUnsavedWorkChange(dirty || pending);
	}, [dirty, pending, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange(false), [onUnsavedWorkChange]);
	return (
		<form
			aria-label={`Edit ${original.label}`}
			className="w-full py-2"
			onSubmit={async (event) => {
				event.preventDefault();
				if (
					sending.current ||
					disabled ||
					blockedCodeChange ||
					!dirty ||
					!code.trim() ||
					!label.trim()
				)
					return;
				sending.current = true;
				setPending(true);
				setError(null);
				try {
					await updateMetadata({
						projectId: convexId<"projects">(projectId),
						localeId: convexId<"locales">(original._id),
						code: code.trim(),
						label: label.trim(),
						expectedCode: original.code,
						expectedLabel: original.label,
					});
					onClose();
				} catch (cause) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not update this language. Try again.",
					);
				} finally {
					sending.current = false;
					setPending(false);
				}
			}}
		>
			<FieldGroup>
				<div className="flex flex-wrap gap-3">
					<Field
						className="min-w-32 flex-1"
						data-disabled={disabled || pending || Boolean(codeRestriction)}
					>
						<FieldLabel htmlFor={`${id}-code`}>Language code</FieldLabel>
						<Input
							id={`${id}-code`}
							value={code}
							required
							disabled={disabled || pending || Boolean(codeRestriction)}
							onChange={(event) => setCode(event.target.value)}
						/>
						{codeRestriction ? (
							<FieldDescription>{codeRestriction}</FieldDescription>
						) : null}
					</Field>
					<Field
						className="min-w-40 flex-1"
						data-disabled={disabled || pending}
					>
						<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
						<Input
							id={`${id}-name`}
							value={label}
							required
							disabled={disabled || pending}
							onChange={(event) => setLabel(event.target.value)}
						/>
					</Field>
				</div>
				<div className="flex gap-2">
					<Button
						type="submit"
						size="sm"
						disabled={
							disabled ||
							pending ||
							blockedCodeChange ||
							!dirty ||
							!code.trim() ||
							!label.trim()
						}
					>
						{pending ? "Saving…" : "Save"}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={pending}
						onClick={onClose}
					>
						Cancel
					</Button>
				</div>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
			</FieldGroup>
		</form>
	);
}
