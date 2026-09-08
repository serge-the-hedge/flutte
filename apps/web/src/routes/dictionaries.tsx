import { Button } from "@blabla/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@blabla/ui/components/card";
import { Field, FieldLabel } from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { Skeleton } from "@blabla/ui/components/skeleton";
import {
	createFileRoute,
	Link,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import {
	Authenticated,
	AuthLoading,
	Unauthenticated,
	useMutation,
	useQuery,
} from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import AuthRedirect from "@/components/auth-redirect";
import { api } from "@/lib/convex-api";

export const Route = createFileRoute("/dictionaries")({
	component: DictionariesRoute,
});
function DictionaryList() {
	const dictionaries = useQuery(api.dictionaries.list, {});
	const create = useMutation(api.dictionaries.create);
	const navigate = useNavigate();
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="mx-auto flex h-full max-w-5xl flex-col gap-6 overflow-auto px-6 py-8">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="font-semibold text-2xl">Dictionaries</h1>
					<p className="text-muted-foreground text-sm">
						Shared terminology for your projects.
					</p>
				</div>
				<Button disabled={busy} onClick={() => setAdding(!adding)}>
					New dictionary
				</Button>
			</div>
			{adding ? (
				<form
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy || !name.trim()) return;
						setBusy(true);
						try {
							const id = await create({ name: name.trim() });
							setName("");
							setAdding(false);
							await navigate({
								to: "/dictionaries/$dictionaryId",
								params: { dictionaryId: id },
							});
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: "Could not create dictionary",
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					<fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
						<Field className="min-w-0 flex-1 basis-48">
							<FieldLabel htmlFor="dictionary-name">Dictionary name</FieldLabel>
							<Input
								id="dictionary-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Brickit terminology"
								required
							/>
						</Field>
						<Button type="submit">Create</Button>
					</fieldset>
				</form>
			) : null}
			{dictionaries === undefined ? (
				<Skeleton className="h-28 w-full" />
			) : dictionaries.length === 0 ? (
				<p className="text-muted-foreground">No dictionaries yet.</p>
			) : (
				<div className="grid gap-3 md:grid-cols-2">
					{dictionaries.map((dictionary) => (
						<Link
							key={dictionary._id}
							to="/dictionaries/$dictionaryId"
							params={{ dictionaryId: dictionary._id }}
						>
							<Card size="sm">
								<CardHeader>
									<CardTitle className="break-words">
										{dictionary.name}
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-muted-foreground text-sm">
										{dictionary.isOwner
											? "Owner"
											: dictionary.canEdit
												? "Editor"
												: "Viewer"}
									</p>
								</CardContent>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
function DictionariesRoute() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	return (
		<>
			<Authenticated>
				{pathname === "/dictionaries" ? <DictionaryList /> : <Outlet />}
			</Authenticated>
			<Unauthenticated>
				<AuthRedirect />
			</Unauthenticated>
			<AuthLoading>
				<Skeleton className="m-6 h-28" />
			</AuthLoading>
		</>
	);
}
