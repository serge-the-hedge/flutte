import { Badge } from "@blabla/ui/components/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import type { FunctionReturnType } from "convex/server";
import { CircleAlert, LoaderCircle } from "lucide-react";
import type { api } from "@/lib/convex-api";

type SyncRun = NonNullable<
	FunctionReturnType<typeof api.snapshots.syncSetup>["latestRun"]
>;
type ActiveSync = NonNullable<
	FunctionReturnType<typeof api.snapshots.syncSetup>["activeSync"]
>;

const STAGE_LABELS = {
	queued: "Waiting to start",
	validating: "Validating catalogs",
	reconciling: "Reconciling catalog keys",
	staging: "Writing catalog changes",
	reviewing: "Restoring approved translations",
	indexing: "Preparing Strings",
	publishing: "Publishing snapshot",
} as const;

/** Live progress for the durable upload job. The reactive setup query updates
 * this card while the CLI is free to reconnect and poll the same job. */
export function SyncProgress({ sync }: { sync: ActiveSync }) {
	const failed = sync.status === "failed";
	const progress = sync.progress;
	const stage = sync.stage ? STAGE_LABELS[sync.stage] : "Preparing snapshot";
	const percentage = progress
		? progress.total === 0
			? 100
			: Math.min(100, (progress.completed / progress.total) * 100)
		: null;
	const progressLabel = progress
		? `${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} ${sync.stage === "validating" ? "catalogs" : "strings"}`
		: null;

	return (
		<Card size="sm" role={failed ? "alert" : "status"}>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-start gap-2">
					{failed ? (
						<CircleAlert
							aria-hidden="true"
							className="mt-0.5 size-4 text-destructive"
						/>
					) : (
						<LoaderCircle
							aria-hidden="true"
							className="mt-0.5 size-4 animate-spin text-muted-foreground"
						/>
					)}
					<div className="flex flex-col gap-0.5">
						<span className="font-medium text-sm">
							{failed ? "Sync failed" : stage}
						</span>
						<span className="text-muted-foreground text-xs">
							{failed
								? (sync.failure ??
									"Blabla could not finish the sync. Running it again is safe.")
								: progressLabel
									? `${progressLabel}. You can leave this page while syncing continues.`
									: "You can leave this page while syncing continues."}
						</span>
					</div>
				</div>
				{!failed && percentage !== null ? (
					<div
						aria-label={stage}
						aria-valuemax={progress?.total}
						aria-valuemin={0}
						aria-valuenow={progress?.completed}
						className="h-1 overflow-hidden rounded-full bg-muted"
						role="progressbar"
					>
						<div
							className="h-full bg-foreground/45 transition-[width] duration-300"
							style={{ width: `${percentage}%` }}
						/>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

/** Historical transition facts, independent of today's translation backlog. */
export function SyncResult({ run }: { run: SyncRun }) {
	const summary = run.summary;
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					Latest sync
					<Badge
						variant={run.status === "failed" ? "destructive" : "secondary"}
					>
						{run.status === "failed"
							? "Failed"
							: run.snapshotKind === "preview"
								? "Preview"
								: "Complete"}
					</Badge>
				</CardTitle>
				<CardDescription>
					<time dateTime={new Date(run.createdAt).toISOString()}>
						{new Date(run.createdAt).toLocaleString()}
					</time>
					{run.commit ? (
						<>
							{" "}
							· <code>{run.commit.slice(0, 12)}</code>
						</>
					) : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3 text-sm">
				{run.status === "failed" ? (
					<p>The sync did not complete. Your accepted catalog is unchanged.</p>
				) : run.snapshotKind === "preview" ? (
					<p>Preview saved; your accepted catalog is unchanged.</p>
				) : summary ? (
					<>
						<p className="text-muted-foreground text-xs">
							{summary.outcome === "initial"
								? "First catalog imported."
								: "Changes in this snapshot."}{" "}
							{summary.sourceKeyCount.toLocaleString()} source keys.
						</p>
						<dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
							{(
								[
									["New keys", summary.addedKeyCount],
									["Source changed", summary.changedSourceKeyCount],
									["Keys archived", summary.removedKeyCount],
									["Translations changed", summary.targetValueChangeCount],
								] as const
							).map(([label, count]) => (
								<div key={label}>
									<dt className="text-muted-foreground text-xs">{label}</dt>
									<dd className="mt-1 font-medium text-lg tabular-nums">
										{count.toLocaleString()}
									</dd>
								</div>
							))}
						</dl>
					</>
				) : (
					<p className="text-muted-foreground text-xs">
						Change totals were not recorded for this sync.
					</p>
				)}
				{run.unboundLocaleFileCount > 0 ? (
					<p>
						{run.unboundLocaleFileCount} language files were unbound in this
						snapshot.
					</p>
				) : null}
				{run.absentTargetLocaleCount > 0 ? (
					<p>
						{run.absentTargetLocaleCount} bound language files were absent from
						this commit.
					</p>
				) : null}
				{run.diagnostics.length > 0 ? (
					<ul className="space-y-1 text-destructive text-xs">
						{run.diagnostics.map((diagnostic) => (
							<li
								key={`${diagnostic.catalogPath ?? "run"}-${diagnostic.message}`}
							>
								{diagnostic.catalogPath ? `${diagnostic.catalogPath}: ` : ""}
								{diagnostic.message}
							</li>
						))}
					</ul>
				) : null}
			</CardContent>
		</Card>
	);
}
