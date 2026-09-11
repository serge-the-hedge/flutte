import { Maximize2 } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Only the preview compresses empty lines. The editor and clipboard retain
 * the original value, including its paragraph breaks. */
export function CatalogLongValue({
	value,
	label,
	onOpen,
	messageId,
	localeId,
	children,
	editing = false,
}: {
	value: string;
	label: string;
	onOpen?: () => void;
	messageId?: string;
	localeId?: string;
	children: ReactNode;
	editing?: boolean;
}) {
	const enabled = onOpen !== undefined;
	const measure = useRef<HTMLSpanElement>(null);
	const [long, setLong] = useState(false);
	useLayoutEffect(() => {
		const element = measure.current;
		if (!element || !enabled) return;
		const update = () =>
			setLong(
				value.length > 0 && element.scrollHeight > element.clientHeight + 1,
			);
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [value, enabled]);
	return (
		<div className="relative min-w-0">
			{onOpen ? (
				<span
					ref={measure}
					aria-hidden="true"
					className="pointer-events-none invisible absolute inset-x-0 top-0 line-clamp-3 whitespace-pre-wrap break-words px-2 py-1 text-[13px] leading-relaxed"
				>
					{value}
				</span>
			) : null}
			{long && onOpen && !editing ? (
				<button
					type="button"
					onClick={onOpen}
					data-workspace-message-id={messageId}
					data-workspace-locale-id={localeId}
					aria-label={`Open ${label} in advanced view`}
					className="flex w-full items-start gap-2 rounded-sm px-2 py-1 text-left text-[13px] leading-relaxed transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						dir="auto"
						className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words"
					>
						{value.replace(/\n(?:[\t ]*\n)+/g, "\n")}
					</span>
					<Maximize2
						aria-hidden="true"
						className="mt-1 size-3 shrink-0 text-muted-foreground"
					/>
				</button>
			) : (
				children
			)}
		</div>
	);
}
