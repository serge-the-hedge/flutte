import { characterCount } from "@blabla/backend/convex/characterLimits";
import { Button } from "@blabla/ui/components/button";
import {
	Field,
	FieldDescription,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { cn } from "@blabla/ui/lib/utils";
import { useMutation } from "convex/react";
import { useEffect, useId, useState } from "react";
import { api, convexId } from "@/lib/convex-api";

export function parsedCharacterLimit(value: string): number | undefined {
	if (!value.trim()) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function CharacterLimitField({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const invalid = value !== "" && parsedCharacterLimit(value) === undefined;
	return (
		<Field data-invalid={invalid || undefined}>
			<FieldLabel htmlFor={id}>
				Character limit{" "}
				<span className="text-muted-foreground">(optional)</span>
			</FieldLabel>
			<Input
				id={id}
				type="number"
				min={1}
				step={1}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				disabled={disabled}
				placeholder="No limit"
				aria-invalid={invalid || undefined}
				aria-describedby={`${id}-help`}
				className="max-w-40"
			/>
			<FieldDescription id={`${id}-help`}>
				All languages, including source. Spaces and line breaks count.
			</FieldDescription>
		</Field>
	);
}

export function CharacterCount({
	value,
	limit,
}: {
	value: string;
	limit?: number;
}) {
	if (limit === undefined) return null;
	const count = characterCount(value);
	const over = count > limit;
	return (
		<p
			className={cn(
				"px-2 text-right text-xs tabular-nums",
				over ? "text-destructive" : "text-muted-foreground",
			)}
			aria-live="polite"
		>
			{count} / {limit}
			{over ? ` · ${count - limit} over limit` : ""}
		</p>
	);
}

export function RepositoryCharacterLimit({
	projectId,
	messageId,
	limit,
	onClose,
	onUnsavedWorkChange,
	onBusyChange,
	disabled,
}: {
	projectId: string;
	messageId: string;
	limit?: number;
	onClose: () => void;
	onUnsavedWorkChange: (dirty: boolean) => void;
	onBusyChange?: (busy: boolean) => void;
	disabled?: boolean;
}) {
	const save = useMutation(api.messageConstraints.setCharacterLimit);
	const [value, setValue] = useState(limit?.toString() ?? "");
	const [expected] = useState(limit ?? null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		onBusyChange?.(busy);
	}, [busy, onBusyChange]);
	useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
	const dirty = value !== (expected?.toString() ?? "");
	useEffect(() => {
		onUnsavedWorkChange(dirty || busy);
	}, [dirty, busy, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange(false), [onUnsavedWorkChange]);
	useEffect(() => {
		if (!dirty && !busy) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty, busy]);
	const [error, setError] = useState<string | null>(null);
	return (
		<form
			className="flex flex-col gap-3 rounded-md border p-3"
			onSubmit={async (event) => {
				event.preventDefault();
				if (
					disabled ||
					busy ||
					(value !== "" && parsedCharacterLimit(value) === undefined)
				)
					return;
				setBusy(true);
				setError(null);
				try {
					await save({
						projectId: convexId<"projects">(projectId),
						messageId,
						characterLimit: parsedCharacterLimit(value) ?? null,
						expectedCharacterLimit: expected,
					});
					onClose();
				} catch (cause) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not save character limit.",
					);
				} finally {
					setBusy(false);
				}
			}}
		>
			<h2 className="font-medium">{messageId}</h2>
			<CharacterLimitField
				value={value}
				onChange={setValue}
				disabled={disabled || busy}
			/>
			<div className="flex gap-2">
				<Button
					type="submit"
					size="xs"
					disabled={
						disabled ||
						busy ||
						(value !== "" && parsedCharacterLimit(value) === undefined)
					}
				>
					Save
				</Button>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={busy}
					onClick={onClose}
				>
					Cancel
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			) : null}
		</form>
	);
}
