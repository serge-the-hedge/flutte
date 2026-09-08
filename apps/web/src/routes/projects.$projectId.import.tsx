import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { LegacyRouteNotice } from "@/components/localization/legacy-route-notice";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/import")({
	component: ImportRetirementRoute,
});

function ImportRetirementRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/import" });
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	return (
		<LegacyRouteNotice
			projectId={projectId}
			projectName={project?.name ?? "Project"}
			title="Import"
		/>
	);
}
