import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@blabla/ui/components/combobox";

/** Search by both the human label and the canonical catalog code. */
export function LocaleSelector({
	id,
	locales,
	value,
	onChange,
	disabled = false,
	placeholder = "Choose a language",
}: {
	id?: string;
	locales: readonly { code: string; label?: string }[];
	value: string | null;
	onChange: (value: string | null) => void;
	disabled?: boolean;
	placeholder?: string;
}) {
	const items = locales.map((locale) => ({
		code: locale.code,
		label: locale.label ? `${locale.label} (${locale.code})` : locale.code,
	}));
	return (
		<Combobox
			items={items}
			value={items.find((item) => item.code === value) ?? null}
			onValueChange={(item) => onChange(item?.code ?? null)}
			itemToStringLabel={(item) => item.label}
			itemToStringValue={(item) => item.code}
			isItemEqualToValue={(left, right) => left.code === right.code}
			disabled={disabled}
		>
			<ComboboxInput
				disabled={disabled}
				id={id}
				aria-label={placeholder}
				placeholder={placeholder}
				showClear
			/>
			<ComboboxContent>
				<ComboboxEmpty>No matching languages.</ComboboxEmpty>
				<ComboboxList>
					{(item) => (
						<ComboboxItem key={item.code} value={item}>
							{item.label}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
