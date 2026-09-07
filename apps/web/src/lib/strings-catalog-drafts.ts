import {
	type CatalogWorkspaceDraft,
	type CatalogWorkspaceDraftSource,
	createCatalogWorkspaceDraft,
} from "./strings-catalog";

export type OptimisticDraftSource = {
	/** Snapshots the subscription may still return before catching up. */
	known: readonly CatalogWorkspaceDraftSource[];
	committed: CatalogWorkspaceDraftSource;
};

export type CatalogEditorState = {
	draft: CatalogWorkspaceDraft;
	optimisticSource: OptimisticDraftSource | null;
	isSaving: boolean;
	error: string | null;
	isRecordingBlank: boolean;
	blankReason: string;
	blankSource: CatalogWorkspaceDraft | null;
};

export function sameDraftSource(
	left: CatalogWorkspaceDraftSource,
	right: CatalogWorkspaceDraftSource,
): boolean {
	return (
		left.value === right.value &&
		left.expectedSourceFingerprint === right.expectedSourceFingerprint &&
		left.expectedGitValueFingerprint === right.expectedGitValueFingerprint &&
		left.expectedGitValueRevision === right.expectedGitValueRevision &&
		left.expectedWorkspaceRevision === right.expectedWorkspaceRevision
	);
}

/** One field's editing session outlives its virtual row, including pending
 * saves. Only this field's subscribers rerender while its author types. */
export class CatalogEditorSession {
	private state: CatalogEditorState;
	private listeners = new Set<() => void>();

	constructor(
		readonly messageId: string,
		readonly localeId: string,
		readonly localeCode: string,
		source: CatalogWorkspaceDraftSource,
		private onChange: () => void,
	) {
		this.state = {
			draft: createCatalogWorkspaceDraft(source),
			optimisticSource: null,
			isSaving: false,
			error: null,
			isRecordingBlank: false,
			blankReason: "",
			blankSource: null,
		};
	}

	getSnapshot = () => this.state;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			// Strict Mode may resubscribe immediately; release only after that cycle.
			queueMicrotask(this.onChange);
		};
	};

	set = <K extends keyof CatalogEditorState>(
		key: K,
		value:
			| CatalogEditorState[K]
			| ((current: CatalogEditorState[K]) => CatalogEditorState[K]),
	) => {
		const next = typeof value === "function" ? value(this.state[key]) : value;
		if (Object.is(next, this.state[key])) return;
		this.state = { ...this.state, [key]: next };
		for (const listener of this.listeners) listener();
		this.onChange();
	};

	get hasUnsavedWork() {
		return (
			this.state.draft.isDirty ||
			this.state.isSaving ||
			this.state.isRecordingBlank
		);
	}

	get canRelease() {
		return (
			this.listeners.size === 0 &&
			!this.hasUnsavedWork &&
			this.state.optimisticSource === null &&
			this.state.error === null
		);
	}
}

/** Owned by a project’s mounted Strings view, never by a virtualized row or
 * the changing Baseline projection. Clean unmounted sessions are released;
 * dirty sessions remain recoverable until saved, discarded, or the view closes. */
export class CatalogEditorDrafts {
	private sessions = new Map<string, CatalogEditorSession>();
	private listeners = new Set<() => void>();
	private revision = 0;

	get(
		messageId: string,
		localeId: string,
		localeCode: string,
		source: CatalogWorkspaceDraftSource,
	) {
		const key = JSON.stringify([messageId, localeId]);
		let session = this.sessions.get(key);
		if (!session) {
			session = new CatalogEditorSession(
				messageId,
				localeId,
				localeCode,
				source,
				() => {
					if (this.sessions.get(key)?.canRelease) this.sessions.delete(key);
					this.revision++;
					for (const listener of this.listeners) listener();
				},
			);
			this.sessions.set(key, session);
		}
		return session;
	}

	getSnapshot = () => this.revision;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	unsaved() {
		return [...this.sessions.values()].filter(
			(session) => session.hasUnsavedWork,
		);
	}

	discard(session: CatalogEditorSession) {
		if (session.getSnapshot().isSaving) return;
		this.sessions.delete(JSON.stringify([session.messageId, session.localeId]));
		this.revision++;
		for (const listener of this.listeners) listener();
	}
}
