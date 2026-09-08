import { Badge } from "@blabla/ui/components/badge";
import { Button } from "@blabla/ui/components/button";
import { Card, CardContent } from "@blabla/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@blabla/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@blabla/ui/components/select";
import { Skeleton } from "@blabla/ui/components/skeleton";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Mail, UserPlus, Users } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import {
	PageHeader,
	ProjectShell,
} from "@/components/localization/project-shell";
import { api, convexId } from "@/lib/convex-api";

export const Route = createFileRoute("/projects/$projectId/settings/members")({
	component: MembersRoute,
});

const ROLE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
	owner: "default",
	editor: "secondary",
	viewer: "outline",
};

type Role = "owner" | "editor" | "viewer";

type MemberRow = {
	_id: string;
	userId: string;
	role: Role;
	user: {
		email?: string;
		name?: string;
	} | null;
};

type InviteRow = {
	_id: string;
	emailLower: string;
	role: Role;
	acceptedAt?: number;
};

function MembersRoute() {
	const { projectId } = useParams({
		from: "/projects/$projectId/settings/members",
	});
	const convexProjectId = convexId<"projects">(projectId);
	const project = useQuery(api.projects.get, { projectId: convexProjectId });
	const members = useQuery(api.projects.listMembers, {
		projectId: convexProjectId,
	}) as MemberRow[] | undefined;
	const invites = useQuery(api.projects.listInvites, {
		projectId: convexProjectId,
	}) as InviteRow[] | undefined;
	const inviteMember = useMutation(api.projects.inviteMemberByEmail);
	const updateRole = useMutation(api.projects.updateMemberRole);
	const removeMember = useMutation(api.projects.removeMember);
	const revokeInvite = useMutation(api.projects.revokeInvite);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("viewer");
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setIsSubmitting(true);
		try {
			const result = await inviteMember({
				projectId: convexProjectId,
				email,
				role,
			});
			setEmail("");
			toast.success(
				result.status === "accepted" ? "Member added" : "Invite saved",
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Invite failed");
		} finally {
			setIsSubmitting(false);
		}
	}

	async function removeProjectMember(member: MemberRow) {
		try {
			await removeMember({ memberId: convexId<"projectMembers">(member._id) });
			toast.success("Member removed");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not remove member",
			);
		}
	}

	async function revokeProjectInvite(invite: InviteRow) {
		try {
			await revokeInvite({ inviteId: convexId<"projectInvites">(invite._id) });
			toast.success("Invite revoked");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not revoke invite",
			);
		}
	}

	return (
		<ProjectShell projectId={projectId} title={project?.name ?? "Project"}>
			<PageHeader title="Members" />
			<div className="flex flex-col gap-4">
				<Card size="sm">
					<CardContent>
						<form onSubmit={submit}>
							<FieldGroup className="grid gap-3 md:grid-cols-[1fr_160px_auto] md:items-end">
								<Field>
									<FieldLabel htmlFor="member-email">Email</FieldLabel>
									<Input
										id="member-email"
										name="email"
										type="email"
										autoComplete="email"
										spellCheck={false}
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										placeholder="teammate@example.com"
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="member-role">Role</FieldLabel>
									<Select
										value={role}
										onValueChange={(value) => setRole(value as Role)}
									>
										<SelectTrigger id="member-role" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="viewer">Viewer</SelectItem>
												<SelectItem value="editor">Editor</SelectItem>
												<SelectItem value="owner">Owner</SelectItem>
											</SelectGroup>
										</SelectContent>
									</Select>
								</Field>
								<Button type="submit" disabled={!email.trim() || isSubmitting}>
									<UserPlus data-icon="inline-start" />
									{isSubmitting ? "Inviting…" : "Invite member"}
								</Button>
							</FieldGroup>
						</form>
					</CardContent>
				</Card>

				{members === undefined ? (
					<Skeleton className="h-32 w-full" />
				) : members.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Users />
							</EmptyMedia>
							<EmptyTitle>No members yet</EmptyTitle>
							<EmptyDescription>
								Invite teammates by email to share this project.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Card size="sm">
						<CardContent className="divide-y">
							{members.map((member) => (
								<div
									key={member._id}
									className="grid gap-3 py-3 first:pt-0 last:pb-0 md:grid-cols-[1fr_160px_auto] md:items-center"
								>
									<div className="min-w-0">
										<div className="truncate font-medium text-sm">
											{member.user?.name ?? member.user?.email ?? member.userId}
										</div>
										<div className="truncate font-mono text-muted-foreground text-xs">
											{member.user?.email ?? member.userId}
										</div>
									</div>
									<div className="flex items-center gap-2">
										<Badge
											variant={ROLE_VARIANT[member.role] ?? "outline"}
											className="capitalize"
										>
											{member.role}
										</Badge>
										<Select
											value={member.role}
											onValueChange={(value) => {
												updateRole({
													memberId: convexId<"projectMembers">(member._id),
													role: value as Role,
												})
													.then(() => toast.success("Member role updated"))
													.catch((error) =>
														toast.error(
															error instanceof Error
																? error.message
																: "Could not update role",
														),
													);
											}}
										>
											<SelectTrigger size="sm" className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectItem value="viewer">Viewer</SelectItem>
													<SelectItem value="editor">Editor</SelectItem>
													<SelectItem value="owner">Owner</SelectItem>
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>
									<ConfirmAction
										triggerLabel="Remove"
										title="Remove this member?"
										description={`${member.user?.name ?? member.user?.email ?? "This member"} will immediately lose access to the project.`}
										confirmLabel="Remove member"
										onConfirm={() => removeProjectMember(member)}
									/>
								</div>
							))}
						</CardContent>
					</Card>
				)}

				{invites === undefined ? (
					<Skeleton className="h-24 w-full" />
				) : invites.length > 0 ? (
					<Card size="sm">
						<CardContent className="divide-y">
							<div className="flex items-center gap-2 pb-3 font-medium text-sm">
								<Mail className="size-4 text-muted-foreground" />
								Invites
							</div>
							{invites.map((invite) => (
								<div
									key={invite._id}
									className="grid gap-3 py-3 last:pb-0 md:grid-cols-[1fr_120px_auto] md:items-center"
								>
									<div className="min-w-0">
										<div className="truncate font-mono text-xs">
											{invite.emailLower}
										</div>
										<div className="text-muted-foreground text-xs">
											{invite.acceptedAt === undefined ? "Pending" : "Accepted"}
										</div>
									</div>
									<Badge
										variant={ROLE_VARIANT[invite.role] ?? "outline"}
										className="w-fit capitalize"
									>
										{invite.role}
									</Badge>
									<ConfirmAction
										triggerLabel="Revoke"
										title={`Revoke invite for ${invite.emailLower}?`}
										description="The pending invite will no longer grant access."
										confirmLabel="Revoke invite"
										disabled={invite.acceptedAt !== undefined}
										onConfirm={() => revokeProjectInvite(invite)}
									/>
								</div>
							))}
						</CardContent>
					</Card>
				) : null}
			</div>
		</ProjectShell>
	);
}
