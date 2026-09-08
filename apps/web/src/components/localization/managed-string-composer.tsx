import { Button } from "@blabla/ui/components/button";
import { Field, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import { useEffect, useRef, useState } from "react";

type NewString = { sourceValue: string; name: string | null; context: string };

/** A successful save leaves a fresh editor in place; failed saves retain the draft. */
export function ManagedStringComposer({
	onCreate,
	onOpen,
	onUnsavedWorkChange,
}: {
	onCreate: (input: NewString) => Promise<string>;
	onOpen: (messageId: string) => void;
	onUnsavedWorkChange: (dirty: boolean) => void;
}) {
	const [value, setValue] = useState("");
	const [name, setName] = useState("");
	const [context, setContext] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const sending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<{ id: string; label: string } | null>(
		null,
	);
	const sourceInput = useRef<HTMLTextAreaElement>(null);
	const dirty = value.length > 0 || name.length > 0 || context.length > 0;
	useEffect(() => {
		onUnsavedWorkChange(dirty || pending);
	}, [dirty, pending, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange(false), [onUnsavedWorkChange]);
	useEffect(() => {
		if (saved) sourceInput.current?.focus();
	}, [saved]);

	async function submit() {
		if (sending.current || !value.trim()) return;
		sending.current = true;
		setPending(true);
		setError(null);
		try {
			const id = await onCreate({
				sourceValue: value,
				name: name.trim() || null,
				context,
			});
			setSaved({ id, label: name.trim() || value });
			setValue("");
			setName("");
			setContext("");
			setDetailsOpen(false);
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
			className="mb-4 rounded-md border bg-card p-3"
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
			<fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
				<Field>
					<FieldLabel htmlFor="new-string-text" className="sr-only">
						New source text
					</FieldLabel>
					<Textarea
						ref={sourceInput}
						id="new-string-text"
						placeholder="Write a new string…"
						rows={2}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						aria-describedby="new-string-shortcut"
					/>
				</Field>
				<details
					open={detailsOpen}
					onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
				>
					<summary className="w-fit cursor-pointer text-muted-foreground text-xs">
						Name and context{" "}
						<span className="text-muted-foreground">(optional)</span>
					</summary>
					<div className="mt-3 grid gap-3 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="new-string-name">Name</FieldLabel>
							<Input
								id="new-string-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="App Store subtitle"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="new-string-context">Context</FieldLabel>
							<Textarea
								id="new-string-context"
								value={context}
								onChange={(event) => setContext(event.target.value)}
								rows={2}
								placeholder="Where it appears, meaning, or length guidance"
							/>
						</Field>
					</div>
				</details>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span
						id="new-string-shortcut"
						className="text-muted-foreground text-xs"
					>
						⌘/Ctrl + Enter to add · Enter for a new line
					</span>
					<Button type="submit" size="sm" disabled={pending || !value.trim()}>
						{pending ? "Adding…" : "Add string"}
					</Button>
				</div>
			</fieldset>
			{error && (
				<p role="alert" className="mt-2 text-destructive text-sm">
					{error}
				</p>
			)}
			{saved && (
				<div className="mt-2 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
					<span role="status" className="truncate">
						Added: {saved.label}
					</span>
					<Button
						type="button"
						variant="link"
						size="sm"
						onClick={() => onOpen(saved.id)}
					>
						View string
					</Button>
				</div>
			)}
		</form>
	);
}
