import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/new")({
	component: NewProjectRoute,
});

function slugify(value: string) {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function NewProjectRoute() {
	const navigate = useNavigate();
	const createProject = useMutation(api.projects.create);
	const createCollection = useMutation(api.contentCollections.create);
	const [managed, setManaged] = useState(false);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [sourceLocaleCode, setSourceLocaleCode] = useState("en");
	const [sourceLocaleLabel, setSourceLocaleLabel] = useState("English");
	const [isSubmitting, setIsSubmitting] = useState(false);

	function handleNameChange(value: string) {
		setName(value);
		if (!slugTouched) setSlug(slugify(value));
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		setIsSubmitting(true);
		let createdProjectId: Awaited<ReturnType<typeof createProject>> | undefined;
		try {
			const projectId = await createProject({
				name,
				slug: slug || slugify(name),
				sourceLocaleCode,
				sourceLocaleLabel,
			});
			createdProjectId = projectId;
			toast.success("Project created");
			if (managed) {
				const collection = await createCollection({
					projectId,
					name: "Content",
					localeIds: [],
				});
				await navigate({
					to: "/projects/$projectId/strings",
					params: { projectId },
					search: { collection },
				});
			} else
				await navigate({
					to: "/projects/$projectId/sync",
					params: { projectId },
					search: {},
				});
		} catch (error) {
			if (createdProjectId) {
				toast.error(
					"Project created, but content setup could not finish. Create a collection from Strings to continue.",
				);
				await navigate({
					to: "/projects/$projectId/strings",
					params: { projectId: createdProjectId },
					search: {},
				});
				return;
			}
			toast.error(
				error instanceof Error
					? `Could not create project: ${error.message}`
					: "Could not create project. Check the details and try again.",
			);
		} finally {
			setIsSubmitting(false);
		}
	}

	return (
		<div className="mx-auto h-full max-w-xl overflow-auto px-6 py-10">
			<div className="mb-6 flex flex-col gap-2">
				<Link
					to="/projects"
					className="inline-flex w-fit items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
				>
					<ArrowLeft className="size-3" />
					Back to projects
				</Link>
				<h1 className="font-semibold text-2xl tracking-tight">New project</h1>
				<p className="text-muted-foreground text-sm">
					Name the workspace and choose its source language.
				</p>
			</div>
			<Card>
				<CardHeader className="sr-only">
					<CardTitle>Project details</CardTitle>
					<CardDescription>Initial project configuration</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit}>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor="project-name">Name</FieldLabel>
								<Input
									id="project-name"
									value={name}
									onChange={(event) => handleNameChange(event.target.value)}
									required
									placeholder="Mobile App"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="project-slug">Slug</FieldLabel>
								<Input
									id="project-slug"
									value={slug}
									onChange={(event) => {
										setSlug(event.target.value);
										setSlugTouched(true);
									}}
									placeholder="mobile-app"
								/>
								<FieldDescription>
									Used in URLs and the API. We'll slugify your name by default.
								</FieldDescription>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel htmlFor="project-locale-code">
										Source locale
									</FieldLabel>
									<Input
										id="project-locale-code"
										value={sourceLocaleCode}
										onChange={(event) =>
											setSourceLocaleCode(event.target.value)
										}
										placeholder="en"
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="project-locale-label">
										Locale label
									</FieldLabel>
									<Input
										id="project-locale-label"
										value={sourceLocaleLabel}
										onChange={(event) =>
											setSourceLocaleLabel(event.target.value)
										}
										placeholder="English"
									/>
								</Field>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={managed}
									onChange={(event) => setManaged(event.target.checked)}
								/>
								Write content here, without a repository
							</label>
							<div className="flex gap-2">
								<Button type="submit" disabled={!name.trim() || isSubmitting}>
									{isSubmitting ? "Creating project…" : "Create project"}
								</Button>
								<Button
									nativeButton={false}
									variant="outline"
									render={<Link to="/projects" />}
								>
									Cancel
								</Button>
							</div>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
