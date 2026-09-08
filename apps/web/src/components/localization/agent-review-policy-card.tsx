import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { useState } from "react";

import { convexApplicationErrorMessage } from "@/lib/translation-task-review";

export function AgentReviewPolicyCard({
	enabled,
	isOwner,
	onChange,
}: {
	enabled: boolean;
	isOwner: boolean;
	onChange: (enabled: boolean) => Promise<unknown>;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function changePolicy() {
		if (!isOwner || saving) return;
		setSaving(true);
		setError(null);
		try {
			await onChange(!enabled);
		} catch (cause) {
			setError(
				convexApplicationErrorMessage(cause, "Could not change agent review."),
			);
		} finally {
			setSaving(false);
		}
	}
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Agent review · {enabled ? "enabled" : "off"}</CardTitle>
				<CardDescription>
					Allow a separate reviewer agent to accept or reject translations.
					Never share its reviewer token with the translating agent.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<p className="text-muted-foreground text-xs">
					When off, editors can still authorize individual candidate revisions.
					Existing reviews and authorizations remain.
				</p>
				{isOwner ? (
					<Button
						variant="outline"
						disabled={saving}
						onClick={() => void changePolicy()}
					>
						{saving
							? "Saving…"
							: enabled
								? "Disable agent review"
								: "Enable agent review"}
					</Button>
				) : (
					<p className="text-muted-foreground text-xs">
						Only project owners can change this setting.
					</p>
				)}
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}
