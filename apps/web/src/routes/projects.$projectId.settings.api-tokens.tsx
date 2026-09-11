import { createFileRoute } from "@tanstack/react-router";
import { AgentAccess } from "@/components/localization/agent-access";

export const Route = createFileRoute(
	"/projects/$projectId/settings/api-tokens",
)({
	component: AgentAccessRoute,
});

function AgentAccessRoute() {
	const { projectId } = Route.useParams();
	return <AgentAccess key={projectId} projectId={projectId} />;
}
