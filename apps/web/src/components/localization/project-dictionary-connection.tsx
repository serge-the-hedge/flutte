import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Field, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api, convexId } from "@/lib/convex-api";

export function ProjectDictionaryConnection({
	projectId,
	projectName,
	canEdit,
	legacyRevision,
	legacyTermCount,
}: {
	projectId: string;
	projectName: string;
	canEdit: boolean;
	legacyRevision: number;
	legacyTermCount: number;
}) {
	const id = convexId<"projects">(projectId);
	const connection = useQuery(api.dictionaries.projectConnection, {
		projectId: id,
	});
	const dictionaries = useQuery(api.dictionaries.list, canEdit ? {} : "skip");
	const connect = useMutation(api.dictionaries.connect);
	const promote = useMutation(api.dictionaries.promoteProjectTerms);
	const [selected, setSelected] = useState("");
	const [name, setName] = useState(`${projectName} terms`);
	const [busy, setBusy] = useState(false);
	async function update(action: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not update dictionary",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Dictionary</CardTitle>
				<CardDescription>
					Shared terms can be reused across projects. Voice guidance stays in
					this project.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{connection === undefined ? (
					<p role="status" className="text-muted-foreground text-sm">
						Loading dictionary connection…
					</p>
				) : connection.dictionaryId ? (
					<div className="flex flex-wrap items-center gap-3">
						<strong className="min-w-0 break-words">{connection.name}</strong>
						<Button
							variant="outline"
							nativeButton={false}
							render={
								<Link
									to="/dictionaries/$dictionaryId"
									params={{ dictionaryId: connection.dictionaryId }}
								/>
							}
						>
							Open dictionary
						</Button>
						{canEdit ? (
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() => {
									if (
										!window.confirm(
											"Disconnect this dictionary? Its terms will no longer guide this project.",
										)
									)
										return;
									void update(() =>
										connect({
											projectId: id,
											dictionaryId: null,
											expectedConnectionRevision: connection.connectionRevision,
										}),
									);
								}}
							>
								Disconnect
							</Button>
						) : null}
					</div>
				) : (
					<p className="text-muted-foreground">
						No shared dictionary connected.
						{!canEdit && " A project owner can connect one."}
					</p>
				)}
				{canEdit && connection ? (
					<>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (!selected) return;
								if (
									legacyTermCount > 0 &&
									!connection.dictionaryId &&
									!window.confirm(
										"Use this shared dictionary for the project? Existing project terms remain in history.",
									)
								)
									return;
								void update(async () => {
									await connect({
										projectId: id,
										dictionaryId: convexId<"dictionaries">(selected),
										expectedConnectionRevision: connection.connectionRevision,
									});
									setSelected("");
								});
							}}
						>
							<fieldset
								disabled={busy}
								className="flex flex-wrap items-end gap-3"
							>
								<Field className="min-w-0 flex-1 basis-48">
									<FieldLabel htmlFor="project-dictionary">
										Connect an existing dictionary
									</FieldLabel>
									<select
										id="project-dictionary"
										className="h-9 min-w-0 max-w-full rounded-md border bg-background px-3 text-sm"
										value={selected}
										onChange={(event) => setSelected(event.target.value)}
									>
										<option value="">Choose a dictionary you can edit</option>
										{(dictionaries ?? [])
											.filter(
												(dictionary) =>
													dictionary.canEdit &&
													dictionary._id !== connection.dictionaryId,
											)
											.map((dictionary) => (
												<option key={dictionary._id} value={dictionary._id}>
													{dictionary.name}
												</option>
											))}
									</select>
								</Field>
								<Button type="submit" disabled={!selected}>
									Connect
								</Button>
							</fieldset>
						</form>
						{!connection.dictionaryId ? (
							<form
								onSubmit={(event) => {
									event.preventDefault();
									if (!name.trim()) return;
									void update(() =>
										promote({
											projectId: id,
											name: name.trim(),
											expectedRevision: legacyRevision,
										}),
									);
								}}
							>
								<fieldset
									disabled={busy}
									className="flex flex-wrap items-end gap-3"
								>
									<Field className="min-w-0 flex-1 basis-48">
										<FieldLabel htmlFor="promoted-dictionary">
											{legacyTermCount
												? `Keep all ${legacyTermCount} existing terms in a shared dictionary`
												: "Create a dictionary for this project"}
										</FieldLabel>
										<Input
											id="promoted-dictionary"
											value={name}
											onChange={(event) => setName(event.target.value)}
											required
										/>
									</Field>
									<Button type="submit">
										{legacyTermCount
											? "Create from existing terms"
											: "Create and connect"}
									</Button>
								</fieldset>
							</form>
						) : null}
					</>
				) : null}
			</CardContent>
		</Card>
	);
}
