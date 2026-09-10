// PROTOTYPE: Three structural variants on Strings (?variant=A/B/C).
// Illustrative data only. No APIs, persisted state, translation writes, or restores.
import {
	Check,
	ChevronDown,
	Clock3,
	Copy,
	GitCommitHorizontal,
	Search,
	X,
} from "lucide-react";
import { useState } from "react";
import { PrototypeSwitcher, type PrototypeVariant } from "./prototype-switcher";

const snapshots = [
	{
		id: "sep10",
		date: "2026-09-10T07:00:00Z",
		commit: "8bd3a7f",
		note: "Scanner onboarding",
	},
	{
		id: "sep09",
		date: "2026-09-09T14:20:00Z",
		commit: "c42e819",
		note: "Ideas and collections",
	},
	{
		id: "sep08",
		date: "2026-09-08T09:45:00Z",
		commit: "a91f32c",
		note: "Subscription copy",
	},
	{
		id: "initial",
		date: "2026-09-01T10:00:00Z",
		commit: "7ef40a2",
		note: "Initial catalog",
	},
].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
const rows = [
	{
		key: "scan_find_bricks",
		source: "Find something new in your bricks.",
		de: "Entdecke etwas Neues in deinen Steinen.",
		fr: "Découvrez de nouvelles idées avec vos briques.",
		snapshot: "sep10",
	},
	{
		key: "scan_spread_bricks",
		source: "Spread your bricks on a flat surface.",
		de: "Verteile deine Steine auf einer ebenen Fläche.",
		fr: "Étalez vos briques sur une surface plane.",
		snapshot: "sep10",
	},
	{
		key: "scan_ready",
		source: "Ready? Let's find your next idea.",
		de: "",
		fr: "",
		snapshot: "sep10",
	},
	{
		key: "ideas_save",
		source: "Save an idea for later.",
		de: "Speichere eine Idee für später.",
		fr: "Gardez une idée pour plus tard.",
		snapshot: "sep09",
	},
	{
		key: "collection_yours",
		source: "A little collection of big ideas.",
		de: "Eine kleine Sammlung großer Ideen.",
		fr: "Une petite collection de grandes idées.",
		snapshot: "sep09",
	},
	{
		key: "subscription_cancel",
		source: "Cancel anytime.",
		de: "Jederzeit kündbar.",
		fr: "Résiliez à tout moment.",
		snapshot: "sep08",
	},
	{
		key: "subscription_caption",
		source: "More ways to build.",
		de: "",
		fr: "Encore plus de façons de construire.",
		snapshot: "sep08",
		blank: true,
	},
	{
		key: "welcome_title",
		source: "Every brick is a beginning.",
		de: "Jeder Stein ist ein Anfang.",
		fr: "Chaque brique est un début.",
		snapshot: "initial",
	},
];
type Row = (typeof rows)[number];
type Locale = "de" | "fr";
type Selection = { key: string; locale: Locale } | null;
const button =
	"inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary";
function date(value: string) {
	return new Date(value).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});
}
function time(value: string) {
	return new Date(value).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
	});
}
function eventsFor(row: Row, locale: Locale) {
	if (!row[locale] && !row.blank) return [];
	const snapshot = snapshots.find((item) => item.id === row.snapshot)!;
	const edited =
		row.key === "scan_find_bricks"
			? locale === "de"
				? "Entdecke neue Möglichkeiten mit deinen Steinen."
				: "Trouvez de nouvelles idées avec vos briques."
			: row[locale]
				? row[locale].replace(/\.$/, "!")
				: "Mehr Möglichkeiten zum Bauen.";
	return [
		{
			id: "review",
			at: "10 Sep · 10:42",
			who: "Reviewer agent",
			kind: "Approved",
			value: row[locale],
			applied: true,
			note:
				row.blank && locale === "de"
					? "Intentionally blank: this caption is hidden in German."
					: "Approved this exact wording.",
		},
		{
			id: "proposal",
			at: "10 Sep · 10:35",
			who: "Translator agent",
			kind: "Proposed",
			value: row[locale],
			applied: false,
			note: "Candidate submitted for independent review.",
		},
		{
			id: "manual",
			at: "10 Sep · 08:18",
			who: "Seryozha",
			kind: "Edited",
			value: edited,
			applied: true,
			note: "Saved in Blabla.",
		},
		{
			id: "git",
			at: `${date(snapshot.date)} · ${time(snapshot.date)}`,
			who: `Git · ${snapshot.commit}`,
			kind: "Imported",
			value:
				row.key === "scan_find_bricks"
					? locale === "de"
						? "Finde neue Dinge in deinen Bausteinen."
						: "Trouvez quelque chose de nouveau dans vos briques."
					: edited,
			applied: true,
			note: "Unconfirmed import.",
		},
	];
}

