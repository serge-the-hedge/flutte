import { buttonVariants } from "@blabla/ui/components/button";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { DiscoveredCatalogs } from "@/components/localization/discovered-catalogs";
import { LanguageIntroductionEditor } from "@/components/localization/language-introduction-editor";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/settings/languages")(
	{ component: LanguagesRoute },
);

function LanguagesRoute() {
	const { projectId } = Route.useParams();
	const id = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: id });
	const targets = useQuery(api.localeIntroductionTargets.list, {
		projectId: id,
	});
	const locales = useQuery(api.locales.list, { projectId: id });
	const save = useMutation(api.localeIntroductionTargets.save);
	const remove = useMutation(api.localeIntroductionTargets.remove);
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title="Languages"
				description="Configure each new language once, then prepare, review, and deliver its catalog."
			/>
			<DiscoveredCatalogs projectId={projectId} />
			{project && targets && locales ? (
				<LanguageIntroductionEditor
					key={projectId}
					targets={targets}
					activeLocaleCodes={locales
						.filter((locale) => locale.archivedAt === undefined)
						.map((locale) => locale.code)}
					canEdit={project.role === "owner" || project.role === "editor"}
					onSave={(target) => save({ projectId: id, ...target })}
					onRemove={(localeCode) => remove({ projectId: id, localeCode })}
				/>
			) : (
				<Skeleton className="h-64 w-full" />
			)}
			<Link
				className={buttonVariants({ variant: "outline" })}
				to="/projects/$projectId/proposals"
				params={{ projectId }}
			>
				Open translation tasks
			</Link>
		</ProjectShell>
	);
}
