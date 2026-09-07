import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { cn } from "@blabla/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	ArrowRight,
	GitBranch,
	GitPullRequestArrow,
	KeyRound,
	Languages,
	MessageSquareText,
	ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/convex-api";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

const featureItems = [
	{
		icon: MessageSquareText,
		title: "One working catalog",
		description:
			"Edit every accepted Locale beside its source, context, contract facts, and review state.",
	},
	{
		icon: GitPullRequestArrow,
		title: "Reviewed proposals",
		description:
			"Agents prepare candidates. Humans review by default, with optional authorization for a separate reviewer agent.",
	},
	{
		icon: GitBranch,
		title: "Repository-backed sync",
		description:
			"A read-only local command submits exact ARB evidence and keeps Git as the delivery boundary.",
	},
	{
		icon: Languages,
		title: "Translation tasks",
		description:
			"Prepare an existing Locale or a new one manually or with an agent in the same review flow.",
	},
	{
		icon: ShieldCheck,
		title: "Safe by default",
		description:
			"Stale source, Git, and workspace state is refused before a reviewed value can become current.",
	},
	{
		icon: KeyRound,
		title: "One agent connection",
		description:
			"Give a project-scoped connection to your local adapter or chat agent without publication power.",
	},
] as const;

function StatusPill({ status }: { status: "ok" | "loading" }) {
	const label = status === "ok" ? "Connected" : "Connecting…";
	const dot =
		status === "ok"
			? "bg-success"
			: "bg-warning animate-pulse motion-reduce:animate-none";
	return (
		<span className="inline-flex items-center gap-2 rounded-full border bg-background/60 px-2.5 py-1 text-muted-foreground text-xs">
			<span className={cn("size-2 rounded-full", dot)} aria-hidden />
			{label}
		</span>
	);
}

function HomeComponent() {
	const healthCheck = useQuery(api.healthCheck.get);
	const status: "ok" | "loading" = healthCheck === "OK" ? "ok" : "loading";

	return (
		<div className="h-full overflow-auto">
			<div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
				<section className="flex flex-col gap-6">
					<div className="flex items-center gap-2">
						<Badge variant="outline" className="border-brand/40 text-brand">
							Localization workspace
						</Badge>
						<StatusPill status={status} />
					</div>
					<div className="flex flex-col gap-3">
						<h1 className="font-semibold text-3xl tracking-tight md:text-4xl">
							Translate together. Ship with confidence.
						</h1>
						<p className="max-w-2xl text-muted-foreground text-sm md:text-base">
							Sync exact catalog evidence from Git, translate manually or with
							an agent, review every candidate, and hand a clean local change
							back to the repository.
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button nativeButton={false} render={<Link to="/projects" />}>
							Open projects
							<ArrowRight data-icon="inline-end" />
						</Button>
						<Button
							nativeButton={false}
							variant="outline"
							render={<Link to="/projects/new" />}
						>
							New project
						</Button>
					</div>
				</section>

				<section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{featureItems.map(({ icon: Icon, title, description }) => (
						<Card key={title} size="sm">
							<CardHeader>
								<span
									aria-hidden
									className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground"
								>
									<Icon className="size-4" />
								</span>
								<CardTitle className="mt-2">{title}</CardTitle>
								<CardDescription>{description}</CardDescription>
							</CardHeader>
						</Card>
					))}
				</section>
			</div>
		</div>
	);
}
