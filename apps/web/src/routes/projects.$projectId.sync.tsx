import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@blabla/ui/components/alert";
import { Badge } from "@blabla/ui/components/badge";
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
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	Check,
	Clipboard,
	GitBranch,
	Pencil,
	Plus,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { RepositoryProjectOnly } from "@/components/localization/repository-project-only";
import { blablaCommand, blablaCommandPrefix } from "@/lib/blabla-command";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/sync")({
	component: SyncRoute,
});

type SyncSetup = {
	version: number;
	project: {
		id: string;
		name: string;
		repository: string | null;
	};
	integrationBranch: string;
	bindings: Array<{
		id: string;
		code: string;
		label: string;
		isSource: boolean;
		catalogPath: string | null;
	}>;
	setupIssues: string[];
	canSync: boolean;
	baseline: {
		id: string;
		repository: string;
		commit: string;
		kind: "baseline" | "preview";
		createdAt: number;
	} | null;
	latestRun: {
		id: string;
		status: "succeeded" | "failed";
		snapshotId: string | null;
		createdAt: number;
		diagnosticCount: number;
		diagnostics: Array<{ catalogPath?: string; message: string }>;
		unboundLocaleFileCount: number;
		absentTargetLocaleCount: number;
	} | null;
};

function copyCommand(command: string) {
	void navigator.clipboard
		.writeText(command)
		.then(() => toast.success("Command copied"))
		.catch(() => toast.error("Could not copy the command"));
}

