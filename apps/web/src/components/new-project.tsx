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
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/convex-api";

function slugify(value: string) {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function NewProject() {
	const navigate = useNavigate();
	const createProject = useMutation(api.projects.create);
	const [type, setType] = useState<"basic" | "repository">("basic");
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
		try {
			const projectId = await createProject({
				type,
				name,
				slug: slug || slugify(name),
				sourceLocaleCode,
				sourceLocaleLabel,
			});
			toast.success("Project created");
			await navigate({
				to:
					type === "basic"
						? "/projects/$projectId/strings"
						: "/projects/$projectId/sync",
				params: { projectId },
				search: {},
			});
		} catch (error) {
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
					Projects
				</Link>
				<h1 className="font-semibold text-2xl tracking-tight">New project</h1>
			</div>
			<Card>
				<CardHeader className="sr-only">
					<CardTitle>Project details</CardTitle>
					<CardDescription>Initial project configuration</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit}>
						<fieldset disabled={isSubmitting}>
							<FieldGroup>
								<fieldset className="grid gap-2">
									<legend className="mb-2 font-medium text-sm">
										Project type
									</legend>
									{(
										[
											[
												"basic",
												"Basic",
												"Write, translate, and download content.",
											],
											[
												"repository",
												"Repository",
												"Sync ARB files with GitHub.",
											],
										] as const
									).map(([value, label, description]) => (
										<label
											key={value}
											className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-checked:border-primary"
										>
											<input
												type="radio"
												name="project-type"
												value={value}
												checked={type === value}
												onChange={() => setType(value)}
												className="mt-1"
											/>
											<span>
												<span className="font-medium">{label}</span>
												<span className="mt-1 block text-muted-foreground text-xs">
													{description}
												</span>
											</span>
										</label>
									))}
								</fieldset>
								<Field>
									<FieldLabel htmlFor="project-name">Name</FieldLabel>
									<Input
										id="project-name"
										value={name}
										onChange={(event) => handleNameChange(event.target.value)}
										required
										placeholder="Mobile app"
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
										Generated from the name. Used by the CLI and API.
									</FieldDescription>
								</Field>
								<div className="grid grid-cols-2 gap-3">
									<Field>
										<FieldLabel htmlFor="project-locale-code">
											Source language code
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
											Language name
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
						</fieldset>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
