import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@blabla/ui/components/combobox";
import { Input } from "@blabla/ui/components/input";
import { useMutation, useQuery } from "convex/react";
import { Tag, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, convexId } from "@/lib/convex-api";

type TagChoice = { id: string; name: string };
export function StringTagFilter({
	tags,
	value,
	onChange,
}: {
	tags: readonly TagChoice[];
	value: readonly string[];
	onChange: (ids: string[]) => void;
}) {
	return (
		<Combobox
			multiple
			items={tags}
			value={tags.filter((t) => value.includes(t.id))}
			itemToStringLabel={(t) => t.name}
			itemToStringValue={(t) => t.id}
			isItemEqualToValue={(a, b) => a.id === b.id}
			onValueChange={(next) => onChange(next.map((t) => t.id).sort())}
		>
			<ComboboxTrigger
				render={<Button variant="outline" />}
				aria-label={`Tags: ${value.length ? `${value.length} selected` : "None selected"}`}
			>
				<Tag data-icon="inline-start" />
				{value.length ? `${value.length} tags` : "Tags"}
			</ComboboxTrigger>
			<ComboboxContent className="w-64">
				<ComboboxInput
					aria-label="Find tags"
					placeholder="Find tags…"
					showTrigger={false}
				/>
				<ComboboxEmpty>No tags found.</ComboboxEmpty>
				<ComboboxList>
					{(tag) => (
						<ComboboxItem key={tag.id} value={tag}>
							{tag.name}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
export function StringTags({
	projectId,
	collectionId,
	messageId,
	canEdit,
}: {
	projectId: string;
	collectionId?: string;
	messageId: string;
	canEdit: boolean;
}) {
	const address = {
		projectId: convexId<"projects">(projectId),
		collectionId: collectionId
			? convexId<"contentCollections">(collectionId)
			: undefined,
	};
	const choices = useQuery(api.messageTags.list, {
		projectId: address.projectId,
	});
	const membership = useQuery(api.messageTags.forMessages, {
		...address,
		messageIds: [messageId],
	});
	const create = useMutation(api.messageTags.create);
	const setTags = useMutation(api.messageTags.setTags);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const ids = membership?.[0]?.tagIds;
	const update = async (next: readonly string[]) => {
		if (!ids || busy || !canEdit) return;
		setBusy(true);
		try {
			await setTags({
				...address,
				messageId,
				tagIds: next.map((id) => convexId<"tags">(id)),
				expectedTagIds: ids,
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not update tags.",
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<span className="font-medium text-sm">Tags</span>
			<div className="flex flex-wrap items-center gap-2">
				{choices?.items
					.filter((tag) => ids?.includes(tag.id))
					.map((tag) => (
						<Badge key={tag.id} variant="secondary">
							{tag.name}
							{canEdit ? (
								<button
									type="button"
									aria-label={`Remove ${tag.name}`}
									disabled={busy}
									onClick={() =>
										void update(ids?.filter((id) => id !== tag.id) ?? [])
									}
								>
									<X className="size-3" />
								</button>
							) : null}
						</Badge>
					))}
				{canEdit && choices && ids ? (
					<fieldset disabled={busy}>
						<StringTagFilter
							tags={choices.items}
							value={ids}
							onChange={(next) => void update(next)}
						/>
					</fieldset>
				) : null}
				{!canEdit && ids?.length === 0 ? (
					<span className="text-muted-foreground text-sm">None</span>
				) : null}
			</div>
			{canEdit ? (
				<form
					className="flex gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!name.trim() || !ids || busy) return;
						setBusy(true);
						try {
							const tagId = await create({
								projectId: address.projectId,
								name: name.trim(),
							});
							await setTags({
								...address,
								messageId,
								tagIds: [...new Set([...ids, tagId])],
								expectedTagIds: ids,
							});
							setName("");
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: "Could not create tag.",
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					<Input
						value={name}
						aria-label="New tag"
						placeholder="New tag"
						disabled={busy || !ids}
						onChange={(e) => setName(e.target.value)}
					/>
					<Button
						type="submit"
						size="sm"
						variant="outline"
						disabled={busy || !ids || !name.trim()}
					>
						Add
					</Button>
				</form>
			) : null}
		</div>
	);
}
