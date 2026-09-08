import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/** Promotions retain task IDs; old links must use the task's current project. */
export function useCanonicalTaskProject(
	projectId: string,
	proposalId: string,
	canonicalProjectId: string | undefined,
) {
	const navigate = useNavigate();
	const relocating =
		canonicalProjectId !== undefined && canonicalProjectId !== projectId;
	useEffect(() => {
		if (relocating)
			void navigate({
				to: "/projects/$projectId/proposals/$proposalId",
				params: { projectId: canonicalProjectId, proposalId },
				search: true,
				hash: true,
				replace: true,
			});
	}, [navigate, relocating, canonicalProjectId, proposalId]);
	return relocating;
}
