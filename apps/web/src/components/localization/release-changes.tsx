import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api } from "@/lib/convex-api";
import type { ReleaseSummary } from "./release-record-view";

type ChangeKey = FunctionReturnType<
	typeof api.releaseRecords.changes
>["page"][number];
type ChangeValue = FunctionReturnType<
	typeof api.releaseRecords.changeValues
>["page"][number];

/** Compare the frozen release to its baseline; live workspace links are separate. */
export function ReleaseChanges({
	record,
	projectId,
	prepareAction,
}: {
	record: ReleaseSummary;
	projectId: string;
	prepareAction?: ReactNode;
}) {
	const [q, setQuery] = useState("");
	const [draft, setDraft] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setQuery(draft.trim()), 200);
		return () => clearTimeout(timer);
	}, [draft]);
	const [localeCode, setLocaleCode] = useState("");
	const languageId = useId();
	const captured = record.changedKeyCount !== undefined;
	return (
		<Card size="sm" className="max-w-3xl">
			<CardHeader>
				<CardTitle>
					Changed strings{captured ? ` · ${record.changedKeyCount}` : ""}
				</CardTitle>
				<CardDescription>
					{captured
						? "Existing languages, compared with Git. Saved when this report was prepared."
						: "This older report did not retain a text comparison. Prepare a new report to inspect current changes."}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{!captured ? (
					prepareAction
				) : record.changedKeyCount === 0 ? (
					<p className="text-muted-foreground">
						No text changes in existing languages.
					</p>
				) : (
					<>
						<form
							className="flex flex-wrap items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								setQuery(draft.trim());
							}}
						>
							<Input
								name="q"
								type="search"
								aria-label="Search changed keys"
								placeholder="Search keys…"
								className="min-w-40 flex-1"
								value={draft}
								onChange={(event) => {
									setDraft(event.target.value);
									if (!event.target.value) setQuery("");
								}}
							/>
							<label htmlFor={languageId} className="sr-only">
								Language
							</label>
							<select
								id={languageId}
								value={localeCode}
								onChange={(event) => setLocaleCode(event.target.value)}
								className="h-8 max-w-full border bg-background px-2 text-xs"
							>
								<option value="">All languages</option>
								{record.sourceLocaleCode ? (
									<option value={record.sourceLocaleCode}>
										{record.sourceLocaleCode} · Source
									</option>
								) : null}
								{record.localeSummaries.map((locale) => (
									<option key={locale.localeCode} value={locale.localeCode}>
										{locale.localeCode}
									</option>
								))}
							</select>
						</form>
						<ReleaseChangeKeys
							key={`${record.recordId}:${q}:${localeCode}`}
							recordId={record.recordId}
							projectId={projectId}
							q={q}
							localeCode={localeCode}
						/>
					</>
				)}
			</CardContent>
		</Card>
	);
}

function ReleaseChangeKeys({
	recordId,
	projectId,
	q,
	localeCode,
}: {
	recordId: ReleaseSummary["recordId"];
	projectId: string;
	q: string;
	localeCode: string;
}) {
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const result = useQuery(api.releaseRecords.changes, {
		recordId,
		q: q || undefined,
		localeCode: localeCode || undefined,
		paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 20 },
	});
	const scanning =
		result !== undefined && result.page.length === 0 && !result.isDone;
	const scanStalled = scanning && result.continueCursor === cursors.at(-1);
	useEffect(() => {
		if (scanning && !scanStalled) {
			setCursors((current) => [...current.slice(0, -1), result.continueCursor]);
		}
	}, [scanning, scanStalled, result]);
	return (
		<div
			className="flex flex-col gap-3"
			aria-busy={result === undefined || scanning}
		>
			{scanStalled ? (
				<p role="alert">
					Could not continue this search. Clear the filter and try again.
				</p>
			) : result === undefined || scanning ? (
				<Skeleton className="h-16 w-full" />
			) : (
				<>
					{result.page.length === 0 ? (
						<p className="text-muted-foreground" role="status">
							{result.isDone && cursors.length === 1
								? "No matching changes."
								: "No matches on this page."}
						</p>
					) : (
						<ul className="divide-y">
							{result.page.map((item) => (
								<li key={item._id}>
									<ReleaseChangeRow
										item={item}
										recordId={recordId}
										localeCode={localeCode}
										editLink={
											<Link
												to="/projects/$projectId/strings"
												params={{ projectId }}
												search={{ q: item.messageId }}
												className="text-muted-foreground text-xs underline underline-offset-4"
											>
												Open in Strings
											</Link>
										}
									/>
								</li>
							))}
						</ul>
					)}
					<ChangePages
						hasPrevious={cursors.length > 1}
						hasNext={!result.isDone}
						onPrevious={() => setCursors((current) => current.slice(0, -1))}
						onNext={() =>
							setCursors((current) => [...current, result.continueCursor])
						}
					/>
				</>
			)}
		</div>
	);
}

