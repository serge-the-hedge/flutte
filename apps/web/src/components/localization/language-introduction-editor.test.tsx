import { beforeAll, describe, expect, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createDomTest } from "@/test/dom";
import type { LanguageIntroductionEditor as Editor } from "./language-introduction-editor";

const dom = createDomTest();
let LanguageIntroductionEditor: typeof Editor;
beforeAll(async () => {
	({ LanguageIntroductionEditor } = await import(
		"./language-introduction-editor"
	));
});
type Props = ComponentProps<typeof Editor>;
const targets = [
	{
		localeCode: "it",
		label: "Italian",
		catalogPath: "intl_it.arb",
		runtimeLocale: "it-IT",
	},
	{
		localeCode: "ja",
		label: "Japanese",
		catalogPath: "intl_ja.arb",
		runtimeLocale: "ja-JP",
	},
];
const props = (overrides: Partial<Props> = {}): Props => ({
	targets,
	activeLocaleCodes: [],
	canEdit: true,
	onSave: async () => {},
	onRemove: async () => {},
	...overrides,
});
function field(name: string) {
	const element = dom.container.querySelector<HTMLInputElement>(
		`#language-${name}`,
	);
	if (!element) throw new Error(`Missing ${name}`);
	return element;
}
function button(label: string) {
	const element = [...dom.container.querySelectorAll("button")].find(
		(button) => button.textContent === label,
	);
	if (!element) throw new Error(`Missing ${label}`);
	return element;
}
async function type(name: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(field(name), value);
		field(name).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function choose(code: string) {
	const input =
		dom.container.querySelector<HTMLInputElement>('[role="combobox"]');
	if (!input) throw new Error("Missing language selector");
	await act(async () => {
		input.focus();
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((option) => option.textContent?.includes(`(${code})`));
	if (!option) throw new Error(`Missing option ${code}`);
	await act(async () => {
		option.click();
	});
}

describe("language setup drafts", () => {
	test("keeps each language draft and blocks switching while a failed save is pending", async () => {
		let rejectSave: (cause: Error) => void = () => {
			throw new Error("Save did not start");
		};
		const requests: Props["targets"][number][] = [];
		await dom.render(
			<LanguageIntroductionEditor
				{...props({
					onSave: (value) => {
						requests.push(value);
						return new Promise((_resolve, reject) => {
							rejectSave = reject;
						});
					},
				})}
			/>,
		);
		await choose("it");
		await type("label", "Italian draft");
		await choose("ja");
		expect(field("label").value).toBe("Japanese");
		await choose("it");
		expect(field("label").value).toBe("Italian draft");
		await act(async () => {
			button("Save language").click();
		});
		expect(button("Add language").disabled).toBe(true);
		expect(
			dom.container.querySelector<HTMLInputElement>('[role="combobox"]')
				?.disabled,
		).toBe(true);
		expect(requests).toEqual([{ ...targets[0], label: "Italian draft" }]);
		await act(async () => {
			rejectSave(new Error("Try again"));
		});
		expect(field("label").value).toBe("Italian draft");
		expect(button("Add language").disabled).toBe(false);
		await act(async () => {
			button("Discard draft").click();
		});
		expect(field("label").value).toBe("Italian");
	});

	test("removes only configuration and leaves other drafts intact", async () => {
		const removed: string[] = [];
		await dom.render(
			<LanguageIntroductionEditor
				{...props({
					onRemove: async (code) => {
						removed.push(code);
					},
				})}
			/>,
		);
		await type("localeCode", "sr");
		await type("label", "Serbian draft");
		await choose("it");
		await act(async () => {
			button("Remove configuration").click();
		});
		expect(removed).toEqual(["it"]);
		expect(field("localeCode").value).toBe("sr");
		expect(field("label").value).toBe("Serbian draft");
	});
});
