import { Button } from "@blabla/ui/components/button";
import {
	Field,
	FieldDescription,
	FieldLabel,
} from "@blabla/ui/components/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@blabla/ui/components/select";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState } from "react";
import { api, convexId } from "@/lib/convex-api";

type Snapshot = FunctionReturnType<typeof api.snapshots.list>[number];

/** Selecting Source is a local choice. Preparation or continuation performs the write. */
export function LocaleSourceSelector({
	projectId,
	baselineSnapshotId,
	value,
	onChange,
	disabled = false,
	autoLoad = false,
}: {
	projectId: string;
	baselineSnapshotId?: string;
	value: string | null;
	onChange: (snapshotId: string | null) => void;
	disabled?: boolean;
	autoLoad?: boolean;
}) {
	const [activated, setActivated] = useState(autoLoad);
	const snapshots = useQuery(
		api.snapshots.list,
		activated ? { projectId: convexId<"projects">(projectId) } : "skip",
	);
	return (
		<LocaleSourceChoices
			baselineSnapshotId={baselineSnapshotId}
			snapshots={snapshots}
			activated={activated}
			onActivate={() => setActivated(true)}
			value={value}
			onChange={onChange}
			disabled={disabled}
		/>
	);
}

function LocaleSourceChoices({
	baselineSnapshotId,
	snapshots,
	activated,
	onActivate,
	value,
	onChange,
	disabled,
}: {
	baselineSnapshotId?: string;
	snapshots: Snapshot[] | undefined;
	activated: boolean;
	onActivate: () => void;
	value: string | null;
	onChange: (snapshotId: string | null) => void;
	disabled: boolean;
}) {
	const id = useId();
	const selected = snapshots?.find((snapshot) => snapshot._id === value);
	const items = [
		{ value: "current", label: "Current accepted source (default)" },
		...(snapshots ?? []).map((snapshot) => ({
			value: snapshot._id,
			label: `${snapshot.name ? `${snapshot.name} · ` : ""}${snapshot.commit.slice(0, 12)} · ${snapshot._id === baselineSnapshotId ? "Current accepted Baseline" : "Captured snapshot"}`,
		})),
	];
	return (
		<Field data-disabled={disabled}>
			<FieldLabel htmlFor={id}>Source for this language</FieldLabel>
			{activated ? (
				<Select
					items={items}
					value={value ?? "current"}
					onValueChange={(next) => onChange(next === "current" ? null : next)}
					disabled={disabled}
				>
					<SelectTrigger id={id} className="w-full max-w-xl">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{items.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : (
				<Button
					id={id}
					variant="outline"
					disabled={disabled}
					onClick={onActivate}
				>
					Choose a captured Source Snapshot
				</Button>
			)}
			<FieldDescription>
				{activated && snapshots === undefined
					? "Loading captured snapshots… "
					: null}
				{selected ? (
					<>
						Selected commit <code className="break-all">{selected.commit}</code>
						{" · "}
						{selected.repository}. Review stays pinned to this Source Snapshot.
						{selected._id !== baselineSnapshotId
							? " Delivery requires continuation on the accepted Source."
							: null}
					</>
				) : (
					"The current accepted source is the default. Choose a captured commit deliberately to review a different Source Snapshot."
				)}
			</FieldDescription>
		</Field>
	);
}
