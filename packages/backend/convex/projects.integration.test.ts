import { describe, expect, test, vi } from "vitest";

import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api, components } from "./_generated/api";
import * as emails from "./emails";

async function setVerified(t: Backend, userId: string, emailVerified: boolean) {
	await t.mutation(components.betterAuth.adapter.updateOne, {
		input: {
			model: "user",
			where: [{ field: "userId", value: userId }],
			update: { emailVerified },
		},
	});
}

describe("project invitations and ownership", () => {
	test.each(["", "   ", "nonexistent-user"])(
		"rejects nonexistent membership account %j",
		async (userId) => {
			const t = createBackend();
			const owner = await authenticatedBackend(t, "owner");
			const projectId = await createProject(owner);
			await expect(
				owner.mutation(api.projects.addMember, {
					projectId,
					userId,
					role: "owner",
				}),
			).rejects.toThrow("Account not found");
			const members = await owner.query(api.projects.listMembers, {
				projectId,
			});
			expect(members).toHaveLength(1);
			const member = members[0];
			if (!member) throw new Error("Expected owner membership");
			await expect(
				owner.mutation(api.projects.removeMember, { memberId: member._id }),
			).rejects.toThrow("at least one owner");
		},
	);

	test("the configured email link verifies the account and unlocks its invitation", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const invitee = await authenticatedBackend(t, "invitee");
		await setVerified(t, "invitee", false);
		await owner.mutation(api.projects.inviteMemberByEmail, {
			projectId,
			email: "invitee@example.test",
			role: "editor",
		});
		const queueEmail = vi
			.spyOn(emails, "queueVerificationEmail")
			.mockResolvedValue();
		try {
			const response = await t.fetch("/api/auth/send-verification-email", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					email: "invitee@example.test",
					callbackURL: "http://localhost:3000/projects",
				}),
			});
			expect(response.status).toBe(200);
			const input = queueEmail.mock.calls[0]?.[1];
			expect(input?.email).toBe("invitee@example.test");
			if (!input) throw new Error("Expected verification email");
			const link = new URL(input.url);
			const verification = await t.fetch(`${link.pathname}${link.search}`);
			expect(verification.status).toBe(302);
			expect(verification.headers.get("location")).toBe(
				"http://localhost:3000/projects",
			);
			expect(
				await invitee.mutation(api.projects.acceptPendingInvites, {}),
			).toEqual({ accepted: 1 });
		} finally {
			queueEmail.mockRestore();
		}
	});

	test("an unverified existing account stays pending until email verification", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const invitee = await authenticatedBackend(t, "invitee");
		await setVerified(t, "invitee", false);
		expect(
			await owner.mutation(api.projects.inviteMemberByEmail, {
				projectId,
				email: " INVITEE@example.test ",
				role: "owner",
			}),
		).toMatchObject({ status: "pending" });
		await expect(
			invitee.mutation(api.projects.acceptPendingInvites, {}),
		).rejects.toThrow("Verify your email");
		await expect(
			invitee.query(api.projects.get, { projectId }),
		).rejects.toThrow("Insufficient project permissions");
		expect(
			await owner.query(api.projects.listInvites, { projectId }),
		).toMatchObject([{ emailLower: "invitee@example.test" }]);
		await setVerified(t, "invitee", true);
		expect(
			await invitee.mutation(api.projects.acceptPendingInvites, {}),
		).toEqual({ accepted: 1 });
		expect(await invitee.query(api.projects.get, { projectId })).toMatchObject({
			role: "owner",
		});
		expect(
			await invitee.mutation(api.projects.acceptPendingInvites, {}),
		).toEqual({ accepted: 0 });
	});

	test("an invitation issued before registration cannot be claimed by an unverified account", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		await owner.mutation(api.projects.inviteMemberByEmail, {
			projectId,
			email: "invitee@example.test",
			role: "editor",
		});
		const invitee = await authenticatedBackend(t, "invitee");
		await setVerified(t, "invitee", false);
		await expect(
			invitee.mutation(api.projects.acceptPendingInvites, {}),
		).rejects.toThrow("Verify your email");
		expect(await invitee.query(api.projects.listMine, {})).toEqual([]);
		await setVerified(t, "invitee", true);
		expect(
			await invitee.mutation(api.projects.acceptPendingInvites, {}),
		).toEqual({ accepted: 1 });
	});

	test("a verified existing account receives the invited role immediately", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const invitee = await authenticatedBackend(t, "invitee");
		expect(
			await owner.mutation(api.projects.inviteMemberByEmail, {
				projectId,
				email: "invitee@example.test",
				role: "editor",
			}),
		).toMatchObject({ status: "accepted" });
		expect(await invitee.query(api.projects.get, { projectId })).toMatchObject({
			role: "editor",
		});
	});

	test("all public membership writes protect the last owner and allow transfer", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		const [member] = await owner.query(api.projects.listMembers, { projectId });
		if (!member) throw new Error("Expected owner membership");
		const account = await owner.query(api.auth.getCurrentUser, {});
		if (!account) throw new Error("Expected owner account");
		await expect(
			owner.mutation(api.projects.addMember, {
				projectId,
				userId: account._id,
				role: "viewer",
			}),
		).rejects.toThrow("at least one owner");
		await expect(
			owner.mutation(api.projects.addMember, {
				projectId,
				userId: "owner",
				role: "viewer",
			}),
		).rejects.toThrow("at least one owner");
		await expect(
			owner.mutation(api.projects.inviteMemberByEmail, {
				projectId,
				email: "owner@example.test",
				role: "viewer",
			}),
		).rejects.toThrow("at least one owner");
		await expect(
			owner.mutation(api.projects.updateMemberRole, {
				memberId: member._id,
				role: "editor",
			}),
		).rejects.toThrow("at least one owner");
		await expect(
			owner.mutation(api.projects.removeMember, { memberId: member._id }),
		).rejects.toThrow("at least one owner");
		await authenticatedBackend(t, "successor");
		await owner.mutation(api.projects.addMember, {
			projectId,
			userId: "successor",
			role: "owner",
		});
		await owner.mutation(api.projects.inviteMemberByEmail, {
			projectId,
			email: "owner@example.test",
			role: "viewer",
		});
		expect(await owner.query(api.projects.get, { projectId })).toMatchObject({
			role: "viewer",
		});
	});

	test("accepting an older pending invitation cannot demote the last owner", async () => {
		const t = createBackend();
		const owner = await authenticatedBackend(t, "owner");
		const projectId = await createProject(owner);
		await setVerified(t, "owner", false);
		await owner.mutation(api.projects.inviteMemberByEmail, {
			projectId,
			email: "owner@example.test",
			role: "viewer",
		});
		await setVerified(t, "owner", true);
		await expect(
			owner.mutation(api.projects.acceptPendingInvites, {}),
		).rejects.toThrow("at least one owner");
		expect(await owner.query(api.projects.get, { projectId })).toMatchObject({
			role: "owner",
		});
	});
});
