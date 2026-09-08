import { Button } from "@blabla/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, convexId } from "@/lib/convex-api";
import type { StringsSearch } from "@/lib/strings-search";

/** Existing collection content stays accessible while its owner moves it into a project. */
export function LegacyContentProjects({
	projectId,
	canPromote,
}: {
	projectId: string;
	canPromote: boolean;
}) {
	const items = useQuery(api.projectStructure.listLegacy, {
		projectId: convexId<"projects">(projectId),
	});
	const promote = useMutation(api.projectStructure.promote);
	const [pending, setPending] = useState<string | null>(null);
	if (!items?.length) return null;
	return (
		<section
			aria-label="Existing content"
			className="mb-6 rounded-lg border p-4"
		>
			<h2 className="font-medium text-sm">Existing content</h2>
			<p className="mt-1 text-muted-foreground text-xs">
				Move text and reviews into a Basic project; copy members and languages.
				Set up agent access again.
			</p>
			<ul className="mt-3 grid gap-3">
				{items.map((item) => (
					<li
						key={item.collectionId}
						className="flex flex-wrap items-center justify-between gap-2 text-sm"
					>
						<div className="min-w-0">
							<span className="break-words">{item.name}</span>
							{item.status === "moving" && (
								<p className="text-muted-foreground text-xs" role="status">
									Moving content…
								</p>
							)}
							{item.error && (
								<p className="text-destructive text-xs">{item.error}</p>
							)}
						</div>
						{item.status === "complete" && item.projectId ? (
							<Button
								size="sm"
								variant="outline"
								nativeButton={false}
								render={
									<Link
										to="/projects/$projectId/strings"
										params={{ projectId: item.projectId }}
										search={{}}
									/>
								}
							>
								Open project
							</Button>
						) : canPromote ? (
							<Button
								size="sm"
								variant="outline"
								disabled={pending !== null || item.status === "moving"}
								onClick={async () => {
									setPending(item.collectionId);
									try {
										await promote({
											projectId: convexId<"projects">(projectId),
											collectionId: item.collectionId,
										});
									} catch (error) {
										toast.error(
											error instanceof Error
												? error.message
												: "Could not move content. Try again.",
										);
									} finally {
										setPending(null);
									}
								}}
							>
								{item.status === "moving"
									? "Moving…"
									: item.status === "failed"
										? "Retry"
										: "Make project"}
							</Button>
						) : (
							<span className="text-muted-foreground text-xs">
								{item.status === "moving"
									? "Moving…"
									: "A project owner can move this content."}
							</span>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

export function LegacyContentLink({
	projectId,
	collectionId,
	search,
}: {
	projectId: string;
	collectionId: string;
	search: StringsSearch;
}) {
	const result = useQuery(api.projectStructure.resolveLegacy, {
		projectId: convexId<"projects">(projectId),
		collectionId: convexId<"contentCollections">(collectionId),
	});
	const navigate = useNavigate();
	const destination = result?.status === "complete" ? result.projectId : null;
	useEffect(() => {
		if (destination)
			void navigate({
				to: "/projects/$projectId/strings",
				params: { projectId: destination },
				search: { ...search, collection: undefined, cursor: undefined },
				replace: true,
			});
	}, [destination, navigate, search]);
	return (
		<p className="text-muted-foreground text-sm" role="status">
			{result === undefined
				? "Opening content…"
				: destination
					? "Opening the new project…"
					: "Move this content using Existing content above, or ask a project owner."}
		</p>
	);
}
