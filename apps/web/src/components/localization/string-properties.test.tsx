import { afterAll, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { act } from "react";
import type { StringsCatalogKey } from "@/lib/strings-catalog";
import { createDomTest } from "@/test/dom";
import { ManagedStringProperties } from "./string-properties";

const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
let saved: unknown;
const mutation = spyOn(client, "mutation").mockImplementation(
	async (_ref, args) => {
		saved = args;
		return { sourceRevision: 3, sourceFingerprint: "updated" };
	},
);
afterAll(async () => {
	mutation.mockRestore();
	await client.close();
});
const noop = () => {};
test("clean properties follow source saves made in the same advanced view", async () => {
	const key: StringsCatalogKey = {
		id: "headline",
		name: "Headline",
		source: {
			localeId: "en",
			localeCode: "en",
			isSource: true,
			value: "Original",
			materialized: false,
			editBasis: {
				kind: "managedSource",
				collectionId: "store",
				sourceRevision: 1,
				sourceFingerprint: "original",
				membershipRevision: 1,
			},
		},
		targets: [],
	};
	const render = (catalogKey: StringsCatalogKey) =>
		dom.render(
			<ConvexProvider client={client}>
				<ManagedStringProperties
					projectId="project"
					collectionId="store"
					catalogKey={catalogKey}
					canEdit
					onDirtyChange={noop}
					onBusyChange={noop}
					onArchived={noop}
				/>
			</ConvexProvider>,
		);
	await render(key);
	await render({
		...key,
		source: {
			...key.source,
			value: "Updated source",
			editBasis: {
				kind: "managedSource",
				collectionId: "store",
				sourceRevision: 2,
				sourceFingerprint: "updated",
				membershipRevision: 1,
			},
		},
	});
	const input =
		dom.container.querySelector<HTMLInputElement>('input[id$="-name"]');
	if (!input) throw new Error("Missing name field");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, "Renamed");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		dom.container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	expect(saved).toMatchObject({
		sourceValue: "Updated source",
		name: "Renamed",
		expectedSourceRevision: 2,
	});
});
