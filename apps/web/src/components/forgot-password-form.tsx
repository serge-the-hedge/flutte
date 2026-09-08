import { env } from "@blabla/env/web";
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
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { BrandWordmark } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordForm() {
	const [sent, setSent] = useState(false);
	const form = useForm({
		defaultValues: { email: "" },
		validators: {
			onSubmit: z.object({ email: z.email("Enter a valid email address") }),
		},
		onSubmit: async ({ value }) => {
			const siteUrl = env.VITE_SITE_URL ?? window.location.origin;
			const result = await authClient.requestPasswordReset({
				email: value.email,
				redirectTo: new URL("/reset-password", siteUrl).toString(),
			});
			if (result.error) {
				toast.error(result.error.message || "Could not request a reset email.");
				return;
			}
			setSent(true);
		},
	});

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
			<div className="flex flex-col items-center gap-3">
				<BrandWordmark />
				<h1 className="text-center font-semibold text-xl tracking-tight">
					Reset password
				</h1>
				<p className="text-center text-muted-foreground text-sm">
					We’ll email a reset link if an account uses this address.
				</p>
			</div>
			<Card>
				<CardHeader className={sent ? undefined : "sr-only"}>
					<CardTitle>{sent ? "Check your inbox" : "Reset link"}</CardTitle>
					{sent && (
						<CardDescription>The link expires in one hour.</CardDescription>
					)}
				</CardHeader>
				{sent ? null : (
					<CardContent>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								form.handleSubmit();
							}}
						>
							<FieldGroup>
								<form.Field name="email">
									{(field) => (
										<Field data-invalid={field.state.meta.errors.length > 0}>
											<FieldLabel htmlFor={field.name}>Email</FieldLabel>
											<Input
												id={field.name}
												name={field.name}
												type="email"
												autoComplete="email"
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
											{isSubmitting ? "Sending…" : "Send reset link"}
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
								search={{ mode: "sign-in", redirect: undefined }}
							/>
						}
					>
						Back to sign in
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
