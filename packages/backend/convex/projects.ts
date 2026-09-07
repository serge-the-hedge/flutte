import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { agentReviewPolicyValidator } from "./agentReviewModel";
import { getAnyUserByEmail, getAnyUserById, requireUser } from "./auth";
import {
	DEFAULT_INTEGRATION_BRANCH,
	normalizeLocaleCode,
	now,
	slugify,
} from "./lib";
import {
	assertProjectExists,
	requireOwner,
	requireViewer,
} from "./permissions";

const roleValidator = v.union(
	v.literal("owner"),
	v.literal("editor"),
	v.literal("viewer"),
);
type Role = "owner" | "editor" | "viewer";

function normalizeCliVersion(value: string) {
	const version = value.trim();
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "CLI version must use semantic version form, for example 1.2.3.",
		});
	}
	return version;
}

function normalizeCliProtocol(value: number) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "CLI protocol must be a whole number between 1 and 1000.",
		});
	}
	return value;
}

function normalizeEmail(email: string) {
	const emailLower = email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "Enter a valid email address.",
		});
	}
	return emailLower;
}

async function assertCanChangeMemberRole(
	ctx: QueryCtx | MutationCtx,
	member: { projectId: Id<"projects">; role: Role },
	nextRole: Role | null,
) {
	if (member.role !== "owner" || nextRole === "owner") {
		return;
	}
	const owners = await ctx.db
		.query("projectMembers")
		.withIndex("by_project_role", (q) =>
			q.eq("projectId", member.projectId).eq("role", "owner"),
		)
		.take(2);
	if (owners.length <= 1) {
		throw new ConvexError({
			code: "VALIDATION",
			message: "A project needs at least one owner.",
		});
	}
}

async function ensureUniqueProjectSlug(
	ctx: QueryCtx | MutationCtx,
	slug: string,
	exceptId?: Id<"projects">,
) {
	const existing = await ctx.db
		.query("projects")
		.withIndex("by_slug", (q) => q.eq("slug", slug))
		.unique();
	if (existing && existing._id !== exceptId) {
		throw new ConvexError({
			code: "CONFLICT",
			message: "Project slug already exists.",
		});
	}
}

async function upsertProjectMember(
	ctx: MutationCtx,
	projectId: Id<"projects">,
	userId: string,
	role: "owner" | "editor" | "viewer",
) {
	const existing = await ctx.db
		.query("projectMembers")
		.withIndex("by_project_user", (q) =>
			q.eq("projectId", projectId).eq("userId", userId),
		)
		.unique();
	if (existing) {
		await assertCanChangeMemberRole(ctx, existing, role);
		await ctx.db.patch(existing._id, { role });
		return existing._id;
	}
	return await ctx.db.insert("projectMembers", {
		projectId,
		userId,
		role,
		createdAt: now(),
	});
}

async function findProjectInviteByEmail(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<"projects">,
	emailLower: string,
) {
	return await ctx.db
		.query("projectInvites")
		.withIndex("by_project_email", (q) =>
			q.eq("projectId", projectId).eq("emailLower", emailLower),
		)
		.first();
}

export const listMine = query({
	args: {},
	handler: async (ctx) => {
		const user = await requireUser(ctx);
		const memberships = await ctx.db
			.query("projectMembers")
			.withIndex("by_user", (q) => q.eq("userId", user.id))
			.collect();
		const projects = await Promise.all(
			memberships.map(async (member) => {
				const project = await ctx.db.get(member.projectId);
				return project && project.archivedAt === undefined
					? { ...project, role: member.role }
					: null;
			}),
		);
		return projects.filter((project) => project !== null);
	},
});

export const get = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		const { member } = await requireViewer(ctx, args.projectId);
		const project = await assertProjectExists(ctx, args.projectId);
		const sourceLocale =
			project.sourceLocaleId === undefined
				? null
				: await ctx.db.get(project.sourceLocaleId);
		return { ...project, role: member.role, sourceLocale };
	},
});

export const listMembers = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireViewer(ctx, args.projectId);
		const members = await ctx.db
			.query("projectMembers")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect();
		return await Promise.all(
			members.map(async (member) => ({
				...member,
				user: await getAnyUserById(ctx, member.userId),
			})),
		);
	},
});