function History({
	row,
	locale,
	compare = false,
	onClose,
}: {
	row: Row;
	locale: Locale;
	compare?: boolean;
	onClose: () => void;
}) {
	const [showProposals, setShowProposals] = useState(false);
	const [olderId, setOlderId] = useState("manual");
	const [copied, setCopied] = useState<string | null>(null);
	const events = eventsFor(row, locale);
	const older = events.find((entry) => entry.id === olderId) ?? events.at(-1);
	return (
		<section
			className="min-w-0"
			aria-label={`History of ${row.key} in ${locale}`}
		>
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-medium text-sm">
						Translation history{" "}
						<span className="ml-1 font-mono text-muted-foreground">
							{locale}
						</span>
					</h2>
					<p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
						{row.key}
					</p>
				</div>
				<button
					className="rounded p-1 hover:bg-muted"
					type="button"
					aria-label="Close history"
					onClick={onClose}
				>
					<X size={16} />
				</button>
			</header>
			<p className="my-4 text-[12px] text-muted-foreground">{row.source}</p>
			{events.length === 0 ? (
				<p className="py-6 text-sm text-muted-foreground">
					No translation yet. Its history will start with the first saved value.
				</p>
			) : (
				<>
					{compare && older ? (
						<div className="mb-5 grid gap-3 sm:grid-cols-2">
							<div className="rounded-md border border-border p-4">
								<label
									className="text-[11px] text-muted-foreground"
									htmlFor="compare-version"
								>
									Earlier value
								</label>
								<select
									id="compare-version"
									className="mt-2 mb-4 w-full rounded border border-border bg-background p-2 text-xs"
									value={olderId}
									onChange={(e) => setOlderId(e.target.value)}
								>
									{events
										.filter((e) => e.id !== "review" && e.applied)
										.map((e) => (
											<option key={e.id} value={e.id}>
												{e.at} · {e.who}
											</option>
										))}
								</select>
								<p className="text-sm leading-relaxed text-rose-200">
									{older.value || "Intentionally blank"}
								</p>
							</div>
							<div className="rounded-md border border-emerald-700/40 bg-emerald-950/10 p-4">
								<p className="mb-4 text-[11px] text-emerald-400">
									Current · approved
								</p>
								<p className="text-sm leading-relaxed">
									{row[locale] || "Intentionally blank"}
								</p>
							</div>
						</div>
					) : null}
					<label className="mb-4 flex items-center gap-2 text-[11px] text-muted-foreground">
						<input
							type="checkbox"
							checked={showProposals}
							onChange={(e) => setShowProposals(e.target.checked)}
						/>
						Include proposals
					</label>
					<ol className="space-y-5 border-l border-border pl-4">
						{events
							.filter((event) => showProposals || event.applied)
							.map((event, index) => (
								<li key={event.id}>
									<div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
										<span>
											{event.kind}{" "}
											<span className="text-muted-foreground">
												· {event.who}
											</span>
										</span>
										<span className="flex items-center gap-2 text-muted-foreground">
											{event.at}
											<button
												type="button"
												title="Copy this value"
												aria-label={`Copy value from ${event.at}`}
												onClick={() => {
													void navigator.clipboard.writeText(event.value);
													setCopied(event.id);
												}}
												className="rounded p-1 hover:bg-muted"
											>
												{copied === event.id ? (
													<Check size={12} />
												) : (
													<Copy size={12} />
												)}
											</button>
										</span>
									</div>
									<p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">
										{event.value || "Intentionally blank"}
										{index === 0 ? (
											<Check
												className="ml-2 inline text-emerald-400"
												size={13}
											/>
										) : null}
									</p>
									<p className="mt-1 text-[11px] text-muted-foreground">
										{event.note}
									</p>
								</li>
							))}
					</ol>
					{compare ? (
						<button
							type="button"
							className={`${button} mt-5`}
							onClick={() => {
								void navigator.clipboard.writeText(older?.value ?? row[locale]);
								setCopied(older?.id ?? "review");
							}}
						>
							<Copy size={13} />
							{copied === older?.id ? "Copied" : "Copy selected earlier value"}
						</button>
					) : null}
				</>
			)}
			<p className="mt-5 border-t border-border pt-3 text-[10px] text-muted-foreground">
				Illustrative history · no changes are saved
			</p>
		</section>
	);
}

