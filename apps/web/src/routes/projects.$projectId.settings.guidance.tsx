import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ProjectDictionaryConnection } from "@/components/localization/project-dictionary-connection";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import {
	DictionaryEditor,
	TranslationGuidanceEditor,
} from "@/components/localization/translation-guidance-editor";
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
	const introductions = useQuery(
		api.localeIntroductionTargets.list,
		project?.type === "repository" ? { projectId: id } : "skip",
	);
	const legacy = useQuery(api.dictionaries.legacyProjectTerms, {
		projectId: id,
	});
	const connection = useQuery(api.dictionaries.projectConnection, {
		projectId: id,
	});
	const guidance = useQuery(api.translationGuidance.list, { projectId: id });
	const saveVoiceGuide = useMutation(api.translationGuidance.saveVoiceGuide);
	const saveProjectVoiceGuide = useMutation(
		api.translationGuidance.saveProjectVoiceGuide,
	);
	const targets = (locales ?? [])
		.filter((locale) => locale._id !== project?.sourceLocaleId)
		.map((locale) => ({
			code: locale.code,
			label: locale.label,
			active: locale.archivedAt === undefined,
		}));
	for (const target of introductions ?? []) {
		if (!targets.some((locale) => locale.code === target.localeCode)) {
			targets.push({
				code: target.localeCode,
				label: target.label,
				active: true,
			});
		}
	}
	for (const code of guidance?.guides.map((guide) => guide.localeCode) ?? []) {
		if (!targets.some((locale) => locale.code === code))
			targets.push({ code, label: code, active: false });
	}
	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader title="Guidance" />
			{project &&
			guidance &&
			locales &&
			legacy &&
			connection &&
			(project.type === "basic" || introductions) ? (
				<>
					<ProjectDictionaryConnection
						key={projectId}
						projectId={projectId}
						projectName={project.name}
						canEdit={project.role === "owner"}
						legacyRevision={legacy.revision}
						legacyTermCount={legacy.terms.length}
					/>
					<TranslationGuidanceEditor
						key={projectId}
						guidance={guidance}
						locales={targets}
						canEdit={project.role === "owner" || project.role === "editor"}
						onSaveProjectVoiceGuide={(input) =>
							saveProjectVoiceGuide({ projectId: id, ...input })
						}
						onSaveVoiceGuide={(input) =>
							saveVoiceGuide({ projectId: id, ...input })
						}
					/>
					<DictionaryEditor
						guidance={guidance}
						locales={targets}
						canEdit={false}
						onSaveTerm={async () => {}}
						onRemoveTerm={async () => {}}
					/>
					{connection.dictionaryId && legacy.terms.length > 0 ? (
						<details>
							<summary className="cursor-pointer text-muted-foreground text-sm">
								Retained project terms · {legacy.terms.length}
							</summary>
							<p className="my-3 text-muted-foreground text-sm">
								Historical terms. This project now uses the connected
								dictionary.
							</p>
							<DictionaryEditor
								guidance={legacy}
								locales={targets}
								canEdit={false}
								onSaveTerm={async () => {}}
								onRemoveTerm={async () => {}}
							/>
						</details>
					) : null}
				</>
			) : (
				<Skeleton className="h-64 w-full" />
			)}
		</ProjectShell>
	);
}
