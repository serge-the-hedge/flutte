import type { GenericCtx } from "@convex-dev/better-auth";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

/** Development is delivery-safe by default. Production must explicitly opt
 * into real recipients with RESEND_TEST_MODE=false after its domain verifies. */
export const resend = new Resend(components.resend, {
	testMode: process.env.RESEND_TEST_MODE !== "false",
});

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required to send account email.`);
	return value;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Queue one durable password-recovery email from Better Auth's HTTP action.
 * The official component owns retries, rate limits, and idempotency. */
export async function queuePasswordResetEmail(
	ctx: GenericCtx<DataModel>,
	input: { email: string; url: string },
): Promise<void> {
	const resetUrl = escapeHtml(input.url);
	await resend.sendEmail(requireActionCtx(ctx), {
		from: requiredEnv("AUTH_EMAIL_FROM"),
		to: input.email,
		subject: "Reset your Flutte password",
		text: [
			"A password reset was requested for your Flutte account.",
			"",
			input.url,
			"",
			"If you did not request this, you can ignore this email.",
		].join("\n"),
		html: `<p>A password reset was requested for your Flutte account.</p><p><a href="${resetUrl}">Choose a new password</a></p><p>If you did not request this, you can ignore this email.</p>`,
	});
}

/** Queue proof-of-address mail; only the signed Better Auth link verifies it. */
export async function queueVerificationEmail(
	ctx: GenericCtx<DataModel>,
	input: { email: string; url: string },
): Promise<void> {
	await resend.sendEmail(requireActionCtx(ctx), {
		from: requiredEnv("AUTH_EMAIL_FROM"),
		to: input.email,
		subject: "Verify your Flutte email address",
		text: [
			"Verify your email address to accept Flutte project invitations.",
			"",
			input.url,
			"",
			"If you did not request this, you can ignore this email.",
		].join("\n"),
		html: `<p>Verify your email address to accept Flutte project invitations.</p><p><a href="${escapeHtml(input.url)}">Verify email address</a></p><p>If you did not request this, you can ignore this email.</p>`,
	});
}
