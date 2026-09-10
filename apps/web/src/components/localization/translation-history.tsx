import { Button } from "@blabla/ui/components/button";
import { useQuery } from "convex/react";
import { Clock3, Copy, X } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import { api, convexId } from "@/lib/convex-api";

const HISTORY_LABELS = {
	saved: "Saved",
	confirmed: "Confirmed",
	accepted: "Accepted translation",
	git: "Synced",
	retained: "Earlier saved value",
};

type TranslationAddress = {
	projectId: string;
	messageId: string;
	localeId: string;
	localeCode: string;
	messageLabel: string;
};

/** History mounts on demand; toggling it never replaces the live editor. */
export function TranslationHistoryRow({
	children,
	...address
}: TranslationAddress & { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const close = () => {
		setOpen(false);
		trigger.current?.focus();
	};
	return (
		<div className="group/history-row">
			<div className="relative pr-8">
				{children}
				<IconButton
					ref={trigger}
					label={`History of ${address.messageLabel} in ${address.localeCode}`}
					icon={Clock3}
					size="icon-xs"
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
					className="absolute top-0.5 right-0 text-muted-foreground/50 hover:text-foreground focus-visible:text-foreground group-hover/history-row:text-muted-foreground"
					onClick={() => setOpen((current) => !current)}
				/>
			</div>
			{open ? (
				<section
					id={panelId}
					aria-label={`History of ${address.messageLabel} in ${address.localeCode}`}
					className="my-3 ml-8 max-w-[78ch] rounded-lg border bg-muted/15 p-4"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							close();
						}
					}}
				>
					<header className="mb-3 flex items-center justify-between gap-3">
						<h3 className="font-medium text-xs">
							Translation history
							<span className="ml-2 font-mono text-muted-foreground">
								{address.localeCode}
							</span>
						</h3>
						<IconButton label="Close history" icon={X} onClick={close} />
					</header>
					<TranslationHistory {...address} />
				</section>
			) : null}
		</div>
	);
}

function TranslationHistory(address: TranslationAddress) {
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const result = useQuery(api.translationHistory.list, {
		projectId: convexId<"projects">(address.projectId),
		messageId: address.messageId,
		localeId: convexId<"locales">(address.localeId),
		cursor: cursors.at(-1),
	});
	if (result === undefined) {
		return (
			<p role="status" className="text-muted-foreground text-xs">
				Loading history…
			</p>
		);
	}
	return (
		<>
			{result.events.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					{result.nextCursor || cursors.length > 1
						? "No changes on this page."
						: "No recorded history."}
				</p>
			) : (
				<ol className="space-y-4 border-l pl-4">
					{result.events.map((entry) => (
						<li key={entry.id}>
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
								<span>
									{HISTORY_LABELS[entry.kind]}
									{entry.actorLabel ? ` · ${entry.actorLabel}` : ""}
								</span>
								<div className="flex items-center gap-1">
									<time dateTime={new Date(entry.recordedAt).toISOString()}>
										{new Date(entry.recordedAt).toLocaleString(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
										})}
									</time>
									<IconButton
										label="Copy value"
										icon={Copy}
										size="icon-xs"
										onClick={() => {
											void navigator.clipboard
												.writeText(entry.value)
												.then(() => toast.success("Value copied"))
												.catch(() => toast.error("Could not copy the value"));
										}}
									/>
								</div>
							</div>
							{entry.snapshot ? (
								<p className="mt-1 text-[11px] text-muted-foreground">
									{entry.snapshot.name ?? entry.snapshot.commit.slice(0, 7)}
								</p>
							) : null}
							<p
								dir="auto"
								className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed"
							>
								{entry.value ||
									(entry.intentionalBlankReason
										? "Intentionally blank"
										: "Empty value")}
							</p>
							{entry.intentionalBlankReason ? (
								<p className="mt-1 text-muted-foreground text-xs">
									{entry.intentionalBlankReason}
								</p>
							) : null}
						</li>
					))}
				</ol>
			)}
			{result.olderManualHistoryUnavailable ? (
				<p className="mt-4 text-[11px] text-muted-foreground">
					Older manual edits may be unavailable.
				</p>
			) : null}
			{cursors.length > 1 || result.nextCursor ? (
				<nav aria-label="History pages" className="mt-3 flex gap-2">
					<Button
						size="xs"
						variant="ghost"
						disabled={cursors.length === 1}
						onClick={() => setCursors((current) => current.slice(0, -1))}
					>
						Newer
					</Button>
					<Button
						size="xs"
						variant="ghost"
						disabled={!result.nextCursor}
						onClick={() => {
							const cursor = result.nextCursor;
							if (cursor) setCursors((current) => [...current, cursor]);
						}}
					>
						Older
					</Button>
				</nav>
			) : null}
		</>
	);
}
