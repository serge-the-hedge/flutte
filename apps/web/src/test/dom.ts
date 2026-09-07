import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

// React and Base UI cache browser capabilities across test modules. Reuse the
// document and global bindings, while each test gets its own disposable root.
const dom = new Window({ url: "http://localhost" });
const globals = {
	window: dom,
	document: dom.document,
	navigator: dom.navigator,
	scrollTo: dom.scrollTo.bind(dom),
	HTMLElement: dom.HTMLElement,
	Event: dom.Event,
	KeyboardEvent: dom.KeyboardEvent,
	MouseEvent: dom.MouseEvent,
	PointerEvent: dom.PointerEvent,
	FocusEvent: dom.FocusEvent,
	HTMLInputElement: dom.HTMLInputElement,
	HTMLTextAreaElement: dom.HTMLTextAreaElement,
	Element: dom.Element,
	Node: dom.Node,
	NodeFilter: dom.NodeFilter,
	getComputedStyle: dom.getComputedStyle.bind(dom),
	ResizeObserver: dom.ResizeObserver,
	MutationObserver: dom.MutationObserver,
	requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
	cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
	IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
}

/** A fresh React root for each interaction test; the web test runner preloads
 * this DOM before libraries cache browser capabilities during module import. */
export function createDomTest() {
	let root: Root;
	let container: HTMLDivElement;
	let createRoot: typeof import("react-dom/client").createRoot;
	beforeAll(async () => {
		({ createRoot } = await import("react-dom/client"));
	});
	afterAll(() => {
		void dom.happyDOM.cancelAsync();
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
	return {
		window: dom,
		get root() {
			return root;
		},
		get container() {
			return container;
		},
		async render(element: ReactNode) {
			await act(async () => root.render(element));
		},
	};
}
