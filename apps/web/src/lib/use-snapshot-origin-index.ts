import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api, convexId } from "./convex-api";

/** Selecting a historical snapshot prepares its disposable filter index once.
 * Browse and counts wait for readiness rather than presenting partial results. */
export function useSnapshotOriginIndex(
	input:
		| {
				projectId: string;
				projectionId: string;
				snapshotIds: string[];
		  }
		| "skip",
) {
	const prepare = useMutation(api.snapshotOriginIndex.prepare);
	const key = JSON.stringify(input);
	const status = useQuery(
		api.snapshotOriginIndex.status,
		input === "skip"
			? "skip"
			: {
					projectId: convexId<"projects">(input.projectId),
					projectionId: convexId<"catalogProjections">(input.projectionId),
					snapshotIds: input.snapshotIds.map((id) =>
						convexId<"sourceSnapshots">(id),
					),
				},
	);
	const [failure, setFailure] = useState<{ key: string; message: string }>();
	const pendingKey = JSON.stringify(
		status?.snapshots
			.filter((item) => item.status === "missing")
			.map((item) => item.snapshotId) ?? [],
	);
	useEffect(() => {
		const args = JSON.parse(key) as typeof input;
		if (args === "skip") return;
		const { projectId, projectionId } = args;
		const pending = JSON.parse(pendingKey) as string[];
		if (!pending.length) return;
		let cancelled = false;
		async function start() {
			for (const snapshotId of pending) {
				if (cancelled) return;
				await prepare({
					projectId: convexId<"projects">(projectId),
					projectionId: convexId<"catalogProjections">(projectionId),
					snapshotId: convexId<"sourceSnapshots">(snapshotId),
				});
			}
		}
		void start().catch((error) => {
			if (!cancelled)
				setFailure({
					key,
					message:
						error instanceof Error
							? error.message
							: "Could not prepare the snapshot filter.",
				});
		});
		return () => {
			cancelled = true;
		};
	}, [key, pendingKey, prepare]);
	const [clock, setClock] = useState(Date.now);
	const oldestBuildingUpdate = Math.min(
		...(status?.snapshots.flatMap((item) =>
			item.status === "building" && item.updatedAt !== null
				? [item.updatedAt]
				: [],
		) ?? []),
	);
	useEffect(() => {
		if (JSON.parse(key) === "skip" || !Number.isFinite(oldestBuildingUpdate))
			return;
		const timer = setTimeout(
			() => setClock(Date.now()),
			Math.max(0, oldestBuildingUpdate + 60_000 - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [key, oldestBuildingUpdate]);
	const paused = clock >= oldestBuildingUpdate + 60_000;
	const failed = status?.snapshots.find((item) => item.status === "failed");
	return {
		ready: input === "skip" || status?.ready === true,
		processed:
			status?.snapshots.reduce((total, item) => total + item.processed, 0) ?? 0,
		expected:
			status?.snapshots.reduce((total, item) => total + item.expected, 0) ?? 0,
		error:
			(failure?.key === key ? failure.message : undefined) ??
			failed?.failure ??
			(paused ? "Snapshot preparation paused. Retry to continue." : undefined),
		retry: async () => {
			setFailure(undefined);
			if (input === "skip") return;
			try {
				for (const item of status?.snapshots ?? []) {
					if (
						item.status !== "failed" &&
						item.status !== "missing" &&
						!(
							item.status === "building" &&
							item.updatedAt !== null &&
							item.updatedAt <= Date.now() - 60_000
						)
					)
						continue;
					await prepare({
						projectId: convexId<"projects">(input.projectId),
						projectionId: convexId<"catalogProjections">(input.projectionId),
						snapshotId: item.snapshotId,
					});
				}
			} catch (error) {
				setFailure({
					key,
					message:
						error instanceof Error
							? error.message
							: "Could not prepare the snapshot filter.",
				});
			}
		},
	};
}
