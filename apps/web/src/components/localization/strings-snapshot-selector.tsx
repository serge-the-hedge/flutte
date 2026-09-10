import { Button } from "@blabla/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@blabla/ui/components/dropdown-menu";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { api, convexId } from "@/lib/convex-api";

export function StringsSnapshotSelector({
	projectId,
	value,
	onChange,
}: {
	projectId: string;
	value: string[] | undefined;
	onChange: (ids: string[] | undefined) => void;
}) {
	const [open, setOpen] = useState(false);
	const project = convexId<"projects">(projectId);
	const selected = useQuery(
		api.snapshotCatalog.getSelected,
		value?.length
			? {
					projectId: project,
					snapshotIds: value.map((id) => convexId<"sourceSnapshots">(id)),
				}
			: "skip",
	);
	const { results, status, loadMore } = usePaginatedQuery(
		api.snapshotCatalog.list,
		open ? { projectId: project } : "skip",
		{ initialNumItems: 20 },
	);
	// A linked selection can be older than the loaded pages. Keep it visible and removable.
	const snapshots = [
		...new Map(
			[...results, ...(selected ?? [])].map((item) => [item.snapshotId, item]),
		).values(),
	].sort(
		(a, b) =>
			b.createdAt - a.createdAt || b.snapshotId.localeCompare(a.snapshotId),
	);
	const count = value?.length ?? 0;
	const single = selected?.[0];
	const label =
		count === 0
			? "Introduced in"
			: count === 1 && single
				? (single.name ?? new Date(single.createdAt).toLocaleDateString())
				: `${count} snapshots`;
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger
				render={<Button variant="outline" />}
				aria-label={`Introduced in: ${count ? label : "all snapshots"}`}
			>
				<span className="max-w-48 truncate">{label}</span>
				<ChevronDown />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="max-h-96 w-80 max-w-[calc(100vw-2rem)]">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Introduced in · newest first</DropdownMenuLabel>
					<DropdownMenuCheckboxItem
						checked={!count}
						closeOnClick={false}
						onCheckedChange={() => onChange(undefined)}
					>
						All snapshots
					</DropdownMenuCheckboxItem>
					<DropdownMenuSeparator />
					{snapshots.map((snapshot) => (
						<DropdownMenuCheckboxItem
							key={snapshot.snapshotId}
							checked={value?.includes(snapshot.snapshotId) ?? false}
							closeOnClick={false}
							disabled={count >= 32 && !value?.includes(snapshot.snapshotId)}
							onCheckedChange={(checked) => {
								const next = checked
									? [...(value ?? []), snapshot.snapshotId]
									: (value?.filter((id) => id !== snapshot.snapshotId) ?? []);
								onChange(next.length ? next.sort() : undefined);
							}}
						>
							<span className="flex min-w-0 flex-col gap-1">
								{snapshot.name ? (
									<span className="truncate">{snapshot.name}</span>
								) : null}
								<span
									className={
										snapshot.name ? "text-muted-foreground" : undefined
									}
								>
									<time dateTime={new Date(snapshot.createdAt).toISOString()}>
										{new Date(snapshot.createdAt).toLocaleString(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
										})}
									</time>
									{" · "}
									<code>{snapshot.commit.slice(0, 7)}</code>
								</span>
								{snapshot.initialCatalog ? (
									<span className="text-muted-foreground">Initial catalog</span>
								) : null}
							</span>
						</DropdownMenuCheckboxItem>
					))}
					{status === "LoadingFirstPage" ? (
						<DropdownMenuItem disabled>Loading snapshots…</DropdownMenuItem>
					) : null}
					{status === "Exhausted" && !snapshots.length ? (
						<DropdownMenuItem disabled>No accepted snapshots.</DropdownMenuItem>
					) : null}
					{status === "CanLoadMore" || status === "LoadingMore" ? (
						<DropdownMenuItem
							closeOnClick={false}
							disabled={status === "LoadingMore"}
							onClick={() => loadMore(20)}
						>
							{status === "LoadingMore" ? "Loading…" : "Older snapshots"}
						</DropdownMenuItem>
					) : null}
					{count >= 32 ? (
						<DropdownMenuItem disabled>
							Up to 32 snapshots at once
						</DropdownMenuItem>
					) : null}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
