import { beforeAll, expect, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { convexId } from "@/lib/convex-api";
import { createDomTest } from "@/test/dom";
import type { DiscoveredCatalogFiles as View } from "./discovered-catalogs";

const dom = createDomTest();
let DiscoveredCatalogFiles: typeof View;
beforeAll(async () => {
	({ DiscoveredCatalogFiles } = await import("./discovered-catalogs"));
});
const file: ComponentProps<typeof View>["files"][number] = {
	id: convexId<"sourceSnapshotUnboundFiles">("file-fr"),
	catalogPath: "lib/l10n/intl_fr.arb",
	declaredLocaleCode: "fr",
	messageCount: 23,
	suggestedCode: "fr",
	suggestedLabel: "",
	existingLocaleId: null,
	issue: null,
};

test("prefills the declared language, submits its exact file, and keeps errors retryable", async () => {
	const added: string[] = [];
	await dom.render(
		<DiscoveredCatalogFiles
			files={[file]}
			canEdit
			onAdd={async (selected, code, label) => {
				added.push(`${selected.catalogPath}:${code}:${label}`);
				throw new Error("The accepted catalog changed. Review and retry.");
			}}
		/>,
	);
	expect(dom.container.textContent).toContain("lib/l10n/intl_fr.arb");
	expect(dom.container.textContent).toContain("23 messages");
	const inputs = dom.container.querySelectorAll<HTMLInputElement>("input");
	expect(inputs[0]?.value).toBe("fr");
	expect(inputs[0]?.readOnly).toBe(true);
	expect(inputs[1]?.value).toBe("French");
	await act(async () => {
		dom.container.querySelector("button")?.click();
	});
	expect(added).toEqual(["lib/l10n/intl_fr.arb:fr:French"]);
	expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
		"accepted catalog changed",
	);
	expect(dom.container.querySelector("button")?.disabled).toBe(false);
});

test("requires a language when no declaration or configuration supplies one", async () => {
	await dom.render(
		<DiscoveredCatalogFiles
			files={[{ ...file, declaredLocaleCode: null, suggestedCode: "" }]}
			canEdit
			onAdd={async () => {}}
		/>,
	);
	expect(dom.container.textContent).toContain("No @@locale declaration");
	expect(dom.container.querySelector("button")?.disabled).toBe(true);
	expect(dom.container.querySelector("input")?.readOnly).toBe(false);
});

test("shows conflicts and keeps viewer discovery read-only", async () => {
	await dom.render(
		<DiscoveredCatalogFiles
			files={[file]}
			canEdit={false}
			onAdd={async () => {}}
		/>,
	);
	expect(dom.container.textContent).toContain(
		"An editor can add this language",
	);
	expect(dom.container.querySelector("button")).toBeNull();
	await dom.render(
		<DiscoveredCatalogFiles
			files={[
				{ ...file, issue: "This language already uses intl_fr_old.arb." },
			]}
			canEdit
			onAdd={async () => {}}
		/>,
	);
	expect(dom.container.textContent).toContain("intl_fr_old.arb");
	expect(dom.container.querySelector("button")).toBeNull();
});
