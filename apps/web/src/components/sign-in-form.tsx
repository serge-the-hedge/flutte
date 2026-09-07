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

export default function SignInForm({ redirectTo }: { redirectTo: string }) {
	const navigate = useNavigate();

	async function finishSignIn() {
		await navigate({
			href: redirectTo,
			replace: true,
		});
		toast.success("Signed in");
	}

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
		},
		onSubmit: async ({ value }) => {
			await authClient.signIn.email(
				{
					email: value.email,
					password: value.password,
				},
				{
					onSuccess: () => {
						void finishSignIn();
					},
					onError: (error) => {
						toast.error(error.error.message || error.error.statusText);
					},
				},
			);
		},
		validators: {
			onSubmit: z.object({
				email: z.email("Invalid email address"),
				password: z.string().min(8, "Password must be at least 8 characters"),
			}),
		},
	});

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
			<div className="flex flex-col items-center gap-3">
				<BrandWordmark />
				<h1 className="text-center font-semibold text-xl tracking-tight">
					Welcome back
				</h1>
				<p className="text-center text-muted-foreground text-sm">
					Sign in to continue to your workspace.
				</p>
			</div>
			<Card>
				<CardHeader className="sr-only">
					<CardTitle>Sign in</CardTitle>
					<CardDescription>
						Sign in with your email and password
					</CardDescription>
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
							<form.Field name="email">
								{(field) => (
									<Field data-invalid={field.state.meta.errors.length > 0}>
										<FieldLabel htmlFor={field.name}>Email</FieldLabel>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											autoComplete="email"
											aria-invalid={field.state.meta.errors.length > 0}
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
							<form.Field name="password">
								{(field) => (
									<Field data-invalid={field.state.meta.errors.length > 0}>
										<FieldLabel htmlFor={field.name}>Password</FieldLabel>
										<Input
											id={field.name}
											name={field.name}
											type="password"
											autoComplete="current-password"
											aria-invalid={field.state.meta.errors.length > 0}
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
							<form.Subscribe
								selector={(state) => ({
									canSubmit: state.canSubmit,
									isSubmitting: state.isSubmitting,
								})}
							>
								{({ canSubmit, isSubmitting }) => (
									<Button
										type="submit"
										className="w-full"
										disabled={!canSubmit || isSubmitting}
									>
										{isSubmitting ? (
											<Loader2
												data-icon="inline-start"
												className="animate-spin motion-reduce:animate-none"
											/>
										) : null}
										{isSubmitting ? "Signing in…" : "Sign in"}
									</Button>
								)}
							</form.Subscribe>
						</FieldGroup>
					</form>
				</CardContent>
				<CardFooter className="flex-col justify-center gap-1">
					<Button
						nativeButton={false}
						variant="link"
						size="sm"
						render={
							<Link
								to="/sign-in"
								search={{ mode: "forgot-password", redirect: redirectTo }}
							/>
						}
					>
						Forgot password?
					</Button>
					<Button
						nativeButton={false}
						variant="link"
						size="sm"
						render={
							<Link
								to="/sign-in"
								search={{ mode: "sign-up", redirect: redirectTo }}
							/>
						}
					>
						Need an account? Sign up
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
