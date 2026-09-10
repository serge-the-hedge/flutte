import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { CharacterCount, RepositoryCharacterLimit } from "./character-limit";

describe("Optional string character limit", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const calls: unknown[] = [];
	let failure = false;
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (_fn, args) => {
			calls.push(args);
			if (failure) throw new Error("Changed elsewhere");
			return null as never;
		},
	);
	afterAll(async () => {
		mutation.mockRestore();
		await client.close();
	});
	test("stays silent without a limit and counts Unicode, spaces, and line breaks", async () => {
		await dom.render(<CharacterCount value={"😀 a\n"} />);
		expect(dom.container.textContent).toBe("");
		await dom.render(<CharacterCount value={"😀 a\n"} limit={3} />);
		expect(dom.container.textContent).toBe("4 / 3 · 1 over limit");
	});
	test("removes a limit with its concurrency baseline and retains a failed draft", async () => {
		let closed = false;
		const dirty: boolean[] = [];
		await dom.render(
			<ConvexProvider client={client}>
				<RepositoryCharacterLimit
					projectId="project"
					messageId="key"
					limit={30}
					onClose={() => {
						closed = true;
					}}
					onUnsavedWorkChange={(value) => dirty.push(value)}
				/>
			</ConvexProvider>,
		);
		const input = dom.container.querySelector<HTMLInputElement>("input");
		if (!input) throw new Error("Missing limit input");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(dirty.at(-1)).toBe(true);
		failure = true;
		await act(async () => {
			dom.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(closed).toBe(false);
		expect(input.value).toBe("");
		expect(dom.container.textContent).toContain("Changed elsewhere");
		expect(calls.at(-1)).toEqual({
			projectId: "project",
			messageId: "key",
			characterLimit: null,
			expectedCharacterLimit: 30,
		});
		failure = false;
		await act(async () => {
			dom.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(closed).toBe(true);
	});
});
