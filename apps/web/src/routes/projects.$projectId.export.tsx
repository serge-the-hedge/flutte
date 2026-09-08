import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { LegacyRouteNotice } from "@/components/localization/legacy-route-notice";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/export")({
	component: ExportRetirementRoute,
});

function ExportRetirementRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/export" });
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	return (
		<LegacyRouteNotice
			projectId={projectId}
			projectName={project?.name ?? "Project"}
			title="Export"
		/>
	);
}