function StringRow({
	row,
	locale,
	selection,
	onHistory,
	inline,
}: {
	row: Row;
	locale: "all" | Locale;
	selection: Selection;
	onHistory: (value: Selection) => void;
	inline?: boolean;
}) {
	return (
		<article className="border-b border-border py-5">
			<p className="mb-3 font-mono text-[11px] text-muted-foreground">
				{row.key}
			</p>
			<div className="grid grid-cols-[28px_1fr] gap-3 text-[13px]">
				<span className="font-mono text-[11px] text-muted-foreground">en</span>
				<p>{row.source}</p>
			</div>
			{(["de", "fr"] as const)
				.filter((code) => locale === "all" || code === locale)
				.map((code) => (
					<div key={code}>
						<div className="group mt-2 grid grid-cols-[28px_1fr_26px] items-start gap-3 text-[13px]">
							<span className="py-1 font-mono text-[11px] text-muted-foreground">
								{code}
							</span>
							<p
								className={`rounded px-0 py-1 leading-relaxed ${!row[code] ? "text-amber-400" : ""}`}
							>
								{row[code] ||
									(row.blank && code === "de"
										? "Intentionally blank"
										: "Needs a value")}
							</p>
							<button
								type="button"
								title={`History · ${code}`}
								aria-label={`History of ${row.key} in ${code}`}
								aria-expanded={
									selection?.key === row.key && selection.locale === code
								}
								className="rounded p-1 text-muted-foreground opacity-45 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
								onClick={() =>
									onHistory(
										selection?.key === row.key && selection.locale === code
											? null
											: { key: row.key, locale: code },
									)
								}
							>
								<Clock3 size={15} />
							</button>
						</div>
						{inline &&
						selection?.key === row.key &&
						selection.locale === code ? (
							<div className="my-3 ml-10 rounded-lg border border-border bg-muted/15 p-5">
								<History
									row={row}
									locale={code}
									onClose={() => onHistory(null)}
								/>
							</div>
						) : null}
					</div>
				))}
		</article>
	);
}