export const listInvites = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireOwner(ctx, args.projectId);
		const invites = await ctx.db
			.query("projectInvites")
			.withIndex("by_project", (q) => q.eq("projectId", args.projectId))
			.collect();
		return invites.filter((invite) => invite.revokedAt === undefined);
	},
});

export const create = mutation({
	args: {
		name: v.string(),
		slug: v.optional(v.string()),
		sourceLocaleCode: v.string(),
		sourceLocaleLabel: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const user = await requireUser(ctx);
		const timestamp = now();
		const slug = slugify(args.slug ?? args.name);
		if (!slug) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Project slug is required.",
			});
		}
		await ensureUniqueProjectSlug(ctx, slug);

		const projectId = await ctx.db.insert("projects", {
			name: args.name.trim(),
			slug,
			integrationBranch: DEFAULT_INTEGRATION_BRANCH,
			createdByUserId: user.id,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await ctx.db.insert("projectMembers", {
			projectId,
			userId: user.id,
			role: "owner",
			createdAt: timestamp,
		});
		const localeCode = normalizeLocaleCode(args.sourceLocaleCode);
		const localeId = await ctx.db.insert("locales", {
			projectId,
			code: localeCode,
			label: args.sourceLocaleLabel?.trim() || localeCode,
			isSource: true,
			createdAt: timestamp,
		});
		await ctx.db.patch(projectId, {
			sourceLocaleId: localeId,
			updatedAt: timestamp,
		});
		return projectId;
	},
});

export const update = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
		slug: v.optional(v.string()),
		minimumCliVersion: v.optional(v.string()),
		minimumCliProtocol: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOwner(ctx, args.projectId);
		await assertProjectExists(ctx, args.projectId);
		const patch: {
			name: string;
			slug?: string;
			minimumCliVersion?: string;
			minimumCliProtocol?: number;
			updatedAt: number;
		} = {
			name: args.name.trim(),
			updatedAt: now(),
		};
		if (args.slug !== undefined) {
			const slug = slugify(args.slug);
			if (!slug) {
				throw new ConvexError({
					code: "VALIDATION",
					message: "Project slug is required.",
				});
			}
			await ensureUniqueProjectSlug(ctx, slug, args.projectId);
			patch.slug = slug;
		}
		if (args.minimumCliVersion !== undefined) {
			patch.minimumCliVersion = normalizeCliVersion(args.minimumCliVersion);
		}
		if (args.minimumCliProtocol !== undefined) {
			patch.minimumCliProtocol = normalizeCliProtocol(args.minimumCliProtocol);
		}
		await ctx.db.patch(args.projectId, patch);
		return null;
	},
});

export const archive = mutation({
	args: { projectId: v.id("projects") },
	handler: async (ctx, args) => {
		await requireOwner(ctx, args.projectId);
		await assertProjectExists(ctx, args.projectId);
		await ctx.db.patch(args.projectId, { archivedAt: now(), updatedAt: now() });
		return null;
	},
});

export const addMember = mutation({
	args: {
		projectId: v.id("projects"),
		userId: v.string(),
		role: roleValidator,
	},
	handler: async (ctx, args) => {
		await requireOwner(ctx, args.projectId);
		await assertProjectExists(ctx, args.projectId);
		const userId = args.userId.trim();
		const account = userId ? await getAnyUserById(ctx, userId) : null;
		if (!account) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Account not found. Invite new members by email instead.",
			});
		}
		return await upsertProjectMember(
			ctx,
			args.projectId,
			account.id,
			args.role,
		);
	},
});

