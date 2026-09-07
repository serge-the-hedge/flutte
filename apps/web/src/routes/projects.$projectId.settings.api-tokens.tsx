import { env } from "@blabla/env/web";
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
import { Checkbox } from "@blabla/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { cn } from "@blabla/ui/lib/utils";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Copy, KeyRound, Plus, ShieldCheck, Terminal, X } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { blablaCommand } from "@/lib/blabla-command";
import { api, convexId } from "@/lib/convex-api";

const scopes = [
	"read",
	"search",
	"propose",
	"export",
	"snapshot-submission",
] as const;
type TokenScope = FunctionArgs<typeof api.apiTokens.create>["scopes"][number];
const workspaceScopes: TokenScope[] = [
	"read",
	"search",
	"propose",
	"export",
	"snapshot-submission",
];
const reviewerScopes: TokenScope[] = ["read", "review"];
type ApiToken = FunctionReturnType<typeof api.apiTokens.list>[number];

export const Route = createFileRoute(
	"/projects/$projectId/settings/api-tokens",
)({
	component: ApiTokensRoute,
});

function ApiTokensRoute() {
	const { projectId } = useParams({
		from: "/projects/$projectId/settings/api-tokens",
	});
	return <ApiTokensForProject key={projectId} projectId={projectId} />;
}

