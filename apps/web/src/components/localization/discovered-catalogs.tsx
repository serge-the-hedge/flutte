import { Alert, AlertDescription } from "@blabla/ui/components/alert";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Link } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState } from "react";
import { toast } from "sonner";
import { api, convexId } from "@/lib/convex-api";

type Discovery = FunctionReturnType<typeof api.locales.discoveredCatalogs>;
type DiscoveredFile = Discovery["files"][number];
type AddLanguage = (
	file: DiscoveredFile,
	code: string,
	label: string,
) => Promise<unknown>;

function languageName(code: string) {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

function DiscoveredFileRow({
	file,
	canEdit,
	onAdd,
}: {
	file: DiscoveredFile;
	canEdit: boolean;
	onAdd: AddLanguage;
}) {
	const id = useId();
	const [code, setCode] = useState(file.suggestedCode);
	const [label, setLabel] = useState(
		file.suggestedLabel || languageName(file.suggestedCode),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<form
			className="flex flex-col gap-3 rounded-md border p-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setSaving(true);
				setError(null);
				try {
					await onAdd(
						file,
						code.trim(),
						label.trim() || languageName(code.trim()),
					);
				} catch (cause) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not add this language. Retry.",
					);
				} finally {
					setSaving(false);
				}
			}}
		>
			<code className="break-all text-sm">{file.catalogPath}</code>
			<p className="text-muted-foreground text-sm">
				{file.declaredLocaleCode
					? `Declared locale: ${file.declaredLocaleCode}`
					: "No @@locale declaration. Confirm the language before adding it."}
				{file.messageCount !== null ? ` · ${file.messageCount} messages` : ""}
			</p>
			{file.issue ? (
				<Alert>
					<AlertDescription>{file.issue}</AlertDescription>
				</Alert>
			) : canEdit ? (
				<>
					<FieldGroup className="grid gap-3 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor={`${id}-code`}>Language code</FieldLabel>
							<Input
								id={`${id}-code`}
								value={code}
								required
								readOnly={
									file.declaredLocaleCode !== null ||
									file.existingLocaleId !== null
								}
								disabled={saving}
								onChange={(event) => {
									setCode(event.target.value);
									if (!file.suggestedLabel)
										setLabel(languageName(event.target.value));
								}}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-label`}>Language name</FieldLabel>
							<Input
								id={`${id}-label`}
								value={label}
								readOnly={file.existingLocaleId !== null}
								disabled={saving}
								onChange={(event) => setLabel(event.target.value)}
							/>
						</Field>
					</FieldGroup>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<Button
						className="self-start"
						type="submit"
						disabled={saving || !code.trim()}
					>
						{saving ? "Adding language…" : "Add language"}
					</Button>
				</>
			) : (
				<p className="text-muted-foreground text-sm">
					An editor can add this language.
				</p>
			)}
		</form>
	);
}

export function DiscoveredCatalogFiles({
	files,
	canEdit,
	onAdd,
}: {
	files: Discovery["files"];
	canEdit: boolean;
	onAdd: AddLanguage;
}) {
	if (files.length === 0) return null;
	return (
		<Card id="discovered-catalogs" size="sm">
			<CardHeader>
				<CardTitle>Languages found in Git ({files.length})</CardTitle>
				<CardDescription>
					Add these languages to Strings without another sync. Imported
					translations need review unless a matching review is already saved.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{files.map((file) => (
					<DiscoveredFileRow
						key={file.id}
						file={file}
						canEdit={canEdit}
						onAdd={onAdd}
					/>
				))}
			</CardContent>
		</Card>
	);
}

export function DiscoveredCatalogs({ projectId }: { projectId: string }) {
	const id = convexId<"projects">(projectId);
	const discovery = useQuery(api.locales.discoveredCatalogs, { projectId: id });
	const add = useAction(api.locales.addDiscovered);
	if (!discovery?.snapshotId) return null;
	const snapshotId = discovery.snapshotId;
	return (
		<DiscoveredCatalogFiles
			key={snapshotId}
			files={discovery.files}
			canEdit={discovery.canEdit}
			onAdd={async (file, code, label) => {
				await add({
					projectId: id,
					snapshotId,
					unboundFileId: file.id,
					code,
					label,
				});
				toast.success(`${label} added to Strings`);
			}}
		/>
	);
}

/** Keep languages found in Git visible where translators already work. */
export function DiscoveredCatalogNotice({ projectId }: { projectId: string }) {
	const discovery = useQuery(api.locales.discoveredCatalogs, {
		projectId: convexId<"projects">(projectId),
	});
	if (!discovery?.files.length) return null;
	return (
		<Alert>
			<AlertDescription>
				<span>
					{discovery.files.length} catalog{" "}
					{discovery.files.length === 1 ? "file is" : "files are"} ready to add
					to Strings.
				</span>
				<Link
					className="underline underline-offset-4"
					to="/projects/$projectId/sync"
					params={{ projectId }}
					hash="discovered-catalogs"
				>
					Review languages
				</Link>
			</AlertDescription>
		</Alert>
	);
}
