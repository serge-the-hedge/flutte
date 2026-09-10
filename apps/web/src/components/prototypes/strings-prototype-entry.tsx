// Standalone fixture harness for the same prototype mounted in the Strings route.
// No auth or API client is initialized; this file is not an application entrypoint.
import {
	BookOpen,
	Bot,
	ChevronLeft,
	Languages,
	MessageSquareText,
	PackageCheck,
} from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import { StringsHistoryPrototype } from "./strings-history-prototype";
import type { PrototypeVariant } from "./prototype-switcher";

function App() {
	const [variant, setVariant] = useState<PrototypeVariant>(() => {
		const value = new URL(location.href).searchParams.get("variant");
		return value === "B" || value === "C" ? value : "A";
	});
	return (
		<div className="min-h-screen bg-background text-foreground">
			<header className="flex h-14 items-center gap-7 border-b border-border px-6 text-xs">
				<span className="flex items-center gap-2 text-sm font-semibold">
					<MessageSquareText
						className="rounded bg-sky-400 p-1 text-black"
						size={26}
					/>
					blabla
				</span>
				<span className="rounded bg-muted px-3 py-1.5">Projects</span>
				<span className="text-muted-foreground">Dictionaries</span>
				<span className="ml-auto text-muted-foreground">Local prototype</span>
			</header>
			<div className="flex min-h-[calc(100vh-56px)]">
				<aside className="hidden w-52 shrink-0 border-r border-border bg-muted/10 p-4 md:block">
					<p className="mb-6 flex items-center gap-1 text-xs text-muted-foreground">
						<ChevronLeft size={14} />
						All projects
					</p>
					<h2 className="font-semibold text-sm">Brickit App</h2>
					<span className="mt-3 inline-block rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">
						Repository
					</span>
					<p className="mt-9 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
						Workspace
					</p>
					{[
						{ name: "Sync", icon: Languages },
						{ name: "Strings", icon: MessageSquareText },
						{ name: "Tasks", icon: Bot },
						{ name: "Release", icon: PackageCheck },
					].map(({ name, icon: Icon }) => (
						<div
							key={name}
							className={`mb-1 flex items-center gap-2 rounded-md px-2 py-2.5 text-xs ${name === "Strings" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
						>
							<Icon size={15} />
							{name}
						</div>
					))}
					<p className="mt-7 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
						Settings
					</p>
					<div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
						<BookOpen size={15} />
						Guidance
					</div>
				</aside>
				<main
					className={`mx-auto w-full min-w-0 px-6 py-8 lg:px-10 ${variant === "B" ? "max-w-[1500px]" : "max-w-5xl"}`}
				>
					<StringsHistoryPrototype
						variant={variant}
						onVariantChange={(next) => {
							const url = new URL(location.href);
							url.searchParams.set("variant", next);
							history.replaceState(null, "", url);
							setVariant(next);
						}}
					/>
				</main>
			</div>
		</div>
	);
}
if (import.meta.env.DEV)
	createRoot(document.getElementById("app")!).render(<App />);
