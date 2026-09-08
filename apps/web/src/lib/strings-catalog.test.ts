import { describe, expect, test } from "bun:test";

import {
	createCatalogWorkspaceDraft,
	editCatalogWorkspaceDraft,
	refreshCatalogWorkspaceDraft,
} from "./strings-catalog";

describe("Catalog Workspace drafts", () => {
	test("retains the source token from a dirty target draft across a newer Source Proposal", () => {
		const firstSource = {
			value: "Hallo",
			expectedSourceFingerprint: "source-proposal-one",
			expectedGitValueFingerprint: "git-one",
			expectedGitValueRevision: 0,
			expectedWorkspaceRevision: 0,
		};
		const dirtyDraft = editCatalogWorkspaceDraft({
			draft: createCatalogWorkspaceDraft(firstSource),
			source: firstSource,
			value: "Willkommen",
		});
		const afterSourceProposalChanges = refreshCatalogWorkspaceDraft(
			dirtyDraft,
			{
				value: "Hallo",
				expectedSourceFingerprint: "source-proposal-two",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 1,
			},
		);

		expect(afterSourceProposalChanges).toEqual({
			value: "Willkommen",
			expectedSourceFingerprint: "source-proposal-one",
			expectedGitValueFingerprint: "git-one",
			expectedGitValueRevision: 0,
			expectedWorkspaceRevision: 0,
			isDirty: true,
		});
	});

	test("refreshes the source token while a target draft is clean", () => {
		const refreshed = refreshCatalogWorkspaceDraft(
			createCatalogWorkspaceDraft({
				value: "Hallo",
				expectedSourceFingerprint: "source-proposal-one",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 0,
			}),
			{
				value: "Hallo",
				expectedSourceFingerprint: "source-proposal-two",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 1,
			},
		);

		expect(refreshed.expectedSourceFingerprint).toBe("source-proposal-two");
		expect(refreshed.expectedWorkspaceRevision).toBe(1);
		expect(refreshed.isDirty).toBeFalse();
	});

	test("refreshes a clean English draft when another editor changes the proposal", () => {
		const refreshed = refreshCatalogWorkspaceDraft(
			createCatalogWorkspaceDraft({
				value: "Account",
				expectedSourceFingerprint: "git-source",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 0,
			}),
			{
				value: "Your account",
				expectedSourceFingerprint: "source-proposal-one",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 1,
			},
		);

		expect(refreshed).toEqual({
			value: "Your account",
			expectedSourceFingerprint: "source-proposal-one",
			expectedGitValueFingerprint: "git-one",
			expectedGitValueRevision: 0,
			expectedWorkspaceRevision: 1,
			isDirty: false,
		});
	});
});
