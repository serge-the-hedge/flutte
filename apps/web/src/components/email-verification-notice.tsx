import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@blabla/ui/components/alert";
import { Button } from "@blabla/ui/components/button";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

export default function EmailVerificationNotice({ email }: { email: string }) {
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);

	async function sendVerification() {
		setSending(true);
		try {
			const { error } = await authClient.sendVerificationEmail({
				email,
				callbackURL: `${window.location.origin}/projects`,
			});
			if (error) {
				toast.error(error.message || "Could not send verification email.");
				return;
			}
			setSent(true);
			toast.success("Verification email sent. Check your inbox.");
		} catch {
			toast.error("Could not send verification email. Please try again.");
		} finally {
			setSending(false);
		}
	}

	return (
		<Alert>
			<AlertTitle>Verify your email to join invited projects</AlertTitle>
			<AlertDescription className="flex flex-wrap items-center justify-between gap-2">
				<p>
					{sent
						? `Open the verification link sent to ${email}. If it expired, request a new one.`
						: `Confirm that you own ${email} to accept project invitations.`}
				</p>
				<Button
					variant="outline"
					size="sm"
					disabled={sending}
					onClick={sendVerification}
				>
					{sending
						? "Sending…"
						: sent
							? "Resend verification email"
							: "Send verification email"}
				</Button>
			</AlertDescription>
		</Alert>
	);
}
