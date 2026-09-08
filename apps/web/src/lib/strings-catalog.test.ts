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
			basis: {
				kind: "repository" as const,
				expectedSourceFingerprint: "source-proposal-one",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 0,
			},
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
				basis: {
					kind: "repository" as const,
					expectedSourceFingerprint: "source-proposal-two",
					expectedGitValueFingerprint: "git-one",
					expectedGitValueRevision: 0,
					expectedWorkspaceRevision: 1,
				},
			},
		);

		expect(afterSourceProposalChanges).toEqual({
			value: "Willkommen",
			basis: {
				kind: "repository" as const,
				expectedSourceFingerprint: "source-proposal-one",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 0,
			},
			isDirty: true,
		});
	});

	test("refreshes the source token while a target draft is clean", () => {
		const refreshed = refreshCatalogWorkspaceDraft(
			createCatalogWorkspaceDraft({
				value: "Hallo",
				basis: {
					kind: "repository" as const,
					expectedSourceFingerprint: "source-proposal-one",
					expectedGitValueFingerprint: "git-one",
					expectedGitValueRevision: 0,
					expectedWorkspaceRevision: 0,
				},
			}),
			{
				value: "Hallo",
				basis: {
					kind: "repository" as const,
					expectedSourceFingerprint: "source-proposal-two",
					expectedGitValueFingerprint: "git-one",
					expectedGitValueRevision: 0,
					expectedWorkspaceRevision: 1,
				},
			},
		);

		if (refreshed.basis.kind !== "repository")
			throw new Error("Expected repository basis");
		expect(refreshed.basis.expectedSourceFingerprint).toBe(
			"source-proposal-two",
		);
		expect(refreshed.basis.expectedWorkspaceRevision).toBe(1);
		expect(refreshed.isDirty).toBeFalse();
	});

	test("refreshes a clean English draft when another editor changes the proposal", () => {
		const refreshed = refreshCatalogWorkspaceDraft(
			createCatalogWorkspaceDraft({
				value: "Account",
				basis: {
					kind: "repository" as const,
					expectedSourceFingerprint: "git-source",
					expectedGitValueFingerprint: "git-one",
					expectedGitValueRevision: 0,
					expectedWorkspaceRevision: 0,
				},
			}),
			{
				value: "Your account",
				basis: {
					kind: "repository" as const,
					expectedSourceFingerprint: "source-proposal-one",
					expectedGitValueFingerprint: "git-one",
					expectedGitValueRevision: 0,
					expectedWorkspaceRevision: 1,
				},
			},
		);

		expect(refreshed).toEqual({
			value: "Your account",
			basis: {
				kind: "repository" as const,
				expectedSourceFingerprint: "source-proposal-one",
				expectedGitValueFingerprint: "git-one",
				expectedGitValueRevision: 0,
				expectedWorkspaceRevision: 1,
			},
			isDirty: false,
		});
	});
});
