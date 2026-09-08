import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { IcuMessageSegmentEditor } from "./icu-message-segment-editor";
import { StringsCatalogView } from "./strings-catalog-view";

const navigationProps = {
	navigationState: { query: "" },
	onNavigationChange: () => {},
	onConnectCheckout: () => {},
};

import type { StringsCatalogKey } from "@/lib/strings-catalog";
import type { StringsNavigationRead } from "@/lib/strings-catalog-navigation";
import { catalogWorkspaceCommitShortcut } from "@/lib/strings-catalog-presentation";
import {
	isCatalogWorkspaceFieldVisible,
	type StringsWindowCards,
} from "@/lib/strings-window";

/** A test Catalog fixture drives both sides of the windowed seam: the
 * compact Navigation digests and the hydrated card map a loaded Window
 * read would return. */
function windowedProps(catalog: {
	snapshotId?: string;
	canEdit?: boolean;
	valueStateCounts?: NonNullable<StringsNavigationRead["valueStateCounts"]>;
	introducedMessageIds?: ReadonlySet<string>;
	keys: readonly StringsCatalogKey[];
}): {
	navigation: StringsNavigationRead;
	hydratedCards: StringsWindowCards;
	onWindowMessageIdsChange: (messageIds: string[]) => void;
} {
	const keys = catalog.keys;
	return {
		navigation: {
			kind: "ready",
			projectionId: "test-projection",
			canEdit: catalog.canEdit ?? false,
			valueStateCounts: catalog.valueStateCounts,
			keys: keys.map((key, index) => ({
				messageId: key.id,
				catalogIndex: index,
				introductionReviewPending: catalog.introducedMessageIds?.has(key.id)
					? key.targets.length
					: 0,
				source: {
					localeId: key.source.localeId ?? key.source.localeCode,
					gitValueFingerprint: key.source.gitValueFingerprint ?? "source",
				},
				targets: key.targets.map((target) => ({
					localeId: target.localeId ?? target.localeCode,
					localeCode: target.localeCode,
					valueState: target.valueState ?? "settled",
					touched: true,
					confirmedGitContent: true,
					confirmedContentPreviously: true,
					firstReviewPending:
						catalog.introducedMessageIds?.has(key.id) ?? false,
					gitValueFingerprint: target.gitValueFingerprint,
				})),
			})),
		},
		hydratedCards: new Map(keys.map((key) => [key.id, key])),
		onWindowMessageIdsChange: () => {},
	};
}

