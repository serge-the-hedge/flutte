import { Button } from "@blabla/ui/components/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@blabla/ui/components/combobox";

const ALL = "__all__";

/** Keep dozens of selections compact; Source is always visible. */
export function StringsLanguageSelector({
	locales,
	value,
	onChange,
}: {
	locales: readonly { code: string; label?: string }[];
	value: readonly string[] | undefined;
	onChange: (codes: string[] | undefined) => void;
}) {
	const items = [
		{ code: ALL, label: "All languages" },
		...locales.map((locale) => ({
			code: locale.code,
			label: locale.label ? `${locale.label} (${locale.code})` : locale.code,
		})),
	];
	const all = value === undefined;
	const selected = items.filter((item) => all || value.includes(item.code));
	const count = selected.filter((item) => item.code !== ALL).length;
	const summary = all
		? `All languages (${locales.length})`
		: count === 0
			? "Source only"
			: count === 1
				? selected[0]?.label
				: `${count} languages`;
	return (
		<Combobox
			multiple
			items={items}
			value={selected}
			itemToStringLabel={(item) => item.label}
			itemToStringValue={(item) => item.code}
			isItemEqualToValue={(a, b) => a.code === b.code}
			onValueChange={(next) => {
				const hasAll = next.some((item) => item.code === ALL);
				if (!all && hasAll) return onChange(undefined);
				if (all && !hasAll) return onChange([]);
				const codes = next
					.filter((item) => item.code !== ALL)
					.map((item) => item.code)
					.sort();
				onChange(codes.length === locales.length ? undefined : codes);
			}}
		>
			<ComboboxTrigger
				render={<Button variant="outline" />}
				aria-label={`Languages: ${summary}`}
			>
				{summary}
			</ComboboxTrigger>
			<ComboboxContent className="w-72">
				<ComboboxInput
					aria-label="Find languages"
					placeholder="Find languages…"
					showTrigger={false}
				/>
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
