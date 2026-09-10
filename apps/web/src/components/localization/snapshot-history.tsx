import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Input } from "@blabla/ui/components/input";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, Pencil, X } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "@/components/icon-button";
import { api, convexId } from "@/lib/convex-api";

type Snapshot = FunctionReturnType<
	typeof api.snapshotCatalog.list
>["page"][number];

export function SnapshotHistory({ projectId }: { projectId: string }) {
	const id = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: id });
	const { results, status, loadMore } = usePaginatedQuery(
		api.snapshotCatalog.list,
		{ projectId: id },
		{ initialNumItems: 4 },
	);
	const canEdit = project?.role === "owner" || project?.role === "editor";
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Snapshots</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{status === "LoadingFirstPage" ? (
					<p role="status" className="text-muted-foreground text-xs">
						Loading snapshots…
					</p>
				) : null}
				{results.length === 0 && status === "Exhausted" ? (
					<p className="text-muted-foreground text-xs">
						No accepted snapshots yet.
					</p>
				) : null}
				<ul className="divide-y">
					{results.map((snapshot) => (
						<SnapshotRow
							key={snapshot.snapshotId}
							projectId={projectId}
							snapshot={snapshot}
							canEdit={canEdit}
						/>
					))}
				</ul>
				{status === "CanLoadMore" || status === "LoadingMore" ? (
					<Button
						size="xs"
						variant="ghost"
						disabled={status === "LoadingMore"}
						onClick={() => loadMore(4)}
					>
						{status === "LoadingMore" ? "Loading…" : "Older snapshots"}
					</Button>
				) : null}
			</CardContent>
		</Card>
	);
}

export function SnapshotRow({
	projectId,
	snapshot,
	canEdit,
}: {
	projectId: string;
	snapshot: Snapshot;
	canEdit: boolean;
}) {
	const rename = useMutation(api.snapshotCatalog.rename);
	const [edit, setEdit] = useState<{
		name: string;
		expectedName: string | null;
	} | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pencil = useRef<HTMLButtonElement>(null);
	const close = () => {
		setEdit(null);
		setError(null);
		requestAnimationFrame(() => pencil.current?.focus());
	};
	async function save() {
		if (!edit || saving) return;
		setSaving(true);
		setError(null);
		try {
			await rename({
				projectId: convexId<"projects">(projectId),
				snapshotId: snapshot.snapshotId,
				name: edit.name,
				expectedName: edit.expectedName,
			});
			close();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save the snapshot name.",
			);
		} finally {
			setSaving(false);
		}
	}
	return (
		<li className="py-3 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{edit ? (
					<form
						className="flex w-full items-center gap-1"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<Input
							aria-label="Snapshot name"
							placeholder="Name (optional)"
							value={edit.name}
							maxLength={120}
							autoFocus
							disabled={saving}
							onChange={(event) =>
								setEdit({ ...edit, name: event.target.value })
							}
							onKeyDown={(event) => {
								if (event.key === "Escape" && !saving) {
									event.preventDefault();
									close();
								}
							}}
						/>
						<IconButton
							type="submit"
							label="Save snapshot name"
							icon={Check}
							disabled={saving}
						/>
						<IconButton
							label="Cancel snapshot name"
							icon={X}
							disabled={saving}
							onClick={close}
						/>
					</form>
				) : (
					<>
						{snapshot.name ? (
							<span className="break-words font-medium text-sm">
								{snapshot.name}
							</span>
						) : null}
						{canEdit ? (
							<IconButton
								ref={pencil}
								label={snapshot.name ? "Rename snapshot" : "Name snapshot"}
								icon={Pencil}
								size="icon-xs"
								onClick={() =>
									setEdit({
										name: snapshot.name ?? "",
										expectedName: snapshot.name,
									})
								}
							/>
						) : null}
					</>
				)}
				<time
					className="text-muted-foreground text-xs"
					dateTime={new Date(snapshot.createdAt).toISOString()}
				>
					{new Date(snapshot.createdAt).toLocaleString(undefined, {
						dateStyle: "medium",
						timeStyle: "short",
					})}
				</time>
				<code className="text-muted-foreground text-xs" title={snapshot.commit}>
					{snapshot.commit.slice(0, 7)}
				</code>
				{snapshot.initialCatalog ? (
					<span className="text-[11px] text-muted-foreground">
						Initial catalog
					</span>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-destructive text-xs">
					{error}
				</p>
			) : null}
		</li>
	);
}
