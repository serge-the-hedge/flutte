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

describe("Basic project workflow", () => {
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
			if (getFunctionName(query) === "managedContent:page")
				return results["managedContent:page"];
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
			(button) =>
				(button.getAttribute("aria-label") ?? button.textContent) === text,
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
							collection: undefined,
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
		expect(
			dom.container.querySelector('nav[aria-label="Catalog scopes"]'),
		).toBeNull();
		const source =
			dom.container.querySelector<HTMLTextAreaElement>("#new-string-text");
		if (!source) throw new Error("Missing composer");
		await type(source, "Keep {braces} literal");
		const name =
			dom.container.querySelector<HTMLInputElement>("#new-string-name");
		if (!name) throw new Error("Missing composer details");
		await type(name, "App Store subtitle");
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
		expect(button("Saving…").disabled).toBe(true);
		await act(async () => {
			pendingCreate?.resolve("new_line");
		});
		pendingCreate = undefined;
		expect(searches).toEqual([]);
		expect(source.value).toBe("");
		expect(document.activeElement).toBe(source);
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
				name: "App Store subtitle",
				sourceValue: "Keep {braces} literal",
				context: "",
				translations: [],
			},
		});
		await act(async () => button("Languages").click());
		const code = dom.container.querySelector<HTMLInputElement>(
			'section[aria-label="Project languages"] input[list]',
		);
		const label = dom.container.querySelector<HTMLInputElement>(
			'section[aria-label="Project languages"] input:not([list])',
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
		expect(calls.at(-1)).toEqual({
			name: "contentCollections:addLocale",
			args: {
				projectId: "project",
				collectionId: "marketing",
				code: "de",
				label: "German",
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

	test("retains an active composer when project membership becomes read-only", async () => {
		const listeners = new Set<() => void>();
		watch.mockImplementation((query, _args) => ({
			onUpdate: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			localQueryResult: () => results[getFunctionName(query)] as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}));
		const root = createRootRoute({
			component: () => (
				<ConvexProvider client={client}>
					<ManagedStrings
						projectId="project"
						collectionId="marketing"
						search={{}}
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
		const source =
			dom.container.querySelector<HTMLTextAreaElement>("#new-string-text");
		if (!source) throw new Error("Composer missing");
		await type(source, "Keep this source");
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[data-composer-locale-id="fr-id"]',
		);
		if (!target) throw new Error("Translation missing");
		await type(target, "Conserver");
		await act(async () => button("Languages").click());
		const original = results["projects:get"];
		try {
			results["projects:get"] = {
				name: "Brickit",
				role: "viewer",
				sourceLocale: { _id: "en-id", code: "en" },
			};
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(dom.container.querySelector("#new-string-text")).toBe(source);
			expect(source.value).toBe("Keep this source");
			expect(source.readOnly).toBe(true);
			expect(target.value).toBe("Conserver");
			expect(target.readOnly).toBe(true);
			expect(
				dom.container.querySelector<HTMLInputElement>(
					'section[aria-label="Project languages"] input[list]',
				)?.disabled,
			).toBe(true);
		} finally {
			results["projects:get"] = original;
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
		const pageLimits: number[] = [];
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
			if (name === "managedContent:page") pageLimits.push(Number(args.limit));
			return {
				onUpdate: () => () => {},
				localQueryResult: () => {
					if (name === "managedContent:page" && Number(args.limit) > 2)
						throw new ConvexError({ code: "LIMIT_EXCEEDED" });
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
						search={{}}
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
		expect([...new Set(pageLimits)]).toEqual([16, 8, 4, 2]);
		expect(seen.every((size) => size <= 4)).toBe(true);
		expect(
			dom.container.querySelectorAll('[data-workspace-message-id="subtitle"]'),
		).toHaveLength(22);
		expect(dom.container.textContent).not.toContain("Loading languages");
	});
	test("exports every matching tagged string across pages without duplicating overlaps", async () => {
		const previousPage = results["managedContent:page"];
		const previousTags = results["messageTags:list"];
		results["messageTags:list"] = {
			items: [
				{ id: "app-store", name: "App Store" },
				{ id: "play", name: "Google Play" },
			],
			revision: 7,
		};
		results["managedContent:page"] = {
			items: [
				{
					messageId: "subtitle",
					sourceValue: "Build",
					sourceRevision: 1,
					sourceFingerprint: "source",
				},
			],
			nextCursor: "second-page",
			tagRevision: 7,
		};
		watch.mockImplementation((query, args) => ({
			onUpdate: () => () => {},
			localQueryResult: () =>
				(getFunctionName(query) === "managedContent:page" &&
				args.cursor !== "second-page"
					? { items: [], nextCursor: "second-page", tagRevision: 7 }
					: results[getFunctionName(query)]) as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}));
		let firstRead = true;
		exportQuery.mockImplementation(async (query, args) => {
			if (getFunctionName(query) === "managedContent:page" && firstRead) {
				firstRead = false;
				throw new ConvexError({
					code: "LIMIT_EXCEEDED",
					message: "Smaller page required",
				});
			}
			if (
				getFunctionName(query) === "managedContent:page" &&
				!(args as { cursor?: string }).cursor
			)
				return results["managedContent:page"];
			if (getFunctionName(query) === "managedContent:page")
				return {
					items: [
						{
							messageId: "description",
							sourceValue: "Describe",
							sourceRevision: 1,
							sourceFingerprint: "source",
						},
					],
					nextCursor: null,
					tagRevision: 7,
				};
			const ids = (args as { messageIds: string[] }).messageIds;
			const values: Record<string, Record<string, string>> = {};
			for (const id of ids)
				values[id] = {
					fr: id === "subtitle" ? "Construire" : "Description complète",
				};
			const document = {
				names: { subtitle: null, description: null },
				collectionId: "marketing",
				mode: "reviewed",
				values,
				omitted: [],
				evidence: [],
			};
			return {
				text: JSON.stringify(document),
				document: {
					...document,
					names: Object.entries(document.names).map(([messageId, name]) => ({
						messageId,
						name,
					})),
					values: Object.entries(document.values).map(
						([messageId, values]) => ({
							messageId,
							values: Object.entries(values).map(([localeCode, value]) => ({
								localeCode,
								value,
							})),
						}),
					),
				},
				omitted: [],
				mode: "reviewed",
			};
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
			const root = createRootRoute({
				component: () => (
					<ConvexProvider client={client}>
						<ManagedStrings
							projectId="project"
							collectionId="marketing"
							search={{ tags: ["app-store", "play"], cursor: "later-page" }}
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
			expect(
				dom.container.querySelector('[data-workspace-message-id="subtitle"]'),
			).not.toBeNull();
			await act(async () => button("Copy JSON").click());
			expect(JSON.parse(copied).values).toEqual({
				subtitle: { fr: "Construire" },
				description: { fr: "Description complète" },
			});
			expect(dom.container.textContent).toContain("2 strings");
		} finally {
			results["managedContent:page"] = previousPage;
			results["messageTags:list"] = previousTags;
			if (previousClipboard)
				Object.defineProperty(navigator, "clipboard", previousClipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
	test("a later export failure never copies an incomplete group", async () => {
		const previousPage = results["managedContent:page"];
		const entries = Array.from({ length: 33 }, (_, index) => ({
			messageId: `key-${index}`,
			sourceValue: "Source",
			sourceRevision: 1,
			sourceFingerprint: "source",
		}));
		results["managedContent:page"] = {
			items: entries.slice(0, 16),
			nextCursor: "remainder",
		};
		watch.mockImplementation((query, _args) => ({
			onUpdate: () => () => {},
			localQueryResult: () => results[getFunctionName(query)] as never,
			localQueryLogs: () => [],
			journal: () => undefined,
		}));
		exportQuery.mockImplementation(async (query, args) => {
			if (getFunctionName(query) === "managedContent:page")
				return { items: entries.slice(16), nextCursor: null };
			if ((args as { messageIds: string[] }).messageIds.includes("key-32"))
				throw new Error("Review the remaining translation before exporting.");
			const document = {
				names: {},
				collectionId: "marketing",
				mode: "reviewed",
				values: {},
				omitted: [],
				evidence: [],
			};
			return {
				text: JSON.stringify(document),
				document: {
					...document,
					names: Object.entries(document.names).map(([messageId, name]) => ({
						messageId,
						name,
					})),
					values: Object.entries(document.values).map(
						([messageId, values]) => ({
							messageId,
							values: Object.entries(values).map(([localeCode, value]) => ({
								localeCode,
								value,
							})),
						}),
					),
				},
				omitted: [],
				mode: "reviewed",
			};
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
			const root = createRootRoute({
				component: () => (
					<ConvexProvider client={client}>
						<ManagedStrings
							projectId="project"
							collectionId="marketing"
							search={{}}
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
			await act(async () => button("Copy JSON").click());
			expect(dom.container.textContent).toContain(
				"Review the remaining translation before exporting.",
			);
			expect(copied).toBe("");
		} finally {
			results["managedContent:page"] = previousPage;
			if (previousClipboard)
				Object.defineProperty(navigator, "clipboard", previousClipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
});