function SyncCommand({
	projectId,
	repository,
	integrationBranch,
}: {
	projectId: string;
	repository: string | null;
	integrationBranch: string;
}) {
	const command = blablaCommand("sync --checkout /path/to/brickit-flutter");
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<GitBranch className="size-4" />
					Connect the local adapter
				</CardTitle>
				<CardDescription>
					The adapter reads the checkout and sends only the bound ARB bytes. It
					never edits, fetches, pushes, or opens a pull request.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{repository ? (
					<div className="text-muted-foreground text-xs">
						Connected repository: <code>{repository}</code>
					</div>
				) : null}
				<div className="text-muted-foreground text-xs">
					Integration branch: <code>{integrationBranch}</code>. Run sync and
					delivery from this checkout branch.
				</div>
				<div className="grid gap-3 md:grid-cols-2">
					<div className="flex flex-col gap-2 rounded-md border p-3">
						<div className="flex items-center gap-2">
							<Badge variant="outline">Once</Badge>
							<span className="font-medium text-sm">Connect this machine</span>
						</div>
						<p className="text-muted-foreground text-xs">
							Create a workspace connection, then run the setup command shown
							with its token. Skip this if you already connected the machine.
							{import.meta.env.DEV
								? " Run it from the Blabla repository."
								: null}
						</p>
						<Button
							nativeButton={false}
							size="sm"
							variant="outline"
							render={
								<Link
									to="/projects/$projectId/settings/api-tokens"
									params={{ projectId }}
								/>
							}
						>
							Open workspace connections
						</Button>
					</div>
					<div className="flex flex-col gap-2 rounded-md border p-3">
						<div className="flex items-center gap-2">
							<Badge variant="outline">Each sync</Badge>
							<span className="font-medium text-sm">Read the checkout</span>
						</div>
						<p className="text-muted-foreground text-xs">
							Replace the example path with the real checkout path. Re-run the
							same command after relevant Git commits change. The command is{" "}
							<code>{blablaCommandPrefix}</code> in this environment.
						</p>
						<div className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5">
							<code className="min-w-0 flex-1 break-all font-mono text-xs">
								{command}
							</code>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Copy sync command"
								onClick={() => copyCommand(command)}
							>
								<Clipboard />
							</Button>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function BindingSetup({ setup }: { setup: SyncSetup }) {
	const projectId = convexId<"projects">(setup.project.id);
	const createLocale = useMutation(api.locales.create);
	const bindLocale = useAction(api.locales.bind);
	const correctSetupBinding = useMutation(api.locales.correctSetupBinding);
	const suggestedBinding = setup.bindings.find(
		(binding) => binding.catalogPath === null,
	);
	const [code, setCode] = useState(suggestedBinding?.code ?? "");
	const [label, setLabel] = useState(suggestedBinding?.label ?? "");
	const [catalogPath, setCatalogPath] = useState(
		suggestedBinding?.catalogPath ?? "",
	);
	const [editingLocaleId, setEditingLocaleId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	function editBinding(binding: SyncSetup["bindings"][number]) {
		setEditingLocaleId(binding.id);
		setCode(binding.code);
		setLabel(binding.label);
		setCatalogPath(binding.catalogPath ?? "");
	}

	function cancelEditing() {
		setEditingLocaleId(null);
		setCode(suggestedBinding?.code ?? "");
		setLabel(suggestedBinding?.label ?? "");
		setCatalogPath(suggestedBinding?.catalogPath ?? "");
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		setSaving(true);
		try {
			const normalizedCode = code.trim();
			const localeId = editingLocaleId
				? await correctSetupBinding({
						localeId: convexId<"locales">(editingLocaleId),
						code: normalizedCode,
						label: label.trim() || normalizedCode,
						catalogPath: catalogPath.trim(),
					})
				: await (async () => {
						const existing = setup.bindings.find(
							(binding) =>
								binding.code.toLowerCase() === normalizedCode.toLowerCase(),
						);
						const createdLocaleId =
							existing?.id ??
							(await createLocale({
								projectId,
								code: normalizedCode,
								label: label.trim() || normalizedCode,
							}));
						await bindLocale({
							localeId: convexId<"locales">(createdLocaleId),
							catalogPath: catalogPath.trim(),
						});
						return createdLocaleId;
					})();
			const nextUnbound = setup.bindings.find(
				(binding) => binding.id !== localeId && binding.catalogPath === null,
			);
			setEditingLocaleId(null);
			setCode(nextUnbound?.code ?? "");
			setLabel(nextUnbound?.label ?? "");
			setCatalogPath("");
			toast.success(
				editingLocaleId
					? "Locale and binding corrected"
					: "Locale binding saved",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save the binding",
			);
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Catalog files</CardTitle>
				<CardDescription>
					Connect each Locale to its repository-relative ARB path. The source
					and at least one target are required for the first accepted catalog.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="divide-y rounded-md border">
					{setup.bindings.map((binding) => (
						<div
							key={binding.id}
							className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm"
						>
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<code className="font-medium text-xs">{binding.code}</code>
								<span className="truncate text-muted-foreground text-xs">
									{binding.label}
								</span>
								{binding.isSource ? (
									<Badge variant="secondary">Source</Badge>
								) : null}
							</div>
							<code className="max-w-full truncate text-muted-foreground text-xs">
								{binding.catalogPath ?? "Not connected"}
							</code>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => editBinding(binding)}
							>
								<Pencil data-icon="inline-start" />
								Edit
							</Button>
						</div>
					))}
				</div>
				<form onSubmit={submit}>
					<div className="mb-2 font-medium text-xs">
						Add or update a binding
					</div>
					<FieldGroup className="grid items-end gap-3 sm:grid-cols-[120px_1fr_1.5fr_auto]">
						<Field>
							<FieldLabel htmlFor="sync-locale-code">Locale</FieldLabel>
							<Input
								id="sync-locale-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								placeholder="en"
								autoComplete="off"
								spellCheck={false}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="sync-locale-label">Label</FieldLabel>
							<Input
								id="sync-locale-label"
								value={label}
								onChange={(event) => setLabel(event.target.value)}
								placeholder="English"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="sync-catalog-path">Catalog path</FieldLabel>
							<Input
								id="sync-catalog-path"
								value={catalogPath}
								onChange={(event) => setCatalogPath(event.target.value)}
								placeholder="lib/l10n/intl_en.arb"
								autoComplete="off"
								spellCheck={false}
							/>
						</Field>
						<div className="flex gap-2">
							<Button
								type="submit"
								disabled={!code.trim() || !catalogPath.trim() || saving}
							>
								{editingLocaleId ? (
									<Check data-icon="inline-start" />
								) : (
									<Plus data-icon="inline-start" />
								)}
								{saving
									? "Saving…"
									: editingLocaleId
										? "Save changes"
										: "Save binding"}
							</Button>
							{editingLocaleId ? (
								<Button
									type="button"
									variant="outline"
									onClick={cancelEditing}
									disabled={saving}
								>
									Cancel
								</Button>
							) : null}
						</div>
					</FieldGroup>
					<p className="mt-2 text-muted-foreground text-xs">
						Use the exact path from the checkout, for example{" "}
						<code>lib/l10n/intl_en.arb</code>. An existing Locale code updates
						that binding; a new code creates a target Locale.
					</p>
				</form>
			</CardContent>
		</Card>
	);
}

function SyncRoute() {
	const { projectId } = Route.useParams();
	return (
		<RepositoryProjectOnly projectId={projectId}>
			<RepositorySyncRoute />
		</RepositoryProjectOnly>
	);
}

function RepositorySyncRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/sync" });
	const setup = useQuery(api.snapshots.syncSetup, {
		projectId: convexId<"projects">(projectId),
	}) as SyncSetup | undefined;

	if (setup === undefined) {
		return (
			<ProjectShell projectId={projectId} title="Project">
				<PageHeader title="Sync" description="Connect the Brickit checkout." />
				<Skeleton className="h-72 w-full" />
			</ProjectShell>
		);
	}

	const needsSetup = setup.setupIssues.length > 0;
	return (
		<ProjectShell projectId={projectId} title={setup.project.name}>
			<PageHeader
				title="Sync"
				description="Connect Brickit once, then keep the accepted catalog current."
				action={
					setup.baseline ? (
						<Button
							nativeButton={false}
							render={
								<Link
									to="/projects/$projectId/strings"
									params={{ projectId }}
								/>
							}
						>
							Open Strings
						</Button>
					) : null
				}
			/>
			<div className="flex flex-col gap-4">
				{needsSetup ? (
					<Alert>
						<TriangleAlert className="size-4" />
						<AlertTitle>Finish catalog setup</AlertTitle>
						<AlertDescription>
							<ul className="list-disc space-y-1 pl-4">
								{setup.setupIssues.map((issue) => (
									<li key={issue}>{issue}</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				) : (
					<Alert>
						<Check className="size-4" />
						<AlertTitle>Catalogs ready</AlertTitle>
						<AlertDescription>
							Bindings are ready. Run the one command below from the Brickit
							checkout.
						</AlertDescription>
					</Alert>
				)}

				<BindingSetup setup={setup} />
				<SyncCommand
					projectId={projectId}
					repository={setup.project.repository}
					integrationBranch={setup.integrationBranch}
				/>

				<Card size="sm">
					<CardHeader>
						<CardTitle>Accepted catalog</CardTitle>
						<CardDescription>
							Strings becomes available only after a Source Snapshot is accepted
							as the Baseline.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{setup.baseline ? (
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<Badge variant="secondary">Baseline</Badge>
								<code className="text-xs">
									{setup.baseline.commit.slice(0, 12)}
								</code>
								<span className="text-muted-foreground">from</span>
								<code className="text-xs">{setup.baseline.repository}</code>
							</div>
						) : (
							<p className="text-muted-foreground text-sm">
								No accepted snapshot yet. Sync the checkout to establish the
								first baseline.
							</p>
						)}
					</CardContent>
				</Card>

				{setup.latestRun ? (
					<Card size="sm">
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								<RefreshCw className="size-4" />
								Latest sync receipt
								<Badge
									variant={
										setup.latestRun.status === "succeeded"
											? "secondary"
											: "destructive"
									}
								>
									{setup.latestRun.status}
								</Badge>
							</CardTitle>
							<CardDescription>
								Run <code>{setup.latestRun.id}</code>
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-3 text-sm">
							{setup.latestRun.unboundLocaleFileCount > 0 ||
							setup.latestRun.absentTargetLocaleCount > 0 ? (
								<div className="text-muted-foreground text-xs">
									{setup.latestRun.unboundLocaleFileCount} unbound file(s),{" "}
									{setup.latestRun.absentTargetLocaleCount} target Locale
									file(s) absent in this commit.
								</div>
							) : null}
							{setup.latestRun.diagnostics.length > 0 ? (
								<ul className="space-y-1 text-destructive text-xs">
									{setup.latestRun.diagnostics.map((diagnostic) => (
										<li
											key={`${diagnostic.catalogPath ?? "run"}-${diagnostic.message}`}
										>
											{diagnostic.catalogPath
												? `${diagnostic.catalogPath}: `
												: ""}
											{diagnostic.message}
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-xs">No diagnostics.</p>
							)}
						</CardContent>
					</Card>
				) : null}
			</div>
		</ProjectShell>
	);
}
