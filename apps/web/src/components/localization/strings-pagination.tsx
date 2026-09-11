import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "@/components/icon-button";

/** Page positions belong to each storage adapter; navigation and feedback do not. */
export function StringsPagination({
	count,
	hasPrevious,
	hasNext,
	onPrevious,
	onNext,
}: {
	count: number | undefined;
	hasPrevious: boolean;
	hasNext: boolean;
	onPrevious: () => void;
	onNext: () => void;
}) {
	const loading = count === undefined;
	return (
		<nav
			aria-label="Strings pages"
			className="mt-4 flex items-center justify-between gap-3"
		>
			<IconButton
				label="Previous page"
				icon={ChevronLeft}
				variant="outline"
				disabled={loading || !hasPrevious}
				onClick={onPrevious}
			/>
			<span className="text-muted-foreground text-sm" role="status">
				{loading
					? "Loading strings…"
					: `${count} ${count === 1 ? "string" : "strings"} on this page`}
			</span>
			<IconButton
				label="Next page"
				icon={ChevronRight}
				variant="outline"
				disabled={loading || !hasNext}
				onClick={onNext}
			/>
		</nav>
	);
}
