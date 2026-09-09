import { Badge } from "@blabla/ui/components/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/lib/convex-api";

type SyncRun = NonNullable<
	FunctionReturnType<typeof api.snapshots.syncSetup>["latestRun"]
>;

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
