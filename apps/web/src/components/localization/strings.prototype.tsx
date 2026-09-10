/** THROWAWAY: three Strings layouts on ?variant=A|B|C. Compare long text navigation,
 * overlapping tags and whole-group export. All edits are in memory, never mutations. */
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
import { Check, ChevronDown, Download, Tag, X } from "lucide-react";
import { useState } from "react";
import {
	PrototypeSwitcher,
	type PrototypeVariant,
} from "@/components/prototype-switcher";
import { exampleStrings, type PrototypeString } from "./strings.prototype-data";

type ViewProps = {
	rows: PrototypeString[];
	codes: string[];
	selected: string[];
	active: string | null;
	onSelect: (id: string) => void;
	onOpen: (id: string | null) => void;
	onChange: (row: PrototypeString) => void;
	expanded: string[];
	onExpanded: (ids: string[]) => void;
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
function Tags({
	row,
	onChange,
}: {
	row: PrototypeString;
	onChange: (row: PrototypeString) => void;
}) {
	const [adding, setAdding] = useState(false);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{row.tags.map((tag) => (
				<Badge key={tag} variant="secondary">
					{tag}
					<button
						type="button"
						aria-label={`Remove ${tag} tag`}
						onClick={() =>
							onChange({ ...row, tags: row.tags.filter((t) => t !== tag) })
						}
					>
						<X className="size-3" />
					</button>
				</Badge>
			))}
			{adding ? (
				<Input
					aria-label="New tag"
					placeholder="Tag, then Enter"
					className="h-6 w-36"
					onKeyDown={(event) => {
						if (event.key === "Enter" && event.currentTarget.value.trim()) {
							onChange({
								...row,
								tags: [
									...new Set([...row.tags, event.currentTarget.value.trim()]),
								],
							});
							setAdding(false);
						}
					}}
				/>
			) : (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Add tag"
					onClick={() => setAdding(true)}
				>
					<Tag />
				</Button>
			)}
		</div>
	);
}
function TextEditor({
	row,
	codes,
	onChange,
}: {
	row: PrototypeString;
	codes: string[];
	onChange: (row: PrototypeString) => void;
}) {
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	return (
		<div className="flex flex-col divide-y">
			{row.values
				.filter((v) => codes.includes(v.code))
				.map((v, index) => (
					<section
						key={v.code}
						id={`prototype-${row.id}-${v.code}`}
						className="scroll-mt-36 py-3"
					>
						<div className="mb-1.5 flex items-center justify-between text-muted-foreground text-xs">
							<span>
								{v.code}
								{index === 0 && v.code === row.values[0]?.code
									? " · Source"
									: ""}
							</span>
							<span>
								{Array.from(
									editing === v.code ? draft : v.text,
								).length.toLocaleString()}
								{row.limit ? ` / ${row.limit.toLocaleString()}` : ""}
								{v.reviewed ? " · Reviewed" : " · Needs review"}
							</span>
						</div>
						{editing === v.code ? (
							<div className="flex flex-col gap-2">
								<Textarea
									aria-label={`Edit ${v.code}`}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									className="max-h-72 min-h-44 resize-y overflow-auto"
								/>
								<div className="flex gap-2">
									<Button
										size="sm"
										disabled={
											!!row.limit && Array.from(draft).length > row.limit
										}
										onClick={() => {
											onChange({
												...row,
												values: row.values.map((value) =>
													value.code === v.code
														? { ...value, text: draft, reviewed: false }
														: value,
												),
											});
											setEditing(null);
										}}
									>
										Save
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setEditing(null)}
									>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<button
								type="button"
								className="w-full whitespace-pre-wrap text-left text-sm leading-relaxed hover:bg-muted/40"
								onClick={() => {
									setEditing(v.code);
									setDraft(v.text);
								}}
							>
								{v.text || (
									<span className="text-muted-foreground">
										Add translation…
									</span>
								)}
							</button>
						)}
					</section>
				))}
		</div>
	);
}
export function VariantA(p: ViewProps) {
	const { expanded, onExpanded: setExpanded } = p;
	return (
		<div className="divide-y">
			{p.rows.map((row) => (
				<article key={row.id} className="py-5">
					<div className="mb-3 flex items-center gap-3">
						<CheckRow id={row.id} selected={p.selected} onSelect={p.onSelect} />
						{row.name ? (
							<h2 className="font-medium text-sm">{row.name}</h2>
						) : null}
						<div className="ml-auto">
							<Tags row={row} onChange={p.onChange} />
						</div>
					</div>
					<div className="flex flex-col gap-1">
						{row.values
							.filter((v) => p.codes.includes(v.code))
							.map((v) => {
								const id = `${row.id}:${v.code}`;
								const open = expanded.includes(id);
								return (
									<div
										key={v.code}
										className="grid grid-cols-[56px_1fr] gap-3 py-1.5"
									>
										<span className="pt-0.5 text-[11px] text-muted-foreground">
											{v.code}
										</span>
										<div>
											<button
												type="button"
												aria-expanded={open}
												className={cn(
													"w-full whitespace-pre-wrap text-left text-sm leading-relaxed hover:bg-muted/40",
													"line-clamp-2",
												)}
												onClick={() =>
													setExpanded(
														open
															? expanded.filter((x) => x !== id)
															: [...expanded, id],
													)
												}
											>
												{v.text || (
													<span className="text-muted-foreground">
														Add translation…
													</span>
												)}
											</button>
											{v.text.length > 180 || open ? (
												<Button
													variant="ghost"
													size="xs"
													onClick={() =>
														setExpanded(
															open
																? expanded.filter((x) => x !== id)
																: [...expanded, id],
														)
													}
												>
													{open
														? "Collapse"
														: `Read ${Array.from(v.text).length.toLocaleString()} characters`}
												</Button>
											) : null}
											{open ? (
												<div className="max-h-96 overflow-auto border-l pl-4">
													<TextEditor
														key={id}
														row={row}
														codes={[v.code]}
														onChange={p.onChange}
													/>
												</div>
											) : null}
										</div>
									</div>
								);
							})}
					</div>
				</article>
			))}
		</div>
	);
}
export function VariantB(p: ViewProps) {
	const active =
		p.rows.find((row) => row.id === p.active) ??
		p.rows.find((row) => row.values[0] && row.values[0].text.length > 300) ??
		p.rows[0];
	return (
		<div className="grid min-h-0 grid-cols-1 overflow-hidden rounded-md border lg:h-[calc(100svh-380px)] lg:min-h-80 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
			<div className="max-h-72 overflow-auto border-b lg:max-h-none lg:border-r lg:border-b-0">
				{p.rows.map((row) => (
					<div
						key={row.id}
						className={cn(
							"flex items-start gap-3 border-b p-3",
							active?.id === row.id && "bg-muted",
						)}
					>
						<div className="pt-1">
							<CheckRow
								id={row.id}
								selected={p.selected}
								onSelect={p.onSelect}
							/>
						</div>
						<button
							type="button"
							className="min-w-0 flex-1 text-left"
							onClick={() => p.onOpen(row.id)}
						>
							{row.name ? (
								<div className="truncate font-medium text-sm">{row.name}</div>
							) : null}
							<p className="mt-1 line-clamp-2 text-muted-foreground text-xs leading-relaxed [overflow-wrap:anywhere]">
								{row.values[0]?.text}
							</p>
							<div className="mt-2 flex flex-wrap gap-1">
								{row.tags.map((t) => (
									<Badge key={t} variant="outline">
										{t}
									</Badge>
								))}
							</div>
						</button>
					</div>
				))}
			</div>
			{active ? (
				<section className="min-w-0 overflow-auto">
					<div className="sticky top-0 border-b bg-background px-5 py-4">
						<div className="mb-2 font-medium text-sm">
							{active.name || active.values[0]?.text.slice(0, 70)}
						</div>
						<Tags row={active} onChange={p.onChange} />
						{active.values.some((v) => v.text.length > 300) ? (
							<nav
								aria-label="Jump to language"
								className="mt-3 flex gap-1 overflow-x-auto"
							>
								{p.codes.map((code) => (
									<Button
										key={code}
										variant="ghost"
										size="xs"
										className="shrink-0"
										onClick={() =>
											document
												.getElementById(`prototype-${active.id}-${code}`)
												?.scrollIntoView({ block: "start" })
										}
									>
										{code}
									</Button>
								))}
							</nav>
						) : null}
					</div>
					<div className="px-5 pb-5">
						<TextEditor
							key={active.id}
							row={active}
							codes={p.codes}
							onChange={p.onChange}
						/>
					</div>
				</section>
			) : null}
		</div>
	);
}
export function VariantC(p: ViewProps) {
	const active = p.rows.find((row) => row.id === p.active);
	return (
		<>
			<div className="overflow-auto rounded-md border">
				<table className="w-full border-collapse text-left text-sm">
					<thead className="bg-muted text-muted-foreground text-xs">
						<tr>
							<th className="w-10 p-3">
								<span className="sr-only">Selection</span>
							</th>
							<th className="min-w-56 p-3">String</th>
							{p.codes.map((code) => (
								<th key={code} className="min-w-56 p-3 font-normal">
									{code}
								</th>
							))}
							<th className="min-w-44 p-3 font-normal">Tags</th>
						</tr>
					</thead>
					<tbody>
						{p.rows.map((row) => (
							<tr key={row.id} className="border-t hover:bg-muted/40">
								<td className="p-3">
									<CheckRow
										id={row.id}
										selected={p.selected}
										onSelect={p.onSelect}
									/>
								</td>
								<td className="p-3">
									<button
										type="button"
										className="max-w-64 truncate text-left font-medium"
										onClick={() => p.onOpen(row.id)}
									>
										{row.name || row.values[0]?.text}
									</button>
								</td>
								{p.codes.map((code) => (
									<td key={code} className="p-3">
										<button
											type="button"
											className="line-clamp-2 max-w-72 text-left text-xs leading-relaxed"
											onClick={() => p.onOpen(row.id)}
										>
											{row.values.find((v) => v.code === code)?.text || (
												<span className="text-muted-foreground">
													Add translation…
												</span>
											)}
										</button>
									</td>
								))}
								<td className="p-3">
									<div className="flex flex-wrap gap-1">
										{row.tags.map((tag) => (
											<Badge key={tag} variant="outline">
												{tag}
											</Badge>
										))}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Sheet
				open={!!active}
				onOpenChange={(open) => {
					if (!open) p.onOpen(null);
				}}
			>
				<SheetContent className="w-full sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>{active?.name || "String"}</SheetTitle>
						<SheetDescription>All selected languages</SheetDescription>
					</SheetHeader>
					{active ? (
						<div className="overflow-auto px-6 pb-8">
							<Tags row={active} onChange={p.onChange} />
							<TextEditor
								key={active.id}
								row={active}
								codes={p.codes}
								onChange={p.onChange}
							/>
						</div>
					) : null}
				</SheetContent>
			</Sheet>
		</>
	);
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
	const [active, setActive] = useState<string | null>(null);
	const [examples, setExamples] = useState(false);
	const [expanded, setExpanded] = useState<string[]>([]);
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
		expandedValues: expanded,
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
		expanded,
		onExpanded: setExpanded,
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
