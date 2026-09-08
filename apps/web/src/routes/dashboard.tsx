import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import {
	Authenticated,
	AuthLoading,
	Unauthenticated,
	useQuery,
} from "convex/react";
import AuthRedirect from "@/components/auth-redirect";
import ChangePasswordForm from "@/components/change-password-form";
import { api } from "@/lib/convex-api";

export const Route = createFileRoute("/dashboard")({
	component: RouteComponent,
});

function PrivateDashboardContent() {
	const user = useQuery(api.auth.getCurrentUser);

	return (
		<div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-auto px-6 py-8">
			<div className="flex flex-col gap-1">
				<h1 className="font-semibold text-2xl tracking-tight">Account</h1>
			</div>
			<Card size="sm">
				<CardHeader>
					<CardTitle>Profile</CardTitle>
				</CardHeader>
				<CardContent>
					{user === undefined ? (
						<Skeleton className="h-12 w-full" />
					) : (
						<dl className="grid grid-cols-[80px_1fr] gap-y-2 text-xs">
							<dt className="text-muted-foreground">Name</dt>
							<dd>{user?.name ?? "—"}</dd>
							<dt className="text-muted-foreground">Email</dt>
							<dd className="truncate font-mono">{user?.email}</dd>
						</dl>
					)}
				</CardContent>
			</Card>
			<ChangePasswordForm />
		</div>
	);
}

function RouteComponent() {
	return (
		<>
			<Authenticated>
				<PrivateDashboardContent />
			</Authenticated>
			<Unauthenticated>
				<AuthRedirect />
			</Unauthenticated>
			<AuthLoading>
				<div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-8">
					<Skeleton className="h-7 w-40" />
					<Skeleton className="h-32 w-full" />
				</div>
			</AuthLoading>
		</>
	);
}
