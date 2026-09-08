import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
	agentReviewAuthorizationValidator,
	agentReviewPolicyValidator,
} from "./agentReviewModel";
import { managedBasisValidator } from "./contentModel";
import { tokenScopeValidator } from "./lib";
import { releaseAssessmentFields } from "./releaseRecordModel";
import {
	guidanceAuthorshipFields,
	guidanceContentValidator,
} from "./translationGuidanceModel";

const role = v.union(
	v.literal("owner"),
	v.literal("editor"),
	v.literal("viewer"),
);
const stringStatus = v.union(
	v.literal("missing"),
	v.literal("translated"),
	v.literal("needs_review"),
	v.literal("stale"),
);
const actor = v.object({
	kind: v.union(
		v.literal("user"),
		v.literal("agent"),
		v.literal("system"),
		v.literal("repositoryAdapter"),
	),
	id: v.string(),
});
const ordinaryImportCounts = {
	total: v.number(),
	eligible: v.number(),
	empty: v.number(),
	sourceIdentical: v.number(),
	repeated: v.number(),
	modified: v.number(),
	stale: v.number(),
	alreadyConfirmed: v.number(),
	pendingSourceProposal: v.number(),
	// Optional only for the deployment that upgrades existing persisted
	// Navigation State rows. Policy v3 always writes this count.
	introduced: v.optional(v.number()),
};
const catalogWorkspaceDecisionRecordCommon = {
	deliveryProjectionId: v.optional(v.id("catalogProjections")),
	localeProposalId: v.optional(v.id("localeProposals")),
	projectId: v.id("projects"),
	messageId: v.string(),
	localeId: v.id("locales"),
	sourceFingerprint: v.string(),
	valueFingerprint: v.string(),
	recordedBy: actor,
	reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
	recordedAt: v.number(),
};
const catalogWorkspaceDecisionRecord = v.union(
	v.object({
		...catalogWorkspaceDecisionRecordCommon,
		kind: v.literal("intentionalBlank"),
		reason: v.string(),
	}),
	v.object({
		...catalogWorkspaceDecisionRecordCommon,
		kind: v.literal("translatorConfirmation"),
	}),
);
const sourceProposalStatus = v.union(
	v.literal("open"),
	// Kept for compatibility with early Restore Proposal rows. New private
	// observations leave the proposal open and derive visibility from their
	// projection-bound resolution heads.
	v.literal("resolving"),
	v.literal("landed"),
	v.literal("superseded"),
);
const sourceProposalCommon = {
	projectId: v.id("projects"),
	messageId: v.string(),
	sourceValue: v.string(),
	sourceFingerprint: v.string(),
	evidenceSnapshotId: v.id("sourceSnapshots"),
	status: sourceProposalStatus,
	observedSnapshotId: v.optional(v.id("sourceSnapshots")),
	observedAt: v.optional(v.number()),
	createdBy: actor,
	createdAt: v.number(),
};
const sourceProposal = v.union(
	v.object({
		...sourceProposalCommon,
		kind: v.literal("restore"),
		archiveStateProjectionId: v.id("catalogProjections"),
	}),
	v.object({
		...sourceProposalCommon,
		kind: v.literal("source"),
		// The Git value the candidate answers. The Source Contract itself stays
		// in the immutable Catalog Projection; this only makes the candidate's
		// provenance explicit until a later Baseline observes it.
		basisGitValueFingerprint: v.string(),
		basisGitValueRevision: v.number(),
		updatedBy: actor,
		updatedAt: v.number(),
	}),
);
const placeholder = v.object({
	name: v.string(),
	type: v.optional(v.string()),
	example: v.optional(v.string()),
});
const changeSetAuthor = v.object({
	kind: v.union(v.literal("user"), v.literal("agent")),
	id: v.string(),
});
const agentTranslationProposalTarget = v.union(
	v.object({
		kind: v.literal("managedCollection"),
		collectionId: v.id("contentCollections"),
	}),
	v.object({ kind: v.literal("catalogWorkspace") }),
	v.object({
		kind: v.literal("localeProposal"),
		localeProposalId: v.id("localeProposals"),
	}),
);
const agentTranslationCandidateReviewDecision = v.union(
	v.object({ kind: v.literal("accept") }),
	v.object({ kind: v.literal("keepForCurrentSource") }),
	v.object({ kind: v.literal("acceptWithEdits"), value: v.string() }),
	v.object({
		kind: v.literal("reject"),
		reason: v.optional(v.string()),
	}),
	v.object({ kind: v.literal("intentionalBlank"), reason: v.string() }),
);
const agentTranslationCatalogWorkspaceBasis = v.object({
	kind: v.literal("catalogWorkspace"),
	projectionId: v.id("catalogProjections"),
	snapshotId: v.id("sourceSnapshots"),
	gitValueFingerprint: v.string(),
	gitValueRevision: v.number(),
	workspaceRevision: v.number(),
	sourceFingerprint: v.string(),
});
const agentTranslationLocaleProposalBasis = v.object({
	kind: v.literal("localeProposal"),
	localeProposalId: v.id("localeProposals"),
	snapshotId: v.id("sourceSnapshots"),
	sourceFingerprint: v.string(),
});
const agentTranslationCandidateBasis = v.union(
	managedBasisValidator,
	agentTranslationCatalogWorkspaceBasis,
	agentTranslationLocaleProposalBasis,
);
const importJobInput = v.object({
	localeCode: v.string(),
	screenSlug: v.optional(v.string()),
	tagSlugs: v.optional(v.array(v.string())),
	mode: v.optional(v.union(v.literal("create_missing"), v.literal("upsert"))),
});
const importJobResult = v.union(
	v.object({ imported: v.number() }),
	v.object({ error: v.string() }),
);
const exportSelection = v.object({
	type: v.union(
		v.literal("all"),
		v.literal("keys"),
		v.literal("tag"),
		v.literal("screen"),
	),
	keys: v.optional(v.array(v.string())),
	tag: v.optional(v.string()),
	screen: v.optional(v.string()),
});
const exportJobInput = v.object({
	localeCode: v.string(),
	selection: exportSelection,
});
const exportJobResult = v.object({ content: v.string() });
const placeholderDefinition = v.union(
	v.object({ type: v.literal("present"), value: v.string() }),
	v.object({ type: v.literal("absent") }),
);
const metadataTransform = v.union(
	v.object({
		kind: v.literal("rename_placeholder"),
		from: v.string(),
		to: v.string(),
	}),
	v.object({
		kind: v.literal("retype_placeholder"),
		name: v.string(),
		from: placeholderDefinition,
		to: placeholderDefinition,
	}),
);
const metadataTransforms = v.optional(v.array(metadataTransform));
const translationResidueCode = v.union(
	v.literal("removed_placeholder"),
	v.literal("target_argument_not_in_source"),
	v.literal("placeholder_rename_conflict"),
	v.literal("plural_to_plain_requires_translation"),
);
const translationResidueReason = v.object({
	code: translationResidueCode,
	placeholderNames: v.optional(v.array(v.string())),
	placeholderNameCount: v.optional(v.number()),
	placeholderNamesComplete: v.optional(v.boolean()),
});
const reconciliationReportGroup = v.union(
	v.literal("locale_setup"),
	v.literal("broken_by_source_change"),
	v.literal("changed_in_git"),
	v.literal("archived_by_sync"),
	v.literal("to_review"),
	v.literal("to_translate"),
);
const reconciliationReportSubject = v.union(
	v.literal("key"),
	v.literal("locale"),
	v.literal("file"),
);
const reconciliationReportFactKind = v.union(
	v.literal("unbound_locale_file"),
	v.literal("source_change_broke_target"),
	v.literal("git_value_changed"),
	v.literal("key_archived"),
	v.literal("locale_archived"),
	v.literal("automatic_restore"),
	v.literal("source_translation_stale"),
	v.literal("automatic_contract_transform"),
	v.literal("new_target_value"),
	v.literal("translation_residue"),
);
const releaseFindingKind = v.union(
	v.literal("contract_invalid"),
	v.literal("missing_value"),
	v.literal("semantic_source_change"),
	v.literal("introduction_review"),
);
const releasePosture = v.union(
	v.literal("blocked"),
	v.literal("needsDecisions"),
	v.literal("ready"),
);
const contractTransformCode = v.union(
	v.literal("renamed_placeholder"),
	v.literal("retyped_placeholder"),
	v.literal("wrapped_plural"),
	v.literal("unwrapped_plural"),
);

