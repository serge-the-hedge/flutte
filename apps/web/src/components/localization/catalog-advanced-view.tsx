import { Button } from "@blabla/ui/components/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@blabla/ui/components/combobox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@blabla/ui/components/dialog";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

export type CatalogLocale = { id: string; code: string; label?: string };

/** One string surface, entered at properties or a particular locale. Only the
 * selected locale is mounted; its editing session belongs to the catalog. */
export function CatalogAdvancedView({
	title,
	locales,
	initialLocaleId,
	initiallyShowProperties,
	properties,
	renderValue,
	onClose,
	returnFocus,
}: {
	title: string;
	locales: CatalogLocale[];
	initialLocaleId: string;
	initiallyShowProperties: boolean;
	properties?: ReactNode;
	renderValue: (localeId: string) => ReactNode;
	onClose: () => void;
	returnFocus: HTMLElement | null;
}) {
	const [localeId, setLocaleId] = useState(initialLocaleId);
	const [showProperties, setShowProperties] = useState(initiallyShowProperties);
	const propertiesId = useId();
	const body = useRef<HTMLDivElement>(null);
	const selected =
		locales.find((locale) => locale.id === localeId) ?? locales[0];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
				finalFocus={() => {
					if (returnFocus?.isConnected) return returnFocus;
					const messageId = returnFocus?.dataset.workspaceMessageId;
					const localeId = returnFocus?.dataset.workspaceLocaleId;
					return (
						[
							...document.querySelectorAll<HTMLElement>(
								"[data-workspace-message-id][data-workspace-locale-id]",
							),
						].find(
							(field) =>
								field.dataset.workspaceMessageId === messageId &&
								field.dataset.workspaceLocaleId === localeId &&
								!field.closest('[role="dialog"]'),
						) ?? false
					);
				}}
			>
				<div className="shrink-0 border-b px-5 py-4 pr-12">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="sr-only">
						String properties and translations
					</DialogDescription>
				</div>
				<div ref={body} className="min-h-0 overflow-y-auto overscroll-contain">
					{properties ? (
						<div className="border-b px-5 py-3">
							<Button
								variant="ghost"
								size="sm"
								aria-expanded={showProperties}
								aria-controls={propertiesId}
								onClick={() => setShowProperties((open) => !open)}
							>
								<ChevronDown
									data-icon="inline-start"
									className={showProperties ? undefined : "-rotate-90"}
								/>
								Properties
							</Button>
							<div
								id={propertiesId}
								hidden={!showProperties}
								className="pt-4 pb-1"
							>
								{properties}
							</div>
						</div>
					) : null}
					<div className="sticky top-0 border-b bg-popover px-5 py-3">
						<Combobox
							items={locales}
							value={selected ?? null}
							itemToStringLabel={(locale) =>
								`${locale.code}${locale.label ? ` · ${locale.label}` : ""}`
							}
							onValueChange={(locale) => {
								if (!locale) return;
								setLocaleId(locale.id);
								setShowProperties(false);
								body.current?.scrollTo({ top: 0 });
							}}
						>
							<ComboboxInput
								aria-label="Editing language"
								placeholder="Find language"
								className="max-w-sm"
							/>
							<ComboboxContent>
								<ComboboxEmpty>No matching languages</ComboboxEmpty>
								<ComboboxList>
									{(locale: CatalogLocale) => (
										<ComboboxGroup key={locale.id}>
											<ComboboxItem value={locale}>
												{locale.code}
												{locale.label ? ` · ${locale.label}` : ""}
											</ComboboxItem>
										</ComboboxGroup>
									)}
								</ComboboxList>
							</ComboboxContent>
						</Combobox>
					</div>
					<div className="min-h-64 px-4 py-4 sm:px-5">
						{selected ? renderValue(selected.id) : null}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
