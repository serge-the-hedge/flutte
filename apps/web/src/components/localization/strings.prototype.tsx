/** THROWAWAY: three advanced-view layouts on the existing Strings route, ?variant=A|B|C.
 * Shared properties/locale entry points, compact previews and tags. Memory-only edits. */
import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@blabla/ui/components/sheet";
import { Textarea } from "@blabla/ui/components/textarea";
import { cn } from "@blabla/ui/lib/utils";
import {
	Check,
	ChevronDown,
	Download,
	Maximize2,
	SlidersHorizontal,
	Tag,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	PrototypeSwitcher,
	type PrototypeVariant,
} from "@/components/prototype-switcher";
import { AdvancedString } from "./strings.prototype-advanced";
import { exampleStrings, type PrototypeString } from "./strings.prototype-data";

type ViewProps = {
	rows: PrototypeString[];
	codes: string[];
	selected: string[];
	active: { id: string; panel: string } | null;
	onSelect: (id: string) => void;
	onOpen: (active: { id: string; panel: string } | null) => void;
	onChange: (row: PrototypeString) => void;
};
function CheckRow({
	id,
	selected,
	onSelect,
}: {
	id: string;
	selected: string[];
	onSelect: (id: string) => void;
}) {
	return (
		<input
			type="checkbox"
			aria-label={`Select ${id}`}
			checked={selected.includes(id)}
			onChange={() => onSelect(id)}
			className="size-3.5 shrink-0 accent-foreground"
		/>
	);
}
function ValueDraft({
	text,
	limit,
	label,
	onSave,
	onClose,
}: {
	text: string;
	limit?: number;
	label: string;
	onSave: (text: string) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(text);
	const input = useRef<HTMLTextAreaElement>(null);
	const count = Array.from(draft).length;
	const tooLong = limit !== undefined && count > limit;
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, []);
	return (
		<div className="flex min-h-0 flex-col gap-3">
			<Textarea
				ref={input}
				aria-label={label}
				value={draft}
				className="min-h-20 resize-none text-sm leading-relaxed"
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
					if (
						event.key === "Enter" &&
						(event.metaKey || event.ctrlKey) &&
						!tooLong
					) {
						event.preventDefault();
						onSave(draft);
					}
				}}
			/>
			<div className="flex items-center gap-2">
				<span
					className={cn(
						"mr-auto text-xs",
						tooLong ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{count.toLocaleString()}
					{limit === undefined ? " characters" : ` / ${limit.toLocaleString()}`}
				</span>
				<Button size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" disabled={tooLong} onClick={() => onSave(draft)}>
					Save
				</Button>
			</div>
		</div>
	);
}
function CompactValue({
	row,
	value,
	onChange,
	onOpen,
}: {
	row: PrototypeString;
	value: PrototypeString["values"][number];
	onChange: (row: PrototypeString) => void;
	onOpen: () => void;
}) {
	const preview = useRef<HTMLSpanElement>(null);
	const [overflow, setOverflow] = useState(false);
	const [editing, setEditing] = useState<"inline" | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Changed text can overflow without changing the clamped element height.
	useEffect(() => {
		const element = preview.current;
		if (!element || editing === "inline") return;
		const measure = () =>
			setOverflow(element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [value.text, editing]);
	const close = () => {
		setEditing(null);
		// Wait for the inline preview to mount before restoring keyboard focus.
		requestAnimationFrame(() =>
			preview.current?.closest("button")?.focus({ preventScroll: true }),
		);
	};
	const save = (text: string) => {
		onChange({
			...row,
			values: row.values.map((v) =>
				v.code === value.code ? { ...v, text, reviewed: false } : v,
			),
		});
		close();
	};
	return (
		<div
			className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 py-1"
			data-compact-value={value.code}
		>
			<span className="pt-0.5 text-[11px] text-muted-foreground">
				{value.code}
			</span>
			{editing === "inline" ? (
				<ValueDraft
					text={value.text}
					limit={row.limit}
					label={`Edit ${value.code}`}
					onSave={save}
					onClose={close}
				/>
			) : (
				<button
					type="button"
					aria-label={`Edit ${value.code}`}
					className="group relative w-full min-w-0 rounded-sm py-0.5 pr-7 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					onClick={() => (overflow ? onOpen() : setEditing("inline"))}
				>
					<span
						ref={preview}
						className="line-clamp-3 whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]"
					>
						{value.text.replace(/\n[\t \r]*\n(?:[\t \r]*\n)*/g, "\n") || (
							<span className="text-muted-foreground">Add translation…</span>
						)}
					</span>
					{overflow ? (
						<Maximize2
							aria-hidden="true"
							className="absolute top-1 right-1 size-3.5 text-muted-foreground group-hover:text-foreground group-focus-visible:text-foreground"
						/>
					) : null}
				</button>
			)}
		</div>
	);
}
function StringList(p: ViewProps & { variant: PrototypeVariant }) {
	const active = p.rows.find((row) => row.id === p.active?.id);
	return (
		<>
			<div
				className={cn(p.variant === "B" ? "flex flex-col gap-5" : "divide-y")}
			>
				{p.rows.map((row) => (
					<article
						key={row.id}
						className={cn(
							p.variant === "B"
								? "rounded-md border bg-muted/15 px-4 py-4"
								: "py-7",
							p.variant === "C" && "my-3 border-l-2 pl-4",
						)}
					>
						<div className="mb-3 flex items-center gap-3">
							<CheckRow
								id={row.id}
								selected={p.selected}
								onSelect={p.onSelect}
							/>
							{row.name ? (
								<h2 className="min-w-0 font-medium text-sm">
									<button
										type="button"
										className="text-left hover:underline"
										onClick={() =>
											p.onOpen({ id: row.id, panel: "properties" })
										}
									>
										{row.name}
									</button>
								</h2>
							) : null}
							<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
								{row.tags.map((tag) => (
									<Badge key={tag} variant="secondary">
										{tag}
									</Badge>
								))}
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={`Properties for ${row.name || "string"}`}
									title="Properties"
									onClick={() => p.onOpen({ id: row.id, panel: "properties" })}
								>
									<SlidersHorizontal />
								</Button>
							</div>
						</div>
						{row.values
							.filter((v) => p.codes.includes(v.code))
							.map((v) => (
								<CompactValue
									key={v.code}
									row={row}
									value={v}
									onChange={p.onChange}
									onOpen={() => p.onOpen({ id: row.id, panel: v.code })}
								/>
							))}
					</article>
				))}
			</div>
			{active && p.active ? (
				<AdvancedString
					key={active.id}
					row={active}
					initialPanel={p.active.panel}
					variant={p.variant}
					onChange={p.onChange}
					onClose={() => p.onOpen(null)}
					onPanelChange={(panel) => p.onOpen({ id: active.id, panel })}
				/>
			) : null}
		</>
	);
}
export function VariantA(p: ViewProps) {
	return <StringList {...p} variant="A" />;
}
export function VariantB(p: ViewProps) {
	return <StringList {...p} variant="B" />;
}
export function VariantC(p: ViewProps) {
	return <StringList {...p} variant="C" />;
}
export function StringsPrototype({
	initialRows,
	variant,
	onVariant,
	localSnapshot = false,
}: {
	initialRows: PrototypeString[];
	variant: PrototypeVariant;
	onVariant: (v: PrototypeVariant) => void;
	localSnapshot?: boolean;
}) {
	const [rows, setRows] = useState(initialRows);
	const [q, setQ] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [active, setActive] = useState<ViewProps["active"]>(null);
	const [examples, setExamples] = useState(false);
	const rawRows = examples
		? [
				...rows,
				...exampleStrings
					.filter((r) => !rows.some((existing) => existing.id === r.id))
					.filter(
						(r) =>
							r.id.startsWith("sample-shared") ||
							r.id === "sample-play" ||
							r.id === "sample-email",
					),
			]
		: rows;
	const allCodes = [
		...new Set(rawRows.flatMap((r) => r.values.map((v) => v.code))),
	];
	const allRows = rawRows.map((row) => ({
		...row,
		values: allCodes.map(
			(code) =>
				row.values.find((v) => v.code === code) ?? {
					code,
					text: "",
					reviewed: false,
				},
		),
	}));
	const [chosen, setChosen] = useState<string[] | null>(null);
	const codes =
		chosen === null
			? allCodes
			: allCodes.filter((c) => c === allCodes[0] || chosen.includes(c));
	const allTags = [...new Set(allRows.flatMap((r) => r.tags))].sort();
	const filtered = allRows.filter(
		(row) =>
			(tags.length === 0 || row.tags.some((t) => tags.includes(t))) &&
			`${row.name ?? ""} ${row.values.map((v) => v.text).join(" ")}`
				.toLowerCase()
				.includes(q.toLowerCase()),
	);
	const [exportOpen, setExportOpen] = useState(false);
	const [mode, setMode] = useState("reviewed");
	const [exportResult, setExportResult] = useState("");
	const [bulkTag, setBulkTag] = useState("");
	const exportRows = selected.length
		? allRows.filter((r) => selected.includes(r.id))
		: filtered;
	const missing = exportRows.flatMap((row) =>
		row.values
			.filter((v) => codes.includes(v.code) && !v.reviewed)
			.map((v) => `${row.name || row.id} · ${v.code}`),
	);
	const state = {
		variant,
		tagsByKey: Object.fromEntries(rows.map((r) => [r.id, r.tags])),
		data: localSnapshot ? "Local Marketing snapshot" : "Examples",
		tags,
		match: "any selected tag",
		query: q,
		selectedKeys: selected,
		openKey: active,
		languages: codes,
		matching: filtered.length,
		exportKeys: exportRows.map((r) => r.id),
		exportMode: mode,
		exampleGroups: examples,
	};
	const props: ViewProps = {
		rows: filtered,
		codes,
		selected,
		active,
		onSelect: (id) =>
			setSelected(
				selected.includes(id)
					? selected.filter((x) => x !== id)
					: [...selected, id],
			),
		onOpen: setActive,
		onChange: (row) =>
			setRows((current) =>
				current.some((r) => r.id === row.id)
					? current.map((r) => (r.id === row.id ? row : r))
					: [...current, row],
			),
	};
	return (
		<div className="mx-auto w-full max-w-7xl pb-24">
			<div className="mb-5 flex items-center justify-between gap-3">
				<h1 className="font-semibold text-xl tracking-tight">Strings</h1>
				<span className="text-muted-foreground text-xs">
					Prototype · edits stay here
				</span>
			</div>
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<Input
					aria-label="Search strings"
					placeholder="Search strings"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					className="min-w-40 flex-1"
				/>
				<details className="relative">
					<summary className="flex cursor-pointer items-center gap-2 border px-3 py-2 text-xs">
						<Tag className="size-3.5" />
						{tags.length ? tags.join(", ") : "Tags"}
						<ChevronDown className="size-3.5" />
					</summary>
					<div className="absolute top-full z-20 mt-1 min-w-52 rounded border bg-popover p-3 shadow-md">
						<p className="mb-2 text-muted-foreground text-xs">
							Match any selected tag
						</p>
						{allTags.map((tag) => (
							<label
								key={tag}
								className="flex items-center gap-2 py-1.5 text-sm"
							>
								<input
									type="checkbox"
									checked={tags.includes(tag)}
									onChange={() =>
										setTags(
											tags.includes(tag)
												? tags.filter((t) => t !== tag)
												: [...tags, tag],
										)
									}
								/>
								{tag}
								<span className="ml-auto text-muted-foreground text-xs">
									{allRows.filter((r) => r.tags.includes(tag)).length}
								</span>
							</label>
						))}
						<Button size="xs" variant="ghost" onClick={() => setTags([])}>
							Clear
						</Button>
					</div>
				</details>
				<details className="relative">
					<summary className="flex cursor-pointer items-center gap-2 border px-3 py-2 text-xs">
						{chosen === null ? "All languages" : `${codes.length} languages`}
						<ChevronDown className="size-3.5" />
					</summary>
					<div className="absolute top-full right-0 z-20 mt-1 max-h-80 min-w-44 overflow-auto rounded border bg-popover p-3 shadow-md">
						<Button size="xs" variant="ghost" onClick={() => setChosen(null)}>
							Select all
						</Button>
						{allCodes.map((code, i) => (
							<label
								key={code}
								className="flex items-center gap-2 py-1.5 text-sm"
							>
								<input
									type="checkbox"
									checked={codes.includes(code)}
									disabled={i === 0}
									onChange={() =>
										setChosen(
											codes.includes(code)
												? codes.filter((c) => c !== code)
												: [...codes, code],
										)
									}
								/>
								{code}
								{i === 0 ? " · Source" : ""}
							</label>
						))}
					</div>
				</details>
				<Button
					variant="outline"
					onClick={() => {
						setExportResult("");
						setExportOpen(true);
					}}
					disabled={!exportRows.length}
				>
					<Download data-icon="inline-start" />
					{selected.length
						? `Export ${selected.length} selected`
						: `Export ${filtered.length} strings`}
				</Button>
			</div>
			<div className="mb-3 flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						aria-label="Select all matching strings"
						checked={
							filtered.length > 0 &&
							filtered.every((r) => selected.includes(r.id))
						}
						onChange={() =>
							setSelected(
								filtered.every((r) => selected.includes(r.id))
									? []
									: filtered.map((r) => r.id),
							)
						}
					/>
					{filtered.length} strings
					{tags.length ? ` · ${tags.join(" or ")}` : ""}
				</label>
				{selected.length ? (
					<>
						<span>{selected.length} selected</span>
						<Input
							aria-label="Tag selected strings"
							value={bulkTag}
							onChange={(e) => setBulkTag(e.target.value)}
							placeholder="Tag selected…"
							className="h-7 w-36"
						/>
						<Button
							size="xs"
							variant="outline"
							disabled={!bulkTag.trim()}
							onClick={() => {
								setRows(
									allRows.map((r) =>
										selected.includes(r.id)
											? {
													...r,
													tags: [...new Set([...r.tags, bulkTag.trim()])],
												}
											: r,
									),
								);
								setBulkTag("");
							}}
						>
							Apply tag
						</Button>
						<Button size="xs" variant="ghost" onClick={() => setSelected([])}>
							Clear selection
						</Button>
					</>
				) : null}
			</div>
			{variant === "A" ? (
				<VariantA {...props} />
			) : variant === "B" ? (
				<VariantB {...props} />
			) : (
				<VariantC {...props} />
			)}
			{!filtered.length ? (
				<p className="py-10 text-center text-muted-foreground text-sm">
					No matching strings.
				</p>
			) : null}
			<label className="mt-5 flex w-fit items-center gap-2 text-muted-foreground text-xs">
				<input
					type="checkbox"
					checked={examples}
					onChange={(e) => {
						setExamples(e.target.checked);
						setSelected([]);
						setActive(null);
					}}
				/>
				Include example Google Play and screenshot groups
			</label>
			<Sheet open={exportOpen} onOpenChange={setExportOpen}>
				<SheetContent>
					<SheetHeader>
						<SheetTitle>Export {exportRows.length} strings</SheetTitle>
						<SheetDescription>
							{selected.length
								? "Selected strings"
								: tags.length
									? tags.join(" or ")
									: "All matching strings"}{" "}
							· {codes.length} languages
						</SheetDescription>
					</SheetHeader>
					<div className="flex min-h-0 flex-col gap-4 overflow-auto px-6 pb-8">
						<label className="flex flex-col gap-2 text-sm">
							Include
							<select
								aria-label="Export mode"
								value={mode}
								onChange={(e) => setMode(e.target.value)}
								className="border bg-background p-2"
							>
								<option value="reviewed">Reviewed only · complete</option>
								<option value="partial">Reviewed only · allow omissions</option>
								<option value="draft">Working drafts</option>
							</select>
						</label>
						<p className="text-muted-foreground text-xs">
							{missing.length
								? `${missing.length} translations still need review.`
								: "Every translation in this export is reviewed."}
						</p>
						{mode === "reviewed" && missing.length ? (
							<p role="status" className="text-sm">
								Review these translations first, or choose a partial or draft
								export.
							</p>
						) : null}
						<Button
							disabled={mode === "reviewed" && missing.length > 0}
							onClick={() => {
								const values = Object.fromEntries(
									exportRows.map((row) => [
										row.id,
										Object.fromEntries(
											row.values
												.filter(
													(v) =>
														codes.includes(v.code) &&
														(mode === "draft" || v.reviewed),
												)
												.map((v) => [v.code, v.text]),
										),
									]),
								);
								const data = JSON.stringify(
									{
										prototype: true,
										mode,
										names: Object.fromEntries(
											exportRows.map((r) => [r.id, r.name]),
										),
										tags: Object.fromEntries(
											exportRows.map((r) => [r.id, r.tags]),
										),
										values,
									},
									null,
									2,
								);
								const url = URL.createObjectURL(
									new Blob([data], { type: "application/json" }),
								);
								const link = document.createElement("a");
								link.href = url;
								link.download = "blabla-prototype-export.json";
								link.click();
								URL.revokeObjectURL(url);
								setExportResult(
									`Downloaded ${exportRows.length} strings${mode === "partial" ? ` · ${missing.length} translations omitted` : ""}.`,
								);
							}}
						>
							<Download data-icon="inline-start" />
							Download JSON
						</Button>
						<p role="status" className="text-sm">
							{exportResult}
						</p>
						<ul className="flex flex-col gap-2 text-sm">
							{exportRows.map((row) => (
								<li key={row.id} className="flex gap-2">
									<Check className="size-4 shrink-0 text-muted-foreground" />
									{row.name || row.values[0]?.text.slice(0, 55)}
								</li>
							))}
						</ul>
					</div>
				</SheetContent>
			</Sheet>
			<PrototypeSwitcher variant={variant} onChange={onVariant} state={state} />
		</div>
	);
}
