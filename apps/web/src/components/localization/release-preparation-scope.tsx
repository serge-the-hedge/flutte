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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@blabla/ui/components/select";
import { useId, useState } from "react";
import {
	type ReleasePreparationSelection,
	releaseSelectionProblem,
} from "@/lib/release-selection";

const modes = [
	{ value: "all", label: "All current changes, with exclusions" },
	{ value: "selected", label: "Only selected messages" },
];

/** Selection applies only to the next immutable assessment. The parent keeps
 * it when refreshing a stale report, using the frozen record as the default. */
export function ReleasePreparationScope({
	selection,
	onChange,
	onPrepare,
	preparing,
}: {
	selection: ReleasePreparationSelection;
	onChange: (selection: ReleasePreparationSelection) => void;
	onPrepare: () => void;
	preparing: boolean;
}) {
	const id = useId();
	const [messageId, setMessageId] = useState("");
	const selectedOnly = selection.mode === "selected";
	const ids = selectedOnly
		? selection.selectedMessageIds
		: selection.excludedMessageIds;
	const problem = releaseSelectionProblem(selection);
	const changeIds = (next: string[]) =>
		onChange(
			selectedOnly
				? { mode: "selected", selectedMessageIds: next }
				: { mode: "all", excludedMessageIds: next },
		);
	const add = () => {
		if (!messageId) return;
		changeIds([...new Set([...ids, messageId])].sort());
		setMessageId("");
	};
	return (
		<Card size="sm" className="max-w-3xl">
			<CardHeader>
				<CardTitle>Choose messages for this release</CardTitle>
				<CardDescription>
					Selection covers Source and all active existing target languages
					together. Other edits and reviews stay pending. New-language additions
					remain separate, complete catalogs.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<FieldGroup>
					<Field data-disabled={preparing}>
						<FieldLabel htmlFor={`${id}-mode`}>
							Existing-language changes
						</FieldLabel>
						<Select
							items={modes}
							value={selection.mode}
							disabled={preparing}
							onValueChange={(mode) => {
								if (mode === "all") onChange({ mode, excludedMessageIds: [] });
								if (mode === "selected")
									onChange({ mode, selectedMessageIds: [] });
								setMessageId("");
							}}
						>
							<SelectTrigger id={`${id}-mode`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{modes.map((mode) => (
										<SelectItem key={mode.value} value={mode.value}>
											{mode.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
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
								disabled={preparing || !messageId || ids.length >= 64}
								onClick={add}
							>
								{selectedOnly ? "Select message" : "Leave pending"}
							</Button>
						</div>
						<FieldDescription id={`${id}-description`}>
							Up to 64 identifiers. Identifiers are checked when you prepare.
						</FieldDescription>
					</Field>
				</FieldGroup>
				{ids.length ? (
					<ul className="flex flex-col gap-2">
						{ids.map((key) => (
							<li key={key} className="flex items-center justify-between gap-2">
								<code className="break-all text-xs">{key}</code>
								<Button
									size="xs"
									variant="outline"
									disabled={preparing}
									aria-label={
										selectedOnly
											? `Remove ${key} from selection`
											: `Include ${key} again`
									}
									onClick={() => changeIds(ids.filter((item) => item !== key))}
								>
									{selectedOnly ? "Remove" : "Include again"}
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-xs">
						{problem ?? "All current message changes are included."}
					</p>
				)}
				{ids.length > 0 && problem ? (
					<p role="status" className="text-muted-foreground text-xs">
						{problem}
					</p>
				) : null}
			</CardContent>
			<CardFooter>
				<Button
					size="sm"
					disabled={preparing || problem !== null}
					onClick={onPrepare}
				>
					Prepare with this selection
				</Button>
			</CardFooter>
		</Card>
	);
}
