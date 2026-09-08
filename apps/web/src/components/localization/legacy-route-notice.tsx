import { Button } from "@blabla/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { api, convexId } from "@/lib/convex-api";

export function LegacyRouteNotice({
	projectId,
	projectName,
	title,
}: {
	projectId: string;
	projectName: string;
	title: string;
}) {
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	const repository = project?.type === "repository";
	return (
		<ProjectShell projectId={projectId} title={projectName}>
			<PageHeader
				title={title}
				description={`This page is no longer used. Continue in ${repository ? "Sync or Strings" : "Strings"}.`}
			/>
			<div className="flex flex-wrap gap-2">
				{repository && (
					<Button
						nativeButton={false}
						render={
							<Link to="/projects/$projectId/sync" params={{ projectId }} />
						}
					>
						Open Sync
					</Button>
				)}
				<Button
					nativeButton={false}
					variant={repository ? "outline" : "default"}
					render={
						<Link to="/projects/$projectId/strings" params={{ projectId }} />
					}
				>
					Open Strings
				</Button>
			</div>
		</ProjectShell>
	);
}
