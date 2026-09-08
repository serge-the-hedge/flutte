import { createFileRoute } from "@tanstack/react-router";
import { NewProject } from "@/components/new-project";

export const Route = createFileRoute("/projects/new")({
	component: NewProject,
});
