import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import {
	createFileRoute,
	Link,
	Outlet,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowUpRight,
	BookOpen,
	KeyRound,
	Languages,
	Users,
} from "lucide-react";
import { AgentReviewPolicyCard } from "@/components/localization/agent-review-policy-card";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/settings")({
	component: SettingsRoute,
});

const settingsLinks = [
	{
		to: "/projects/$projectId/settings/languages" as const,
		title: "Languages",
		description: "Language setup and catalog files.",
		icon: Languages,
	},
	{
		to: "/projects/$projectId/settings/guidance" as const,
		title: "Guidance",
		description: "Dictionary and voice guide.",
		icon: BookOpen,
	},
	{
		to: "/projects/$projectId/settings/api-tokens" as const,
		title: "API tokens",
		description: "Agent access and permissions.",
		icon: KeyRound,
	},
	{
		to: "/projects/$projectId/settings/members" as const,
		title: "Members",
		description: "Owners, editors, and viewers.",
		icon: Users,
	},
];

function SettingsRoute() {
	const { projectId } = useParams({ from: "/projects/$projectId/settings" });
	const setAgentReviewPolicy = useMutation(api.projects.setAgentReviewPolicy);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const project = useQuery(api.projects.get, {
		projectId: convexId<"projects">(projectId),
	});

	if (pathname !== `/projects/${projectId}/settings`) {
		return <Outlet />;
	}

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader title="Settings" />
			<div className="grid gap-3 md:grid-cols-2">
				{settingsLinks.map(({ to, title, description, icon: Icon }) => (
					<Link
						key={to}
						to={to}
						params={{ projectId }}
						className="group outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Card
							size="sm"
							className="h-full transition-colors group-hover:bg-muted/40"
						>
							<CardHeader>
								<div className="flex items-center justify-between gap-2">
									<span
										aria-hidden
										className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground"
									>
										<Icon className="size-4" />
									</span>
									<ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
								</div>
								<CardTitle className="mt-2">{title}</CardTitle>
								<CardDescription>{description}</CardDescription>
							</CardHeader>
						</Card>
					</Link>
				))}
			</div>
			{project ? (
				<div className="mt-4">
					<AgentReviewPolicyCard
						key={projectId}
						enabled={project.agentReviewPolicy?.enabled ?? false}
						isOwner={project.role === "owner"}
						onChange={(enabled) =>
							setAgentReviewPolicy({
								projectId: convexId<"projects">(projectId),
								enabled,
							})
						}
					/>
				</div>
			) : null}
		</ProjectShell>
	);
}
