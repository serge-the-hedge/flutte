import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api, convexId } from "@/lib/convex-api";
import { ProjectShell } from "./project-shell";

/** Keep repository operations and their subscriptions out of Basic projects. */
export function RepositoryProjectOnly({
	projectId,
	children,
}: {
	projectId: string;
	children: ReactNode;
}) {
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});
	if (project?.type === "repository") return children;
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			{project ? (
				<p className="text-sm">
					This is a Basic project.{" "}
					<Link
						to="/projects/$projectId/strings"
						params={{ projectId }}
						search={{}}
						className="underline"
					>
						Open Strings
					</Link>{" "}
					to write, translate, or download content.
				</p>
			) : (
				<p role="status">Loading project…</p>
			)}
		</ProjectShell>
	);
}