export const inviteMemberByEmail = mutation({
	args: {
		projectId: v.id("projects"),
		email: v.string(),
		role: roleValidator,
	},
	handler: async (ctx, args) => {
		const inviter = await requireUser(ctx);
		await requireOwner(ctx, args.projectId);
		await assertProjectExists(ctx, args.projectId);
		const emailLower = normalizeEmail(args.email);
		const timestamp = now();
		const existingInvite = await findProjectInviteByEmail(
			ctx,
			args.projectId,
			emailLower,
		);
		const authUser = await getAnyUserByEmail(ctx, emailLower);

		if (authUser?.emailVerified) {
			const memberId = await upsertProjectMember(
				ctx,
				args.projectId,
				authUser.id,
				args.role,
			);
			if (existingInvite) {
				await ctx.db.patch(existingInvite._id, {
					role: args.role,
					acceptedAt: existingInvite.acceptedAt ?? timestamp,
					acceptedByUserId: existingInvite.acceptedByUserId ?? authUser.id,
					revokedAt: undefined,
				});
			} else {
				await ctx.db.insert("projectInvites", {
					projectId: args.projectId,
					emailLower,
					role: args.role,
					invitedByUserId: inviter.id,
					createdAt: timestamp,
					acceptedAt: timestamp,
					acceptedByUserId: authUser.id,
				});
			}
			return { status: "accepted" as const, memberId };
		}

		if (existingInvite) {
			await ctx.db.patch(existingInvite._id, {
				role: args.role,
				invitedByUserId: inviter.id,
				acceptedAt: undefined,
				acceptedByUserId: undefined,
				revokedAt: undefined,
			});
			return { status: "pending" as const, inviteId: existingInvite._id };
		}

		const inviteId = await ctx.db.insert("projectInvites", {
			projectId: args.projectId,
			emailLower,
			role: args.role,
			invitedByUserId: inviter.id,
			createdAt: timestamp,
		});
		return { status: "pending" as const, inviteId };
	},
});

export const acceptPendingInvites = mutation({
	args: {},
	handler: async (ctx) => {
		const user = await requireUser(ctx);
		if (!user.emailVerified) {
			throw new ConvexError({
				code: "EMAIL_NOT_VERIFIED",
				message: "Verify your email before accepting project invitations.",
			});
		}
		if (!user.email) {
			throw new ConvexError({
				code: "VALIDATION",
				message: "Your account does not have an email address.",
			});
		}
		const emailLower = normalizeEmail(user.email);
		const invites = await ctx.db
			.query("projectInvites")
			.withIndex("by_email", (q) => q.eq("emailLower", emailLower))
			.collect();
		const timestamp = now();
		let accepted = 0;

		for (const invite of invites) {
			if (invite.revokedAt !== undefined || invite.acceptedAt !== undefined) {
				continue;
			}
			const project = await ctx.db.get(invite.projectId);
			if (!project || project.archivedAt !== undefined) {
				continue;
			}
			await upsertProjectMember(ctx, invite.projectId, user.id, invite.role);
			await ctx.db.patch(invite._id, {
				acceptedAt: timestamp,
				acceptedByUserId: user.id,
			});
			accepted += 1;
		}

		return { accepted };
	},
});

export const revokeInvite = mutation({
	args: { inviteId: v.id("projectInvites") },
	handler: async (ctx, args) => {
		const invite = await ctx.db.get(args.inviteId);
		if (!invite) {
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Invite not found.",
			});
		}
		await requireOwner(ctx, invite.projectId);
		await ctx.db.patch(args.inviteId, { revokedAt: now() });
		return null;
	},
});

export const updateMemberRole = mutation({
	args: { memberId: v.id("projectMembers"), role: roleValidator },
	handler: async (ctx, args) => {
		const member = await ctx.db.get(args.memberId);
		if (!member)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Member not found.",
			});
		await requireOwner(ctx, member.projectId);
		await upsertProjectMember(ctx, member.projectId, member.userId, args.role);
		return null;
	},
});

export const removeMember = mutation({
	args: { memberId: v.id("projectMembers") },
	handler: async (ctx, args) => {
		const member = await ctx.db.get(args.memberId);
		if (!member)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Member not found.",
			});
		await requireOwner(ctx, member.projectId);
		await assertCanChangeMemberRole(ctx, member, null);
		await ctx.db.delete(args.memberId);
		return null;
	},
});

/** Project-wide delegation is opt-in and can only be changed by an owner. */
export const setAgentReviewPolicy = mutation({
	args: { projectId: v.id("projects"), enabled: v.boolean() },
	returns: agentReviewPolicyValidator,
	handler: async (ctx, args) => {
		const { userId } = await requireOwner(ctx, args.projectId);
		const project = await assertProjectExists(ctx, args.projectId);
		const policy = {
			enabled: args.enabled,
			revision: (project.agentReviewPolicy?.revision ?? 0) + 1,
			updatedByUserId: userId,
			updatedAt: now(),
		};
		await ctx.db.patch(project._id, {
			agentReviewPolicy: policy,
			updatedAt: now(),
		});
		return policy;
	},
});
