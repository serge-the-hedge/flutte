import { Button } from "@blabla/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	return (
		<div className="h-full overflow-auto">
			<div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12">
				<div className="flex flex-col gap-3">
					<h1 className="font-semibold text-3xl tracking-tight md:text-4xl">
						Write and translate together
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm md:text-base">
						Create content here or sync ARB files from a repository.
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
			</div>
		</div>
	);
}
