import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

export default function ChangePasswordForm() {
	const form = useForm({
		defaultValues: {
			currentPassword: "",
			newPassword: "",
			confirmPassword: "",
		},
		validators: {
			onSubmit: z
				.object({
					currentPassword: z.string().min(1, "Enter your current password"),
					newPassword: z
						.string()
						.min(8, "Password must be at least 8 characters"),
					confirmPassword: z.string(),
				})
				.refine((value) => value.newPassword === value.confirmPassword, {
					message: "Passwords do not match",
					path: ["confirmPassword"],
				}),
		},
		onSubmit: async ({ value }) => {
			const result = await authClient.changePassword({
				currentPassword: value.currentPassword,
				newPassword: value.newPassword,
				revokeOtherSessions: true,
			});
			if (result.error) {
				toast.error(result.error.message || "Could not change your password.");
				return;
			}
			form.reset();
			toast.success("Password changed. Other sessions were signed out.");
		},
	});

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Password</CardTitle>
				<CardDescription>Other sessions will be signed out.</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						form.handleSubmit();
					}}
				>
					<FieldGroup>
						{(
							[
								["currentPassword", "Current password", "current-password"],
								["newPassword", "New password", "new-password"],
								["confirmPassword", "Confirm new password", "new-password"],
							] as const
						).map(([name, label, autoComplete]) => (
							<form.Field key={name} name={name}>
								{(field) => (
									<Field data-invalid={field.state.meta.errors.length > 0}>
										<FieldLabel htmlFor={field.name}>{label}</FieldLabel>
										<Input
											id={field.name}
											name={field.name}
											type="password"
											autoComplete={autoComplete}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(event) =>
												field.handleChange(event.target.value)
											}
										/>
										<FieldError errors={field.state.meta.errors} />
									</Field>
								)}
							</form.Field>
						))}
						<form.Subscribe selector={(state) => state.isSubmitting}>
							{(isSubmitting) => (
								<Button
									type="submit"
									className="self-start"
									disabled={isSubmitting}
								>
									{isSubmitting ? <Loader2 className="animate-spin" /> : null}
									{isSubmitting ? "Changing…" : "Change password"}
								</Button>
							)}
						</form.Subscribe>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
