// Throwaway UI comparison control; never rendered in a production build.
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect } from "react";

export type PrototypeVariant = "A" | "B" | "C";
const names = {
	A: "Picker + inline history",
	B: "Snapshot rail + history panel",
	C: "Snapshot strip + comparison",
};
export function PrototypeSwitcher({
	variant,
	onChange,
	state,
}: {
	variant: PrototypeVariant;
	onChange: (value: PrototypeVariant) => void;
	state: object;
}) {
	function cycle(delta: number) {
		const variants: PrototypeVariant[] = ["A", "B", "C"];
		onChange(
			variants[
				(variants.indexOf(variant) + delta + variants.length) % variants.length
			]!,
		);
	}
	useEffect(() => {
		function key(event: KeyboardEvent) {
			if (
				event.target instanceof Element &&
				event.target.closest(
					"input,textarea,select,[contenteditable],[role=dialog]",
				)
			)
				return;
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				cycle(event.key === "ArrowLeft" ? -1 : 1);
			}
		}
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [variant, onChange]);
	if (!import.meta.env.DEV) return null;
	return (
		<div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-violet-400/40 bg-[#211c32] px-3 py-2 text-white shadow-2xl">
			<div className="flex items-center gap-3 whitespace-nowrap">
				<button
					type="button"
					onClick={() => cycle(-1)}
					aria-label="Previous variant"
					className="rounded-lg p-2 hover:bg-white/10"
				>
					<ArrowLeft size={17} />
				</button>
				<div className="min-w-52 text-center">
					<p className="text-[10px] uppercase tracking-[0.18em] text-violet-300">
						Prototype · {variant}
					</p>
					<p className="text-xs">{names[variant]}</p>
				</div>
				<button
					type="button"
					onClick={() => cycle(1)}
					aria-label="Next variant"
					className="rounded-lg p-2 hover:bg-white/10"
				>
					<ArrowRight size={17} />
				</button>
			</div>
			<details className="text-center text-[10px] text-violet-200">
				<summary className="cursor-pointer">Prototype state</summary>
				<pre className="max-h-36 max-w-96 overflow-auto pt-2 text-left">
					{JSON.stringify(state, null, 2)}
				</pre>
			</details>
		</div>
	);
}
