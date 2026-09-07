import { cn } from "@blabla/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import {
	Authenticated,
	Unauthenticated,
	useMutation,
	useQuery,
} from "convex/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { BrandWordmark } from "@/components/brand";
import EmailVerificationNotice from "@/components/email-verification-notice";
import { ModeToggle } from "@/components/mode-toggle";
import UserMenu from "@/components/user-menu";
import { api } from "@/lib/convex-api";

const links = [
	{ to: "/", label: "Home" },
	{ to: "/projects", label: "Projects" },
	{ to: "/dashboard", label: "Account" },
] as const;

function PendingInviteActivator() {
	const acceptPendingInvites = useMutation(api.projects.acceptPendingInvites);
	const user = useQuery(api.auth.getCurrentUser);
	const activatedUser = useRef<string | null>(null);
	const verifiedUserId = user?.emailVerified ? user._id : null;

	useEffect(() => {
		if (!verifiedUserId || activatedUser.current === verifiedUserId) {
			return;
		}
		activatedUser.current = verifiedUserId;
		acceptPendingInvites()
			.then(({ accepted }) => {
				if (accepted > 0) toast.success("Project invitations accepted");
			})
			.catch(() => {
				toast.error(
					"Could not accept project invitations. Reload to try again.",
				);
			});
	}, [acceptPendingInvites, verifiedUserId]);

	return user && !user.emailVerified ? (
		<EmailVerificationNotice key={user._id} email={user.email} />
	) : null;
}

export default function Header() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
			<div className="flex h-12 items-center justify-between gap-2 px-3 sm:gap-4 sm:px-4">
				<div className="flex items-center gap-6">
					<Link
						to="/"
						className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<BrandWordmark />
					</Link>
					<nav
						aria-label="Main"
						className="hidden items-center gap-1 text-sm sm:flex"
					>
						{links.map(({ to, label }) => {
							const active =
								to === "/"
									? pathname === "/"
									: pathname === to || pathname.startsWith(`${to}/`);
							return (
								<Link
									key={to}
									to={to}
									className={cn(
										"rounded-md px-2.5 py-1 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
										active
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{label}
								</Link>
							);
						})}
					</nav>
				</div>
				<div className="flex items-center gap-2">
					<ModeToggle />
					<Authenticated>
						<UserMenu />
					</Authenticated>
					<Unauthenticated>
						<Link
							to="/sign-in"
							search={{ mode: "sign-in", redirect: "/projects" }}
							className="rounded-md border bg-background px-2.5 py-1 font-medium text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						>
							Sign in
						</Link>
					</Unauthenticated>
				</div>
			</div>
			<Authenticated>
				<PendingInviteActivator />
			</Authenticated>
		</header>
	);
}
