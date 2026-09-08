import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api, convexId } from "@/lib/convex-api";

export function ContentCollectionSelector({
	projectId,
	value,
	onChange,
	canEdit,
}: {
	projectId: string;
	value?: string;
	onChange: (value?: string) => void;
	canEdit: boolean;
}) {
	const collections = useQuery(api.contentCollections.list, {
		projectId: convexId<"projects">(projectId),
	});
	const create = useMutation(api.contentCollections.create);
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="mb-5 flex flex-wrap items-center gap-2">
			<label className="text-sm" htmlFor="content-collection">
				Collection
			</label>
			<select
				id="content-collection"
				disabled={busy}
				className="h-9 rounded-md border bg-background px-3 text-sm"
				value={value ?? "app"}
				onChange={(event) =>
					onChange(
						event.target.value === "app" ? undefined : event.target.value,
					)
				}
			>
				{(collections ?? [{ id: "app", name: "App" }]).map((collection) => (
					<option key={collection.id} value={collection.id}>
						{collection.name}
					</option>
				))}
			</select>
			{canEdit && (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => setAdding(!adding)}
				>
					New collection
				</Button>
			)}
			{adding && (
				<form
					className="flex items-center gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy || !name.trim()) return;
						setBusy(true);
						try {
							const id = await create({
								projectId: convexId<"projects">(projectId),
								name: name.trim(),
								localeIds: [],
							});
							setAdding(false);
							setName("");
							onChange(id);
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: "Could not create collection",
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					<Input
						disabled={busy}
						aria-label="Collection name"
						placeholder="Store listings"
						value={name}
						onChange={(event) => setName(event.target.value)}
						required
					/>
					<Button type="submit" disabled={busy}>
						Create
					</Button>
				</form>
			)}
		</div>
	);
}
