import { buttonVariants } from "@blabla/ui/components/button";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/icon-button";
import { DiscoveredCatalogs } from "@/components/localization/discovered-catalogs";
import { LanguageIntroductionEditor } from "@/components/localization/language-introduction-editor";
import { LanguageMetadataEditor } from "@/components/localization/language-metadata-editor";
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
	const [editingId, setEditingId] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	useBlocker({
		disabled: !dirty,
		enableBeforeUnload: dirty,
		shouldBlockFn: () =>
			!window.confirm(
				"Discard unsaved language edits? Saves already sent will still complete.",
			),
	});
	const id = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: id });
	const targets = useQuery(api.localeIntroductionTargets.list, {
		projectId: id,
	});
	const locales = useQuery(api.locales.list, { projectId: id });
	const save = useMutation(api.localeIntroductionTargets.save);
	const remove = useMutation(api.localeIntroductionTargets.remove);
	const canEdit = project?.role === "owner" || project?.role === "editor";
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader title="Languages" />
			<DiscoveredCatalogs projectId={projectId} />
			{locales?.some((locale) => locale.archivedAt === undefined) ? (
				<section aria-label="Project languages" className="flex flex-col gap-2">
					{locales
						.filter((locale) => locale.archivedAt === undefined)
						.map((locale) => (
							<div
								key={locale._id}
								className="flex flex-wrap items-center justify-between gap-2"
							>
								{editingId === locale._id ? (
									<LanguageMetadataEditor
										projectId={projectId}
										locale={locale}
										disabled={!canEdit}
										codeRestriction="Language codes come from the repository."
										onClose={() => setEditingId(null)}
										onUnsavedWorkChange={setDirty}
									/>
								) : (
									<>
										<span className="text-sm">
											{locale.label}{" "}
											<span className="text-muted-foreground">
												· {locale.code}
												{locale.isSource ? " · Source" : ""}
											</span>
										</span>
										{canEdit ? (
											<IconButton
												icon={Pencil}
												label={`Edit ${locale.label}`}
												disabled={editingId !== null}
												onClick={() => setEditingId(locale._id)}
											/>
										) : null}
									</>
								)}
							</div>
						))}
				</section>
			) : null}
			{project && targets && locales ? (
				<LanguageIntroductionEditor
					key={projectId}
					targets={targets}
					activeLocaleCodes={locales
						.filter((locale) => locale.archivedAt === undefined)
						.map((locale) => locale.code)}
					canEdit={canEdit}
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
