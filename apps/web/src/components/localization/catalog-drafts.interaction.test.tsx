import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps, StrictMode, useState } from "react";
import type { Root } from "react-dom/client";
import type {
	CatalogWorkspaceCommit,
	CatalogWorkspaceCommitReceipt,
} from "@/lib/strings-catalog";
import type { StringsCatalogView as View } from "./strings-catalog-view";

type Props = ComponentProps<typeof View>;
const dom = new Window({ url: "http://localhost" });
const globals = {
	window: dom,
	scrollTo: dom.scrollTo.bind(dom),
	document: dom.document,
	HTMLElement: dom.HTMLElement,
	Event: dom.Event,
	KeyboardEvent: dom.KeyboardEvent,
	MouseEvent: dom.MouseEvent,
	HTMLInputElement: dom.HTMLInputElement,
	HTMLTextAreaElement: dom.HTMLTextAreaElement,
	Element: dom.Element,
	Node: dom.Node,
	getComputedStyle: dom.getComputedStyle.bind(dom),
	ResizeObserver: dom.ResizeObserver,
	requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
	cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
	IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let container: HTMLDivElement;
let StringsCatalogView: typeof View;
let createRoot: typeof import("react-dom/client").createRoot;
const noop = () => {};

beforeAll(async () => {
	for (const [name, value] of Object.entries(globals)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value,
		});
	}
	// Install the DOM before React initializes its event support.
	({ createRoot } = await import("react-dom/client"));
	({ StringsCatalogView } = await import("./strings-catalog-view"));
});
afterAll(() => {
	for (const [name, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	void dom.happyDOM.close();
});
beforeEach(() => {
	container = document.createElement("div");
	container.style.overflowY = "auto";
	Object.defineProperties(container, {
		offsetHeight: { value: 800 },
		offsetWidth: { value: 1000 },
	});
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function props({
	query = "",
	value = "Bienvenue",
	revision = 0,
	projectionId = "baseline-1",
	sourceFingerprint = "source-1",
	gitFingerprint = "git-1",
	messageIds = ["welcome", "other"],
	onCommitValue = async () => ({
		workspaceRevision: 1,
		sourceFingerprint: "source-1",
	}),
}: {
	query?: string;
	value?: string;
	revision?: number;
	projectionId?: string;
	sourceFingerprint?: string;
	gitFingerprint?: string;
	messageIds?: string[];
	onCommitValue?: Props["onCommitValue"];
} = {}): Props {
	return {
		navigationState: { query },
		onNavigationChange: noop,
		onConnectCheckout: noop,
		onWindowMessageIdsChange: noop,
		onCommitValue,
		navigation: {
			kind: "ready",
			projectionId,
			canEdit: true,
			keys: messageIds.map((messageId, index) => ({
				messageId,
				catalogIndex: index,
				introductionReviewPending: 0,
				searchCorpus: [messageId],
				source: { localeId: "en", gitValueFingerprint: sourceFingerprint },
				targets: [
					{
						localeId: "fr",
						localeCode: "fr",
						valueState: "waiting",
						touched: false,
						confirmedGitContent: false,
						confirmedContentPreviously: false,
						firstReviewPending: false,
						gitValueFingerprint: gitFingerprint,
					},
				],
			})),
		},
		hydratedCards: new Map(
			messageIds.map((id) => [
				id,
				{
					id,
					source: {
						localeCode: "en",
						isSource: true,
						value: "Welcome",
						materialized: false,
					},
					targets: [
						{
							localeId: "fr",
							localeCode: "fr",
							isSource: false,
							value,
							materialized: false,
							gitValueFingerprint: gitFingerprint,
							gitValueRevision: 0,
							workspaceRevision: revision,
							expectedSourceFingerprint: sourceFingerprint,
							valueState: "waiting",
						},
					],
				},
			]),
		),
	};
}
async function render(next: Props, project = "project-1") {
	await act(async () => {
		root.render(
			<StrictMode>
				<StringsCatalogView key={project} {...next} />
			</StrictMode>,
		);
	});
}
function field(messageId = "welcome") {
	const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`[data-workspace-message-id="${messageId}"]`,
	);
	if (!input)
		throw new Error(
			`No editor for ${messageId}: ${container.innerHTML.slice(-1500)}`,
		);
	return input;
}
async function type(value: string, input = field()) {
	const prototype =
		input.tagName === "TEXTAREA"
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			input,
			value,
		);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function commit(input = field()) {
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				ctrlKey: true,
				bubbles: true,
			}),
		);
	});
}

