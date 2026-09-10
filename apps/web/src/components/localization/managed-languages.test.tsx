import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { ManagedLanguages } from "./managed-languages";

describe("immediate Basic language management", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const calls: { name: string; args: unknown }[] = [];
	let fail = false;
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (reference, args) => {
			calls.push({ name: getFunctionName(reference), args });
			if (fail) throw Error("Try again later");
			return { localeId: "de-id", membershipRevision: 2 };
		},
	);
	beforeEach(() => {
		calls.length = 0;
		fail = false;
	});
	afterAll(() => {
		mutation.mockRestore();
		void client.close();
	});
	const props = {
		projectId: "project-id",
		collectionId: "collection-id",
		locales: [
			{ _id: "en-id", code: "en", label: "English", isSource: true },
			{ _id: "fr-id", code: "fr", label: "French", isSource: false },
			{ _id: "de-id", code: "de", label: "German", isSource: false },
		],
		enabledLocaleIds: ["fr-id"],
	};
	async function render(
		extra: {
			blockedLocaleIds?: string[];
			onUnsavedWorkChange?: (dirty: boolean) => void;
		} = {},
	) {
		await dom.render(
			<ConvexProvider client={client}>
				<ManagedLanguages {...props} {...extra} />
			</ConvexProvider>,
		);
	}
	async function type(index: number, value: string) {
		const input = dom.container.querySelectorAll("input")[index];
		if (!input) throw Error("Input missing");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function submit() {
		await act(async () => {
			dom.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
	}
	test("adds a language immediately through one mutation and clears successful input", async () => {
		const dirty: boolean[] = [];
		await render({ onUnsavedWorkChange: (value) => dirty.push(value) });
		await type(0, "de");
		await type(1, "German");
		await submit();
		expect(calls).toEqual([
			{
				name: "contentCollections:addLocale",
				args: {
					projectId: "project-id",
					collectionId: "collection-id",
					code: "de",
					label: "German",
				},
			},
		]);
		expect(dom.container.querySelector("input")?.value).toBe("");
		expect(dirty).toContain(true);
		expect(dirty.at(-1)).toBe(false);
		expect(dom.container.textContent).not.toContain("Save languages");
	});
	test("protects unsaved translations and otherwise removes with one direct action", async () => {
		await render({ blockedLocaleIds: ["fr-id"] });
		const button = () =>
			dom.container.querySelector<HTMLButtonElement>(
				'button[aria-label="Remove French"]',
			);
		expect(button()?.disabled).toBe(true);
		await act(async () => button()?.click());
		expect(calls).toEqual([]);
		await render();
		await act(async () => button()?.click());
		expect(calls).toEqual([
			{
				name: "contentCollections:removeLocale",
				args: {
					projectId: "project-id",
					collectionId: "collection-id",
					localeId: "fr-id",
				},
			},
		]);
	});
	test("retains an unsuccessful add draft for retry", async () => {
		await render();
		await type(0, "ja");
		fail = true;
		await submit();
		expect(dom.container.querySelector("input")?.value).toBe("ja");
		expect(
			dom.container.querySelector('[role="alert"]')?.textContent,
		).toContain("Try again later");
		fail = false;
		await submit();
		expect(dom.container.querySelector("input")?.value).toBe("");
		expect(calls).toHaveLength(2);
	});
	test("edits a source language without changing its identity or offering removal", async () => {
		const dirty: boolean[] = [];
		await render({ onUnsavedWorkChange: (value) => dirty.push(value) });
		expect(
			dom.container.querySelector('button[aria-label="Remove English"]'),
		).toBeNull();
		await act(async () =>
			dom.container
				.querySelector<HTMLButtonElement>('button[aria-label="Edit English"]')
				?.click(),
		);
		await type(0, "en-GB");
		await type(1, "British English");
		expect(dirty.at(-1)).toBe(true);
		await submit();
		expect(calls).toEqual([
			{
				name: "locales:updateMetadata",
				args: {
					projectId: "project-id",
					localeId: "en-id",
					code: "en-GB",
					label: "British English",
					expectedCode: "en",
					expectedLabel: "English",
				},
			},
		]);
		expect(
			dom.container.querySelector('form[aria-label="Edit English"]'),
		).toBeNull();
		expect(dirty.at(-1)).toBe(false);
	});
	test("locks a draft language's code but allows its display name to change", async () => {
		await render({ blockedLocaleIds: ["fr-id"] });
		await act(async () =>
			dom.container
				.querySelector<HTMLButtonElement>('button[aria-label="Edit French"]')
				?.click(),
		);
		expect(
			dom.container.querySelector<HTMLInputElement>("input")?.disabled,
		).toBe(true);
		await type(1, "Français");
		await submit();
		expect(calls[0]).toEqual({
			name: "locales:updateMetadata",
			args: {
				projectId: "project-id",
				localeId: "fr-id",
				code: "fr",
				label: "Français",
				expectedCode: "fr",
				expectedLabel: "French",
			},
		});
	});
	test("retains rejected metadata and retries against the same original values", async () => {
		await render();
		await act(async () =>
			dom.container
				.querySelector<HTMLButtonElement>('button[aria-label="Edit French"]')
				?.click(),
		);
		await type(0, "fr-CA");
		fail = true;
		await submit();
		expect(dom.container.querySelector<HTMLInputElement>("input")?.value).toBe(
			"fr-CA",
		);
		expect(
			dom.container.querySelector('[role="alert"]')?.textContent,
		).toContain("Try again later");
		fail = false;
		await submit();
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(calls[0]);
	});
});
