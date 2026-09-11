/** Throwaway: three structures for the same string properties and locale editor. */
import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import { cn } from "@blabla/ui/lib/utils";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PrototypeVariant } from "@/components/prototype-switcher";
import type { PrototypeString } from "./strings.prototype-data";

type EditorProps = {
	draft: PrototypeString;
	panel: string;
	onPanel: (panel: string) => void;
	onChange: (row: PrototypeString) => void;
};
function Properties({
	draft,
	onChange,
}: Pick<EditorProps, "draft" | "onChange">) {
	const fieldId = useId();
	return (
		<div className="flex flex-col gap-4" data-properties>
			<label
				htmlFor={`${fieldId}-name`}
				className="flex flex-col gap-1.5 text-sm"
			>
				Name
				<Input
					id={`${fieldId}-name`}
					value={draft.name ?? ""}
					placeholder="Optional"
					onChange={(e) => onChange({ ...draft, name: e.target.value || null })}
				/>
			</label>
			<label
				htmlFor={`${fieldId}-context`}
				className="flex flex-col gap-1.5 text-sm"
			>
				Context
				<Textarea
					id={`${fieldId}-context`}
					value={draft.context ?? ""}
					placeholder="Optional"
					className="min-h-20"
					onChange={(e) => onChange({ ...draft, context: e.target.value })}
				/>
			</label>
			<div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
				<label
					htmlFor={`${fieldId}-tags`}
					className="flex flex-col gap-1.5 text-sm"
				>
					Tags
					<Input
						id={`${fieldId}-tags`}
						value={draft.tags.join(",")}
						placeholder="App Store, Google Play"
						onChange={(e) =>
							onChange({ ...draft, tags: e.target.value.split(",") })
						}
					/>
				</label>
				<label
					htmlFor={`${fieldId}-limit`}
					className="flex flex-col gap-1.5 text-sm"
				>
					Character limit
					<Input
						id={`${fieldId}-limit`}
						type="number"
						min={1}
						step={1}
						value={draft.limit ?? ""}
						placeholder="None"
						onChange={(e) =>
							onChange({
								...draft,
								limit: e.target.value ? Number(e.target.value) : undefined,
							})
						}
					/>
				</label>
			</div>
		</div>
	);
}
function LocalePicker({ draft, panel, onPanel }: EditorProps) {
	return (
		<select
			aria-label="Editing language"
			className="h-9 max-w-full rounded-md border bg-background px-2 text-sm"
			value={panel === "properties" ? "" : panel}
			onChange={(e) => onPanel(e.target.value)}
		>
			<option value="" disabled>
				Choose language…
			</option>
			{draft.values.map((v, i) => (
				<option key={v.code} value={v.code}>
					{v.code}
					{i === 0 ? " · Source" : ""}
				</option>
			))}
		</select>
	);
}
function LocaleEditor({ draft, panel, onChange }: EditorProps) {
	const value = draft.values.find((v) => v.code === panel);
	if (!value) return null;
	const count = Array.from(value.text).length;
	return (
		<div
			className="flex min-h-0 flex-1 flex-col gap-2"
			data-locale-editor={panel}
		>
			<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
				<span>
					{panel === draft.values[0]?.code
						? "Source"
						: value.reviewed
							? "Reviewed"
							: "Needs review"}
				</span>
				<span
					className={cn(
						draft.limit !== undefined &&
							count > draft.limit &&
							"text-destructive",
					)}
				>
					{count.toLocaleString()}
					{draft.limit === undefined
						? " characters"
						: ` / ${draft.limit.toLocaleString()}`}
				</span>
			</div>
			<Textarea
				aria-label={`Edit ${panel}`}
				value={value.text}
				className="min-h-64 flex-1 resize-none text-sm leading-relaxed"
				onChange={(e) =>
					onChange({
						...draft,
						values: draft.values.map((v) =>
							v.code === panel
								? { ...v, text: e.target.value, reviewed: false }
								: v,
						),
					})
				}
			/>
		</div>
	);
}
export function AdvancedA(p: EditorProps) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b px-5 py-3">
				<Button
					variant={p.panel === "properties" ? "secondary" : "ghost"}
					size="sm"
					onClick={() => p.onPanel("properties")}
				>
					Properties
				</Button>
				<div className="ml-auto">
					<LocalePicker {...p} />
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-auto p-5">
				{p.panel === "properties" ? (
					<Properties {...p} />
				) : (
					<LocaleEditor {...p} />
				)}
			</div>
		</div>
	);
}
export function AdvancedB(p: EditorProps) {
	const [query, setQuery] = useState("");
	return (
		<div className="grid min-h-0 flex-1 grid-cols-[8rem_minmax(0,1fr)] sm:grid-cols-[10rem_minmax(0,1fr)]">
			<nav
				aria-label="String sections"
				className="flex min-h-0 flex-col gap-1 overflow-auto border-r p-2"
			>
				<Button
					className="justify-start"
					size="sm"
					variant={p.panel === "properties" ? "secondary" : "ghost"}
					onClick={() => p.onPanel("properties")}
				>
					Properties
				</Button>
				<Input
					aria-label="Find language"
					placeholder="Find language"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="my-2"
				/>
				{p.draft.values
					.filter((v) => v.code.toLowerCase().includes(query.toLowerCase()))
					.map((v) => (
						<Button
							key={v.code}
							className="shrink-0 justify-start"
							size="sm"
							variant={p.panel === v.code ? "secondary" : "ghost"}
							onClick={() => p.onPanel(v.code)}
						>
							{v.code}
						</Button>
					))}
			</nav>
			<div className="flex min-h-0 flex-col overflow-auto p-4 sm:p-5">
				<h3 className="mb-4 font-medium text-sm">
					{p.panel === "properties" ? "Properties" : p.panel}
				</h3>
				{p.panel === "properties" ? (
					<Properties {...p} />
				) : (
					<LocaleEditor {...p} />
				)}
			</div>
		</div>
	);
}
export function AdvancedC(p: EditorProps) {
	const source = p.draft.values[0]?.code ?? "";
	const editor = { ...p, panel: p.panel === "properties" ? source : p.panel };
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto">
			<details
				open={p.panel === "properties"}
				className="shrink-0 border-b px-5 py-3"
				onToggle={(event) => {
					if (event.currentTarget.open && p.panel !== "properties")
						p.onPanel("properties");
					if (!event.currentTarget.open && p.panel === "properties")
						p.onPanel(source);
				}}
			>
				<summary className="cursor-pointer text-sm">Properties</summary>
				<div className="py-4">
					<Properties {...p} />
				</div>
			</details>
			<div className="sticky top-0 flex shrink-0 items-center gap-3 border-b bg-background px-5 py-3">
				<LocalePicker {...editor} />
			</div>
			<div className="flex min-h-80 flex-1 flex-col p-5">
				<LocaleEditor {...editor} />
			</div>
		</div>
	);
}
export function AdvancedString({
	row,
	initialPanel,
	variant,
	onChange,
	onClose,
	onPanelChange,
}: {
	row: PrototypeString;
	initialPanel: string;
	variant: PrototypeVariant;
	onChange: (row: PrototypeString) => void;
	onClose: () => void;
	onPanelChange: (panel: string) => void;
}) {
	const [draft, setDraft] = useState(row);
	const [panel, setPanel] = useState(initialPanel);
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const onPanel = (next: string) => {
		setPanel(next);
		onPanelChange(next);
	};
	useEffect(() => {
		const element = dialog.current;
		const opener = document.activeElement;
		element?.showModal();
		return () => {
			element?.close();
			if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
		};
	}, []);
	useEffect(() => {
		dialog.current
			?.querySelector<HTMLElement>(
				panel === "properties"
					? "[data-properties] input"
					: "[data-locale-editor] textarea",
			)
			?.focus({ preventScroll: true });
	}, [panel]);
	const invalidLimit =
		draft.limit !== undefined &&
		(!Number.isInteger(draft.limit) || draft.limit < 1);
	const overLimit = draft.values.filter(
		(v) =>
			draft.limit !== undefined &&
			Array.from(v.text).length > draft.limit &&
			(draft.limit !== row.limit ||
				v.text !== row.values.find((old) => old.code === v.code)?.text),
	);
	const props = { draft, panel, onPanel, onChange: setDraft };
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			onCancel={onClose}
			className={cn(
				"fixed m-auto overflow-hidden rounded-lg border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40",
				variant === "B"
					? "inset-y-0 right-0 left-auto h-svh max-h-svh w-[min(64rem,100vw)] max-w-full rounded-r-none"
					: variant === "C"
						? "inset-0 h-[90svh] max-h-[90svh] w-[min(68rem,calc(100vw-2rem))]"
						: "inset-0 h-[min(44rem,90svh)] max-h-[90svh] w-[min(50rem,calc(100vw-2rem))]",
			)}
		>
			<div className="flex h-full min-h-0 flex-col">
				<header className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
					<h2
						id={titleId}
						className="min-w-0 flex-1 truncate font-medium text-sm"
					>
						{draft.name || row.values[0]?.text.slice(0, 70) || "String"}
					</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Close advanced view"
						onClick={onClose}
					>
						<X />
					</Button>
				</header>
				{variant === "A" ? (
					<AdvancedA {...props} />
				) : variant === "B" ? (
					<AdvancedB {...props} />
				) : (
					<AdvancedC {...props} />
				)}
				<footer className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
					<span className="mr-auto text-destructive text-xs">
						{invalidLimit
							? "Use a positive whole number."
							: overLimit.length
								? `Over limit: ${overLimit.map((v) => v.code).join(", ")}`
								: ""}
					</span>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={invalidLimit || overLimit.length > 0}
						onClick={() => {
							onChange({
								...draft,
								tags: [
									...new Set(draft.tags.map((t) => t.trim()).filter(Boolean)),
								],
							});
							onClose();
						}}
					>
						Save
					</Button>
				</footer>
			</div>
		</dialog>
	);
}
