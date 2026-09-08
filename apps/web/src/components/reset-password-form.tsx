import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
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
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import z from "zod";

import { BrandWordmark } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export default function ResetPasswordForm({
	token,
	error,
}: {
	token?: string;
	error?: string;
}) {
	const navigate = useNavigate();
	const invalid = !token || error === "INVALID_TOKEN";
	const form = useForm({
		defaultValues: { password: "", confirmPassword: "" },
		validators: {
			onSubmit: z
				.object({
					password: z.string().min(8, "Password must be at least 8 characters"),
					confirmPassword: z.string(),
				})
				.refine((value) => value.password === value.confirmPassword, {
					message: "Passwords do not match",
					path: ["confirmPassword"],
				}),
		},
		onSubmit: async ({ value }) => {
			if (!token) return;
			const result = await authClient.resetPassword({
				newPassword: value.password,
				token,
			});
			if (result.error) {
				toast.error(result.error.message || "Could not reset your password.");
				return;
			}
			toast.success("Password reset. Sign in with your new password.");
			await navigate({
				to: "/sign-in",
				search: { mode: "sign-in", redirect: undefined },
				replace: true,
			});
		},
	});

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
			<div className="flex flex-col items-center gap-3">
				<BrandWordmark />
				<h1 className="text-center font-semibold text-xl tracking-tight">
					Reset password
				</h1>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>
						{invalid ? "Link expired or invalid" : "New password"}
					</CardTitle>
					<CardDescription>
						{invalid
							? "Request a new reset link."
							: "Other sessions will be signed out."}
					</CardDescription>
				</CardHeader>
				{invalid ? null : (
					<CardContent>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								form.handleSubmit();
							}}
						>
							<FieldGroup>
								{(["password", "confirmPassword"] as const).map((name) => (
									<form.Field key={name} name={name}>
										{(field) => (
											<Field data-invalid={field.state.meta.errors.length > 0}>
												<FieldLabel htmlFor={field.name}>
													{name === "password"
														? "New password"
														: "Confirm password"}
												</FieldLabel>
												<Input
													id={field.name}
													name={field.name}
													type="password"
													autoComplete="new-password"
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
											className="w-full"
											disabled={isSubmitting}
										>
											{isSubmitting ? (
												<Loader2 className="animate-spin" />
											) : null}
											{isSubmitting ? "Resetting…" : "Reset password"}
										</Button>
									)}
								</form.Subscribe>
							</FieldGroup>
						</form>
					</CardContent>
				)}
				<CardFooter className="justify-center">
					<Button
						nativeButton={false}
						variant="link"
						size="sm"
						render={
							<Link
								to="/sign-in"
								search={{
									mode: invalid ? "forgot-password" : "sign-in",
									redirect: undefined,
								}}
							/>
						}
					>
						{invalid ? "Request another link" : "Back to sign in"}
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
