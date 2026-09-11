import { Button } from "@blabla/ui/components/button";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api, convexId } from "@/lib/convex-api";
import { StringTagFilter } from "./string-tags";

/** Whole-match selection is resolved before writes, so tagging cannot change its own remaining scope. */
export function StringSelectionTools({
	projectId,
	collectionId,
	tags,
	selected,
	onSelectionChange,
	selectAll,
	canEdit,
}: {
	projectId: string;
	collectionId?: string;
	tags: readonly { id: string; name: string }[];
	selected: readonly string[];
	onSelectionChange: (ids: readonly string[]) => void;
	selectAll: (progress: (count: number) => void) => Promise<string[]>;
	canEdit: boolean;
}) {
	const update = useMutation(api.messageTags.updateMany);
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	async function apply(remove: boolean) {
		if (busy || !selected.length || !tagIds.length) return;
		setBusy(true);
		setNote("");
		let completed = 0;
		try {
			for (let index = 0; index < selected.length; index += 32) {
				await update({
					projectId: convexId<"projects">(projectId),
					collectionId: collectionId
						? convexId<"contentCollections">(collectionId)
						: undefined,
					messageIds: selected.slice(index, index + 32),
					...(remove
						? { removeTagIds: tagIds.map((id) => convexId<"tags">(id)) }
						: { addTagIds: tagIds.map((id) => convexId<"tags">(id)) }),
				});
				completed = Math.min(index + 32, selected.length);
				setNote(`${completed} / ${selected.length} strings updated…`);
			}
			setNote(`Tags updated on ${completed} strings.`);
		} catch (error) {
			setNote(
				`${completed} strings updated. ${error instanceof Error ? error.message : "Could not finish tagging."}`,
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="mb-3 flex flex-wrap items-center gap-2">
			<Button
				size="sm"
				variant="ghost"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setNote("");
					try {
						const ids = await selectAll((count) =>
							setNote(`Selecting ${count} strings…`),
						);
						onSelectionChange(ids);
						setNote("");
					} catch (error) {
						setNote(
							error instanceof Error
								? error.message
								: "Could not select strings.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				Select all matching
			</Button>
			{selected.length ? (
				<>
					<span className="text-muted-foreground text-xs">
						{selected.length} selected
					</span>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => onSelectionChange([])}
					>
						Clear selection
					</Button>
					{canEdit ? (
						<fieldset
							disabled={busy}
							className="flex flex-wrap items-center gap-2"
						>
							<StringTagFilter
								tags={tags}
								value={tagIds}
								onChange={setTagIds}
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={!tagIds.length}
								onClick={() => void apply(false)}
							>
								Add tags
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={!tagIds.length}
								onClick={() => void apply(true)}
							>
								Remove tags
							</Button>
						</fieldset>
					) : null}
				</>
			) : null}
			{note ? (
				<span role="status" className="text-muted-foreground text-xs">
					{note}
				</span>
			) : null}
		</div>
	);
}
