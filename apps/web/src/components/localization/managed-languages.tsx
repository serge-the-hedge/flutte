import { Button } from "@blabla/ui/components/button";
import { Input } from "@blabla/ui/components/input";
import { useMutation } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { api, convexId } from "@/lib/convex-api";

type Language = {
	_id: string;
	code: string;
	label: string;
	isSource: boolean;
	archivedAt?: number;
};
/** Each action updates one language immediately; removed translations remain available on re-add. */
export function ManagedLanguages({
	projectId,
	collectionId,
	locales,
	enabledLocaleIds,
	blockedLocaleIds = [],
	disabled = false,
	onUnsavedWorkChange,
}: {
	projectId: string;
	collectionId: string;
	locales: readonly Language[];
	enabledLocaleIds: readonly string[];
	blockedLocaleIds?: readonly string[];
	disabled?: boolean;
	onUnsavedWorkChange?: (dirty: boolean) => void;
}) {
	const addLocale = useMutation(api.contentCollections.addLocale);
	const removeLocale = useMutation(api.contentCollections.removeLocale);
	const [code, setCode] = useState("");
	const [label, setLabel] = useState("");
	const [pending, setPending] = useState(false);
	const sending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const optionsId = useId();
	const dirty = code.length > 0 || label.length > 0;
	useEffect(() => {
		onUnsavedWorkChange?.(dirty || pending);
	}, [dirty, pending, onUnsavedWorkChange]);
	useEffect(() => () => onUnsavedWorkChange?.(false), [onUnsavedWorkChange]);
	const enabled = new Set(enabledLocaleIds);
	const blocked = new Set(blockedLocaleIds);
	async function update(work: () => Promise<unknown>, after?: () => void) {
		if (sending.current || disabled) return;
		sending.current = true;
		setPending(true);
		setError(null);
		try {
			await work();
			after?.();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not update languages. Try again.",
			);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	return (
		<section
			aria-label="Project languages"
			className="mb-5 rounded-md border p-4"
		>
			<h2 className="font-medium text-sm">Languages</h2>
			<p className="mt-1 text-muted-foreground text-xs">
				Removing a language keeps its translations. Add it again to restore
				them.
			</p>
			<div className="mt-3 flex flex-col gap-2">
				{locales
					.filter(
						(locale) =>
							!locale.isSource &&
							locale.archivedAt === undefined &&
							enabled.has(locale._id),
					)
					.map((locale) => (
						<div
							key={locale._id}
							className="flex flex-wrap items-center justify-between gap-2"
						>
							<span className="text-sm">
								{locale.label}{" "}
								<span className="text-muted-foreground">· {locale.code}</span>
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={disabled || pending || blocked.has(locale._id)}
								title={
									blocked.has(locale._id)
										? "Finish or clear this draft before removing its language."
										: undefined
								}
								aria-label={`Remove ${locale.label}`}
								onClick={() => {
									if (blocked.has(locale._id)) return;
									void update(() =>
										removeLocale({
											projectId: convexId<"projects">(projectId),
											collectionId:
												convexId<"contentCollections">(collectionId),
											localeId: convexId<"locales">(locale._id),
										}),
									);
								}}
							>
								Remove
							</Button>
						</div>
					))}
			</div>
			{blockedLocaleIds.some((id) => enabled.has(id)) && (
				<p className="mt-2 text-muted-foreground text-xs">
					Finish or clear a language’s draft before removing it.
				</p>
			)}
			<form
				className="mt-4 flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!code.trim()) return;
					void update(
						() =>
							addLocale({
								projectId: convexId<"projects">(projectId),
								collectionId: convexId<"contentCollections">(collectionId),
								code: code.trim(),
								label: label.trim() || undefined,
							}),
						() => {
							setCode("");
							setLabel("");
						},
					);
				}}
			>
				<label
					htmlFor={`${optionsId}-code`}
					className="flex min-w-0 flex-1 flex-col gap-1 text-xs"
				>
					Language code
					<Input
						id={`${optionsId}-code`}
						list={optionsId}
						placeholder="e.g. fr or pt-BR"
						value={code}
						disabled={disabled || pending}
						onChange={(event) => setCode(event.target.value)}
					/>
				</label>
				<datalist id={optionsId}>
					{locales
						.filter((locale) => !locale.isSource && !enabled.has(locale._id))
						.map((locale) => (
							<option key={locale._id} value={locale.code}>
								{locale.label}
							</option>
						))}
				</datalist>
				<label
					htmlFor={`${optionsId}-name`}
					className="flex min-w-0 flex-1 flex-col gap-1 text-xs"
				>
					Name (optional)
					<Input
						id={`${optionsId}-name`}
						placeholder="e.g. French"
						value={label}
						disabled={disabled || pending}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</label>
				<Button
					type="submit"
					size="sm"
					disabled={disabled || pending || !code.trim()}
				>
					{pending ? "Updating…" : "Add language"}
				</Button>
			</form>
			{error && (
				<p role="alert" className="mt-2 text-destructive text-sm">
					{error}
				</p>
			)}
		</section>
	);
}
