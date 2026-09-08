import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Checkbox } from "@blabla/ui/components/checkbox";
import { Field, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { DictionaryEditor } from "@/components/localization/translation-guidance-editor";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/dictionaries/$dictionaryId")({
	component: DictionaryDetail,
});
function DictionaryDetail() {
	const { dictionaryId } = Route.useParams();
	return (
		<DictionaryDetailContent key={dictionaryId} dictionaryId={dictionaryId} />
	);
}
function DictionaryDetailContent({ dictionaryId }: { dictionaryId: string }) {
	const id = convexId<"dictionaries">(dictionaryId);
	const detail = useQuery(api.dictionaries.detail, { dictionaryId: id });
	const saveTerm = useMutation(api.dictionaries.saveTerm);
	const removeTerm = useMutation(api.dictionaries.removeTerm);
	const setEditor = useMutation(api.dictionaries.setEditor);
	const setConnectionWrites = useMutation(api.dictionaries.setConnectionWrites);
	const [editorEmail, setEditorEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
	useBlocker({
		disabled: !hasUnsavedWork,
		enableBeforeUnload: true,
		shouldBlockFn: ({ current, next }) =>
			current.pathname !== next.pathname &&
			!window.confirm(
				"Discard unsaved dictionary edits? Saves already sent will still complete.",
			),
	});
	async function update(action: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not update access",
			);
		} finally {
			setBusy(false);
		}
	}
	if (!detail) return <Skeleton className="m-6 h-64" />;
	const codes = [
		...new Set(
			detail.terms.flatMap(({ term }) =>
				term.kind === "translated"
					? term.renderings.map((rendering) => rendering.localeCode)
					: [],
			),
		),
	].sort();
	return (
		<div className="mx-auto flex h-full max-w-5xl flex-col gap-6 overflow-auto px-6 py-8">
			<Link to="/dictionaries" className="text-muted-foreground text-sm">
				Dictionaries
			</Link>
			<div>
				<h1 className="break-words font-semibold text-2xl">
					{detail.dictionary.name}
				</h1>
				<p className="text-muted-foreground text-sm">
					Changes apply to every connected project.
				</p>
			</div>
			<DictionaryEditor
				key={dictionaryId}
				guidance={detail}
				locales={codes.map((code) => ({ code, label: code }))}
				onUnsavedWorkChange={setHasUnsavedWork}
				allowCustomLocales
				canEdit={detail.canEdit}
				onSaveTerm={(input) => saveTerm({ dictionaryId: id, ...input })}
				onRemoveTerm={(input) => removeTerm({ dictionaryId: id, ...input })}
			/>
			{detail.canEdit ? (
				<Card size="sm">
					<CardHeader>
						<CardTitle>Connections and access</CardTitle>
						<CardDescription>
							Connected projects can read terms. Dictionary editors can change
							them.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{detail.connections.length === 0 ? (
							<p className="text-muted-foreground">
								Connect a project from Settings → Guidance.
							</p>
						) : (
							detail.connections.map((connection) => (
								<div
									key={connection.projectId}
									className="flex flex-wrap items-center justify-between gap-3"
								>
									<span className="min-w-0 break-words">
										{connection.projectName}
									</span>
									{detail.canEdit ? (
										<label
											htmlFor={`agent-write-${connection.projectId}`}
											className="flex items-center gap-2 text-sm"
										>
											<Checkbox
												id={`agent-write-${connection.projectId}`}
												disabled={busy}
												checked={connection.agentWriteEnabled}
												onCheckedChange={(checked) => {
													const enabled = checked === true;
													void update(() =>
														setConnectionWrites({
															dictionaryId: id,
															projectId: connection.projectId,
															expectedConnectionRevision: connection.revision,
															enabled,
														}),
													);
												}}
											/>
											Allow project agents with dictionary editing permission to
											edit terms
										</label>
									) : null}
								</div>
							))
						)}
						{detail.isOwner ? (
							<details>
								<summary className="cursor-pointer text-sm">
									Dictionary editors · {detail.editors.length}
								</summary>
								<div className="flex flex-col gap-3 pt-4">
									{detail.editors.map((editor) => (
										<div
											key={editor.userId}
											className="flex flex-wrap items-center justify-between gap-3"
										>
											<span className="min-w-0 break-words">
												{editor.name ?? editor.email ?? editor.userId}
												{editor.name && editor.email
													? ` · ${editor.email}`
													: ""}
											</span>
											<Button
												variant="ghost"
												disabled={busy}
												onClick={() =>
													void update(() =>
														setEditor({
															dictionaryId: id,
															userId: editor.userId,
															enabled: false,
														}),
													)
												}
											>
												Remove editor
											</Button>
										</div>
									))}
									<form
										onSubmit={(event) => {
											event.preventDefault();
											if (!editorEmail.trim()) return;
											void update(async () => {
												await setEditor({
													dictionaryId: id,
													email: editorEmail.trim(),
													enabled: true,
												});
												setEditorEmail("");
											});
										}}
									>
										<fieldset
											disabled={busy}
											className="flex flex-wrap items-end gap-3"
										>
											<Field className="min-w-0 flex-1 basis-48">
												<FieldLabel htmlFor="dictionary-editor">
													Editor email
												</FieldLabel>
												<Input
													id="dictionary-editor"
													type="email"
													value={editorEmail}
													onChange={(event) =>
														setEditorEmail(event.target.value)
													}
													required
												/>
											</Field>
											<Button type="submit">Add editor</Button>
										</fieldset>
									</form>
								</div>
							</details>
						) : null}
					</CardContent>
				</Card>
			) : (
				<p className="text-muted-foreground text-sm">
					Read-only access through a connected project.
				</p>
			)}
		</div>
	);
}
