export type CatalogWorkspaceValue = {
	/** The durable Locale identity is present whenever a Workspace value is editable. */
	localeId?: string;
	localeCode: string;
	isSource: boolean;
	value: string;
	materialized: boolean;
	/** Git's immutable value identity and the current local-head revision form
	 * the optimistic-concurrency token for a Catalog Workspace save. */
	gitValueFingerprint?: string;
	gitValueRevision?: number;
	workspaceRevision?: number;
	/** The source wording visible when this editable value was read. */
	expectedSourceFingerprint?: string;
	valueState?: "waiting" | "unconfirmedImport" | "stale" | "settled";
	/** When a confirmed target's Source Contract changed, this classifies the
	 * latest Git-authored source transition. Missing classification is treated
	 * conservatively as semantic by presentation code. */
	sourceChangeKind?: "semantic" | "cosmetic";
	intentionalBlankReason?: string;
	/** A durable Source Proposal sits beside Git's Source Contract until a later
	 * accepted Source Snapshot observes the same or different source wording. */
	sourceProposalStatus?: "pending" | "landed" | "superseded";
};

export type CatalogWorkspaceKey = {
	id: string;
	values: readonly CatalogWorkspaceValue[];
};

export type StringsCatalogKey = {
	id: string;
	source: CatalogWorkspaceValue;
	targets: readonly CatalogWorkspaceValue[];
};

/** The route carries this opaque compare-and-save input to the Catalog
 * Workspace. Presentation code never derives or alters its concurrency data. */
type CatalogWorkspaceValueIdentity = {
	messageId: string;
	localeId: string;
	expectedGitValueFingerprint: string;
	expectedGitValueRevision: number;
	expectedWorkspaceRevision: number;
	expectedSourceFingerprint: string;
};

/** The editor names only the user decision. The Catalog Workspace derives the
 * current text and provenance for confirmations and Intentional Blanks. */
type CatalogWorkspaceValueIntent =
	| { kind: "save"; value: string }
	| { kind: "confirm" }
	| { kind: "intentionalBlank"; reason: string };

export type CatalogWorkspaceCommit = CatalogWorkspaceValueIdentity & {
	intent: CatalogWorkspaceValueIntent;
};

/** The server returns the concurrency baseline produced by a commit. Keeping
 * this receipt local lets an editor become clean before Convex's subscription
 * round-trip paints the committed row back into the catalog. */
export type CatalogWorkspaceCommitReceipt = {
	workspaceRevision: number;
	sourceFingerprint: string;
};

export type CatalogWorkspaceDraftSource = {
	value: string;
	expectedSourceFingerprint: string;
	expectedGitValueFingerprint: string;
	expectedGitValueRevision: number;
	expectedWorkspaceRevision: number;
};

/** A Catalog Workspace draft owns the full compare-and-save snapshot present
 * when its author first changes it. `isDirty` is explicit: comparing text with
 * a reactive server value would mistake another editor's Source Proposal for a
 * local edit. Reactive updates therefore refresh clean drafts, while dirty
 * snapshots conflict instead of being silently overwritten. */
export type CatalogWorkspaceDraft = CatalogWorkspaceDraftSource & {
	isDirty: boolean;
};

export function createCatalogWorkspaceDraft(
	source: CatalogWorkspaceDraftSource,
): CatalogWorkspaceDraft {
	return { ...source, isDirty: false };
}

export function refreshCatalogWorkspaceDraft(
	draft: CatalogWorkspaceDraft,
	source: CatalogWorkspaceDraftSource,
): CatalogWorkspaceDraft {
	return draft.isDirty ? draft : createCatalogWorkspaceDraft(source);
}

export function editCatalogWorkspaceDraft(input: {
	draft: CatalogWorkspaceDraft;
	source: CatalogWorkspaceDraftSource;
	value: string;
}): CatalogWorkspaceDraft {
	const snapshot = input.draft.isDirty
		? input.draft
		: createCatalogWorkspaceDraft(input.source);
	return {
		...snapshot,
		value: input.value,
		isDirty: input.value !== input.source.value,
	};
}

/** Shape one Baseline Catalog key for the Strings adapter. The projection
 * guarantees exactly one source value per key; rejecting a broken shape here
 * keeps a malformed read from looking like an editable catalog state. */
export function readStringsCatalogKey(
	key: CatalogWorkspaceKey,
): StringsCatalogKey {
	const sources = key.values.filter((value) => value.isSource);
	if (sources.length !== 1) {
		throw new Error(
			`The Baseline Catalog has ${sources.length} source values for ${key.id}.`,
		);
	}
	const [source] = sources;
	if (!source) {
		throw new Error(`The Baseline Catalog has no source value for ${key.id}.`);
	}
	return {
		id: key.id,
		source,
		targets: key.values.filter((value) => !value.isSource),
	};
}
