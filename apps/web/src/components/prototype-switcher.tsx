/** Throwaway UI comparison controls, intentionally unavailable in production. */
import { Button } from "@blabla/ui/components/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";
export const prototypeVariants = {
	A: "Inline expansion",
	B: "Reading pane",
	C: "Compact table",
} as const;
export type PrototypeVariant = keyof typeof prototypeVariants;
const keys = Object.keys(prototypeVariants) as PrototypeVariant[];
export function PrototypeSwitcher({
	variant,
	onChange,
	state,
}: {
	variant: PrototypeVariant;
	onChange: (value: PrototypeVariant) => void;
	state: unknown;
}) {
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			if (
				!(event.target instanceof Element) ||
				event.target.closest(
					'input,textarea,select,[contenteditable], [role="dialog"]',
				) ||
				event.altKey ||
				event.metaKey ||
				event.ctrlKey
			)
				return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			onChange(
				keys[
					(keys.indexOf(variant) + (event.key === "ArrowRight" ? 1 : 2)) % 3
				] ?? "A",
			);
		};
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [variant, onChange]);
	if (!import.meta.env.DEV) return null;
	return (
		<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-foreground px-3 py-2 text-background shadow-lg">
			<Button
				size="icon-sm"
				variant="secondary"
				aria-label="Previous variant"
				onClick={() => onChange(keys[(keys.indexOf(variant) + 2) % 3] ?? "A")}
			>
				<ChevronLeft />
			</Button>
			<span className="min-w-44 text-center text-xs">
				{variant} · {prototypeVariants[variant]}
			</span>
			<Button
				size="icon-sm"
				variant="secondary"
				aria-label="Next variant"
				onClick={() => onChange(keys[(keys.indexOf(variant) + 1) % 3] ?? "A")}
			>
				<ChevronRight />
			</Button>
			<details className="text-xs">
				<summary className="cursor-pointer">State</summary>
				<pre className="absolute right-0 bottom-14 max-h-72 w-80 overflow-auto rounded border bg-background p-3 text-foreground">
					{JSON.stringify(state, null, 2)}
				</pre>
			</details>
		</div>
	);
}