export function ReleaseChangeRow({
	item,
	recordId,
	localeCode,
	editLink,
}: {
	item: ChangeKey;
	recordId: ReleaseSummary["recordId"];
	localeCode?: string;
	editLink?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	return (
		<div className="py-2">
			<Button
				variant="ghost"
				className="h-auto w-full justify-start whitespace-normal py-2 text-left"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<ChevronRight
					data-icon="inline-start"
					className={open ? "rotate-90" : undefined}
				/>
				<span className="min-w-0 flex-1 break-all font-mono text-xs">
					{item.messageId}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs">
					{localeCode ||
						(item.localeCodes.length <= 3
							? item.localeCodes.join(", ")
							: `${item.changedValueCount} values`)}
				</span>
			</Button>
			{open ? (
				<section
					id={panelId}
					aria-label={`Changes to ${item.messageId}`}
					className="flex flex-col gap-3 py-3"
				>
					<div className="flex justify-end">{editLink}</div>
					<ReleaseChangeValues
						recordId={recordId}
						messageId={item.messageId}
						localeCode={localeCode}
					/>
				</section>
			) : null}
		</div>
	);
}

function ReleaseChangeValues({
	recordId,
	messageId,
	localeCode,
}: {
	recordId: ReleaseSummary["recordId"];
	messageId: string;
	localeCode?: string;
}) {
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const result = useQuery(api.releaseRecords.changeValues, {
		recordId,
		messageId,
		localeCode: localeCode || undefined,
		paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 5 },
	});
	if (result === undefined)
		return (
			<p role="status" className="text-muted-foreground">
				Loading changes…
			</p>
		);
	return (
		<>
			{result.page.map((value) => (
				<ReleaseValueComparison key={value._id} value={value} />
			))}
			<ChangePages
				hasPrevious={cursors.length > 1}
				hasNext={!result.isDone}
				onPrevious={() => setCursors((current) => current.slice(0, -1))}
				onNext={() =>
					setCursors((current) => [...current, result.continueCursor])
				}
			/>
		</>
	);
}

export function ReleaseValueComparison({ value }: { value: ChangeValue }) {
	return (
		<div className="flex flex-col gap-2">
			<h4 className="font-medium text-xs">
				{value.localeCode}
				{value.isSource ? " · Source" : ""}
			</h4>
			<div className="grid gap-2 sm:grid-cols-2">
				{(
					[
						{ label: "Before", text: value.before },
						{ label: "In this release", text: value.after },
					] as const
				).map((side) => (
					<div key={side.label} className="min-w-0 border p-3">
						<p className="mb-2 text-muted-foreground text-xs">{side.label}</p>
						<section
							// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard access to overflowing text
							tabIndex={0}
							aria-label={`${value.localeCode} ${side.label}`}
							className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm"
							dir="auto"
						>
							{side.text === null ? (
								<span className="text-muted-foreground italic">
									Not present
								</span>
							) : side.text === "" ? (
								<span className="text-muted-foreground italic">
									Empty value
								</span>
							) : (
								side.text
							)}
						</section>
					</div>
				))}
			</div>
		</div>
	);
}

function ChangePages({
	hasPrevious,
	hasNext,
	onPrevious,
	onNext,
}: {
	hasPrevious: boolean;
	hasNext: boolean;
	onPrevious: () => void;
	onNext: () => void;
}) {
	if (!hasPrevious && !hasNext) return null;
	return (
		<nav aria-label="Change pages" className="flex gap-2">
			<Button
				size="xs"
				variant="outline"
				disabled={!hasPrevious}
				onClick={onPrevious}
			>
				Previous
			</Button>
			<Button size="xs" variant="outline" disabled={!hasNext} onClick={onNext}>
				Next
			</Button>
		</nav>
	);
}