describe("StringsCatalogView", () => {
	test("maps the editor shortcut to save, imported confirmation, or no-op", () => {
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: true,
				valueState: "waiting",
			}),
		).toBe("save");
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: false,
				valueState: "unconfirmedImport",
			}),
		).toBe("confirm");
		expect(
			catalogWorkspaceCommitShortcut({
				isDirty: false,
				valueState: "waiting",
			}),
		).toBe("none");
	});

	test("only scrolls a pending focus target when it is outside the viewport", () => {
		expect(
			isCatalogWorkspaceFieldVisible({
				fieldTop: 190,
				fieldBottom: 219,
				viewportTop: 0,
				viewportBottom: 751,
			}),
		).toBe(true);
		expect(
			isCatalogWorkspaceFieldVisible({
				fieldTop: 742,
				fieldBottom: 771,
				viewportTop: 0,
				viewportBottom: 751,
			}),
		).toBe(false);
	});

	test("explains when no Baseline Catalog has been published", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				navigation={{ kind: "noBaseline" }}
				hydratedCards={new Map()}
				onWindowMessageIdsChange={() => {}}
				{...navigationProps}
			/>,
		);

		expect(markup).toContain("No Baseline Catalog yet");
		expect(markup).toContain("accepted Baseline Snapshot");
	});

	test("lets an editor explicitly prepare an incomplete catalog index", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				navigation={{
					kind: "incomplete",
					canEdit: true,
					status: "missing",
					progress: {
						rowCount: 0,
						expectedRowCount: 1_434,
						byteLength: 0,
					},
				}}
				hydratedCards={new Map()}
				onWindowMessageIdsChange={() => {}}
				onStartNavigationBackfill={() => {}}
				{...navigationProps}
			/>,
		);

		expect(markup).toContain("Prepare this catalog for fast browsing");
		expect(markup).toContain("0 of 1,434 keys prepared");
		expect(markup).toContain("Prepare catalog");
	});

	test("explains incomplete catalog preparation to viewers", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				navigation={{
					kind: "incomplete",
					canEdit: false,
					status: "staging",
				}}
				hydratedCards={new Map()}
				onWindowMessageIdsChange={() => {}}
				{...navigationProps}
			/>,
		);

		expect(markup).toContain("An editor needs to finish this preparation");
		expect(markup).not.toContain("Resume preparation</button>");
	});

	test("shows automatic preparation as busy instead of asking for another click", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				navigation={{
					kind: "incomplete",
					canEdit: true,
					status: "staging",
					stepPending: true,
				}}
				hydratedCards={new Map()}
				onWindowMessageIdsChange={() => {}}
				onStartNavigationBackfill={() => {}}
				{...navigationProps}
			/>,
		);

		expect(markup).toContain("Preparing catalog");
		expect(markup).toContain("disabled");
		expect(markup).not.toContain("Resume preparation");
	});

	test("renders source and target values in Catalog Order", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...windowedProps({
					snapshotId: "baseline-snapshot",
					keys: [
						{
							id: "account_title",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Account",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "Konto",
									materialized: false,
								},
							],
						},
						{
							id: "billing_title",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Billing",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "",
									materialized: true,
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toMatch(/account_title[\s\S]*Account[\s\S]*Konto/);
		expect(markup).toMatch(/billing_title[\s\S]*Billing[\s\S]*No target value/);
		expect(markup.indexOf("account_title")).toBeLessThan(
			markup.indexOf("billing_title"),
		);
	});

	test("gives editors a subtle key-level Translation Task selector", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "account_title",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Account",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "Konto",
									materialized: false,
								},
							],
						},
					],
				})}
				onCreateTranslationTask={async () => {}}
			/>,
		);

		expect(markup).toContain(
			'aria-label="Add account_title to Translation Task"',
		);
	});

	test("distinguishes explicit empty values from materialized missing targets", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...windowedProps({
					keys: [
						{
							id: "blank_value",
							source: {
								localeCode: "en",
								isSource: true,
								value: "",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "",
									materialized: false,
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup.match(/Empty value/g) ?? []).toHaveLength(2);
		expect(markup).not.toContain("No target value");
	});

	test("mounts a catalog-card window instead of every loaded key", () => {
		const keyCount = 24;
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...windowedProps({
					keys: Array.from({ length: keyCount }, (_, index) => ({
						id: `key_${index}`,
						source: {
							localeCode: "en",
							isSource: true,
							value: `Source ${index}`,
							materialized: false,
						},
						targets: [],
					})),
				})}
			/>,
		);

		const mountedCardCount = (markup.match(/data-catalog-key=/g) ?? []).length;
		expect(mountedCardCount).toBeGreaterThan(0);
		expect(mountedCardCount).toBeLessThan(keyCount);
	});

	test("shows a removable search scope", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				navigationState={{ query: "account" }}
				{...windowedProps({
					keys: [
						{
							id: "account_title",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Account",
								materialized: false,
							},
							targets: [],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Search: account");
	});

	test("renders live Catalog Scopes as dismissible chips", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				navigationState={{ query: "", scope: "stale" }}
				{...windowedProps({
					valueStateCounts: {
						waiting: 1,
						unconfirmedImport: 1,
						stale: 1,
						settled: 0,
					},
					keys: [
						{
							id: "changed_copy",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Copy",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "Kopie",
									materialized: false,
									valueState: "stale",
									sourceChangeKind: "semantic",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Source changed ·");
		expect(markup).toContain('aria-label="Clear Source changed scope (1)"');
		expect(markup).toContain('aria-label="Show Waiting scope (1)"');
		expect(markup).toContain('aria-label="Show Unconfirmed scope (1)"');
	});

	test("marks populated post-bootstrap keys without replacing their value state", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...windowedProps({
					introducedMessageIds: new Set(["new_copy"]),
					valueStateCounts: {
						waiting: 0,
						unconfirmedImport: 1,
						stale: 0,
						settled: 0,
					},
					keys: [
						{
							id: "new_copy",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Draft source",
								materialized: false,
							},
							targets: [
								{
									localeCode: "de",
									isSource: false,
									value: "Platzhalter",
									materialized: false,
									valueState: "unconfirmedImport",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("New from Git · 1");
		expect(markup).toContain('aria-label="Show New from Git scope (1)"');
	});

	test("shows a removable Release work hand-off beside local scopes", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				workHandoff={{ keyCount: 12, onClear: () => {} }}
				{...windowedProps({
					valueStateCounts: {
						waiting: 0,
						unconfirmedImport: 0,
						stale: 0,
						settled: 1,
					},
					keys: [
						{
							id: "release_key",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Release",
								materialized: false,
							},
							targets: [],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Release work · 12");
		expect(markup).toContain('aria-label="Clear Release work hand-off"');
	});

	test("does not present a zero-key Release hand-off as an active scope", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				workHandoff={{ keyCount: 0, onClear: () => {} }}
				{...windowedProps({
					valueStateCounts: {
						waiting: 0,
						unconfirmedImport: 0,
						stale: 0,
						settled: 1,
					},
					keys: [
						{
							id: "ordinary_key",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Ordinary",
								materialized: false,
							},
							targets: [],
						},
					],
				})}
			/>,
		);

		expect(markup).not.toContain("Release work · 0");
		expect(markup).not.toContain('aria-label="Clear Release work hand-off"');
	});

	test("offers one guarded action for ordinary imported values", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onStartOrdinaryImportRun={() => {}}
				ordinaryImports={{
					policy: "ordinary-v1",
					total: 12,
					eligible: 7,
					empty: 1,
					sourceIdentical: 1,
					repeated: 2,
					modified: 0,
					stale: 1,
					alreadyConfirmed: 0,
					pendingSourceProposal: 0,
					introduced: 0,
					run: null,
				}}
				{...windowedProps({
					valueStateCounts: {
						waiting: 1,
						unconfirmedImport: 10,
						stale: 1,
						settled: 0,
					},
					keys: [
						{
							id: "copy",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Copy",
								materialized: false,
							},
							targets: [],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Confirm ordinary · 7");
	});

	test("keeps the ordinary-import explanation available when none qualify", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onStartOrdinaryImportRun={() => {}}
				ordinaryImports={{
					policy: "ordinary-v1",
					total: 2,
					eligible: 0,
					empty: 0,
					sourceIdentical: 0,
					repeated: 2,
					modified: 0,
					stale: 0,
					alreadyConfirmed: 0,
					pendingSourceProposal: 0,
					introduced: 0,
					run: null,
				}}
				{...windowedProps({
					valueStateCounts: {
						waiting: 0,
						unconfirmedImport: 2,
						stale: 0,
						settled: 0,
					},
					keys: [
						{
							id: "reviewed",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Reviewed",
								materialized: false,
							},
							targets: [],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Confirm ordinary · 0");
	});

	test("makes an editor's source proposal and target values live Catalog Workspace fields", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onCommitValue={async () => ({
					workspaceRevision: 0,
					sourceFingerprint: "source",
				})}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "greeting",
							source: {
								localeId: "locale-en",
								localeCode: "en",
								isSource: true,
								value: "Hello {name}",
								materialized: false,
								gitValueFingerprint: "git-en",
								gitValueRevision: 0,
								workspaceRevision: 0,
								expectedSourceFingerprint: "source-proposal",
								sourceProposalStatus: "pending",
							},
							targets: [
								{
									localeId: "locale-de",
									localeCode: "de",
									isSource: false,
									value: "Hallo {name}",
									materialized: false,
									gitValueFingerprint: "git-de",
									gitValueRevision: 0,
									workspaceRevision: 2,
									expectedSourceFingerprint: "source-proposal",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain('aria-label="Edit en value for greeting"');
		expect(markup).toContain('aria-label="Edit de value for greeting"');
		expect(markup.match(/<textarea/g) ?? []).toHaveLength(2);
		// English is a Locale, not a source panel: it is an ordinary editable row
		// whose asymmetry lives in its provenance rather than in a badge.
		expect(markup).not.toContain("Source Contract");
		expect(markup).not.toContain("Materialized");
	});

	test("a settled value says nothing and offers nothing at rest", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onCommitValue={async () => ({
					workspaceRevision: 0,
					sourceFingerprint: "source",
				})}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "greeting",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Hello",
								materialized: false,
							},
							targets: [
								{
									localeId: "locale-de",
									localeCode: "de",
									isSource: false,
									value: "Hallo",
									materialized: false,
									gitValueFingerprint: "git-de",
									gitValueRevision: 0,
									workspaceRevision: 1,
									expectedSourceFingerprint: "source-greeting",
									valueState: "settled",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain('aria-label="Edit de value for greeting"');
		// The key permalink is the only control on a fully settled key: no Save,
		// no Confirm, no Render nothing, no raw-ICU toggle.
		expect(markup).not.toContain('data-slot="button"');
		expect(markup).not.toContain("needs a value");
		expect(markup).not.toContain("⌘↵");
		expect(markup).not.toContain("waiting");
	});

	test("shows a pointer-accessible approval for an unconfirmed value", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onCommitValue={async () => ({
					workspaceRevision: 1,
					sourceFingerprint: "source-greeting",
				})}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "greeting",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Hello",
								materialized: false,
							},
							targets: [
								{
									localeId: "locale-de",
									localeCode: "de",
									isSource: false,
									value: "Hallo",
									materialized: false,
									gitValueFingerprint: "git-de",
									gitValueRevision: 0,
									workspaceRevision: 0,
									expectedSourceFingerprint: "source-greeting",
									valueState: "unconfirmedImport",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain("Approve");
		expect(markup).toContain("⌘↵ still correct");
	});

	test("renders compound ICU as a sentence with quiet arm affordances", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onCommitValue={async () => ({
					workspaceRevision: 0,
					sourceFingerprint: "source",
				})}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "task_summary",
							source: {
								localeId: "locale-en",
								localeCode: "en",
								isSource: true,
								value:
									"{count, plural, one{One task} other{{count} tasks}} {gender, select, male{His} other{Their}} list",
								materialized: false,
								gitValueFingerprint: "git-en",
								gitValueRevision: 0,
								workspaceRevision: 0,
								expectedSourceFingerprint: "source-en",
							},
							targets: [
								{
									localeId: "locale-ru",
									localeCode: "ru",
									isSource: false,
									value:
										"{count, plural, one{Одна задача} other{{count} задач}} {gender, select, male{Его} other{Их}} список",
									materialized: false,
									gitValueFingerprint: "git-ru",
									gitValueRevision: 0,
									workspaceRevision: 0,
									expectedSourceFingerprint: "source-en",
								},
							],
						},
					],
				})}
			/>,
		);

		expect(markup).toContain('aria-label="en representative for count"');
		expect(markup).toContain('aria-label="ru representative for count"');
		expect(markup).toContain('aria-label="Open select gender with 2 cases"');
		expect(markup).toContain("decoration-dotted");
		expect(markup).toContain('aria-label="Multi-arm ICU string"');
		// Arm details are available after focusing/opening the segment; they do
		// not turn every resting row into a stack of bordered cards.
		expect(markup).not.toContain("Representative Arm · Other");
		expect(markup).not.toContain('aria-label="Add plural arm for count"');
		expect(markup).not.toContain("rounded border bg-background");
		// The raw-ICU escape is available on every value, but like every other
		// control it arrives with focus rather than sitting on a settled row.
		expect(markup).not.toContain("Raw ICU");
	});

	test("collapses a plural whose cases are identical", () => {
		const markup = renderToStaticMarkup(
			<IcuMessageSegmentEditor
				messageId="same_tasks"
				localeId="locale-en"
				localeCode="en"
				value="{count, plural, one{Tasks} other{Tasks}}"
				disabled={false}
				canChangeStructure={false}
				onValueChange={() => {}}
				onKeyDown={() => {}}
				showRawToggle={false}
			/>,
		);

		expect(markup).toContain("same for every case");
		expect(markup).not.toContain(">One<");
		expect(markup).not.toContain(">Other<");
	});

	test("the raw ICU escape is offered on the value being worked", () => {
		const props = {
			messageId: "task_summary",
			localeId: "locale-ru",
			localeCode: "ru",
			value: "Одна задача",
			disabled: false,
			canChangeStructure: true,
			onValueChange: () => {},
			onKeyDown: () => {},
		};

		expect(
			renderToStaticMarkup(
				<IcuMessageSegmentEditor {...props} showRawToggle={false} />,
			),
		).not.toContain("Raw ICU");
		expect(
			renderToStaticMarkup(
				<IcuMessageSegmentEditor {...props} showRawToggle={true} />,
			),
		).toContain("Raw ICU");
	});

	test("shows target decision states and keyboard affordances", () => {
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				onCommitValue={async () => ({
					workspaceRevision: 0,
					sourceFingerprint: "source",
				})}
				{...windowedProps({
					canEdit: true,
					keys: [
						{
							id: "waiting_value",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Name",
								materialized: false,
							},
							targets: [
								{
									localeId: "locale-de",
									localeCode: "de",
									isSource: false,
									value: "",
									materialized: false,
									gitValueFingerprint: "git-waiting",
									gitValueRevision: 0,
									workspaceRevision: 0,
									expectedSourceFingerprint: "source-waiting",
									valueState: "waiting",
								},
							],
						},
						{
							id: "imported_value",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Welcome",
								materialized: false,
							},
							targets: [
								{
									localeId: "locale-fr",
									localeCode: "fr",
									isSource: false,
									value: "Bienvenue",
									materialized: false,
									gitValueFingerprint: "git-imported",
									gitValueRevision: 0,
									workspaceRevision: 0,
									expectedSourceFingerprint: "source-imported",
									valueState: "unconfirmedImport",
								},
							],
						},
						{
							id: "deliberate_blank",
							source: {
								localeCode: "en",
								isSource: true,
								value: "Optional label",
								materialized: false,
							},
							targets: [
								{
									localeId: "locale-es",
									localeCode: "es",
									isSource: false,
									value: "",
									materialized: false,
									gitValueFingerprint: "git-blank",
									gitValueRevision: 0,
									workspaceRevision: 1,
									expectedSourceFingerprint: "source-blank",
									valueState: "settled",
									intentionalBlankReason: "No Spanish label here",
								},
							],
						},
					],
				})}
			/>,
		);

		// Only the value still waiting on someone speaks, and it speaks once.
		expect(markup).toContain("needs a value");
		expect(markup.match(/needs a value/g) ?? []).toHaveLength(1);
		// An Unconfirmed Import is marked on its own rule, never styled as
		// missing and never captioned: until a catalog has been swept once
		// every key carries one, so a word here would fire on all of them.
		expect(markup).not.toContain("unconfirmed import");
		expect(markup).not.toContain("unconfirmed<");
		expect(markup).toContain("rounded bg-border");
		// Work that is genuinely waiting still speaks, once, in the header.
		expect(markup).toContain("1 waiting");
		// Nothing is charged for until a value has focus or a dirty draft.
		expect(markup).not.toContain("Render nothing");
		expect(markup).not.toContain(">Confirm<");
		expect(markup).toContain("Renders nothing — No Spanish label here");
		expect(markup).toContain(
			'aria-keyshortcuts="Meta+Enter Control+Enter Escape Tab"',
		);
	});
});

describe("StringsCatalogView window hydration", () => {
	const catalog = {
		keys: [
			{
				id: "account_title",
				source: {
					localeCode: "en",
					isSource: true,
					value: "Account settings",
					materialized: false,
				},
				targets: [],
			},
			{
				id: "billing_title",
				source: {
					localeCode: "en",
					isSource: true,
					value: "Billing settings",
					materialized: false,
				},
				targets: [],
			},
			{
				id: "checkout_title",
				source: {
					localeCode: "en",
					isSource: true,
					value: "Checkout settings",
					materialized: false,
				},
				targets: [],
			},
		],
	};

	test("keeps hydrated cards and estimates the rest as quiet placeholders", () => {
		const props = windowedProps(catalog);
		const partial = new Map([...props.hydratedCards].slice(0, 2));
		const markup = renderToStaticMarkup(
			<StringsCatalogView
				{...navigationProps}
				{...props}
				hydratedCards={partial}
			/>,
		);

		const rows = (markup.match(/data-catalog-key=/g) ?? []).length;
		expect(rows).toBe(3);
		const hydrated = (markup.match(/data-hydrated="true"/g) ?? []).length;
		expect(hydrated).toBe(2);
		expect(markup).toContain("Account settings");
		expect(markup).toContain('data-catalog-placeholder="true"');
		expect(markup).toContain('data-slot="skeleton"');
		expect(markup).not.toContain("h-72 w-full");
		expect(markup).not.toContain("Checkout settings");
	});
});
