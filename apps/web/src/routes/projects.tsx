import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Skeleton } from "@blabla/ui/components/skeleton";
import {
	createFileRoute,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import {
	Authenticated,
	AuthLoading,
	Unauthenticated,
	useQuery,
} from "convex/react";
import { ArrowUpRight, FolderKanban, Plus } from "lucide-react";

import AuthRedirect from "@/components/auth-redirect";
import { api } from "@/lib/convex-api";

export const Route = createFileRoute("/projects")({
	component: ProjectsRoute,
});

function ProjectsHeader() {
	return (
		<div className="flex flex-wrap items-end justify-between gap-3">
			<div className="flex flex-col gap-1">
				<h1 className="font-semibold text-2xl tracking-tight">Projects</h1>
				<p className="text-muted-foreground text-sm">
					Write content here or connect a repository.
				</p>
			</div>
			<Button nativeButton={false} render={<Link to="/projects/new" />}>
				<Plus data-icon="inline-start" />
				New project
			</Button>
		</div>
	);
}

function ProjectsGridSkeleton() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			{[0, 1, 2, 3].map((index) => (
				<Skeleton key={index} className="h-28 w-full" />
			))}
		</div>
	);
}

function ProjectsContent() {
	const projects = useQuery(api.projects.listMine);

	return (
		<div className="mx-auto flex h-full max-w-5xl flex-col gap-6 overflow-auto px-6 py-8">
			<ProjectsHeader />
			{projects === undefined ? (
				<ProjectsGridSkeleton />
			) : projects.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FolderKanban />
						</EmptyMedia>
						<EmptyTitle>No projects yet</EmptyTitle>
						<EmptyDescription>
							Create a project to start writing or translating content.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button nativeButton={false} render={<Link to="/projects/new" />}>
							<Plus data-icon="inline-start" />
							Create project
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<div className="grid gap-3 md:grid-cols-2">
					{projects.map((project) => (
						<Link
							key={project._id}
							to="/projects/$projectId/strings"
							params={{ projectId: project._id }}
							search={{}}
							className="group outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Card className="h-full transition-colors group-hover:bg-muted/40">
								<CardHeader>
									<div className="flex items-center justify-between gap-2">
										<CardTitle className="truncate font-medium text-base">
											{project.name}
										</CardTitle>
										<ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
									</div>
									<CardDescription className="truncate font-mono">
										{project.slug}
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="flex items-center gap-1.5">
										<Badge variant="outline">
											{project.type === "basic" ? "Basic" : "Repository"}
										</Badge>
										<Badge variant="secondary" className="capitalize">
											{project.role}
										</Badge>
									</div>
								</CardContent>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}

function ProjectsRoute() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<>
			<Authenticated>
				{pathname === "/projects" ? <ProjectsContent /> : <Outlet />}
			</Authenticated>
			<Unauthenticated>
				<AuthRedirect />
			</Unauthenticated>
			<AuthLoading>
				<div className="mx-auto max-w-5xl px-6 py-8">
					<ProjectsGridSkeleton />
				</div>
			</AuthLoading>
		</>
	);
}