describe("Catalog editor draft lifecycle", () => {
	test("retains filtered-out text and its original concurrency basis across Baseline remounts", async () => {
		const commits: CatalogWorkspaceCommit[] = [];
		const onCommitValue: NonNullable<Props["onCommitValue"]> = async (
			input,
		) => {
			commits.push(input);
			return { workspaceRevision: 3, sourceFingerprint: "source-1" };
		};
		await render(props({ onCommitValue }));
		await type("Mon brouillon");
		await render({ ...props({ onCommitValue }), navigation: undefined });
		await render(props({ onCommitValue }));
		expect(field().value).toBe("Mon brouillon");
		await render(props({ query: "other", onCommitValue }));
		expect(
			container.querySelector('[data-workspace-message-id="welcome"]'),
		).toBeNull();
		await render(
			props({
				value: "Someone else’s edit",
				sourceFingerprint: "source-2",
				gitFingerprint: "git-2",
				revision: 2,
				projectionId: "baseline-2",
				onCommitValue,
			}),
		);
		expect(field().value).toBe("Mon brouillon");
		await commit();
		expect(commits).toHaveLength(1);
		expect(commits[0]).toMatchObject({
			expectedWorkspaceRevision: 0,
			expectedGitValueFingerprint: "git-1",
			expectedGitValueRevision: 0,
			expectedSourceFingerprint: "source-1",
			intent: { kind: "save", value: "Mon brouillon" },
		});
	});

	test("keeps a pending save disabled after remount and exposes its failure without dropping the draft", async () => {
		const request = Promise.withResolvers<CatalogWorkspaceCommitReceipt>();
		let calls = 0;
		const onCommitValue = () => {
			calls++;
			return request.promise;
		};
		await render(props({ onCommitValue }));
		await type("Keep this");
		await commit();
		await render(props({ query: "other", onCommitValue }));
		await render(props({ onCommitValue }));
		expect(field().disabled).toBe(true);
		await commit();
		expect(calls).toBe(1);
		await act(async () =>
			request.reject(new Error("Workspace changed; reload before saving.")),
		);
		expect(field().disabled).toBe(false);
		expect(field().value).toBe("Keep this");
		expect(container.textContent).toContain(
			"Workspace changed; reload before saving.",
		);
		await render(props({ query: "other", onCommitValue }));
		await render(props({ onCommitValue }));
		expect(field().value).toBe("Keep this");
		expect(container.textContent).toContain(
			"Workspace changed; reload before saving.",
		);
	});

	test("keeps a successful offscreen save until the subscription catches up, then releases a clean draft", async () => {
		const request = Promise.withResolvers<CatalogWorkspaceCommitReceipt>();
		const onCommitValue = () => request.promise;
		await render(props({ onCommitValue }));
		await type("Saved offscreen");
		await commit();
		await render(props({ query: "other", onCommitValue }));
		await act(async () =>
			request.resolve({ workspaceRevision: 1, sourceFingerprint: "source-1" }),
		);
		await render(props({ onCommitValue }));
		expect(field().value).toBe("Saved offscreen");
		await act(async () => {
			field().dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(field().value).toBe("Saved offscreen");
		await render(
			props({ value: "Saved offscreen", revision: 1, onCommitValue }),
		);
		await render(
			props({
				query: "other",
				value: "Saved offscreen",
				revision: 1,
				onCommitValue,
			}),
		);
		await render(
			props({ value: "New server text", revision: 2, onCommitValue }),
		);
		expect(field().value).toBe("New server text");
	});

	test("retains a deliberate-blank reason and basis through remounts and a failed save", async () => {
		const commits: CatalogWorkspaceCommit[] = [];
		const onCommitValue: NonNullable<Props["onCommitValue"]> = async (
			input,
		) => {
			commits.push(input);
			throw new Error("Workspace changed.");
		};
		await render(props({ onCommitValue }));
		await type("");
		const blankButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "deliberately empty",
		);
		if (!blankButton) throw new Error("Missing deliberate blank action");
		await act(async () => {
			blankButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		const reason = () => {
			const input = container.querySelector<HTMLInputElement>(
				'input[placeholder="Why should this render nothing?"]',
			);
			if (!input) throw new Error("Missing blank reason editor");
			return input;
		};
		await type("No label is needed here", reason());
		await render(props({ query: "other", onCommitValue }));
		await render(
			props({ value: "Concurrent wording", revision: 2, onCommitValue }),
		);
		expect(reason().value).toBe("No label is needed here");
		await act(async () => {
			reason().dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(commits[0]).toMatchObject({
			expectedWorkspaceRevision: 0,
			intent: { kind: "intentionalBlank", reason: "No label is needed here" },
		});
		expect(reason().value).toBe("No label is needed here");
		expect(field().value).toBe("");
		expect(container.textContent).toContain("Workspace changed.");
	});

	test("revert releases a draft and removed-key discard removes its unload warning", async () => {
		await render(props());
		await type("Throw away");
		await act(async () => {
			field().dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		await render(props({ query: "other" }));
		await render(props({ value: "Refreshed", revision: 2 }));
		expect(field().value).toBe("Refreshed");
		await type("Removed draft");
		await render(props({ messageIds: ["other"], projectionId: "baseline-2" }));
		const discard = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Discard edit",
		);
		if (!discard) throw new Error("Missing discard action");
		await act(async () => {
			discard.click();
		});
		expect(container.textContent).not.toContain(
			"Unsaved edits outside the current catalog",
		);
		const unload = new dom.Event("beforeunload", { cancelable: true });
		dom.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(false);
	});

	test("shows recoverable drafts when the author becomes a viewer", async () => {
		await render(props());
		await type("Before access changed");
		const next = props();
		await render({
			...next,
			navigation: { ...next.navigation, kind: "ready", canEdit: false },
		});
		expect(
			container.querySelector('[data-workspace-message-id="welcome"]'),
		).toBeNull();
		expect(container.textContent).toContain(
			"Unsaved edits you can no longer save",
		);
		expect(
			container.querySelector<HTMLTextAreaElement>(
				'[aria-label="Unsaved welcome fr"]',
			)?.value,
		).toBe("Before access changed");
		await render(props());
		expect(field().value).toBe("Before access changed");
	});

	test("allows filtering but requires confirmation before project or tab navigation", async () => {
		const {
			createRootRoute,
			createRoute,
			createRouter,
			createMemoryHistory,
			RouterProvider,
			Outlet,
		} = await import("@tanstack/react-router");
		const { useCatalogNavigationGuard } = await import(
			"@/lib/use-catalog-navigation-guard"
		);
		const rootRoute = createRootRoute({ component: Outlet });
		function GuardedStrings() {
			const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
			useCatalogNavigationGuard(hasUnsavedWork);
			const { projectId } = stringsRoute.useParams();
			const { q } = stringsRoute.useSearch();
			return (
				<StringsCatalogView
					key={projectId}
					{...props({ query: q })}
					onUnsavedWorkChange={setHasUnsavedWork}
				/>
			);
		}
		const stringsRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/projects/$projectId/strings",
			component: GuardedStrings,
			validateSearch: (search: Record<string, unknown>) => ({
				q: typeof search.q === "string" ? search.q : "",
			}),
		});
		const tasksRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/projects/$projectId/proposals",
			component: () => <p>Translation tasks</p>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([stringsRoute, tasksRoute]),
			history: createMemoryHistory({
				initialEntries: ["/projects/project-1/strings"],
			}),
		});
		await act(async () => {
			root.render(<RouterProvider router={router} />);
			await router.load();
		});
		await type("Stay with me");
		const originalConfirm = window.confirm;
		const confirmations: string[] = [];
		let allowLeaving = false;
		window.confirm = (message) => {
			confirmations.push(message ?? "");
			return allowLeaving;
		};
		try {
			await act(async () => {
				void router.navigate({
					to: "/projects/$projectId/strings",
					params: { projectId: "project-1" },
					search: { q: "other" },
				});
			});
			expect(confirmations).toHaveLength(0);
			await act(async () => {
				void router.navigate({
					to: "/projects/$projectId/strings",
					params: { projectId: "project-2" },
					search: { q: "" },
				});
			});
			expect(router.state.location.pathname).toBe(
				"/projects/project-1/strings",
			);
			expect(confirmations).toHaveLength(1);
			await act(async () => {
				void router.navigate({
					to: "/projects/$projectId/strings",
					params: { projectId: "project-1" },
					search: { q: "" },
				});
			});
			expect(field().value).toBe("Stay with me");
			allowLeaving = true;
			await act(async () => {
				void router.navigate({
					to: "/projects/$projectId/proposals",
					params: { projectId: "project-1" },
				});
			});
			expect(confirmations).toHaveLength(2);
			expect(container.textContent).toContain("Translation tasks");
		} finally {
			window.confirm = originalConfirm;
		}
	});

	test("keeps removed keys recoverable and isolates project changes", async () => {
		await render(props());
		await type("Rescue me");
		const unload = new dom.Event("beforeunload", { cancelable: true });
		dom.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);
		await render(props({ messageIds: ["other"], projectionId: "baseline-2" }));
		expect(container.textContent).toContain(
			"Unsaved edits outside the current catalog",
		);
		expect(
			container.querySelector<HTMLTextAreaElement>(
				'[aria-label="Unsaved welcome fr"]',
			)?.value,
		).toBe("Rescue me");
		await render(props(), "project-2");
		expect(field().value).toBe("Bienvenue");
		expect(container.textContent).not.toContain(
			"Unsaved edits outside the current catalog",
		);
	});
});