export function StringsHistoryPrototype({
	variant,
	onVariantChange,
}: {
	variant: PrototypeVariant;
	onVariantChange: (value: PrototypeVariant) => void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const [picker, setPicker] = useState(false);
	const [query, setQuery] = useState("");
	const [locale, setLocale] = useState<"all" | Locale>("all");
	const [selection, setSelection] = useState<Selection>(null);
	const visible = rows.filter(
		(row) =>
			(!selected.length || selected.includes(row.snapshot)) &&
			`${row.key} ${row.source} ${row.de} ${row.fr}`
				.toLowerCase()
				.includes(query.toLowerCase()),
	);
	const historyRow = rows.find((row) => row.key === selection?.key);
	function toggleSnapshot(id: string) {
		setSelected((current) =>
			current.includes(id)
				? current.filter((item) => item !== id)
				: [...current, id],
		);
		setSelection(null);
	}
	function snapshotChoices() {
		return (
			<div className="space-y-1">
				<button
					type="button"
					onClick={() => {
						setSelected([]);
						setSelection(null);
					}}
					className="mb-2 w-full rounded px-2 py-2 text-left text-xs hover:bg-muted"
				>
					All snapshots{" "}
					<span className="float-right text-muted-foreground">
						{rows.length}
					</span>
				</button>
				{snapshots.map((snapshot) => (
					<label
						key={snapshot.id}
						className={`flex cursor-pointer items-start gap-3 rounded-md px-2 py-3 hover:bg-muted/60 ${selected.includes(snapshot.id) ? "bg-muted/50" : ""}`}
					>
						<input
							className="mt-1"
							type="checkbox"
							checked={selected.includes(snapshot.id)}
							onChange={() => toggleSnapshot(snapshot.id)}
						/>
						<div className="min-w-0 flex-1">
							<p className="text-xs">
								{date(snapshot.date)}{" "}
								<span className="text-muted-foreground">
									· {time(snapshot.date)} UTC
								</span>
								<span className="float-right pl-3 text-muted-foreground">
									{rows.filter((row) => row.snapshot === snapshot.id).length}
								</span>
							</p>
							<p className="mt-1 text-[11px] text-muted-foreground">
								{snapshot.note} · <code>{snapshot.commit}</code>
							</p>
						</div>
					</label>
				))}
			</div>
		);
	}
	return (
		<div className="pb-32">
			<div className="mb-6 flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Strings</h1>
					<p className="mt-2 text-[11px] text-muted-foreground">
						UI study · illustrative catalog and history
					</p>
				</div>
				<select
					className={`${button} bg-background`}
					aria-label="Languages"
					value={locale}
					onChange={(event) => {
						setLocale(event.target.value as "all" | Locale);
						setSelection(null);
					}}
				>
					<option value="all">All languages (2)</option>
					<option value="de">German</option>
					<option value="fr">French</option>
				</select>
			</div>
			<div className="mb-5 flex flex-wrap items-center gap-3">
				<div className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-border px-3">
					<Search size={15} className="text-muted-foreground" />
					<input
						className="w-full bg-transparent py-2.5 text-xs outline-none"
						aria-label="Search strings"
						placeholder="Search strings"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setSelection(null);
						}}
					/>
				</div>
				{variant === "A" ? (
					<div className="relative">
						<button
							type="button"
							className={button}
							onClick={() => setPicker(!picker)}
							aria-expanded={picker}
						>
							Introduced in ·{" "}
							{selected.length
								? `${selected.length} snapshot${selected.length === 1 ? "" : "s"}`
								: "All"}
							<ChevronDown size={13} />
						</button>
						{picker ? (
							<div className="absolute right-0 top-full z-20 mt-2 w-80 max-w-[85vw] rounded-lg border border-border bg-background p-3 shadow-2xl">
								<div className="mb-2 flex justify-between px-2">
									<p className="text-[11px] text-muted-foreground">
										Introduced in · newest first
									</p>
									<button
										type="button"
										aria-label="Close snapshot picker"
										onClick={() => setPicker(false)}
									>
										<X size={14} />
									</button>
								</div>
								{snapshotChoices()}
								<p className="mt-3 border-t border-border px-2 pt-3 text-[10px] text-muted-foreground">
									First seen by Blabla. Current translations stay visible.
								</p>
							</div>
						) : null}
					</div>
				) : null}
			</div>
			<div className="mb-2 flex flex-wrap items-center gap-5 border-b border-border pb-4 text-[11px] text-muted-foreground">
				<span className="text-foreground">All</span>
				<span>
					Needs a value <span className="ml-1 text-amber-400">2</span>
				</span>
				<span>
					New from Git <span className="ml-1">5</span>
				</span>
				<span className="ml-auto">{visible.length} strings</span>
			</div>
			{selected.length ? (
				<div className="my-3 flex flex-wrap items-center gap-2 text-[11px]">
					{snapshots
						.filter((s) => selected.includes(s.id))
						.map((s) => (
							<button
								type="button"
								key={s.id}
								className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5"
								onClick={() => toggleSnapshot(s.id)}
							>
								{date(s.date)} · {s.commit}
								<X size={11} />
							</button>
						))}
					<button
						type="button"
						className="text-muted-foreground"
						onClick={() => {
							setSelected([]);
							setSelection(null);
						}}
					>
						Clear
					</button>
				</div>
			) : null}
			{variant === "A" ? (
				<div>
					{visible.map((row) => (
						<StringRow
							key={row.key}
							row={row}
							locale={locale}
							selection={selection}
							onHistory={setSelection}
							inline
						/>
					))}
				</div>
			) : variant === "B" ? (
				<div className="grid items-start gap-6 lg:grid-cols-[225px_minmax(0,1fr)]">
					<aside className="pt-5">
						<p className="mb-3 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
							Introduced in · newest first
						</p>
						{snapshotChoices()}
					</aside>
					<div
						className={
							selection
								? "grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(270px,0.9fr)]"
								: ""
						}
					>
						<div>
							{visible.map((row) => (
								<StringRow
									key={row.key}
									row={row}
									locale={locale}
									selection={selection}
									onHistory={setSelection}
								/>
							))}
						</div>
						{selection && historyRow ? (
							<aside className="sticky top-4 mt-5 rounded-lg border border-border bg-muted/10 p-5">
								<History
									key={`${selection.key}-${selection.locale}`}
									row={historyRow}
									locale={selection.locale}
									onClose={() => setSelection(null)}
								/>
							</aside>
						) : null}
					</div>
				</div>
			) : (
				<div>
					<div className="my-5 flex gap-3 overflow-x-auto pb-2">
						{snapshots.map((snapshot) => (
							<button
								type="button"
								key={snapshot.id}
								onClick={() => toggleSnapshot(snapshot.id)}
								className={`min-w-44 rounded-lg border p-3 text-left ${selected.includes(snapshot.id) ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"}`}
							>
								<p className="flex items-center gap-2 text-xs">
									<GitCommitHorizontal size={14} />
									{date(snapshot.date)}
									<span className="ml-auto text-muted-foreground">
										{rows.filter((r) => r.snapshot === snapshot.id).length}
									</span>
								</p>
								<p className="mt-2 text-[11px] text-muted-foreground">
									{snapshot.note}
								</p>
								<code className="mt-1 block text-[10px] text-muted-foreground">
									{snapshot.commit}
								</code>
							</button>
						))}
					</div>
					{visible.map((row) => (
						<StringRow
							key={row.key}
							row={row}
							locale={locale}
							selection={selection}
							onHistory={setSelection}
						/>
					))}
				</div>
			)}
			{!visible.length ? (
				<p className="py-12 text-center text-sm text-muted-foreground">
					No strings match. Clear the search or choose another snapshot.
				</p>
			) : null}
			{variant === "C" && selection && historyRow ? (
				<dialog
					ref={(node) => {
						if (node && !node.open) node.showModal();
					}}
					onCancel={() => setSelection(null)}
					aria-label="Translation history comparison"
					className="fixed inset-0 m-auto max-h-[80vh] w-[calc(100%_-_40px)] max-w-3xl overflow-auto rounded-xl border border-border bg-background p-6 text-foreground backdrop:bg-black/70"
				>
					<History
						key={`${selection.key}-${selection.locale}`}
						row={historyRow}
						locale={selection.locale}
						compare
						onClose={() => setSelection(null)}
					/>
				</dialog>
			) : null}
			<PrototypeSwitcher
				variant={variant}
				onChange={(next) => {
					setPicker(false);
					onVariantChange(next);
				}}
				state={{
					variant,
					introducedIn: selected.length ? selected : "all",
					locale,
					query,
					visibleKeys: visible.map((r) => r.key),
					history: selection,
				}}
			/>
		</div>
	);
}
