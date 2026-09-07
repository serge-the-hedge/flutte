import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { TranslationGuidanceEditor } from "@/components/localization/translation-guidance-editor";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/settings/guidance")({
	component: GuidanceRoute,
});

function GuidanceRoute() {
	const { projectId } = useParams({
		from: "/projects/$projectId/settings/guidance",
	});
	const id = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: id });
	const locales = useQuery(api.locales.list, { projectId: id });
	const guidance = useQuery(api.translationGuidance.list, { projectId: id });
	const saveTerm = useMutation(api.translationGuidance.saveTerm);
	const removeTerm = useMutation(api.translationGuidance.removeTerm);
	const saveVoiceGuide = useMutation(api.translationGuidance.saveVoiceGuide);
	const saveProjectVoiceGuide = useMutation(
		api.translationGuidance.saveProjectVoiceGuide,
	);
	const sourceLocaleCode = locales?.find(
		(locale) => locale._id === project?.sourceLocaleId,
	)?.code;
	const targets = (locales ?? [])
		.filter((locale) => locale._id !== project?.sourceLocaleId)
		.map((locale) => ({
			code: locale.code,
			label: locale.label,
			active: locale.archivedAt === undefined || locale.code === "pt",
		}));
	if (
		sourceLocaleCode !== undefined &&
		sourceLocaleCode !== "pt" &&
		!targets.some((locale) => locale.code === "pt")
	) {
		targets.push({ code: "pt", label: "Portuguese", active: true });
	}
	for (const code of [
		...(guidance?.guides.map((guide) => guide.localeCode) ?? []),
		...(guidance?.terms.flatMap(({ term }) =>
			term.kind === "translated"
				? term.renderings.map((rendering) => rendering.localeCode)
				: [],
		) ?? []),
	]) {
		if (!targets.some((locale) => locale.code === code))
			targets.push({ code, label: code, active: false });
	}
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader
				title="Translation guidance"
				description="The project’s terminology and voice, shared by translators and independent reviewers."
			/>
			{project && guidance && locales ? (
				<TranslationGuidanceEditor
					key={projectId}
					guidance={guidance}
					locales={targets}
					canEdit={project.role === "owner" || project.role === "editor"}
					onSaveTerm={(input) => saveTerm({ projectId: id, ...input })}
					onRemoveTerm={(input) => removeTerm({ projectId: id, ...input })}
					onSaveProjectVoiceGuide={(input) =>
						saveProjectVoiceGuide({ projectId: id, ...input })
					}
					onSaveVoiceGuide={(input) =>
						saveVoiceGuide({ projectId: id, ...input })
					}
				/>
			) : (
				<Skeleton className="h-64 w-full" />
			)}
		</ProjectShell>
	);
}
