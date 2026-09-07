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

describe("Translation guidance editing", () => {
	test("gives viewers readable terms and voice without write controls", async () => {
		await dom.render(
			<TranslationGuidanceEditor {...props({ canEdit: false })} />,
		);
		expect(dom.container.textContent).toContain("Modell");
		expect(dom.container.textContent).toContain("Use informal address.");
		expect(dom.container.querySelector("button")).toBeNull();
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
		await click("Edit de voice guide");
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
		await click("Save voice guide");
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
		expect(button("Edit de voice guide").disabled).toBe(true);
		await click("Remove de voice guide");
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