export default defineSchema({
	contentCollections: defineTable({
		projectId: v.id("projects"),
		name: v.string(),
		membershipRevision: v.number(),
		createdAt: v.number(),
	}).index("by_project", ["projectId"]),
	contentCollectionLocales: defineTable({
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		localeId: v.id("locales"),
		active: v.boolean(),
	})
		.index("by_collection", ["collectionId"])
		.index("by_collection_locale", ["collectionId", "localeId"])
		.index("by_locale", ["localeId"]),
	managedMessages: defineTable({
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		key: v.string(),
		sourceValue: v.string(),
		context: v.optional(v.string()),
		sourceRevision: v.number(),
		sourceFingerprint: v.string(),
		archivedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_collection_key", ["collectionId", "key"])
		.index("by_collection", ["collectionId"]),
	managedSourceRevisions: defineTable({
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		messageId: v.string(),
		sourceValue: v.string(),
		context: v.optional(v.string()),
		sourceRevision: v.number(),
		sourceFingerprint: v.string(),
		actor,
		createdAt: v.number(),
		archivedAt: v.optional(v.number()),
	}).index("by_message", ["collectionId", "messageId"]),
	managedTargets: defineTable({
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		messageId: v.string(),
		localeId: v.id("locales"),
		value: v.string(),
		sourceFingerprint: v.string(),
		revision: v.number(),
		intentionalBlankReason: v.optional(v.string()),
		actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		updatedAt: v.number(),
	})
		.index("by_value", ["collectionId", "messageId", "localeId"])
		.index("by_locale", ["localeId"]),
	managedTargetRevisions: defineTable({
		projectId: v.id("projects"),
		collectionId: v.id("contentCollections"),
		messageId: v.string(),
		localeId: v.id("locales"),
		value: v.string(),
		sourceFingerprint: v.string(),
		revision: v.number(),
		intentionalBlankReason: v.optional(v.string()),
		actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		createdAt: v.number(),
	}).index("by_value", ["collectionId", "messageId", "localeId"]),

	projects: defineTable({
		name: v.string(),
		slug: v.string(),
		// The Repository Adapter establishes this on its first submission. It is
		// project state because later local syncs must not silently switch remotes.
		repository: v.optional(v.string()),
		// The branch that receives reviewed localization delivery pull requests.
		// Older projects fall back to the team default in the adapter seams.
		integrationBranch: v.optional(v.string()),
		sourceLocaleId: v.optional(v.id("locales")),
		localeBindingRevision: v.optional(v.number()),
		baselineSnapshotId: v.optional(v.id("sourceSnapshots")),
		activeCatalogProjectionId: v.optional(v.id("catalogProjections")),
		// Repository Adapter protocol floors are project setup, never checkout
		// configuration. A version floor warns; a protocol floor can refuse.
		minimumCliVersion: v.optional(v.string()),
		minimumCliProtocol: v.optional(v.number()),
		agentReviewPolicy: v.optional(agentReviewPolicyValidator),
		// Incremented whenever the current Source Proposal set changes. A staging
		// projection captures this revision and restages if a candidate races its
		// accepted transition.
		sourceProposalHeadVersion: v.optional(v.number()),
		createdByUserId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		archivedAt: v.optional(v.number()),
	})
		.index("by_slug", ["slug"])
		.index("by_createdByUserId", ["createdByUserId"])
		.index("by_archivedAt", ["archivedAt"]),

	projectMembers: defineTable({
		projectId: v.id("projects"),
		userId: v.string(),
		role,
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_user", ["userId"])
		.index("by_project_role", ["projectId", "role"])
		.index("by_project_user", ["projectId", "userId"]),

	projectInvites: defineTable({
		projectId: v.id("projects"),
		emailLower: v.string(),
		role,
		invitedByUserId: v.string(),
		createdAt: v.number(),
		acceptedAt: v.optional(v.number()),
		acceptedByUserId: v.optional(v.string()),
		revokedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_project_email", ["projectId", "emailLower"])
		.index("by_email", ["emailLower"]),

	// Authored translation references are independent of release truth.
	// Heads bound current reads; immutable revisions keep old citations useful.
	translationGuidanceStates: defineTable({
		projectId: v.id("projects"),
		revision: v.number(),
		termCount: v.number(),
		guideCount: v.number(),
		byteLength: v.number(),
	}).index("by_project", ["projectId"]),

	translationGuidanceEntries: defineTable({
		projectId: v.id("projects"),
		key: v.string(),
		content: guidanceContentValidator,
		revisionId: v.id("translationGuidanceRevisions"),
		...guidanceAuthorshipFields,
	}).index("by_project_and_key", ["projectId", "key"]),

	translationGuidanceRevisions: defineTable({
		projectId: v.id("projects"),
		key: v.string(),
		content: v.union(guidanceContentValidator, v.null()),
		...guidanceAuthorshipFields,
	}).index("by_project_and_revision", ["projectId", "revision"]),

	locales: defineTable({
		projectId: v.id("projects"),
		code: v.string(),
		label: v.string(),
		isSource: v.boolean(),
		// The Locale Binding: the repository-relative catalog file this Locale
		// is read from and written to. Explicit setup rather than a filename
		// convention, because a path may change while the Locale does not.
		catalogPath: v.optional(v.string()),
		createdAt: v.number(),
		archivedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_project_code", ["projectId", "code"])
		.index("by_project_source", ["projectId", "isSource"])
		.index("by_project_catalogPath", ["projectId", "catalogPath"]),

	screens: defineTable({
		projectId: v.id("projects"),
		name: v.string(),
		slug: v.string(),
		description: v.optional(v.string()),
		createdAt: v.number(),
		archivedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_project_slug", ["projectId", "slug"]),

	tags: defineTable({
		projectId: v.id("projects"),
		name: v.string(),
		slug: v.string(),
		color: v.optional(v.string()),
		createdAt: v.number(),
		archivedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_project_slug", ["projectId", "slug"]),

	translationKeys: defineTable({
		projectId: v.id("projects"),
		key: v.string(),
		description: v.optional(v.string()),
		screenId: v.optional(v.id("screens")),
		tagIds: v.array(v.id("tags")),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		placeholders: v.array(placeholder),
		createdAt: v.number(),
		updatedAt: v.number(),
		archivedAt: v.optional(v.number()),
		searchText: v.string(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_key", ["projectId", "key"])
		.index("by_project_screen", ["projectId", "screenId"])
		.index("by_project_archivedAt", ["projectId", "archivedAt"])
		.searchIndex("searchText", {
			searchField: "searchText",
			filterFields: ["projectId"],
		}),

	translationValues: defineTable({
		projectId: v.id("projects"),
		keyId: v.id("translationKeys"),
		localeId: v.id("locales"),
		value: v.string(),
		status: stringStatus,
		sourceVersion: v.number(),
		version: v.number(),
		updatedBy: actor,
		updatedAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_key", ["keyId"])
		.index("by_locale", ["localeId"])
		.index("by_project_locale", ["projectId", "localeId"])
		.index("by_project_locale_status", ["projectId", "localeId", "status"])
		.index("by_project_key_locale", ["projectId", "keyId", "localeId"]),

	translationHistory: defineTable({
		projectId: v.id("projects"),
		keyId: v.id("translationKeys"),
		localeId: v.id("locales"),
		previousValue: v.union(v.string(), v.null()),
		nextValue: v.string(),
		previousStatus: v.union(stringStatus, v.null()),
		nextStatus: stringStatus,
		previousVersion: v.union(v.number(), v.null()),
		nextVersion: v.number(),
		changedBy: actor,
		changeSetId: v.optional(v.id("changeSets")),
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_key_locale", ["keyId", "localeId"])
		.index("by_changeSet", ["changeSetId"])
		.index("by_createdAt", ["createdAt"]),

	// A Source Snapshot: one commit's bound catalogs, published atomically.
	// The files themselves live in file storage as immutable evidence; the
	// Catalog Document is parsed from those bytes rather than stored beside
	// them, so there is only ever one representation of a file.
	sourceSnapshots: defineTable({
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		manifestHash: v.string(),
		kind: v.union(v.literal("baseline"), v.literal("preview")),
		lineage: v.optional(
			v.object({
				baselineCommit: v.string(),
				relationship: v.union(
					v.literal("ancestor"),
					v.literal("descendant"),
					v.literal("divergent"),
				),
				mergeBase: v.string(),
			}),
		),
		createdBy: actor,
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_commit", ["projectId", "commit"])
		.index("by_project_and_repository_and_commit_and_manifestHash", [
			"projectId",
			"repository",
			"commit",
			"manifestHash",
		]),

	snapshotUploadSessions: defineTable({
		projectId: v.id("projects"),
		tokenId: v.id("apiTokens"),
		releaseRecordId: v.optional(v.id("releaseRecords")),
		deliveryCaptureId: v.optional(v.id("releaseDeliveryCaptures")),
		repository: v.string(),
		commit: v.string(),
		lineage: v.optional(
			v.object({
				baselineCommit: v.string(),
				relationship: v.union(
					v.literal("ancestor"),
					v.literal("descendant"),
					v.literal("divergent"),
				),
				mergeBase: v.string(),
			}),
		),
		expectedFiles: v.number(),
		uploadedFiles: v.number(),
		status: v.union(
			v.literal("uploading"),
			v.literal("processing"),
			v.literal("completed"),
		),
		createdAt: v.number(),
		expiresAt: v.number(),
		processingAt: v.optional(v.number()),
		runId: v.optional(v.id("snapshotIngestionRuns")),
	}),
	snapshotUploadFiles: defineTable({
		sessionId: v.id("snapshotUploadSessions"),
		catalogPath: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		outputStorageId: v.optional(v.id("_storage")),
		byteLength: v.number(),
	}).index("by_session_and_catalogPath", ["sessionId", "catalogPath"]),

	sourceSnapshotFiles: defineTable({
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		// A Snapshot keeps the Locale role it observed at ingest time. Older
		// snapshots predate this field and fall back to the project's source
		// Locale when they are projected for the first time.
		isSource: v.optional(v.boolean()),
		catalogPath: v.string(),
		storageId: v.id("_storage"),
		byteLength: v.number(),
	})
		.index("by_snapshot", ["snapshotId"])
		.index("by_snapshot_and_isSource", ["snapshotId", "isSource"])
		.index("by_snapshot_and_localeId", ["snapshotId", "localeId"])
		.index("by_snapshot_and_localeCode", ["snapshotId", "localeCode"])
		.index("by_storageId", ["storageId"]),

	// A file without a Locale Binding is still immutable Snapshot evidence. It
	// never joins the working catalog until an editor deliberately binds it.
	sourceSnapshotUnboundFiles: defineTable({
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		catalogPath: v.string(),
		storageId: v.id("_storage"),
		byteLength: v.number(),
		declaredLocaleCode: v.optional(v.string()),
		messageCount: v.optional(v.number()),
	})
		.index("by_snapshot", ["snapshotId"])
		.index("by_snapshot_and_catalogPath", ["snapshotId", "catalogPath"])
		.index("by_storageId", ["storageId"]),

	// A target Locale can be deliberately absent from a complete Snapshot. Keep
	// that ingest-time observation beside the immutable files rather than
	// consulting mutable Locale Bindings if a Preview later becomes Baseline.
	sourceSnapshotAbsentLocales: defineTable({
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
	}).index("by_snapshot", ["snapshotId"]),

	// A Snapshot Ingestion Run ends with a published snapshot or with
	// diagnostics — never with mere acceptance of the request.
	snapshotIngestionRuns: defineTable({
		projectId: v.id("projects"),
		repository: v.string(),
		commit: v.string(),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		snapshotId: v.optional(v.id("sourceSnapshots")),
		manifestHash: v.string(),
		diagnosticGeneration: v.number(),
		createdBy: actor,
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_repository_and_commit_and_manifestHash", [
			"projectId",
			"repository",
			"commit",
			"manifestHash",
		]),

	snapshotIngestionDiagnostics: defineTable({
		runId: v.id("snapshotIngestionRuns"),
		generation: v.number(),
		catalogPath: v.optional(v.string()),
		message: v.string(),
	}).index("by_run_and_generation", ["runId", "generation"]),

	// A Locale Proposal is deliberately separate from a Locale Binding. It pins
	// one target catalog to immutable source evidence, while its submitted
	// values remain bounded child rows until a complete delivery artifact exists.
	localeIntroductionTargets: defineTable({
		projectId: v.id("projects"),
		localeCode: v.string(),
		label: v.string(),
		catalogPath: v.string(),
		runtimeLocale: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		updatedBy: v.string(),
	})
		.index("by_project_and_localeCode", ["projectId", "localeCode"])
		.index("by_project_and_catalogPath", ["projectId", "catalogPath"]),

	localeProposals: defineTable({
		projectId: v.id("projects"),
		sourceSnapshotId: v.id("sourceSnapshots"),
		sourceSnapshotFileId: v.id("sourceSnapshotFiles"),
		sourceCatalogPath: v.string(),
		sourceStorageId: v.id("_storage"),
		sourceMessageCount: v.number(),
		localeCode: v.string(),
		runtimeLocale: v.string(),
		localeLabel: v.optional(v.string()),
		catalogPath: v.optional(v.string()),
		catalogContentHash: v.optional(v.string()),
		status: v.union(v.literal("draft"), v.literal("ready")),
		stagedValueCount: v.number(),
		stagedValueByteLength: v.number(),
		revision: v.number(),
		diagnosticGeneration: v.number(),
		diagnosticCount: v.number(),
		artifactStorageId: v.optional(v.id("_storage")),
		artifactHash: v.optional(v.string()),
		artifactByteLength: v.optional(v.number()),
		finalizedAt: v.optional(v.number()),
		createdBy: actor,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project_and_status_and_catalogContentHash", [
			"projectId",
			"status",
			"catalogContentHash",
		])
		.index("by_project", ["projectId"])
		.index("by_project_and_catalogPath_and_catalogContentHash", [
			"projectId",
			"catalogPath",
			"catalogContentHash",
		])
		.index("by_project_and_sourceSnapshotId_and_localeCode", [
			"projectId",
			"sourceSnapshotId",
			"localeCode",
		]),

	localeBindingRealizations: defineTable({
		projectId: v.id("projects"),
		snapshotId: v.id("sourceSnapshots"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		isSource: v.literal(false),
		catalogPath: v.string(),
		storageId: v.id("_storage"),
		byteLength: v.number(),
		projectionId: v.id("catalogProjections"),
		realizedAt: v.number(),
	})
		.index("by_snapshot", ["snapshotId"])
		.index("by_snapshot_and_localeCode", ["snapshotId", "localeCode"]),

	localeDeliveryObservations: defineTable({
		localeId: v.optional(v.id("locales")),
		decisionsStaged: v.boolean(),
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		proposalId: v.id("localeProposals"),
		catalogPath: v.string(),
		catalogContentHash: v.string(),
		localeCode: v.string(),
		observedAt: v.number(),
	})
		.index("by_projection", ["projectionId"])
		.index("by_proposal", ["proposalId"])
		.index("by_project_and_catalogPath", ["projectId", "catalogPath"]),

	localeProposalValues: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageId: v.string(),
		value: v.string(),
		sourceFingerprint: v.string(),
		intentionalBlankReason: v.optional(v.string()),
		byteLength: v.number(),
		updatedBy: actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		updatedAt: v.number(),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_proposal_and_messageId", ["proposalId", "messageId"])
		.index("by_proposal_and_author_and_reviewer_and_messageId", [
			"proposalId",
			"updatedBy.kind",
			"reviewAuthorization.reviewerTokenId",
			"messageId",
		]),

	// Every validation attempt keeps a bounded, generation-stamped review
	// sample. Staging a newer value generation makes old diagnostics inert
	// without an unbounded deletion transaction.
	localeProposalDiagnostics: defineTable({
		proposalId: v.id("localeProposals"),
		generation: v.number(),
		message: v.string(),
	}).index("by_proposal_and_generation", ["proposalId", "generation"]),

	// Append-only review evidence for submitted Locale Proposal values. Later
	// candidate revisions retain their own authorization even when bytes recur.
	localeProposalValueReviews: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("localeProposals"),
		messageId: v.string(),
		valueFingerprint: v.string(),
		decision: agentTranslationCandidateReviewDecision,
		reviewer: actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		finalValue: v.optional(v.string()),
		finalValueFingerprint: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_proposal_and_messageId_and_valueFingerprint", [
			"proposalId",
			"messageId",
			"valueFingerprint",
		]),

	// Normalized workflow fields derived from Catalog Documents. A projection
	// becomes visible only when its Source Snapshot becomes the baseline.
	catalogProjections: defineTable({
		localeBindingRevision: v.optional(v.number()),
		projectId: v.id("projects"),
		// A staging projection claims the Snapshot Identity it was derived from.
		// That claim is checked before it can be published, preventing one
		// project's pending rows from being attached to another snapshot.
		repository: v.string(),
		commit: v.string(),
		manifestHash: v.string(),
		// The staged totals make the one-query working-catalog envelope an
		// integrity invariant rather than a best effort on the read path.
		expectedKeyCount: v.number(),
		expectedMessageCount: v.number(),
		expectedByteLength: v.number(),
		stagedKeyCount: v.number(),
		stagedMessageCount: v.number(),
		stagedByteLength: v.number(),
		// A staged projection compares against this accepted baseline. These stay
		// optional so projections created before Git-change reconciliation remain
		// readable while new projections always write the complete envelope.
		previousBaselineSnapshotId: v.optional(v.id("sourceSnapshots")),
		previousCatalogProjectionId: v.optional(v.id("catalogProjections")),
		// Captured at staging time and checked immediately before publication so a
		// racing Source Proposal is never omitted from an accepted transition.
		sourceProposalHeadVersion: v.optional(v.number()),
		expectedGitChangeCount: v.optional(v.number()),
		expectedGitChangeByteLength: v.optional(v.number()),
		stagedGitChangeCount: v.optional(v.number()),
		stagedGitChangeByteLength: v.optional(v.number()),
		gitChangesStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// Translation Residue is the bounded, normalized reviewer work left after
		// automatic Contract Transforms. It is staged before publication so a
		// Baseline never exposes a half-derived catalog or an omitted residue set.
		expectedTranslationResidueCount: v.optional(v.number()),
		expectedTranslationResidueByteLength: v.optional(v.number()),
		stagedTranslationResidueCount: v.optional(v.number()),
		stagedTranslationResidueByteLength: v.optional(v.number()),
		translationResidueStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// Archive Reconciliation is staged alongside the projection. Optional
		// fields keep projections published before #40 readable as quiet history.
		expectedArchiveKeyCount: v.optional(v.number()),
		expectedArchiveLocaleCount: v.optional(v.number()),
		expectedArchiveValueCount: v.optional(v.number()),
		expectedArchiveByteLength: v.optional(v.number()),
		stagedArchiveKeyCount: v.optional(v.number()),
		stagedArchiveLocaleCount: v.optional(v.number()),
		stagedArchiveValueCount: v.optional(v.number()),
		stagedArchiveByteLength: v.optional(v.number()),
		archiveStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// This is the carry-forward archive state used to restore a source key
		// after more than one accepted baseline has omitted it. It is separate
		// from the transition's immutable Archive Reconciliation actions.
		expectedArchiveStateValueCount: v.optional(v.number()),
		expectedArchiveStateByteLength: v.optional(v.number()),
		stagedArchiveStateValueCount: v.optional(v.number()),
		stagedArchiveStateByteLength: v.optional(v.number()),
		archiveStateStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// Automatic restores are a transition fact, not inferred by re-reading
		// two whole working catalogs. The staged envelope keeps the public
		// Reconciliation surface bounded even at the full corpus size.
		expectedRestoreValueCount: v.optional(v.number()),
		expectedRestoreByteLength: v.optional(v.number()),
		stagedRestoreValueCount: v.optional(v.number()),
		stagedRestoreByteLength: v.optional(v.number()),
		restoreStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// Source Proposal observations are staged from every source value before
		// publication. The projection status makes their normalized heads visible
		// atomically, without a bulk post-publication proposal mutation.
		expectedSourceProposalObservationCount: v.optional(v.number()),
		expectedSourceProposalObservationByteLength: v.optional(v.number()),
		stagedSourceProposalObservationCount: v.optional(v.number()),
		stagedSourceProposalObservationByteLength: v.optional(v.number()),
		sourceProposalObservationsStatus: v.optional(
			v.union(v.literal("pending"), v.literal("staging"), v.literal("staged")),
		),
		// A Reconciliation Report is staged beside a private projection and made
		// visible in the same Baseline transition. Quiet transitions deliberately
		// carry no report instead of manufacturing history with no consequence.
		reconciliationReportId: v.optional(v.id("reconciliationReports")),
		reconciliationReportStatus: v.optional(
			v.union(
				v.literal("pending"),
				v.literal("staging"),
				v.literal("staged"),
				v.literal("quiet"),
			),
		),
		snapshotId: v.optional(v.id("sourceSnapshots")),
		status: v.union(v.literal("staging"), v.literal("published")),
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_snapshot_and_status", [
			"projectId",
			"snapshotId",
			"status",
		]),

	// A deliberately small companion to a Catalog Projection. Resolution heads
	// consult this record rather than repeatedly reading the projection's
	// immutable, potentially large identity fields just to learn whether a
	// private projection became visible.
	catalogProjectionPublicationStates: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		status: v.union(v.literal("staging"), v.literal("published")),
		snapshotId: v.optional(v.id("sourceSnapshots")),
	}).index("by_projection", ["projectionId"]),

	// Private raw inputs exist only while a projection is being reconciled.
	catalogProcessingInputs: defineTable({
		projectionId: v.id("catalogProjections"),
		messageId: v.string(),
		payload: v.string(),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_messageId", ["projectionId", "messageId"]),

	catalogProjectionMessages: defineTable({
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		// The locale's Snapshot-time Binding, never the mutable current path.
		catalogPath: v.string(),
		isSource: v.boolean(),
		catalogIndex: v.number(),
		messageId: v.string(),
		value: v.string(),
		valueFingerprint: v.optional(v.string()),
		// Opaque ARB metadata remains only in the snapshot-bound Catalog
		// Document. This points to the Catalog Document that owns it: the value's
		// own file, or the source file for a materialized target entry.
		metadataCatalogPath: v.optional(v.string()),
		// Normally metadata and value evidence live in this projection's Source
		// Snapshot. A restored target deliberately points back to its archived
		// evidence instead, so its exact metadata remains readable.
		metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
		restoredFromSnapshotId: v.optional(v.id("sourceSnapshots")),
		gitValueFingerprint: v.optional(v.string()),
		gitValueRevision: v.optional(v.number()),
		// Projection construction materializes whether this target's visible
		// imported content repeats in its Locale, keeping Navigation staging free
		// of one database probe per target.
		repeatedGitContent: v.optional(v.boolean()),
		// Version 2 means the marker was computed from visible post-transform
		// content. A Navigation backfill rechecks older rows.
		repeatedGitContentVersion: v.optional(v.number()),
		metadataTransforms,
		sourceFingerprint: v.string(),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		// Bounded at staging time; an incomplete flag directs later validators to
		// the full Catalog Document rather than rejecting a faithful snapshot.
		argumentNames: v.array(v.string()),
		argumentNamesComplete: v.boolean(),
		argumentNameCount: v.number(),
		// The declared half of the Message Signature belongs to the source row.
		declaredPlaceholderNames: v.optional(v.array(v.string())),
		declaredPlaceholderNamesComplete: v.optional(v.boolean()),
		declaredPlaceholderNameCount: v.optional(v.number()),
		introducedAt: v.optional(v.number()),
		introductionLocaleIds: v.optional(v.array(v.id("locales"))),
		materialized: v.boolean(),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_messageId", ["projectionId", "messageId"])
		.index("by_projection_and_messageId_and_isSource", [
			"projectionId",
			"messageId",
			"isSource",
		])
		// Catalog Order access lets the Navigation staging worker and the Window
		// read walk one bounded catalogIndex range instead of scanning keys.
		.index("by_projection_and_catalogIndex", ["projectionId", "catalogIndex"])
		// Locale Proposal review walks source rows in Catalog Order. Keeping the
		// source discriminator in the index prevents every review page from reading
		// every target-Locale row in the projection first.
		.index("by_projection_and_isSource_and_catalogIndex", [
			"projectionId",
			"isSource",
			"catalogIndex",
		])
		.index("by_projection_and_messageId_and_localeId", [
			"projectionId",
			"messageId",
			"localeId",
		])
		// The ordinary-confirmation run's targeted revalidation counts visible
		// values repeated in a Locale with one bounded probe instead of a Locale scan.
		.index("by_projection_and_localeId_and_gitValueFingerprint", [
			"projectionId",
			"localeId",
			"gitValueFingerprint",
		])
		.index("by_projection_and_localeId_and_valueFingerprint", [
			"projectionId",
			"localeId",
			"valueFingerprint",
		]),

	// The mutable Catalog Workspace is deliberately separate from the immutable
	// Source Snapshot projection. This one small state document bounds the
	// project-wide head collection without making translator saves rewrite a
	// shared catalog document.
	catalogWorkspaceStates: defineTable({
		projectId: v.id("projects"),
		valueHeadCount: v.number(),
		valueHeadByteLength: v.number(),
		// Every accepted Baseline advances this generation. A bounded internal
		// reconciler then retires heads whose Git value no longer matches.
		reconciliationGeneration: v.number(),
	}).index("by_project", ["projectId"]),

	// One current translator-authored value per active Locale message. A head
	// keeps its Git basis and Source Fingerprint so the workspace can retain it
	// only while Release Truth has not replaced the value it answered.
	catalogWorkspaceValueHeads: defineTable({
		projectId: v.id("projects"),
		messageId: v.string(),
		localeId: v.id("locales"),
		value: v.string(),
		valueFingerprint: v.optional(v.string()),
		sourceFingerprint: v.string(),
		basisGitValueFingerprint: v.string(),
		basisGitValueRevision: v.number(),
		revision: v.number(),
		reconciliationGeneration: v.number(),
		updatedBy: actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		updatedAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_reconciliationGeneration", [
			"projectId",
			"reconciliationGeneration",
		])
		.index("by_project_and_messageId_and_localeId", [
			"projectId",
			"messageId",
			"localeId",
		]),

	// Intentional Blank and Translator Confirmation retain their exact content
	// evidence even after a later value replaces it. The explicit aggregate
	// envelope keeps that bounded history safe to compose with the active Catalog.
	catalogWorkspaceDecisionStates: defineTable({
		projectId: v.id("projects"),
		decisionRecordCount: v.number(),
		decisionRecordByteLength: v.number(),
	}).index("by_project", ["projectId"]),

	catalogWorkspaceDecisionRecords: defineTable(catalogWorkspaceDecisionRecord)
		.index("by_project_and_messageId_and_localeId_and_actor_and_recordedAt", [
			"projectId",
			"messageId",
			"localeId",
			"recordedBy.kind",
			"recordedAt",
		])
		.index("by_deliveryProjectionId", ["deliveryProjectionId"])
		.index("by_project", ["projectId"])
		.index("by_value_identity", [
			"projectId",
			"messageId",
			"localeId",
			"sourceFingerprint",
			"valueFingerprint",
		])
		// A value can have many Source Contract decisions over time, but a
		// current card only needs the latest decision for its value fingerprint.
		.index("by_value_and_recordedAt", [
			"projectId",
			"messageId",
			"localeId",
			"valueFingerprint",
			"recordedAt",
		]),

	// One small, current Source Proposal head per source key. This is separate
	// from the unbounded Source Proposal history, so the complete Catalog
	// Workspace remains one bounded read even after many source-value attempts.
	catalogWorkspaceSourceProposalStates: defineTable({
		projectId: v.id("projects"),
		headCount: v.number(),
		headByteLength: v.number(),
	}).index("by_project", ["projectId"]),

	catalogWorkspaceSourceProposalHeads: defineTable({
		projectId: v.id("projects"),
		messageId: v.string(),
		proposalId: v.id("sourceProposals"),
		sourceValue: v.string(),
		sourceFingerprint: v.string(),
		basisGitValueFingerprint: v.string(),
		basisGitValueRevision: v.number(),
		revision: v.number(),
		updatedBy: actor,
		updatedAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_messageId", ["projectId", "messageId"]),

	// One bounded Catalog Navigation Index row per active key, in Catalog Order.
	// This is the disposable read model that lets Strings navigate, search, and
	// scope the whole catalog without loading full key cards: it carries only
	// the message identifier, its Catalog Order position, the case-folded search
	// corpus, and the small per-target state facts Catalog Scopes, keyboard
	// traversal, and the ordinary-confirmation summary need. The internal
	// projector derives every field from canonical evidence; the index is never
	// Release Truth and never a second edit path.
	catalogWorkspaceNavigationRows: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		messageId: v.string(),
		catalogIndex: v.number(),
		searchCorpus: v.array(v.string()),
		pendingSourceProposal: v.boolean(),
		// Policy v3 rows always carry First Review facts. Optional storage keeps
		// the schema deployable over disposable policy-v2 rows until backfill.
		introductionReviewPending: v.optional(v.number()),
		source: v.object({
			localeId: v.id("locales"),
			// The Git content identity used by Source-identical and repeated-value
			// classification, falling back to the Source Contract fingerprint for
			// source rows without Git identity.
			gitValueFingerprint: v.string(),
		}),
		targets: v.array(
			v.object({
				localeId: v.id("locales"),
				localeCode: v.string(),
				valueState: v.union(
					v.literal("waiting"),
					v.literal("unconfirmedImport"),
					v.literal("stale"),
					v.literal("settled"),
				),
				// A current Workspace value head exists for this target.
				touched: v.boolean(),
				// An exact decision exists for the target's Git content.
				confirmedGitContent: v.boolean(),
				// Some earlier Translator Confirmation covered the Git content, so
				// its Source Contract has since changed.
				confirmedContentPreviously: v.boolean(),
				firstReviewPending: v.optional(v.boolean()),
				// The visible value identity lets one key detect suspicious repetition
				// across its own target Locales without comparing unrelated keys.
				repeatedGitContent: v.optional(v.boolean()),
				valueFingerprint: v.optional(v.string()),
				gitValueFingerprint: v.optional(v.string()),
			}),
		),
	})
		// Rows are keyed per projection, so a pending generation can stage its
		// complete index beside the active one and generations never mix.
		.index("by_project_and_projection_and_messageId", [
			"projectId",
			"projectionId",
			"messageId",
		])
		.index("by_project_and_projection_and_catalogIndex", [
			"projectId",
			"projectionId",
			"catalogIndex",
		]),

	// One server-owned ordinary-import confirmation run. The cursor walks the
	// Navigation Index in Catalog Order; confirmed/skipped/progress counts are
	// durable, so a run resumes after a partial failure and restarts are
	// idempotent. A changed Baseline projection supersedes the run.
	ordinaryImportRuns: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		policy: v.literal("ordinary-v1"),
		status: v.union(
			v.literal("running"),
			v.literal("done"),
			v.literal("superseded"),
			v.literal("failed"),
		),
		cursor: v.number(),
		confirmed: v.number(),
		skipped: v.number(),
		skipReasons: v.record(v.string(), v.number()),
		startedBy: actor,
		// Claims the one scheduled step so a restart cannot double-schedule.
		stepPending: v.boolean(),
		// A failed scheduled step is terminal until an explicit retry starts a
		// fresh run, preserving the diagnostic instead of losing it to logs.
		failure: v.optional(
			v.object({
				code: v.optional(v.string()),
				message: v.string(),
				failedAt: v.number(),
			}),
		),
		updatedAt: v.number(),
	})
		.index("by_project_and_status", ["projectId", "status"])
		.index("by_project_and_projection", ["projectId", "projectionId"]),

	// The bounded envelope for one project's active Navigation Index generation,
	// tied to the exact Catalog Projection the rows were derived from. Rows of
	// earlier projections are uncounted garbage that the reset worker reclaims
	// in batches. The optional completeness facts stay unset for a legacy
	// generation until its backfill verifies them; the read paths treat a
	// missing status or ordinary-import count envelope as incomplete and fail
	// closed instead of guessing.
	catalogWorkspaceNavigationStates: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		// Monotonically advances whenever the active Navigation generation changes.
		// Durable consumers such as Release Assessment capture it as an exact
		// Workspace basis and fail closed if editing continues while they prepare.
		revision: v.optional(v.number()),
		rowCount: v.number(),
		byteLength: v.number(),
		status: v.optional(
			v.union(
				v.literal("staging"),
				v.literal("verifying"),
				v.literal("ready"),
				v.literal("failed"),
			),
		),
		expectedRowCount: v.optional(v.number()),
		expectedByteLength: v.optional(v.number()),
		// Resumable backfill progress over the active generation, in Catalog
		// Order: the last catalog index whose key the backfill already covered.
		backfillLastCatalogIndex: v.optional(v.number()),
		// Chunked envelope verification progress; verification recounts the rows
		// and fails closed on any drift from the declared envelope.
		verificationLastCatalogIndex: v.optional(v.number()),
		verifiedRowCount: v.optional(v.number()),
		verifiedByteLength: v.optional(v.number()),
		// Persisted ordinary-import counts make the Agent read proportional to
		// the requested page rather than the whole Navigation Index.
		ordinaryImportCounts: v.optional(v.object(ordinaryImportCounts)),
		// Versioned separately from policy's public name so category semantics can
		// force one safe rebuild without inventing a second user-facing policy.
		ordinaryImportPolicyVersion: v.optional(v.number()),
		// A legacy ready state has no derived counts or repeated-value facts.
		// The first operator backfill force-rebuilds its rows into the new shape.
		backfillForceRebuild: v.optional(v.boolean()),
		// Prevents two scheduled continuation steps from doing the same work.
		backfillStepPending: v.optional(v.boolean()),
		// Platform limits can terminate a scheduled function before it clears the
		// flag above. The timestamp turns that flag into a short, resumable lease.
		backfillStepPendingAt: v.optional(v.number()),
		// A failed scheduled step is terminal until an explicit retry command
		// clears this diagnostic and re-arms the worker.
		backfillFailure: v.optional(
			v.object({
				code: v.optional(v.string()),
				message: v.string(),
				failedAt: v.number(),
			}),
		),
	}).index("by_project", ["projectId"]),

	// The per-projection staging envelope for a Navigation Index generation that
	// is not visible yet: either a pending Baseline publication or a backfill of
	// the active generation. Publication is only allowed once this envelope is
	// complete, so the Navigation read can rely on the exact Catalog Projection
	// it read from without ever observing a partially staged generation.
	catalogWorkspaceNavigationStaging: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		status: v.union(v.literal("staging"), v.literal("ready")),
		// Progress cursor in Catalog Order: the last catalog index whose key the
		// staging worker already derived and upserted.
		lastCatalogIndex: v.number(),
		rowCount: v.number(),
		byteLength: v.number(),
		expectedRowCount: v.number(),
		// Recorded once the last key is staged, so the publish gate can compare
		// the complete envelope rather than trusting incremental sums alone.
		expectedByteLength: v.optional(v.number()),
		ordinaryImportCounts: v.optional(v.object(ordinaryImportCounts)),
	})
		.index("by_projection", ["projectionId"])
		.index("by_project", ["projectId"]),

	// The durable automatic actions for one accepted Baseline transition. They
	// are normalized separately from the active projection, so the action view
	// never needs to scan prior working-catalog rows.
	catalogProjectionRestorations: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
		catalogIndex: v.number(),
		messageId: v.string(),
		value: v.string(),
		metadataCatalogPath: v.optional(v.string()),
		metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
		sourceFingerprint: v.string(),
		materialized: v.boolean(),
		restoredFromSnapshotId: v.id("sourceSnapshots"),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_catalogIndex", ["projectionId", "catalogIndex"])
		.index("by_projection_and_messageId", ["projectionId", "messageId"]),

	// Git-authored value changes are staged alongside a catalog projection, then
	// become visible with it. Their two values point through their projection's
	// previous/current Snapshot provenance instead of pretending a translator
	// authored either side.
	catalogProjectionGitChanges: defineTable({
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		isSource: v.boolean(),
		catalogIndex: v.number(),
		messageId: v.string(),
		previousCatalogPath: v.string(),
		catalogPath: v.string(),
		previousValue: v.string(),
		value: v.string(),
		previousSourceFingerprint: v.string(),
		sourceFingerprint: v.string(),
		previousMaterialized: v.boolean(),
		materialized: v.boolean(),
	})
		.index("by_projection", ["projectionId"])
		// Catalog Workspace stale-state derivation needs only source transitions;
		// keeping that read separate avoids duplicating every changed target value.
		.index("by_projection_and_isSource", ["projectionId", "isSource"])
		// Window composition reads one bounded Catalog Order range per window.
		.index("by_projection_and_catalogIndex", ["projectionId", "catalogIndex"])
		// Window composition point-reads the Git-change evidence of one key.
		.index("by_projection_and_messageId", ["projectionId", "messageId"])
		.index("by_projection_and_messageId_and_isSource", [
			"projectionId",
			"messageId",
			"isSource",
		]),

	// The translator work a Contract Transform could not repair mechanically.
	// Rows are grouped by Locale value; the reason array is capped by the four
	// concrete residue reasons at staging time.
	catalogProjectionTranslationResidues: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
		catalogIndex: v.number(),
		messageId: v.string(),
		reasons: v.array(translationResidueReason),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_messageId", ["projectionId", "messageId"]),

	// One durable Reconciliation Report describes the consequences of one
	// accepted Baseline transition. Its rows and facts are normalized so report
	// history can grow without turning one document into an unbounded worklist.
	reconciliationReports: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		snapshotId: v.optional(v.id("sourceSnapshots")),
		previousSnapshotId: v.optional(v.id("sourceSnapshots")),
		workHandoffId: v.optional(v.id("reconciliationWorkHandoffs")),
		status: v.union(
			v.literal("staging"),
			v.literal("staged"),
			v.literal("published"),
		),
		expectedRowCount: v.number(),
		expectedFactCount: v.number(),
		expectedByteLength: v.number(),
		stagedRowCount: v.number(),
		stagedFactCount: v.number(),
		stagedByteLength: v.number(),
		createdAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_status", ["projectId", "status"])
		.index("by_projection", ["projectionId"]),

	// A row is key-level (or the exceptional Locale/file setup row). Facts keep
	// each Locale's consequence and disposition independently readable.
	reconciliationReportRows: defineTable({
		projectId: v.id("projects"),
		reportId: v.id("reconciliationReports"),
		group: reconciliationReportGroup,
		groupOrder: v.number(),
		subject: reconciliationReportSubject,
		subjectKey: v.string(),
		catalogIndex: v.number(),
		messageId: v.optional(v.string()),
		catalogPath: v.optional(v.string()),
	})
		.index("by_report_and_groupOrder_and_catalogIndex", [
			"reportId",
			"groupOrder",
			"catalogIndex",
		])
		.index("by_report_and_groupOrder_and_subject_and_subjectKey", [
			"reportId",
			"groupOrder",
			"subject",
			"subjectKey",
		])
		.index("by_report", ["reportId"]),

	reconciliationReportFacts: defineTable({
		projectId: v.id("projects"),
		reportId: v.id("reconciliationReports"),
		rowId: v.id("reconciliationReportRows"),
		localeId: v.optional(v.id("locales")),
		localeCode: v.optional(v.string()),
		catalogPath: v.optional(v.string()),
		kind: reconciliationReportFactKind,
		reasonCodes: v.optional(v.array(translationResidueCode)),
		transformCode: v.optional(contractTransformCode),
		relatedSnapshotId: v.optional(v.id("sourceSnapshots")),
		declaredLocaleCode: v.optional(v.string()),
		messageCount: v.optional(v.number()),
		disposedBy: v.optional(actor),
		disposedAt: v.optional(v.number()),
	})
		.index("by_row", ["rowId"])
		.index("by_report", ["reportId"]),

	// A Work Hand-off freezes the exact key set a report passes to Strings. It
	// intentionally remains separate from the report header so its bounded
	// members can be read without duplicating them into every report document.
	reconciliationWorkHandoffs: defineTable({
		projectId: v.id("projects"),
		reportId: v.id("reconciliationReports"),
		status: v.union(
			v.literal("staging"),
			v.literal("staged"),
			v.literal("published"),
		),
		expectedKeyCount: v.number(),
		expectedByteLength: v.number(),
		stagedKeyCount: v.number(),
		stagedByteLength: v.number(),
	}).index("by_report", ["reportId"]),

	reconciliationWorkHandoffKeys: defineTable({
		projectId: v.id("projects"),
		handoffId: v.id("reconciliationWorkHandoffs"),
		catalogIndex: v.number(),
		messageId: v.string(),
	}).index("by_handoff", ["handoffId"]),

	// A Release Record is one immutable, durable assessment of an exact
	// Baseline plus Workspace revision. Preparation is resumable; once ready,
	// its normalized findings and evidence remain historical release truth.
	releaseRecords: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		snapshotId: v.id("sourceSnapshots"),
		commit: v.string(),
		navigationRevision: v.number(),
		expectedKeyCount: v.number(),
		handoffId: v.id("releaseWorkHandoffs"),
		status: v.union(
			v.literal("preparing"),
			v.literal("ready"),
			v.literal("superseded"),
			v.literal("failed"),
		),
		posture: v.optional(releasePosture),
		...releaseAssessmentFields,
		startedBy: actor,
		failure: v.optional(
			v.object({
				code: v.optional(v.string()),
				message: v.string(),
				failedAt: v.number(),
			}),
		),
		createdAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_createdAt", ["projectId", "createdAt"])
		.index("by_project_and_projection_and_navigationRevision", [
			"projectId",
			"projectionId",
			"navigationRevision",
		]),

	// Preparation is the mutable, resumable side of a Release Record. Keeping
	// it separate means progress writes do not invalidate immutable history.
	releaseRecordPreparations: defineTable({
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
		cursor: v.number(),
		...releaseAssessmentFields,
		terminal: v.optional(
			v.union(
				v.object({
					status: v.literal("superseded"),
					completedAt: v.number(),
				}),
				v.object({
					status: v.literal("failed"),
					completedAt: v.number(),
					failure: v.object({
						code: v.optional(v.string()),
						message: v.string(),
						failedAt: v.number(),
					}),
				}),
			),
		),
		stepPending: v.boolean(),
		updatedAt: v.number(),
	}).index("by_recordId", ["recordId"]),

	releaseFindings: defineTable({
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
		catalogIndex: v.number(),
		messageId: v.string(),
		localeId: v.id("locales"),
		localeCode: v.string(),
		kind: releaseFindingKind,
		reasonCodes: v.optional(v.array(translationResidueCode)),
	})
		.index("by_record", ["recordId"])
		.index("by_record_and_catalogIndex", ["recordId", "catalogIndex"]),

	releaseEvidence: defineTable(
		v.union(
			v.object({
				projectId: v.id("projects"),
				recordId: v.id("releaseRecords"),
				catalogIndex: v.number(),
				messageId: v.string(),
				localeId: v.id("locales"),
				localeCode: v.string(),
				kind: v.literal("intentional_blank"),
				reason: v.string(),
			}),
			v.object({
				projectId: v.id("projects"),
				recordId: v.id("releaseRecords"),
				catalogIndex: v.number(),
				messageId: v.string(),
				localeId: v.id("locales"),
				localeCode: v.string(),
				kind: v.literal("source_identical"),
			}),
		),
	)
		.index("by_record", ["recordId"])
		.index("by_record_and_catalogIndex", ["recordId", "catalogIndex"]),

	releaseWorkHandoffs: defineTable({
		projectId: v.id("projects"),
		recordId: v.optional(v.id("releaseRecords")),
		status: v.union(v.literal("staging"), v.literal("published")),
		keyCount: v.number(),
		byteLength: v.number(),
	}).index("by_record", ["recordId"]),

	releaseWorkHandoffKeys: defineTable({
		projectId: v.id("projects"),
		handoffId: v.id("releaseWorkHandoffs"),
		catalogIndex: v.number(),
		messageId: v.string(),
	}).index("by_handoff", ["handoffId"]),

	// One immutable Release Bundle per approved Release Record. Construction is
	// an explicit, durable run; the complete artifact lives in file storage and
	// the local Repository Adapter can only ask Blabla to apply its delta.
	releaseBuildRuns: defineTable({
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
		status: v.union(
			v.literal("building"),
			v.literal("ready"),
			v.literal("failed"),
		),
		startedBy: actor,
		bundleStorageId: v.optional(v.id("_storage")),
		bundleHash: v.optional(v.string()),
		bundleByteLength: v.optional(v.number()),
		changeKeyCount: v.optional(v.number()),
		failure: v.optional(
			v.object({
				code: v.optional(v.string()),
				message: v.string(),
				failedAt: v.number(),
			}),
		),
		createdAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index("by_record", ["recordId"])
		.index("by_project_and_createdAt", ["projectId", "createdAt"]),

	// The exact catalog tree observed by a local delivery. It is evidence for
	// the Release Record, never a candidate Baseline Snapshot.
	releaseBuildChunks: defineTable({
		runId: v.id("releaseBuildRuns"),
		storageId: v.id("_storage"),
	}).index("by_runId", ["runId"]),
	releaseDeliveryCaptureFiles: defineTable({
		captureId: v.id("releaseDeliveryCaptures"),
		catalogPath: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		byteLength: v.number(),
	})
		.index("by_captureId_and_catalogPath", ["captureId", "catalogPath"])
		.index("by_storageId", ["storageId"]),
	releaseDeliveryCaptures: defineTable({
		projectId: v.id("projects"),
		recordId: v.id("releaseRecords"),
		runId: v.id("releaseBuildRuns"),
		deliveredBy: actor,
		captureStorageId: v.id("_storage"),
		captureHash: v.string(),
		captureByteLength: v.number(),
		appliedCount: v.number(),
		// The complete report stays in captureStorageId. Keeping only its count
		// here avoids Convex's document-array ceiling on large releases.
		skippedCount: v.number(),
		createdAt: v.number(),
	})
		.index("by_record_and_captureHash", ["recordId", "captureHash"])
		.index("by_record_and_createdAt", ["recordId", "createdAt"]),

	// Automatic Archive Reconciliation remains normalized and tied to the
	// accepted projection that made it visible. Published rows are immutable
	// history; only abandoned staging rows are ever discarded.
	catalogProjectionArchiveKeys: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		catalogIndex: v.number(),
		messageId: v.string(),
		sourceFingerprint: v.string(),
	})
		.index("by_projection", ["projectionId"])
		.index("by_project_and_messageId", ["projectId", "messageId"]),

	catalogProjectionArchiveLocales: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
	})
		.index("by_projection", ["projectionId"])
		.index("by_project_and_localeId", ["projectId", "localeId"]),

	catalogProjectionArchiveValues: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
		isSource: v.boolean(),
		catalogIndex: v.number(),
		messageId: v.string(),
		value: v.string(),
		valueFingerprint: v.optional(v.string()),
		metadataCatalogPath: v.optional(v.string()),
		metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
		restoredFromSnapshotId: v.optional(v.id("sourceSnapshots")),
		gitValueFingerprint: v.optional(v.string()),
		gitValueRevision: v.optional(v.number()),
		repeatedGitContent: v.optional(v.boolean()),
		repeatedGitContentVersion: v.optional(v.number()),
		metadataTransforms,
		sourceFingerprint: v.string(),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		argumentNames: v.array(v.string()),
		argumentNamesComplete: v.boolean(),
		argumentNameCount: v.number(),
		declaredPlaceholderNames: v.optional(v.array(v.string())),
		declaredPlaceholderNamesComplete: v.optional(v.boolean()),
		declaredPlaceholderNameCount: v.optional(v.number()),
		introducedAt: v.optional(v.number()),
		introductionLocaleIds: v.optional(v.array(v.id("locales"))),
		materialized: v.boolean(),
		keyArchived: v.boolean(),
		localeArchived: v.boolean(),
		evidenceSnapshotId: v.id("sourceSnapshots"),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_catalogIndex", ["projectionId", "catalogIndex"])
		.index("by_project_and_messageId", ["projectId", "messageId"])
		.index("by_project_and_localeId", ["projectId", "localeId"]),

	// A complete archive state is staged for each accepted projection. It keeps
	// current recovery lookup bounded even when a key stays absent across many
	// later baselines; the immutable Archive Reconciliation rows above retain
	// the per-transition history.
	catalogProjectionArchiveStateValues: defineTable({
		projectId: v.id("projects"),
		projectionId: v.id("catalogProjections"),
		localeId: v.id("locales"),
		localeCode: v.string(),
		catalogPath: v.string(),
		isSource: v.boolean(),
		catalogIndex: v.number(),
		messageId: v.string(),
		value: v.string(),
		valueFingerprint: v.optional(v.string()),
		metadataCatalogPath: v.optional(v.string()),
		metadataSnapshotId: v.optional(v.id("sourceSnapshots")),
		restoredFromSnapshotId: v.optional(v.id("sourceSnapshots")),
		gitValueFingerprint: v.optional(v.string()),
		gitValueRevision: v.optional(v.number()),
		repeatedGitContent: v.optional(v.boolean()),
		repeatedGitContentVersion: v.optional(v.number()),
		metadataTransforms,
		sourceFingerprint: v.string(),
		icuType: v.union(v.literal("plain"), v.literal("icu")),
		argumentNames: v.array(v.string()),
		argumentNamesComplete: v.boolean(),
		argumentNameCount: v.number(),
		declaredPlaceholderNames: v.optional(v.array(v.string())),
		declaredPlaceholderNamesComplete: v.optional(v.boolean()),
		declaredPlaceholderNameCount: v.optional(v.number()),
		introducedAt: v.optional(v.number()),
		introductionLocaleIds: v.optional(v.array(v.id("locales"))),
		materialized: v.boolean(),
		keyArchived: v.boolean(),
		localeArchived: v.boolean(),
		evidenceSnapshotId: v.id("sourceSnapshots"),
	})
		.index("by_projection", ["projectionId"])
		.index("by_projection_and_isSource", ["projectionId", "isSource"])
		.index("by_projection_and_messageId", ["projectionId", "messageId"]),

	// Source Proposals retain durable candidate evidence beside Git. Restore
	// Proposals recover an archived key; Source Proposals change the value of an
	// existing source key without rewriting the Source Contract.
	sourceProposals: defineTable(sourceProposal)
		.index("by_project", ["projectId"])
		.index("by_project_and_status", ["projectId", "status"])
		.index("by_project_and_messageId_and_status", [
			"projectId",
			"messageId",
			"status",
		]),

	// The current proposal for one archived key. It remains small and point
	// readable while sourceProposals retains the immutable, unbounded history of
	// recovery requests. A published resolution is derived from its projection
	// head rather than rewritten across every proposal in one transaction.
	sourceProposalOpenHeads: defineTable({
		projectId: v.id("projects"),
		messageId: v.string(),
		proposalId: v.id("sourceProposals"),
	})
		.index("by_project", ["projectId"])
		.index("by_project_and_messageId", ["projectId", "messageId"]),

	// A lightweight head records one private projection's observation of a
	// Source Proposal. The physical table name predates this feature, but its
	// projection-bound lifecycle is shared: competing private projections may
	// observe the same proposal; only the accepted Baseline makes it visible.
	restoreProposalResolutionHeads: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("sourceProposals"),
		projectionId: v.id("catalogProjections"),
		messageId: v.string(),
		status: v.union(v.literal("landed"), v.literal("superseded")),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_proposal_and_projection", ["proposalId", "projectionId"])
		.index("by_projection", ["projectionId"]),

	apiTokens: defineTable({
		projectId: v.id("projects"),
		name: v.string(),
		tokenHash: v.string(),
		scopes: v.array(tokenScopeValidator),
		createdByUserId: v.string(),
		createdAt: v.number(),
		lastUsedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	})
		.index("by_project", ["projectId"])
		.index("by_tokenHash", ["tokenHash"])
		.index("by_revokedAt", ["revokedAt"]),

	agentReviewGrants: defineTable({
		revision: v.number(),
		projectId: v.id("projects"),
		candidateRevisionId: v.id("agentTranslationCandidateRevisions"),
		reviewerTokenId: v.id("apiTokens"),
		grantedByUserId: v.string(),
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
		revokedByUserId: v.optional(v.string()),
	})
		.index("by_revision", ["candidateRevisionId"])
		.index("by_revision_and_reviewer", [
			"candidateRevisionId",
			"reviewerTokenId",
		]),

	// Agent Translation Proposals are immutable candidate evidence. They never
	// become current values until a human or explicitly authorized independent
	// reviewer accepts a revision through the proposal module.
	agentTranslationProposals: defineTable({
		projectId: v.id("projects"),
		// Agent-created proposals retain their owning token. Human-created
		// Translation Tasks deliberately have no token owner: any current
		// project-scoped propose token may fill their frozen target scope.
		createdByTokenId: v.optional(v.id("apiTokens")),
		createdBy: actor,
		clientProposalKey: v.string(),
		target: agentTranslationProposalTarget,
		taskScope: v.optional(
			v.object({
				localeId: v.id("locales"),
				localeCode: v.string(),
				targetCount: v.number(),
			}),
		),
		// Widening field for the unified Translation Task seam. Existing taskScope
		// records remain valid while new-Locale tasks page the complete pinned
		// Locale Proposal rather than copying its source template into task rows.
		localeProposalTaskScope: v.optional(
			v.object({
				localeProposalId: v.id("localeProposals"),
				localeCode: v.string(),
				targetCount: v.number(),
			}),
		),
		status: v.union(
			v.literal("open"),
			v.literal("accepted"),
			v.literal("rejected"),
		),
		candidateCount: v.number(),
		revisionCount: v.number(),
		retainedByteLength: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project_and_token_and_clientProposalKey", [
			"projectId",
			"createdByTokenId",
			"clientProposalKey",
		])
		.index("by_owner_and_existingTask", [
			"projectId",
			"createdByTokenId",
			"taskScope.localeId",
		])
		.index("by_owner_and_newLocaleTask", [
			"projectId",
			"createdByTokenId",
			"localeProposalTaskScope.localeProposalId",
		])
		.index("by_project_and_updatedAt", ["projectId", "updatedAt"]),

	// A Translation Task freezes a small, human-legible key/Locale scope without
	// copying the catalog into one reactive document. Reads resolve each target's
	// live Source and target facts; every immutable candidate revision captures
	// the server-owned basis it actually answers, so agents submit only values.
	translationTaskTargets: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("agentTranslationProposals"),
		catalogIndex: v.number(),
		messageId: v.string(),
		localeId: v.id("locales"),
		localeCode: v.string(),
		sourceValue: v.optional(v.string()),
		targetValue: v.optional(v.string()),
		targetCatalogPath: v.optional(v.string()),
		basis: v.union(
			agentTranslationCatalogWorkspaceBasis,
			managedBasisValidator,
		),
		createdAt: v.number(),
	})
		.index("by_proposal_and_catalogIndex", ["proposalId", "catalogIndex"])
		.index("by_proposal_and_messageId", ["proposalId", "messageId"]),

	agentTranslationCandidates: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("agentTranslationProposals"),
		messageId: v.string(),
		localeId: v.optional(v.id("locales")),
		localeProposalId: v.optional(v.id("localeProposals")),
		currentRevision: v.number(),
		latestRevisionId: v.optional(v.id("agentTranslationCandidateRevisions")),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_proposal_and_messageId_and_localeId", [
			"proposalId",
			"messageId",
			"localeId",
		])
		.index("by_proposal_and_messageId_and_localeProposalId", [
			"proposalId",
			"messageId",
			"localeProposalId",
		]),

	agentTranslationCandidateRevisions: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("agentTranslationProposals"),
		candidateId: v.id("agentTranslationCandidates"),
		messageId: v.string(),
		localeId: v.optional(v.id("locales")),
		localeProposalId: v.optional(v.id("localeProposals")),
		revision: v.number(),
		clientRevisionKey: v.string(),
		value: v.string(),
		// An agent may propose an Intentional Blank and explain why, but only a
		// human or authorized independent review can apply it to either task adapter.
		intentionalBlankReason: v.optional(v.string()),
		valueFingerprint: v.string(),
		basis: agentTranslationCandidateBasis,
		createdBy: actor,
		createdAt: v.number(),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_candidate_and_revision", ["candidateId", "revision"])
		.index("by_candidate_and_clientRevisionKey", [
			"candidateId",
			"clientRevisionKey",
		]),

	agentTranslationCandidateReviews: defineTable({
		projectId: v.id("projects"),
		proposalId: v.id("agentTranslationProposals"),
		candidateId: v.id("agentTranslationCandidates"),
		revisionId: v.id("agentTranslationCandidateRevisions"),
		decision: agentTranslationCandidateReviewDecision,
		reviewer: actor,
		reviewAuthorization: v.optional(agentReviewAuthorizationValidator),
		finalValue: v.optional(v.string()),
		finalValueFingerprint: v.optional(v.string()),
		// The candidate keeps its authored basis. This separate basis records what
		// the human actually applied, including an explicit keep after Source drift.
		appliedBasis: v.optional(agentTranslationCandidateBasis),
		createdAt: v.number(),
	})
		.index("by_proposal", ["proposalId"])
		.index("by_revision", ["revisionId"])
		.index("by_candidate", ["candidateId"]),

	// Retained historical evidence. No legacy catalog or Change Set writers remain.
	changeSets: defineTable({
		projectId: v.id("projects"),
		title: v.string(),
		description: v.optional(v.string()),
		author: changeSetAuthor,
		authorKind: v.union(v.literal("user"), v.literal("agent")),
		authorId: v.string(),
		status: v.union(
			v.literal("draft"),
			v.literal("open"),
			v.literal("approved"),
			v.literal("rejected"),
			v.literal("applied"),
		),
		baseSnapshotVersion: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		openedAt: v.optional(v.number()),
		reviewedAt: v.optional(v.number()),
		appliedAt: v.optional(v.number()),
		reviewedByUserId: v.optional(v.string()),
		summary: v.object({
			filesChanged: v.number(),
			fieldsChanged: v.number(),
			additions: v.number(),
			deletions: v.number(),
		}),
	})
		.index("by_project", ["projectId"])
		.index("by_project_status", ["projectId", "status"])
		.index("by_author", ["authorKind", "authorId"])
		.index("by_updatedAt", ["updatedAt"]),

	changeSetItems: defineTable({
		projectId: v.id("projects"),
		changeSetId: v.id("changeSets"),
		kind: v.union(
			v.literal("translation_value"),
			v.literal("key_metadata"),
			v.literal("locale_create"),
			v.literal("locale_archive"),
			v.literal("key_create"),
			v.literal("key_archive"),
		),
		keyId: v.optional(v.id("translationKeys")),
		localeId: v.optional(v.id("locales")),
		fieldPath: v.string(),
		previousValue: v.union(v.string(), v.null()),
		nextValue: v.union(v.string(), v.null()),
		originalNextValue: v.optional(v.string()),
		baseVersion: v.optional(v.number()),
		status: v.union(
			v.literal("pending"),
			v.literal("accepted"),
			v.literal("rejected"),
			v.literal("conflicted"),
		),
		createdAt: v.number(),
	})
		.index("by_changeSet", ["changeSetId"])
		.index("by_key", ["keyId"])
		.index("by_locale", ["localeId"])
		.index("by_status", ["status"]),

	importJobs: defineTable({
		projectId: v.id("projects"),
		workflowId: v.optional(v.string()),
		kind: v.union(v.literal("json"), v.literal("arb")),
		status: v.union(
			v.literal("queued"),
			v.literal("running"),
			v.literal("completed"),
			v.literal("failed"),
		),
		input: importJobInput,
		result: v.optional(importJobResult),
		createdBy: actor,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_status", ["status"]),

	exportJobs: defineTable({
		projectId: v.id("projects"),
		workflowId: v.optional(v.string()),
		kind: v.union(v.literal("json"), v.literal("arb")),
		status: v.union(
			v.literal("queued"),
			v.literal("running"),
			v.literal("completed"),
			v.literal("failed"),
		),
		input: exportJobInput,
		result: v.optional(exportJobResult),
		createdBy: actor,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["projectId"])
		.index("by_status", ["status"]),
});
