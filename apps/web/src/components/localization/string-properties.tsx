import { Button } from "@blabla/ui/components/button";
import { Field, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Textarea } from "@blabla/ui/components/textarea";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, convexId } from "@/lib/convex-api";
import type { StringsCatalogKey } from "@/lib/strings-catalog";
import { CharacterLimitField, parsedCharacterLimit } from "./character-limit";

/** Metadata keeps its original concurrency basis until Save succeeds or Reset is deliberate. */
export function ManagedStringProperties({
	projectId,
	collectionId,
	catalogKey,
	canEdit,
	onDirtyChange,
	onBusyChange,
	onArchived,
}: {
	projectId: string;
	collectionId: string;
	catalogKey: StringsCatalogKey;
	canEdit: boolean;
	onDirtyChange: (dirty: boolean) => void;
	onBusyChange: (busy: boolean) => void;
	onArchived: () => void;
}) {
	const save = useMutation(api.managedContent.saveSource);
	const archive = useMutation(api.managedContent.archiveMessage);
	const id = useId();
	const read = useCallback(
		() => ({
			name: catalogKey.name ?? "",
			context: catalogKey.context ?? "",
			limit: catalogKey.characterLimit?.toString() ?? "",
			basis: catalogKey.source.editBasis,
			source: catalogKey.source.value,
		}),
		[catalogKey],
	);
	const [original, setOriginal] = useState(read);
	const [draft, setDraft] = useState(original);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty =
		draft.name !== original.name ||
		draft.context !== original.context ||
		draft.limit !== original.limit;
	const invalid =
		draft.limit !== "" && parsedCharacterLimit(draft.limit) === undefined;
	const observed = useRef(JSON.stringify(original));
	useEffect(() => {
		if (dirty || busy) return;
		const latest = read();
		const version = JSON.stringify(latest);
		if (observed.current === version) return;
		observed.current = version;
		setOriginal(latest);
		setDraft(latest);
	}, [read, dirty, busy]);
	useEffect(() => {
		onDirtyChange(dirty);
		return () => onDirtyChange(false);
	}, [dirty, onDirtyChange]);
	useEffect(() => {
		onBusyChange(busy);
		return () => onBusyChange(false);
	}, [busy, onBusyChange]);
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (
					!canEdit ||
					busy ||
					invalid ||
					original.basis?.kind !== "managedSource"
				)
					return;
				setBusy(true);
				setError(null);
				try {
					const result = await save({
						projectId: convexId<"projects">(projectId),
						collectionId: convexId<"contentCollections">(collectionId),
						messageId: catalogKey.id,
						sourceValue: original.source,
						name: draft.name.trim() || null,
						context: draft.context,
						characterLimit: parsedCharacterLimit(draft.limit) ?? null,
						expectedCharacterLimit:
							parsedCharacterLimit(original.limit) ?? null,
						expectedSourceRevision: original.basis.sourceRevision,
					});
					const next = { ...draft, basis: { ...original.basis, ...result } };
					setOriginal(next);
					setDraft(next);
				} catch (cause) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not save properties.",
					);
				} finally {
					setBusy(false);
				}
			}}
		>
			<fieldset disabled={!canEdit || busy} className="contents">
				<Field>
					<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
					<Input
						id={`${id}-name`}
						value={draft.name}
						placeholder="Optional"
						onChange={(e) => setDraft({ ...draft, name: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-context`}>Context</FieldLabel>
					<Textarea
						id={`${id}-context`}
						value={draft.context}
						placeholder="Optional"
						className="min-h-20"
						onChange={(e) => setDraft({ ...draft, context: e.target.value })}
					/>
				</Field>
				<CharacterLimitField
					value={draft.limit}
					onChange={(limit) => setDraft({ ...draft, limit })}
				/>
				{canEdit ? (
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={!dirty || invalid}>
							Save properties
						</Button>
						{dirty ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									const next = read();
									setOriginal(next);
									setDraft(next);
									setError(null);
								}}
							>
								Reset
							</Button>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							className="ml-auto"
							onClick={async () => {
								if (
									original.basis?.kind !== "managedSource" ||
									!window.confirm(
										"Archive this string? Its history will be preserved.",
									)
								)
									return;
								setBusy(true);
								setError(null);
								try {
									await archive({
										projectId: convexId<"projects">(projectId),
										collectionId: convexId<"contentCollections">(collectionId),
										messageId: catalogKey.id,
										expectedSourceRevision: original.basis.sourceRevision,
									});
									onDirtyChange(false);
									onBusyChange(false);
									onArchived();
								} catch (cause) {
									setError(
										cause instanceof Error
											? cause.message
											: "Could not archive string.",
									);
								} finally {
									setBusy(false);
								}
							}}
						>
							Archive
						</Button>
					</div>
				) : null}
			</fieldset>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</form>
	);
}