function ApiTokensForProject({ projectId }: { projectId: string }) {
	const convexProjectId = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: convexProjectId });
	const tokens = useQuery(api.apiTokens.list, { projectId: convexProjectId });
	const createToken = useMutation(api.apiTokens.create);
	const revoke = useMutation(api.apiTokens.revoke);
	const [name, setName] = useState("brickit-workspace");
	const [selectedScopes, setSelectedScopes] =
		useState<TokenScope[]>(workspaceScopes);
	const [showAdvancedScopes, setShowAdvancedScopes] = useState(false);
	const [isReviewer, setIsReviewer] = useState(false);
	const [issuedReviewerToken, setIssuedReviewerToken] = useState(false);
	const effectiveScopes = isReviewer ? reviewerScopes : selectedScopes;
	const isOwner = project?.role === "owner";
	const [rawToken, setRawToken] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [revokingId, setRevokingId] = useState<string>();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!isOwner || isCreating) return;
		setIsCreating(true);
		try {
			const result = await createToken({
				projectId: convexProjectId,
				name,
				scopes: effectiveScopes,
			});
			setRawToken(result.token);
			setIssuedReviewerToken(isReviewer);
			setName(isReviewer ? "independent-reviewer" : "brickit-workspace");
			toast.success("Token created — copy it now");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not create token",
			);
		} finally {
			setIsCreating(false);
		}
	}

	async function copyToken() {
		if (!rawToken) return;
		try {
			await navigator.clipboard.writeText(rawToken);
			toast.success("Token copied to clipboard");
		} catch {
			toast.error("Could not copy the token. Select and copy it manually.");
		}
	}

	async function copyConnectionCommand() {
		if (!rawToken) return;
		const command = blablaCommand(
			`login --server ${env.VITE_CONVEX_SITE_URL} --token ${rawToken}`,
		);
		try {
			await navigator.clipboard.writeText(command);
			toast.success("Connection command copied");
		} catch {
			toast.error("Could not copy the command. Select and copy it manually.");
		}
	}

	async function revokeToken(token: ApiToken) {
		setRevokingId(token._id);
		try {
			await revoke({ tokenId: convexId<"apiTokens">(token._id) });
			toast.success("Token revoked");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not revoke token",
			);
		} finally {
			setRevokingId(undefined);
		}
	}

	function closeToken() {
		setRawToken("");
	}

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title="API tokens"
				description="Project-scoped connections for the local adapter and external agents."
			/>
			<div className="flex flex-col gap-4">
				{isOwner ? (
					<Card size="sm">
						<CardHeader>
							<CardTitle>Create API token</CardTitle>
							<CardDescription>
								Workspace credentials let local commands sync snapshots and
								deliver reviewed bundles, and agents propose translations.
								Reviewer credentials belong to a separate agent and only read
								and review authorized candidates.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<form onSubmit={submit}>
								<FieldGroup>
									<Field orientation="horizontal">
										<Checkbox
											id="reviewer-token"
											checked={isReviewer}
											disabled={isCreating}
											onCheckedChange={(checked) => {
												setIsReviewer(checked === true);
												setRawToken("");
												setName(
													checked === true
														? "independent-reviewer"
														: "brickit-workspace",
												);
											}}
										/>
										<FieldLabel htmlFor="reviewer-token">
											Dedicated Reviewer credential
										</FieldLabel>
									</Field>
									{isReviewer ? (
										<p className="text-muted-foreground text-xs">
											Give this credential only to a separate reviewer agent. It
											can read and review authorized candidates, but cannot
											propose translations, submit snapshots, or deliver
											changes.
										</p>
									) : null}
									<Field>
										<FieldLabel htmlFor="token-name">Name</FieldLabel>
										<Input
											id="token-name"
											name="tokenName"
											autoComplete="off"
											value={name}
											onChange={(event) => setName(event.target.value)}
											placeholder="agent-ci, translator-bot…"
										/>
									</Field>
									<Field>
										<FieldLabel>Permissions</FieldLabel>
										<div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="font-medium text-xs">
													{isReviewer
														? "Reviewer credential"
														: "Workspace connection"}
												</span>
												{effectiveScopes.map((scope) => (
													<Badge
														key={scope}
														variant="secondary"
														className="font-normal"
													>
														{scope}
													</Badge>
												))}
											</div>
											{!isReviewer ? (
												<Button
													type="button"
													size="xs"
													variant="ghost"
													onClick={() =>
														setShowAdvancedScopes((value) => !value)
													}
												>
													{showAdvancedScopes ? "Hide advanced" : "Customize"}
												</Button>
											) : null}
										</div>
										{showAdvancedScopes && !isReviewer ? (
											<div className="mt-3 flex flex-wrap gap-3 rounded-md border bg-muted/30 p-3">
												{scopes.map((scope) => {
													const id = `scope-${scope}`;
													const checked = selectedScopes.includes(scope);
													return (
														<label
															key={scope}
															htmlFor={id}
															className={cn(
																"flex cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs transition-colors",
																checked
																	? "border-brand/40 bg-brand/5 text-foreground"
																	: "border-input text-muted-foreground hover:text-foreground",
															)}
														>
															<Checkbox
																id={id}
																checked={checked}
																onCheckedChange={(value) =>
																	setSelectedScopes((current) =>
																		value
																			? [...current, scope]
																			: current.filter(
																					(item) => item !== scope,
																				),
																	)
																}
															/>
															<span className="capitalize">{scope}</span>
														</label>
													);
												})}
											</div>
										) : null}
									</Field>
									<Button
										type="submit"
										disabled={
											!name.trim() || effectiveScopes.length === 0 || isCreating
										}
									>
										<Plus data-icon="inline-start" />
										{isCreating
											? "Creating…"
											: isReviewer
												? "Create Reviewer token"
												: "Create workspace connection"}
									</Button>
									{rawToken ? (
										<div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
											<div className="flex items-center justify-between gap-2">
												<span className="font-medium">
													Copy this token now — it won't be shown again.
												</span>
												<div className="flex items-center gap-1">
													<Button
														type="button"
														size="xs"
														variant="ghost"
														onClick={copyToken}
													>
														<Copy data-icon="inline-start" />
														Copy
													</Button>
													<Button
														type="button"
														size="xs"
														variant="ghost"
														onClick={closeToken}
														aria-label="Close token"
													>
														<X data-icon="inline-start" />
														Close
													</Button>
												</div>
											</div>
											<pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-[11px]">
												{rawToken}
											</pre>
											{!issuedReviewerToken ? (
												<div className="mt-2 flex flex-col gap-2 border-warning/30 border-t pt-2">
													<span className="font-medium">
														Connect this machine once
													</span>
													<code className="break-all rounded-md bg-background p-2 font-mono text-[11px]">
														{blablaCommand(
															`login --server ${env.VITE_CONVEX_SITE_URL} --token ${rawToken}`,
														)}
													</code>
													<Button
														type="button"
														size="xs"
														variant="outline"
														onClick={copyConnectionCommand}
													>
														<Terminal data-icon="inline-start" />
														Copy setup command
													</Button>
													<span className="text-muted-foreground">
														This command contains the secret token. Run it
														locally; do not paste it into chat or commit it.
													</span>
												</div>
											) : (
												<p className="mt-2 text-muted-foreground">
													Configure this token as the separate reviewer agent’s
													Bearer credential. Keep it out of the translator’s
													session and leave the local workspace CLI connection
													unchanged.
												</p>
											)}
										</div>
									) : null}
								</FieldGroup>
							</form>
						</CardContent>
					</Card>
				) : null}

				<Card size="sm">
					<CardHeader>
						<CardTitle>Agent connection</CardTitle>
						<CardDescription>
							The same workspace connection can be handed to an agent through
							your chat or used by the local sync and delivery commands.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<div className="grid gap-2 text-xs md:grid-cols-2">
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="mb-1 flex items-center gap-1.5 font-medium">
									<Terminal className="size-3.5" />
									Base URL
								</div>
								<code className="break-all text-muted-foreground">
									{env.VITE_CONVEX_SITE_URL}/api/agent/v1
								</code>
							</div>
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="mb-1 flex items-center gap-1.5 font-medium">
									<ShieldCheck className="size-3.5" />
									Header
								</div>
								<code className="break-all text-muted-foreground">
									Authorization: Bearer {"<project_api_token>"}
								</code>
							</div>
						</div>
						<Alert>
							<KeyRound className="size-4" />
							<AlertTitle>Reviewable changes only</AlertTitle>
							<AlertDescription>
								Translation credentials create inert candidates. A human decides
								them, or authorizes a separate reviewer agent through the
								project setting or an exact-revision delegation.
							</AlertDescription>
						</Alert>
					</CardContent>
				</Card>

				{tokens === undefined ? (
					<Skeleton className="h-32 w-full" />
				) : tokens.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<KeyRound />
							</EmptyMedia>
							<EmptyTitle>No tokens yet</EmptyTitle>
							<EmptyDescription>
								Create a scoped connection for repository sync or reviewable
								agent proposals.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Card size="sm">
						<CardContent className="divide-y">
							{tokens.map((token) => (
								<div
									key={token._id}
									className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
								>
									<div className="flex min-w-0 flex-col gap-1">
										<span className="truncate font-medium text-sm">
											{token.name}
										</span>
										<div className="flex flex-wrap gap-1">
											{token.scopes.map((scope: string) => (
												<Badge
													key={scope}
													variant="outline"
													className="font-normal capitalize"
												>
													{scope}
												</Badge>
											))}
										</div>
									</div>
									{isOwner && !token.revokedAt ? (
										<ConfirmAction
											triggerLabel={
												revokingId === token._id ? "Revoking…" : "Revoke"
											}
											title={`Revoke ${token.name}?`}
											description="Any agent using this token will immediately lose access. This cannot be undone."
											confirmLabel="Revoke token"
											disabled={revokingId !== undefined}
											onConfirm={() => revokeToken(token)}
										/>
									) : token.revokedAt ? (
										<Badge variant="outline">Revoked</Badge>
									) : null}
								</div>
							))}
						</CardContent>
					</Card>
				)}
			</div>
		</ProjectShell>
	);
}
