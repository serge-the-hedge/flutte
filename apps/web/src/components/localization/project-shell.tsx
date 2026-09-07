import { Button } from "@blabla/ui/components/button";
import { Separator } from "@blabla/ui/components/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@blabla/ui/components/sheet";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { cn } from "@blabla/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import {
	BookOpen,
	Bot,
	ChevronLeft,
	KeyRound,
	Languages,
	type LucideIcon,
	Menu,
	MessageSquareText,
	PackageCheck,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type NavItem = { label: string; to: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
	{
		label: "Workspace",
		items: [
			{
				label: "Sync",
				to: "/projects/$projectId/sync",
				icon: Languages,
			},
			{
				label: "Strings",
				to: "/projects/$projectId/strings",
				icon: MessageSquareText,
			},
			{
				label: "Translation tasks",
				to: "/projects/$projectId/proposals",
				icon: Bot,
			},
			{
				label: "Release",
				to: "/projects/$projectId/release",
				icon: PackageCheck,
			},
		],
	},
	{
		label: "Settings",
		items: [
			{
				label: "Translation guidance",
				to: "/projects/$projectId/settings/guidance",
				icon: BookOpen,
			},
			{
				label: "API tokens",
				to: "/projects/$projectId/settings/api-tokens",
				icon: KeyRound,
			},
			{
				label: "Members",
				to: "/projects/$projectId/settings/members",
				icon: Users,
			},
		],
	},
];

function ProjectNavigation({
	projectId,
	pathname,
	onNavigate,
}: {
	projectId: string;
	pathname: string;
	onNavigate?: () => void;
}) {
	return (
		<nav
			aria-label="Project"
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 py-4"
		>
			{navGroups.map((group) => (
				<div key={group.label} className="flex flex-col gap-1">
					<div className="px-2 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
						{group.label}
					</div>
					{group.items.map((item) => {
						const resolvedHref = item.to.replace("$projectId", projectId);
						const active = pathname.startsWith(resolvedHref);
						return (
							<Link
								key={item.to}
								to={item.to as never}
								params={{ projectId } as never}
								onClick={onNavigate}
								className={cn(
									"group flex items-center gap-2 rounded-md px-2 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
										: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
								)}
							>
								<item.icon aria-hidden="true" className="size-3.5" />
								{item.label}
							</Link>
						);
					})}
				</div>
			))}
		</nav>
	);
}

function ProjectIdentity({ title }: { title: string }) {
	return (
		<div className="flex flex-col gap-3 border-b p-4">
			<Link
				to="/projects"
				className="inline-flex w-fit items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronLeft aria-hidden="true" className="size-3" />
				All projects
			</Link>
			{title ? (
				<div className="truncate font-semibold text-base tracking-tight">
					{title}
				</div>
			) : (
				<Skeleton className="h-5 w-3/4" />
			)}
		</div>
	);
}

export function ProjectShell({
	projectId,
	title,
	children,
}: {
	projectId: string;
	title: string;
	children: ReactNode;
}) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	return (
		<div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[232px_1fr]">
			<aside className="hidden min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
				<ProjectIdentity title={title} />
				<ProjectNavigation projectId={projectId} pathname={pathname} />
			</aside>
			<div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
				<div className="flex h-11 shrink-0 items-center gap-3 border-b bg-sidebar px-3 md:hidden">
					<Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
						<SheetTrigger
							render={
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label="Open project navigation"
								/>
							}
						>
							<Menu aria-hidden="true" />
						</SheetTrigger>
						<SheetContent
							side="left"
							className="w-[min(19rem,88vw)] bg-sidebar text-sidebar-foreground"
						>
							<SheetHeader className="sr-only">
								<SheetTitle>Project navigation</SheetTitle>
								<SheetDescription>
									Navigate within {title || "this project"}.
								</SheetDescription>
							</SheetHeader>
							<ProjectIdentity title={title} />
							<ProjectNavigation
								projectId={projectId}
								pathname={pathname}
								onNavigate={() => setMobileNavOpen(false)}
							/>
						</SheetContent>
					</Sheet>
					<span className="min-w-0 truncate font-medium text-sm">{title}</span>
				</div>
				<div className="min-w-0 flex-1 overflow-auto">
					<div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}

export function PageHeader({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-6 flex flex-col gap-3">
			<div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="text-balance font-semibold text-xl tracking-tight">
						{title}
					</h1>
					{description ? (
						<p className="text-pretty text-muted-foreground text-sm">
							{description}
						</p>
					) : null}
				</div>
				{action ? (
					<div className="flex max-w-full flex-wrap gap-2 sm:shrink-0">
						{action}
					</div>
				) : null}
			</div>
			<Separator />
		</div>
	);
}

export function PageSection({
	title,
	description,
	children,
	className,
}: {
	title?: string;
	description?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-3", className)}>
			{title || description ? (
				<div className="flex flex-col gap-0.5">
					{title ? <h2 className="font-medium text-sm">{title}</h2> : null}
					{description ? (
						<p className="text-muted-foreground text-xs">{description}</p>
					) : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

export function PageSkeleton() {
	return (
		<div
			className="flex flex-col gap-3"
			role="status"
			aria-label="Loading page"
		>
			<Skeleton className="h-9 w-full" />
			<Skeleton className="h-32 w-full" />
			<Skeleton className="h-32 w-full" />
		</div>
	);
}
