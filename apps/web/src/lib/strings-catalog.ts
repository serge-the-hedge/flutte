export type RepositoryEditBasis = {
	kind: "repository";
	expectedGitValueFingerprint: string;
	expectedGitValueRevision: number;
	expectedWorkspaceRevision: number;
	expectedSourceFingerprint: string;
};
export type ManagedEditBasis = {
	kind: "managed";
	collectionId: string;
	sourceRevision: number;
	targetRevision: number;
	sourceFingerprint: string;
	membershipRevision: number;
};
export type ManagedSourceEditBasis = {
	kind: "managedSource";
	collectionId: string;
	sourceRevision: number;
	sourceFingerprint: string;
	membershipRevision: number;
};
export type CatalogEditBasis =
	| RepositoryEditBasis
	| ManagedEditBasis
	| ManagedSourceEditBasis;

export type CatalogWorkspaceValue = {
	/** The durable Locale identity is present whenever a Workspace value is editable. */
	localeId?: string;
	editBasis?: CatalogEditBasis;
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
	characterLimit?: number;
	id: string;
	values: readonly CatalogWorkspaceValue[];
};

export type StringsCatalogKey = {
	characterLimit?: number;
	id: string;
	/** Undefined keeps repository key labels; null is an unnamed Basic string. */
	name?: string | null;
	context?: string;
	source: CatalogWorkspaceValue;
	targets: readonly CatalogWorkspaceValue[];
};

/** Unnamed Basic content has no headline; its source supplies accessible control labels. */
export function stringDisplayName({
	id,
	name,
	sourceValue,
}: {
	id: string;
	name?: string | null;
	sourceValue: string;
}) {
	const title = name === undefined ? id : name;
	const preview =
		name === null
			? sourceValue.slice(0, 160).replace(/\s+/g, " ").trim().slice(0, 100)
			: "";
	return { title, label: title ?? (preview || "String") };
}

/** The route carries this opaque compare-and-save input to the Catalog
 * Workspace. Presentation code never derives or alters its concurrency data. */
type CatalogWorkspaceValueIdentity = {
	messageId: string;
	localeId: string;
	basis: CatalogEditBasis;
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
export type CatalogWorkspaceCommitReceipt = { basis: CatalogEditBasis };

export type CatalogWorkspaceDraftSource = {
	value: string;
	basis: CatalogEditBasis;
};

export function catalogValueEditBasis(
	value: CatalogWorkspaceValue,
): CatalogEditBasis | undefined {
	if (value.editBasis) return value.editBasis;
	if (
		value.gitValueFingerprint === undefined ||
		value.gitValueRevision === undefined ||
		value.workspaceRevision === undefined ||
		value.expectedSourceFingerprint === undefined
	)
		return undefined;
	return {
		kind: "repository",
		expectedGitValueFingerprint: value.gitValueFingerprint,
		expectedGitValueRevision: value.gitValueRevision,
		expectedWorkspaceRevision: value.workspaceRevision,
		expectedSourceFingerprint: value.expectedSourceFingerprint,
	};
}

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
		characterLimit: key.characterLimit,
		source,
		targets: key.values.filter((value) => !value.isSource),
	};
}
