import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { LanguageMetadataEditor } from "./language-metadata-editor";

describe("language metadata editor", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const mutation = spyOn(client, "mutation").mockResolvedValue(null);
	afterAll(() => {
		mutation.mockRestore();
		void client.close();
	});
	const locale = { _id: "fr-id", code: "fr", label: "French", isSource: false };
	const report = () => {};
	async function render(codeRestriction?: string, label = locale.label) {
		await dom.render(
			<ConvexProvider client={client}>
				<LanguageMetadataEditor
					projectId="project-id"
					locale={{ ...locale, label }}
					codeRestriction={codeRestriction}
					onClose={report}
					onUnsavedWorkChange={report}
				/>
			</ConvexProvider>,
		);
	}
	async function type(index: number, value: string) {
		const input = dom.container.querySelectorAll("input")[index];
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, value);
			input?.dispatchEvent(new Event("input", { bubbles: true }));
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
	test("repository codes stay bound while display names use the metadata API", async () => {
		mutation.mockClear();
		await render("Language codes come from the repository.");
		expect(
			dom.container.querySelector<HTMLInputElement>("input")?.disabled,
		).toBe(true);
		await type(1, "Français");
		await submit();
		expect(mutation.mock.calls[0]?.[1]).toEqual({
			projectId: "project-id",
			localeId: "fr-id",
			code: "fr",
			label: "Français",
			expectedCode: "fr",
			expectedLabel: "French",
		});
	});
	test("a restriction arriving after typing prevents submitting the code change", async () => {
		mutation.mockClear();
		await render();
		await type(0, "fr-CA");
		await render("Finish the translation draft first.");
		await submit();
		expect(mutation).not.toHaveBeenCalled();
		expect(dom.container.querySelector<HTMLInputElement>("input")?.value).toBe(
			"fr-CA",
		);
		await render();
		await submit();
		expect(mutation).toHaveBeenCalledTimes(1);
	});
	test("reactive updates do not overwrite drafts or silently advance save preconditions", async () => {
		mutation.mockClear();
		await render();
		await type(1, "Français");
		await render(undefined, "French (France)");
		expect(dom.container.querySelectorAll("input")[1]?.value).toBe("Français");
		await submit();
		expect(mutation.mock.calls[0]?.[1]).toMatchObject({
			expectedLabel: "French",
			label: "Français",
		});
	});
});
