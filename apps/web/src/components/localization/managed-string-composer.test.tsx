import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { ManagedStringComposer } from "./managed-string-composer";

describe("Continuous Basic string entry", () => {
	const dom = createDomTest();
	const noop = () => {};
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
	test("adds consecutive unnamed multiline strings without reopening or navigating", async () => {
		const calls: unknown[] = [];
		const dirty: boolean[] = [];
		const opened: string[] = [];
		await dom.render(
			<ManagedStringComposer
				onCreate={async (input) => {
					calls.push(input);
					return `id-${calls.length}`;
				}}
				onOpen={(id) => opened.push(id)}
				onUnsavedWorkChange={(value) => dirty.push(value)}
			/>,
		);
		expect(dom.container.querySelector("details")?.open).toBe(false);
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
		});
		expect(source().value).toBe("");
		expect(document.activeElement).toBe(source());
		expect(dirty.at(-1)).toBe(false);
		await type(source(), "Another string");
		await key({ ctrlKey: true });
		expect(calls).toHaveLength(2);
		expect(source().value).toBe("");
		expect(opened).toEqual([]);
		const view = [...dom.container.querySelectorAll("button")].find(
			(button) => button.textContent === "View string",
		);
		await act(async () => view?.click());
		expect(opened).toEqual(["id-2"]);
	});
	test("blocks duplicate submissions, retains a failed draft, and retries with its optional details", async () => {
		let attempt = Promise.withResolvers<string>();
		const calls: unknown[] = [];
		const dirty: boolean[] = [];
		await dom.render(
			<ManagedStringComposer
				onCreate={(input) => {
					calls.push(input);
					return attempt.promise;
				}}
				onOpen={noop}
				onUnsavedWorkChange={(value) => dirty.push(value)}
			/>,
		);
		await type(source(), "Keep this draft");
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
		});
		expect(source().value).toBe("");
		expect(name.value).toBe("");
		expect(context.value).toBe("");
		expect(document.activeElement).toBe(source());
		expect(dirty.at(-1)).toBe(false);
	});
});
