import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "./convex-api";

/** Keep browsing attached to stable catalog identity/classifications. Only text
 * searches need the strict revision that also protects releases and exports. */
export function useCatalogBrowseReadiness(
	projectId: FunctionArgs<typeof api.catalogBrowse.overview>["projectId"],
	searchText?: string,
) {
	const overview = useQuery(api.catalogBrowse.readiness, { projectId });
	const content = useQuery(
		api.catalogBrowse.overview,
		searchText?.trim() ? { projectId } : "skip",
	);
	const prepare = useMutation(api.catalogBrowseIndex.ensurePrepared);
	const needsPreparation =
		overview?.kind === "ready" && overview.optimizationNeeded;
	const projectionId =
		overview?.kind === "ready" ? overview.projectionId : undefined;
	useEffect(() => {
		if (!needsPreparation || !projectionId) return;
		void prepare({ projectId }).catch(() => {
			toast.error("Could not finish preparing Strings. Reload to retry.");
		});
	}, [prepare, projectId, projectionId, needsPreparation]);
	return {
		overview,
		contentRevision:
			content?.kind === "ready" && content.projectionId === projectionId
				? content.revision
				: undefined,
	};
}
