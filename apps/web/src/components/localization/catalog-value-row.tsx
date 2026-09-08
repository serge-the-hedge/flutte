import { cn } from "@blabla/ui/lib/utils";
import type { ReactNode } from "react";
import type { ValueTone } from "@/lib/strings-catalog-presentation";

export const QUIET_CATALOG_FIELD =
	"field-sizing-content min-h-0 w-full resize-none border-0 bg-transparent px-2 py-1 text-[13px] leading-relaxed shadow-none transition-colors hover:bg-muted/40 focus:bg-muted/60 focus-visible:border-0 focus-visible:ring-0 md:text-[13px] dark:bg-transparent dark:hover:bg-muted/30 dark:focus:bg-muted/50";

/**
 * A value's own line. The Locale sits in a narrow gutter and the value takes
 * the rest of the width at a reading measure; the coloured rule beside it is
 * the only thing that fires without being asked, and only for work that is
 * still waiting on someone.
 */
export function CatalogValueRow({
	localeCode,
	tone,
	children,
}: {
	localeCode: string;
	tone: ValueTone;
	children: ReactNode;
}) {
	return (
		<div className="relative flex items-start gap-2">
			<span
				aria-hidden="true"
				className={cn(
					"mt-1.5 w-px shrink-0 self-stretch rounded",
					tone === "attention"
						? "bg-amber-500/70"
						: tone === "mark"
							? "bg-border"
							: "bg-transparent",
				)}
			/>
			<span
				className="max-w-[25%] shrink-0 break-all pt-1.5 font-medium font-mono text-[11px] text-muted-foreground/60"
				style={{ width: "var(--locale-gutter, 3ch)" }}
				title={localeCode}
			>
				{localeCode}
			</span>
			<div className={"min-w-0 max-w-[74ch] flex-1"}>{children}</div>
		</div>
	);
}
