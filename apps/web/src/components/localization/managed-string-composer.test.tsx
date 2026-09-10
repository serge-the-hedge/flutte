import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { ManagedStringComposer } from "./managed-string-composer";

describe("Continuous Basic string entry", () => {
	const dom = createDomTest();
	const noop = () => {};
	const languageProps = {
		sourceLocale: { id: "en", code: "en" },
		enabledLocales: [{ id: "fr", code: "fr" }],
		visibleLocales: [{ id: "fr", code: "fr" }],
	};
	function source() {
		const input =
			dom.container.querySelector<HTMLTextAreaElement>("#new-string-text");
		if (!input) throw new Error("Composer missing");
		return input;
	}
	async function type(
		input: HTMLInputElement | HTMLTextAreaElement,
		value: string,
	) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				input.tagName === "TEXTAREA"
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function key(options: KeyboardEventInit) {
		const event = new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
			...options,
		});
		await act(async () => {
			source().dispatchEvent(event);
		});
		return event;
	}
	test("enforces the optional limit across source and hidden translation drafts", async () => {
		const calls: unknown[] = [];
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				onCreate={async (input) => {
					calls.push(input);
					return "new-id";
				}}
				onUnsavedWorkChange={noop}
			/>,
		);
		await type(source(), "Hi");
		const limit = dom.container.querySelector<HTMLInputElement>(
			'input[type="number"]',
		);
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr"]',
		);
		if (!limit || !target) throw new Error("Missing detail controls");
		await type(limit, "3");
		await type(target, "😀ab!");
		expect(dom.container.textContent).toContain("4 / 3 · 1 over limit");
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(0);
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				visibleLocales={[]}
				onCreate={async (input) => {
					calls.push(input);
					return "new-id";
				}}
				onUnsavedWorkChange={noop}
			/>,
		);
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(0);
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				onCreate={async (input) => {
					calls.push(input);
					return "new-id";
				}}
				onUnsavedWorkChange={noop}
			/>,
		);
		const restored = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr"]',
		);
		if (!restored) throw new Error("Missing translation draft");
		expect(restored.value).toBe("😀ab!");
		await type(restored, "😀ab");
		await key({ ctrlKey: true });
		expect(calls).toEqual([
			{
				sourceValue: "Hi",
				name: null,
				context: "",
				characterLimit: 3,
				translations: [{ localeId: "fr", value: "😀ab" }],
			},
		]);
	});

	test("adds consecutive unnamed multiline strings without reopening or navigating", async () => {
		const calls: unknown[] = [];
		const dirty: boolean[] = [];
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				onCreate={async (input) => {
					calls.push(input);
					return `id-${calls.length}`;
				}}
				onUnsavedWorkChange={(value) => dirty.push(value)}
			/>,
		);
		expect(dom.container.querySelectorAll("textarea")).toHaveLength(1);
		await type(source(), "First line\nSecond line");
		expect((await key({})).defaultPrevented).toBe(false);
		expect(
			(await key({ ctrlKey: true, isComposing: true })).defaultPrevented,
		).toBe(false);
		expect(calls).toHaveLength(0);
		expect((await key({ metaKey: true })).defaultPrevented).toBe(true);
		expect(calls[0]).toEqual({
			sourceValue: "First line\nSecond line",
			name: null,
			context: "",
			translations: [],
		});
		expect(source().value).toBe("");
		expect(document.activeElement).toBe(source());
		expect(dirty.at(-1)).toBe(false);
		await type(source(), "Another string");
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(2);
		expect(source().value).toBe("");
	});
	test("blocks duplicate submissions, retains a failed draft, and retries with its optional details", async () => {
		let attempt = Promise.withResolvers<string>();
		const calls: unknown[] = [];
		const dirty: boolean[] = [];
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				onCreate={(input) => {
					calls.push(input);
					return attempt.promise;
				}}
				onUnsavedWorkChange={(value) => dirty.push(value)}
			/>,
		);
		await type(source(), "Keep this draft");
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr"]',
		);
		if (!target) throw new Error("Missing target");
		await type(target, "Conserver");
		const name =
			dom.container.querySelector<HTMLInputElement>("#new-string-name");
		const context = dom.container.querySelector<HTMLTextAreaElement>(
			"#new-string-context",
		);
		if (!name || !context) throw new Error("Details missing");
		await type(name, " Store subtitle ");
		await type(context, "Keep it short");
		await key({ ctrlKey: true });
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(1);
		expect(source().closest("fieldset")?.disabled).toBe(true);
		expect(dirty.at(-1)).toBe(true);
		await act(async () => attempt.reject(new Error("Try again")));
		expect(source().value).toBe("Keep this draft");
		expect(name.value).toBe(" Store subtitle ");
		expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe(
			"Try again",
		);
		attempt = Promise.withResolvers<string>();
		await key({ ctrlKey: true });
		await act(async () => attempt.resolve("saved"));
		expect(calls[1]).toEqual({
			sourceValue: "Keep this draft",
			name: "Store subtitle",
			context: "Keep it short",
			translations: [{ localeId: "fr", value: "Conserver" }],
		});
		expect(source().value).toBe("");
		expect(
			dom.container.querySelector<HTMLInputElement>("#new-string-name")?.value,
		).toBe("");
		expect(
			dom.container.querySelector<HTMLTextAreaElement>("#new-string-context")
				?.value,
		).toBe("");
		expect(document.activeElement).toBe(source());
		expect(dirty.at(-1)).toBe(false);
	});
	test("keeps hidden targets, blocks removed-language drafts, then saves all values together", async () => {
		const calls: unknown[] = [];
		const create = async (input: unknown) => {
			calls.push(input);
			return "new";
		};
		const draftChanges: string[][] = [];
		const onTargetDraftsChange = (ids: readonly string[]) =>
			draftChanges.push([...ids]);
		const initial = (
			<ManagedStringComposer
				{...languageProps}
				onCreate={create}
				onUnsavedWorkChange={noop}
				onTargetDraftsChange={onTargetDraftsChange}
			/>
		);
		await dom.render(initial);
		await act(async () => source().focus());
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr"]',
		);
		if (!target) throw new Error("Missing target row");
		await type(target, "Bonjour");
		expect(draftChanges.at(-1)).toEqual(["fr"]);
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				visibleLocales={[]}
				onCreate={create}
				onUnsavedWorkChange={noop}
				onTargetDraftsChange={onTargetDraftsChange}
			/>,
		);
		expect(
			dom.container.querySelector('[data-composer-locale-id="fr"]'),
		).toBeNull();
		expect(dom.container.textContent).toContain(
			"1 hidden translation included",
		);
		await type(source(), "Hello");
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				enabledLocales={[]}
				visibleLocales={[]}
				onCreate={create}
				onUnsavedWorkChange={noop}
				onTargetDraftsChange={onTargetDraftsChange}
			/>,
		);
		expect(
			dom.container.querySelector<HTMLTextAreaElement>(
				'[data-composer-locale-id="fr"]',
			)?.value,
		).toBe("Bonjour");
		expect(dom.container.textContent).toContain("This language was removed");
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(0);
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				visibleLocales={[]}
				onCreate={create}
				onUnsavedWorkChange={noop}
				onTargetDraftsChange={onTargetDraftsChange}
			/>,
		);
		await key({ ctrlKey: true });
		expect(calls).toEqual([
			{
				sourceValue: "Hello",
				name: null,
				context: "",
				translations: [{ localeId: "fr", value: "Bonjour" }],
			},
		]);
		expect(draftChanges.at(-1)).toEqual([]);
	});
	test("keeps source and translations copyable when editing access is withdrawn", async () => {
		const calls: unknown[] = [];
		const onCreate = async (input: unknown) => {
			calls.push(input);
			return "saved";
		};
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				onCreate={onCreate}
				onUnsavedWorkChange={noop}
			/>,
		);
		await type(source(), "Keep source");
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr"]',
		);
		if (!target) throw new Error("Missing target");
		await type(target, "Conserver");
		await dom.render(
			<ManagedStringComposer
				{...languageProps}
				readOnly
				onCreate={onCreate}
				onUnsavedWorkChange={noop}
			/>,
		);
		expect(source().value).toBe("Keep source");
		expect(source().readOnly).toBe(true);
		expect(source().disabled).toBe(false);
		expect(target.value).toBe("Conserver");
		expect(target.readOnly).toBe(true);
		expect(
			dom.container.querySelector('[role="status"]')?.textContent,
		).toContain("draft is kept here for copying");
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(0);
	});
});
