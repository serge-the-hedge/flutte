/** Local-only fixture runner. Reuses the app shell and the same Strings URL; no auth or backend calls. */
import { Badge } from "@blabla/ui/components/badge";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { BrandWordmark } from "@/components/brand";
import { ModeToggle } from "@/components/mode-toggle";
import { ThemeProvider } from "@/components/theme-provider";
import { ProjectIdentity, ProjectNavigation } from "./project-shell";
import { StringsPrototype } from "./strings.prototype";
import { exampleStrings, type PrototypeString } from "./strings.prototype-data";

const local = import.meta.glob<PrototypeString[]>(
	"./strings.prototype.local.json",
	{ eager: true, import: "default" },
);
const rootRoute = createRootRoute({
	component: () => (
		<ThemeProvider attribute="class" defaultTheme="dark">
			<div className="grid h-svh grid-rows-[auto_1fr] bg-background text-foreground">
				<header className="flex h-14 items-center gap-6 border-b px-4">
					<BrandWordmark />
					<span className="rounded bg-accent px-2.5 py-1 text-xs">
						Projects
					</span>
					<span className="text-muted-foreground text-xs">Dictionaries</span>
					<div className="ml-auto flex items-center gap-3">
						<Badge variant="outline">Local prototype</Badge>
						<ModeToggle />
					</div>
				</header>
				<Outlet />
			</div>
		</ThemeProvider>
	),
});
const route = createRoute({
	getParentRoute: () => rootRoute,
	path: "/projects/$projectId/strings",
	validateSearch: (search: Record<string, unknown>) => ({
		variant:
			search.variant === "B" || search.variant === "C"
				? search.variant
				: ("A" as "A" | "B" | "C"),
	}),
	component: PrototypePage,
});
const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
function PrototypePage() {
	const { variant } = route.useSearch();
	const { projectId } = route.useParams();
	const initialRows = Object.values(local)[0] ?? exampleStrings.slice(0, 3);
	return (
		<div className="grid min-h-0 grid-cols-1 md:grid-cols-[232px_1fr]">
			<aside className="hidden min-h-0 flex-col border-r bg-sidebar md:flex">
				<ProjectIdentity title="Brickit Marketing" type="basic" />
				<ProjectNavigation
					projectId={projectId}
					pathname={`/projects/${projectId}/strings`}
					type="basic"
				/>
			</aside>
			<main className="min-w-0 overflow-auto p-5 lg:p-8">
				<StringsPrototype
					initialRows={initialRows}
					variant={variant ?? "A"}
					localSnapshot={Object.keys(local).length > 0}
					onVariant={(next) =>
						void router.navigate({
							to: "/projects/$projectId/strings",
							params: { projectId },
							search: { variant: next },
							replace: true,
						})
					}
				/>
			</main>
		</div>
	);
}
export function startStringsPrototype(element: HTMLElement) {
	ReactDOM.createRoot(element).render(<RouterProvider router={router} />);
}
