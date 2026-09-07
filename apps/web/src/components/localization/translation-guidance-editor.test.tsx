import { beforeAll, describe, expect, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import type { TranslationGuidanceEditor as Editor } from "./translation-guidance-editor";

const dom = createDomTest();
let TranslationGuidanceEditor: typeof Editor;
beforeAll(async () => {
	({ TranslationGuidanceEditor } = await import(
		"./translation-guidance-editor"
	));
});
type Props = ComponentProps<typeof Editor>;
const saved: Props["guidance"] = {
	revision: 2,
	projectGuide: {
		text: "Be clear, warm, and direct.",
		examples: [],
		revisionId: convexId<"translationGuidanceRevisions">("project-voice-1"),
		revision: 2,
		authoredBy: { kind: "user", id: "editor" },
		authoredAt: 2,
	},
	terms: [
		{
			term: {
				sourceTerm: "Build",
				definition: "A model assembled from bricks.",
				kind: "translated",
				renderings: [{ localeCode: "de", value: "Modell" }],
			},
			revisionId: convexId<"translationGuidanceRevisions">("term-1"),
			revision: 1,
			authoredBy: { kind: "user", id: "editor" },
			authoredAt: 1,
		},
	],
	guides: [
		{
			localeCode: "de",
			text: "Use informal address.",
			examples: [],
			revisionId: convexId<"translationGuidanceRevisions">("voice-1"),
			revision: 2,
			authoredBy: { kind: "user", id: "editor" },
			authoredAt: 2,
		},
	],
};
function props(overrides: Partial<Props> = {}): Props {
	return {
		guidance: saved,
		locales: [
			{ code: "de", label: "German" },
			{ code: "pt", label: "Portuguese" },
		],
		canEdit: true,
		onSaveTerm: async () => {},
		onRemoveTerm: async () => {},
		onSaveVoiceGuide: async () => {},
		onSaveProjectVoiceGuide: async () => {},
		...overrides,
	};
}
function button(label: string) {
	const found = [...dom.container.querySelectorAll("button")].find(
		(element) => element.textContent === label,
	);
	if (!found) throw new Error(`No button: ${label}`);
	return found;
}
async function click(label: string) {
	await act(async () => {
		button(label).click();
	});
}
function field(id: string) {
	const found = dom.container.querySelector<
		HTMLInputElement | HTMLTextAreaElement
	>(`#${id}`);
	if (!found) throw new Error(`No field: ${id}`);
	return found;
}
async function type(id: string, value: string) {
	const element = field(id);
	const prototype =
		element.tagName === "TEXTAREA"
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			element,
			value,
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function chooseLocale(id: string, code: string) {
	const trigger = dom.container.querySelector<HTMLButtonElement>(`#${id}`);
	if (!trigger) throw new Error(`No locale picker: ${id}`);
	await act(async () => {
		trigger.click();
	});
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find(
		(element) =>
			element.getAttribute("data-value") === code ||
			element.textContent?.includes(`(${code})`),
	);
	if (!option) throw new Error(`No locale option: ${code}`);
	await act(async () => {
		option.click();
	});
}

describe("Translation guidance editing", () => {
	test("keeps dozens of Locales compact and preserves renderings while switching the selected Locale", async () => {
		const requests: Parameters<Props["onSaveTerm"]>[0][] = [];
		const manyLocales = [
			...props().locales,
			...Array.from({ length: 48 }, (_, index) => ({
				code: `locale-${index}`,
				label: `Locale ${index}`,
			})),
		];
		await dom.render(
			<TranslationGuidanceEditor
				{...props({
					locales: manyLocales,
					onSaveTerm: async (input) => {
						requests.push(input);
					},
				})}
			/>,
		);
		expect(dom.container.querySelector("details")?.open).toBe(false);
		expect(dom.container.querySelectorAll("textarea").length).toBe(0);
		expect(dom.container.querySelectorAll("article").length).toBe(1);
		await click("Edit Build");
		expect(dom.container.querySelectorAll('input[id^="term-"]').length).toBe(1);
		await type("term-de", "Bauwerk");
		await chooseLocale("term-locale", "pt");
		await type("term-pt", "Modelo");
		await chooseLocale("term-locale", "de");
		expect(field("term-de").value).toBe("Bauwerk");
		await click("Save term");
		expect(requests[0]?.term).toMatchObject({
			renderings: [
				{ localeCode: "de", value: "Bauwerk" },
				{ localeCode: "pt", value: "Modelo" },
			],
		});
	});

	test("edits the project voice and a separate Locale add-on without losing stale project drafts", async () => {
		const globalRequests: Parameters<Props["onSaveProjectVoiceGuide"]>[0][] =
			[];
		const localeRequests: Parameters<Props["onSaveVoiceGuide"]>[0][] = [];
		const handlers = {
			onSaveProjectVoiceGuide: async (
				input: Parameters<Props["onSaveProjectVoiceGuide"]>[0],
			) => {
				globalRequests.push(input);
			},
			onSaveVoiceGuide: async (
				input: Parameters<Props["onSaveVoiceGuide"]>[0],
			) => {
				localeRequests.push(input);
			},
		};
		await dom.render(<TranslationGuidanceEditor {...props(handlers)} />);
		await click("Edit project voice guide");
		await type("voice-text", "Speak plainly to builders of every age.");
		await dom.render(
			<TranslationGuidanceEditor
				{...props({
					...handlers,
					guidance: {
						...saved,
						revision: 3,
						projectGuide: saved.projectGuide
							? { ...saved.projectGuide, text: "New shared voice." }
							: null,
					},
				})}
			/>,
		);
		expect(field("voice-text").value).toBe(
			"Speak plainly to builders of every age.",
		);
		expect(dom.container.textContent).toContain("New shared voice.");
		expect(button("Save project voice guide").disabled).toBe(true);
		await click("Keep my draft");
		await click("Save project voice guide");
		expect(globalRequests).toEqual([
			{
				expectedRevision: 3,
				text: "Speak plainly to builders of every age.",
				examples: [],
			},
		]);
		await chooseLocale("voice-locale", "pt");
		await click("Add pt add-on");
		await type("voice-text", "Use informal singular address.");
		await click("Save locale add-on");
		expect(localeRequests).toEqual([
			{
				expectedRevision: 3,
				localeCode: "pt",
				text: "Use informal singular address.",
				examples: [],
			},
		]);
	});

	test("gives viewers readable terms and voice without write controls", async () => {
		await dom.render(
			<TranslationGuidanceEditor {...props({ canEdit: false })} />,
		);
		expect(dom.container.textContent).toContain("Modell");
		expect(dom.container.textContent).toContain("Use informal address.");
		expect(dom.container.textContent).toContain("Be clear, warm, and direct.");
		expect(
			[...dom.container.querySelectorAll("button")].some((element) =>
				/^(Add|Edit|Remove)/.test(element.textContent ?? ""),
			),
		).toBe(false);
	});

	test("adding an existing trimmed term preserves the draft without overwriting its saved entry", async () => {
		const requests: Parameters<Props["onSaveTerm"]>[0][] = [];
		const onSaveTerm: Props["onSaveTerm"] = async (input) => {
			requests.push(input);
		};
		await dom.render(<TranslationGuidanceEditor {...props({ onSaveTerm })} />);
		await click("Add term");
		await type("guidance-term", " Build ");
		await type("guidance-definition", "A new definition.");
		await type("term-de", "Bauwerk");
		await click("Save term");
		expect(requests).toEqual([]);
		expect(field("guidance-definition").value).toBe("A new definition.");
		expect(dom.container.textContent).toContain(
			"already exists. Cancel this draft and use Edit Build",
		);
		expect(dom.container.textContent).toContain("Modell");
	});

	test("preserves term edits and original revision after a failed save, then requires deliberate conflict resolution", async () => {
		const requests: Parameters<Props["onSaveTerm"]>[0][] = [];
		let rejectSave = true;
		const savedTerm = saved.terms[0];
		if (!savedTerm) throw new Error("Expected saved term.");
		const onSaveTerm: Props["onSaveTerm"] = async (input) => {
			requests.push(input);
			if (rejectSave)
				throw new Error("Guidance changed. Review the current saved entry.");
		};
		await dom.render(<TranslationGuidanceEditor {...props({ onSaveTerm })} />);
		await click("Edit Build");
		await type("term-de", "Bauwerk");
		await click("Save term");
		expect(requests[0]).toMatchObject({
			expectedRevision: 2,
			term: { renderings: [{ localeCode: "de", value: "Bauwerk" }] },
		});
		expect(field("term-de").value).toBe("Bauwerk");
		expect(dom.container.textContent).toContain("Guidance changed. Review");
		await dom.render(
			<TranslationGuidanceEditor
				{...props({
					onSaveTerm,
					guidance: {
						...saved,
						revision: 3,
						terms: [
							{
								...savedTerm,
								term: {
									sourceTerm: "Build",
									definition: "Current saved meaning.",
									kind: "translated",
									renderings: [{ localeCode: "de", value: "Gebäude" }],
								},
							},
						],
					},
				})}
			/>,
		);
		expect(field("term-de").value).toBe("Bauwerk");
		expect(dom.container.textContent).toContain("Gebäude");
		expect(button("Save term").disabled).toBe(true);
		await click("Keep my draft");
		rejectSave = false;
		await click("Save term");
		expect(requests[1]).toMatchObject({
			expectedRevision: 3,
			term: { renderings: [{ localeCode: "de", value: "Bauwerk" }] },
		});
		expect(dom.container.querySelector("#term-de")).toBeNull();
	});

	test("saves voice examples as editable pairs and removes an archived guide deliberately", async () => {
		const requests: Parameters<Props["onSaveVoiceGuide"]>[0][] = [];
		const onSaveVoiceGuide: Props["onSaveVoiceGuide"] = async (input) => {
			requests.push(input);
		};
		await dom.render(
			<TranslationGuidanceEditor {...props({ onSaveVoiceGuide })} />,
		);
		await click("Edit de add-on");
		await type("voice-text", "Keep instructions short.");
		await click("Add example");
		const source = dom.container.querySelector<HTMLTextAreaElement>(
			'[id^="example-source-"]',
		);
		const target = dom.container.querySelector<HTMLTextAreaElement>(
			'[id^="example-target-"]',
		);
		if (!source || !target) throw new Error("Expected example fields.");
		await type(source.id, "Start building");
		await type(target.id, "Bau los");
		await click("Save locale add-on");
		expect(requests[0]).toEqual({
			expectedRevision: 2,
			localeCode: "de",
			text: "Keep instructions short.",
			examples: [{ source: "Start building", target: "Bau los" }],
		});
		await dom.render(
			<TranslationGuidanceEditor
				{...props({
					onSaveVoiceGuide,
					locales: [{ code: "de", active: false }],
				})}
			/>,
		);
		expect(button("Edit de add-on").disabled).toBe(true);
		await click("Remove de add-on");
		expect(requests[1]).toEqual({
			expectedRevision: 2,
			localeCode: "de",
			text: "",
			examples: [],
		});
	});

	test("does not submit an open draft after editor access is withdrawn", async () => {
		const requests: unknown[] = [];
		const onSaveTerm: Props["onSaveTerm"] = async (input) => {
			requests.push(input);
		};
		await dom.render(<TranslationGuidanceEditor {...props({ onSaveTerm })} />);
		await click("Edit Build");
		await type("term-de", "Bauwerk");
		await dom.render(
			<TranslationGuidanceEditor {...props({ onSaveTerm, canEdit: false })} />,
		);
		expect(button("Save term").disabled).toBe(true);
		await click("Save term");
		expect(requests).toEqual([]);
		expect(field("term-de").value).toBe("Bauwerk");
	});
});
