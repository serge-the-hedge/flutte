import { createFileRoute } from "@tanstack/react-router";
import { LocaleProposalWorkbench } from "@/components/localization/locale-proposal-workbench";

export const Route = createFileRoute(
	"/projects/$projectId/locale-proposals/pt",
)({
	component: PortugueseCompatibilityRoute,
});

function PortugueseCompatibilityRoute() {
	const { projectId } = Route.useParams();
	return <LocaleProposalWorkbench projectId={projectId} localeCode="pt" />;
}
