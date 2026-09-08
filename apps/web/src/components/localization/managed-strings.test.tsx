import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { act } from "react";
import { createDomTest } from "@/test/dom";
import { ManagedStrings } from "./managed-strings";

describe("Managed collection workflow", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const basis = {
		kind: "managed",
		collectionId: "marketing",
		sourceRevision: 1,
		targetRevision: 0,
		sourceFingerprint: "source",
		membershipRevision: 1,
	};
	const results: Record<string, unknown> = {
		"projects:get": {
			name: "Brickit",
			role: "editor",
			sourceLocale: { _id: "en-id", code: "en" },
		},
		"contentCollections:get": {
			id: "marketing",
			name: "Store listings",
			localeIds: ["fr-id"],
			membershipRevision: 1,
		},
		"locales:list": [
			{ _id: "en-id", code: "en", label: "English", isSource: true },
			{ _id: "fr-id", code: "fr", label: "French", isSource: false },
		],
		"managedContent:page": {
			items: [
				{
					messageId: "subtitle",
					key: "subtitle",
					sourceValue: "Build {anything}",
					context: "Store subtitle",
					sourceRevision: 1,
					sourceFingerprint: "source",
				},
			],
			nextCursor: null,
		},
		"managedContent:context": {
			items: [
				{
					messageId: "subtitle",
					localeId: "fr-id",
					localeCode: "fr",
					sourceValue: "Build {anything}",
					context: "Store subtitle",
					value: "",
					valueState: "waiting",
					intentionalBlank: null,
					basis,
				},
			],
		},
	};
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () => results[getFunctionName(query)] as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}),
	);
	const calls: Array<{ name: string; args: unknown }> = [];
	let pendingCreate:
		| ReturnType<typeof Promise.withResolvers<string>>
		| undefined;
	const mutation = spyOn(client, "mutation").mockImplementation(
		async (query, args) => {
			const name = getFunctionName(query);
			calls.push({ name, args });
			if (name === "managedContent:createMessage")
				return pendingCreate?.promise ?? "new_line";
			if (name === "managedContent:commit")
				return { basis: { ...basis, targetRevision: 1 } };
			if (name === "locales:create") return "de-id";
			return 2;
		},
	);
	const exportQuery = spyOn(client, "query").mockImplementation(
		async (query, args) => {
			calls.push({ name: getFunctionName(query), args });
			return {
				text: '{"values":{"subtitle":{"fr":"Construire"}}}',
				omitted: [],
				mode: "reviewed",
			};
		},
	);
	afterAll(async () => {
		watch.mockRestore();
		mutation.mockRestore();
		exportQuery.mockRestore();
		await client.close();
	});
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
	function button(text: string) {
		const found = [...dom.container.querySelectorAll("button")].find(
			(button) => button.textContent === text,
		);
		if (!found) throw new Error(`Missing ${text}`);
		return found;
	}
	test("authors source text without a checkout and enables an unbound language", async () => {
		const searches: unknown[] = [];
		const root = createRootRoute({
			component: () => (
				<ConvexProvider client={client}>
					<ManagedStrings
						projectId="project"
						collectionId="marketing"
						search={{
							collection: "marketing",
							cursor: "previous-page",
							q: "old search",
						}}
						onSearch={(search) => searches.push(search)}
					/>
				</ConvexProvider>
			),
		});
		const router = createRouter({
			routeTree: root,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		expect(dom.container.textContent).toContain("Build {anything}");
		expect(dom.container.textContent).toContain("Store subtitle");
		expect(dom.container.textContent).not.toContain("Raw ICU");
		await act(async () => button("Add string").click());
		const key = dom.container.querySelector<HTMLInputElement>(
			"#managed-source-key",
		);
		const source = dom.container.querySelector<HTMLTextAreaElement>(
			"#managed-source-text",
		);
		if (!key || !source) throw new Error("Missing source form");
		await type(key, "new_line");
		await type(source, "Keep {braces} literal");
		const beforeUnload = new dom.window.Event("beforeunload", {
			cancelable: true,
		});
		dom.window.dispatchEvent(beforeUnload);
		expect(beforeUnload.defaultPrevented).toBe(true);
		pendingCreate = Promise.withResolvers<string>();
		await act(async () => {
			source
				.closest("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(source.closest("fieldset")?.disabled).toBe(true);
		expect(button("Add string").disabled).toBe(true);
		expect(button("Languages").disabled).toBe(true);
		await act(async () => {
			pendingCreate?.resolve("new_line");
		});
		pendingCreate = undefined;
		expect(searches.at(-1)).toEqual({
			collection: "marketing",
			key: "new_line",
			locales: undefined,
		});
		const savedUnload = new dom.window.Event("beforeunload", {
			cancelable: true,
		});
		dom.window.dispatchEvent(savedUnload);
		expect(savedUnload.defaultPrevented).toBe(false);

		expect(calls.at(-1)).toEqual({
			name: "managedContent:createMessage",
			args: {
				projectId: "project",
				collectionId: "marketing",
				key: "new_line",
				sourceValue: "Keep {braces} literal",
				context: "",
			},
		});
		await act(async () => button("Languages").click());
		const code = dom.container.querySelector<HTMLInputElement>(
			'[aria-label="New language code"]',
		);
		const label = dom.container.querySelector<HTMLInputElement>(
			'[aria-label="New language name"]',
		);
		if (!code || !label) throw new Error("Missing language form");
		await type(code, "de");
		await type(label, "German");
		const languageUnload = new dom.window.Event("beforeunload", {
			cancelable: true,
		});
		dom.window.dispatchEvent(languageUnload);
		expect(languageUnload.defaultPrevented).toBe(true);
		await act(async () => button("Add language").click());
		await act(async () => button("Save languages").click());
		expect(calls.at(-1)).toEqual({
			name: "contentCollections:setLocales",
			args: {
				projectId: "project",
				collectionId: "marketing",
				localeIds: ["fr-id", "de-id"],
				expectedMembershipRevision: 1,
			},
		});
		const previousClipboard = Object.getOwnPropertyDescriptor(
			navigator,
			"clipboard",
		);
		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied = text;
				},
			},
		});
		try {
			await act(async () => button("Copy JSON").click());
			expect(calls.at(-1)).toEqual({
				name: "managedContent:exportSelection",
				args: {
					projectId: "project",
					collectionId: "marketing",
					messageIds: ["subtitle"],
					localeIds: ["fr-id"],
					mode: "reviewed",
				},
			});
			expect(copied).toContain("Construire");
			expect(dom.container.textContent).toContain("0 values omitted");
		} finally {
			if (previousClipboard)
				Object.defineProperty(navigator, "clipboard", previousClipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
	test("All languages hydrate through bounded splits without a render loop", async () => {
		const targets = Array.from({ length: 21 }, (_, index) => ({
			_id: `locale-${index}`,
			code: `l${index}`,
			label: `Language ${index}`,
			isSource: false,
		}));
		const many: Record<string, unknown> = {
			...results,
			"locales:list": [
				{ _id: "en-id", code: "en", label: "English", isSource: true },
				...targets,
			],
			"contentCollections:get": {
				id: "marketing",
				name: "Store listings",
				localeIds: targets.map((locale) => locale._id),
				membershipRevision: 1,
			},
		};
		const seen: number[] = [];
		watch.mockImplementation((query, args) => {
			const name = getFunctionName(query);
			const ids: string[] = Array.isArray(args.localeIds)
				? args.localeIds.map(String)
				: [];
			const result =
				name === "managedContent:context"
					? {
							items: ids.map((id) => ({
								messageId: "subtitle",
								localeId: id,
								localeCode:
									targets.find((locale) => locale._id === id)?.code ?? id,
								value: `Translation ${id}`,
								valueState: "settled",
								intentionalBlank: null,
								basis: { ...basis, targetRevision: 1 },
							})),
						}
					: many[name];
			if (name === "managedContent:context") seen.push(ids.length);
			return {
				onUpdate: () => () => {},
				localQueryResult: () => {
					if (name === "managedContent:context" && ids.length > 2)
						throw new ConvexError({ code: "LIMIT_EXCEEDED" });
					return result as never;
				},
				localQueryLogs: () => [],
				journal: () => undefined,
			};
		});
		const root = createRootRoute({
			component: () => (
				<ConvexProvider client={client}>
					<ManagedStrings
						projectId="project"
						collectionId="marketing"
						search={{ collection: "marketing" }}
						onSearch={() => {}}
					/>
				</ConvexProvider>
			),
		});
		const router = createRouter({
			routeTree: root,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		await dom.render(<RouterProvider router={router} />);
		expect(seen.some((size) => size > 2)).toBe(true);
		expect(seen.every((size) => size <= 4)).toBe(true);
		expect(
			dom.container.querySelectorAll('[data-workspace-message-id="subtitle"]'),
		).toHaveLength(22);
		expect(dom.container.textContent).not.toContain("Loading languages");
	});
});
