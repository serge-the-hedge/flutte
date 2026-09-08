import type { CatalogWorkspaceValue } from "./strings-catalog";

export type StringsCatalogNavigationState = {
	query: string;
	key?: string;
	scope?: CatalogValueScope;
	/** A durable Work Hand-off narrows the catalog to this exact ordered key
	 * membership. Search and Catalog Scopes are then applied as an AND. */
	handoffMessageIds?: readonly string[];
};

export type CatalogValueScope =
	| "waiting"
	| "unconfirmedImport"
	| "stale"
	| "introduced";

/** An editable target's place in the locally loaded Catalog Workspace. The
 * component owns DOM focus; this module owns the deterministic movement rule. */
export type CatalogWorkspaceFocusTarget = {
	messageId: string;
	localeId: string;
	keyIndex: number;
	valueState?: CatalogWorkspaceValue["valueState"];
	sourceChangeKind?: CatalogWorkspaceValue["sourceChangeKind"];
};

export type CatalogWorkspaceFocusIntent =
	| { kind: "adjacent"; direction: -1 | 1 }
	| { kind: "next" }
	| { kind: "nextWaiting" };

/** Find the next editor field without changing Catalog Order. Tab does not
 * wrap at an edge; after a commit, the next field wraps through the catalog so
 * populated values are never skipped. The older nextWaiting intent remains
 * available for callers that explicitly want unresolved work. */
export function nextCatalogWorkspaceFocusTarget(
	targets: readonly CatalogWorkspaceFocusTarget[],
	current: Pick<CatalogWorkspaceFocusTarget, "messageId" | "localeId">,
	intent: CatalogWorkspaceFocusIntent,
): CatalogWorkspaceFocusTarget | undefined {
	const currentIndex = targets.findIndex(
		(target) =>
			target.messageId === current.messageId &&
			target.localeId === current.localeId,
	);
	if (currentIndex < 0) return undefined;
	if (intent.kind === "adjacent") {
		return targets[currentIndex + intent.direction];
	}
	if (intent.kind === "next") {
		if (targets.length < 2) return undefined;
		return targets[(currentIndex + 1) % targets.length];
	}
	for (let offset = 1; offset < targets.length; offset++) {
		const candidate = targets[(currentIndex + offset) % targets.length];
		if (
			candidate?.valueState === "waiting" ||
			(candidate?.valueState === "stale" &&
				candidate.sourceChangeKind !== "cosmetic")
		) {
			return candidate;
		}
	}
	return undefined;
}

/** One key on the server-filtered browse page: its position and target state
 * facts, without full Locale values. */
export type StringsNavigationDigest = {
	messageId: string;
	catalogIndex: number;
	introductionReviewPending: number;
	source: {
		localeId: string;
		gitValueFingerprint: string;
	};
	targets: readonly {
		localeId: string;
		localeCode: string;
		valueState: CatalogWorkspaceValue["valueState"];
		touched: boolean;
		confirmedGitContent: boolean;
		confirmedContentPreviously: boolean;
		firstReviewPending: boolean;
		repeatedGitContent?: boolean;
		gitValueFingerprint?: string;
	}[];
};

export type StringsNavigationRead = {
	kind: "noBaseline" | "incomplete" | "ready";
	projectionId?: string;
	canEdit?: boolean;
	stepPending?: boolean;
	keyCount?: number;
	status?: "missing" | "staging" | "verifying" | "ready" | "failed";
	progress?: {
		rowCount: number;
		expectedRowCount: number;
		byteLength: number;
	};
	failure?: {
		code?: string;
		message: string;
		failedAt: number;
	} | null;
	valueStateCounts?: {
		waiting: number;
		unconfirmedImport: number;
		stale: number;
		settled: number;
	};
	keys?: readonly StringsNavigationDigest[];
};

/** Existing-locale tasks require one Locale target shared by every selected
 * key. Preserve the first key's Locale order so the chooser remains stable. */
export function translationTaskLocales(
	digests: readonly StringsNavigationDigest[],
	selectedMessageIds: ReadonlySet<string>,
): Array<{ localeId: string; localeCode: string }> {
	if (selectedMessageIds.size === 0) return [];
	const selected = digests.filter((digest) =>
		selectedMessageIds.has(digest.messageId),
	);
	if (selected.length !== selectedMessageIds.size) return [];
	const [first, ...rest] = selected;
	if (!first) return [];
	return first.targets
		.filter((target) =>
			rest.every((digest) =>
				digest.targets.some(
					(candidate) => candidate.localeId === target.localeId,
				),
			),
		)
		.map(({ localeId, localeCode }) => ({ localeId, localeCode }));
}

/** Preserve page order and release membership while locating a permalink.
 * The browse query owns search and scope filtering. */
export function navigateStringsDigests(
	navigation: StringsNavigationRead,
	state: Pick<StringsCatalogNavigationState, "key" | "handoffMessageIds">,
): {
	matchingDigests: readonly StringsNavigationDigest[];
	target?: { id: string; index: number };
} {
	const keys = navigation.keys ?? [];
	const handoff = state.handoffMessageIds
		? new Set(state.handoffMessageIds)
		: undefined;
	const matchingDigests = handoff
		? keys.filter((digest) => handoff.has(digest.messageId))
		: keys;
	const targetKey = state.key;
	const targetIndex = targetKey
		? matchingDigests.findIndex((digest) => digest.messageId === targetKey)
		: -1;
	return {
		matchingDigests,
		target:
			targetKey === undefined || targetIndex === -1
				? undefined
				: { id: targetKey, index: targetIndex },
	};
}
