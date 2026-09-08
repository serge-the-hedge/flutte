import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useEffect } from "react";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId")({
	component: ProjectIndexRoute,
});

function ProjectIndexRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId" });
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	const opening = pathname === `/projects/${projectId}`;
	const project = useQuery(
		api.projects.get,
		opening ? { projectId: convexId<"projects">(projectId) } : "skip",
	);
	const collections = useQuery(
		api.contentCollections.list,
		opening && project && !project.baselineSnapshotId
			? { projectId: convexId<"projects">(projectId) }
			: "skip",
	);
	const managedId = collections?.find(
		(collection) => collection.kind === "managed",
	)?.id;
	useEffect(() => {
		if (opening && project && (project.baselineSnapshotId || collections)) {
			if (managedId) {
				void navigate({
					to: "/projects/$projectId/strings",
					params: { projectId },
					search: { collection: managedId },
					replace: true,
				});
				return;
			}
			navigate({
				to: "/projects/$projectId/sync",
				params: { projectId },
				search: {},
				replace: true,
			});
		}
	}, [navigate, opening, project, collections, managedId, projectId]);

	if (pathname !== `/projects/${projectId}`) {
		return <Outlet />;
	}

	return (
		<div className="p-5 text-muted-foreground text-sm">Opening project…</div>
	);
}
