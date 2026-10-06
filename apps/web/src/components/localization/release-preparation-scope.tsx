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
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@blabla/ui/components/field";
import { Input } from "@blabla/ui/components/input";
import { useId, useState } from "react";

/** Selection applies only to the next immutable assessment. The parent keeps
 * it when refreshing a stale report, using the frozen record as the default. */
export function ReleasePreparationScope({
	excludedMessageIds,
	onChange,
	onPrepare,
	preparing,
}: {
	excludedMessageIds: readonly string[];
	onChange: (ids: string[]) => void;
	onPrepare: () => void;
	preparing: boolean;
}) {
	const id = useId();
	const [messageId, setMessageId] = useState("");
	const add = () => {
		if (!messageId) return;
		onChange([...new Set([...excludedMessageIds, messageId])].sort());
		setMessageId("");
	};
	return (
		<Card size="sm" className="max-w-3xl">
			<CardHeader>
				<CardTitle>Leave messages pending for this release</CardTitle>
				<CardDescription>
					Deferred messages are excluded from the existing-language delta:
					Source and all active target languages. Their pending edits and
					reviews are retained. Complete new-language catalogs still include
					these messages.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<FieldGroup>
					<Field data-disabled={preparing}>
						<FieldLabel htmlFor={id}>Exact message identifier</FieldLabel>
						<div className="flex gap-2">
							<Input
								id={id}
								aria-describedby={`${id}-description`}
								value={messageId}
								disabled={preparing}
								onChange={(event) => setMessageId(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										add();
									}
								}}
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={preparing || !messageId}
								onClick={add}
							>
								Leave pending
							</Button>
						</div>
						<FieldDescription id={`${id}-description`}>
							Up to 64 identifiers. Identifiers are checked when you prepare.
						</FieldDescription>
					</Field>
				</FieldGroup>
				{excludedMessageIds.length ? (
					<ul className="flex flex-col gap-2">
						{excludedMessageIds.map((key) => (
							<li key={key} className="flex items-center justify-between gap-2">
								<code className="break-all text-xs">{key}</code>
								<Button
									size="xs"
									variant="outline"
									disabled={preparing}
									aria-label={`Include ${key} again`}
									onClick={() =>
										onChange(excludedMessageIds.filter((item) => item !== key))
									}
								>
									Include again
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-xs">
						All current message changes are included.
					</p>
				)}
			</CardContent>
			<CardFooter>
				<Button size="sm" disabled={preparing} onClick={onPrepare}>
					Prepare with this selection
				</Button>
			</CardFooter>
		</Card>
	);
}
