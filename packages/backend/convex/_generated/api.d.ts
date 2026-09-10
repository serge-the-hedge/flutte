/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as messageConstraints from "../messageConstraints.js";
import type * as contentModel from "../contentModel.js";
import type * as contentCollections from "../contentCollections.js";
import type * as managedContent from "../managedContent.js";
import type * as agentContent from "../agentContent.js";
import type * as catalogBrowse from "../catalogBrowse.js";
import type * as catalogProcessing from "../catalogProcessing.js";
import type * as snapshotUploads from "../snapshotUploads.js";
import type * as releaseUploadDelivery from "../releaseUploadDelivery.js";
import type * as accessControl from "../accessControl.js";
import type * as agentRetrieval from "../agentRetrieval.js";
import type * as catalogSearch from "../catalogSearch.js";
import type * as catalogWorkspaceRead from "../catalogWorkspaceRead.js";
import type * as agentProposalRetrieval from "../agentProposalRetrieval.js";
import type * as translationHistory from "../translationHistory.js";
import type * as translationHistoryModel from "../translationHistoryModel.js";
import type * as translationHistoryWrite from "../translationHistoryWrite.js";
import type * as translationGuidance from "../translationGuidance.js";
import type * as translationGuidanceModel from "../translationGuidanceModel.js";
import type * as agentApi from "../agentApi.js";
import type * as agentDictionary from "../agentDictionary.js";
import type * as agentReviewModel from "../agentReviewModel.js";
import type * as agentReviews from "../agentReviews.js";
import type * as agentTranslationProposals from "../agentTranslationProposals.js";
import type * as apiTokens from "../apiTokens.js";
import type * as archiveReconciliation from "../archiveReconciliation.js";
import type * as auth from "../auth.js";
import type * as catalogDocument from "../catalogDocument.js";
import type * as catalogIntroductionReviews from "../catalogIntroductionReviews.js";
import type * as catalogProjection from "../catalogProjection.js";
import type * as catalogWorkspace from "../catalogWorkspace.js";
import type * as catalogWorkspaceDecisionQueries from "../catalogWorkspaceDecisionQueries.js";
import type * as catalogWorkspaceNavigation from "../catalogWorkspaceNavigation.js";
import type * as catalogWorkspaceView from "../catalogWorkspaceView.js";
import type * as contractTransforms from "../contractTransforms.js";
import type * as crons from "../crons.js";
import type * as emails from "../emails.js";
import type * as exports from "../exports.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as lib from "../lib.js";
import type * as localeIntroductionTargets from "../localeIntroductionTargets.js";
import type * as localeDelivery from "../localeDelivery.js";
import type * as localeProposals from "../localeProposals.js";
import type * as locales from "../locales.js";
import type * as messageFacts from "../messageFacts.js";
import type * as ordinaryImportConfirmations from "../ordinaryImportConfirmations.js";
import type * as ordinaryImportRuns from "../ordinaryImportRuns.js";
import type * as permissions from "../permissions.js";
import type * as privateData from "../privateData.js";
import type * as projects from "../projects.js";
import type * as dictionaries from "../dictionaries.js";
import type * as dictionaryAccess from "../dictionaryAccess.js";
import type * as projectStructure from "../projectStructure.js";
import type * as rateLimits from "../rateLimits.js";
import type * as reconciliationReports from "../reconciliationReports.js";
import type * as releaseBundleModel from "../releaseBundleModel.js";
import type * as releaseBundles from "../releaseBundles.js";
import type * as releaseRecordModel from "../releaseRecordModel.js";
import type * as releaseRecords from "../releaseRecords.js";
import type * as restoreProposals from "../restoreProposals.js";
import type * as snapshotOriginIndex from "../snapshotOriginIndex.js";
import type * as snapshotCatalog from "../snapshotCatalog.js";
import type * as snapshots from "../snapshots.js";
import type * as sourceProposals from "../sourceProposals.js";
import type * as translationResidue from "../translationResidue.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  messageConstraints: typeof messageConstraints;
  contentModel: typeof contentModel;
  contentCollections: typeof contentCollections;
  managedContent: typeof managedContent;
  agentContent: typeof agentContent;

  catalogBrowse: typeof catalogBrowse;
  catalogProcessing: typeof catalogProcessing;
  snapshotUploads: typeof snapshotUploads;
  releaseUploadDelivery: typeof releaseUploadDelivery;
  accessControl: typeof accessControl;
  agentRetrieval: typeof agentRetrieval;
  catalogSearch: typeof catalogSearch;
  catalogWorkspaceRead: typeof catalogWorkspaceRead;
  agentProposalRetrieval: typeof agentProposalRetrieval;
  translationHistory: typeof translationHistory;
  translationHistoryModel: typeof translationHistoryModel;
  translationHistoryWrite: typeof translationHistoryWrite;
  translationGuidance: typeof translationGuidance;
  translationGuidanceModel: typeof translationGuidanceModel;
  agentApi: typeof agentApi;
  agentDictionary: typeof agentDictionary;
  agentReviewModel: typeof agentReviewModel;
  agentReviews: typeof agentReviews;
  agentTranslationProposals: typeof agentTranslationProposals;
  apiTokens: typeof apiTokens;
  archiveReconciliation: typeof archiveReconciliation;
  auth: typeof auth;
  catalogDocument: typeof catalogDocument;
  catalogIntroductionReviews: typeof catalogIntroductionReviews;
  catalogProjection: typeof catalogProjection;
  catalogWorkspace: typeof catalogWorkspace;
  catalogWorkspaceDecisionQueries: typeof catalogWorkspaceDecisionQueries;
  catalogWorkspaceNavigation: typeof catalogWorkspaceNavigation;
  catalogWorkspaceView: typeof catalogWorkspaceView;
  contractTransforms: typeof contractTransforms;
  crons: typeof crons;
  emails: typeof emails;
  exports: typeof exports;
  healthCheck: typeof healthCheck;
  http: typeof http;
  imports: typeof imports;
  lib: typeof lib;
  localeIntroductionTargets: typeof localeIntroductionTargets;
  localeDelivery: typeof localeDelivery;
  localeProposals: typeof localeProposals;
  locales: typeof locales;
  messageFacts: typeof messageFacts;
  ordinaryImportConfirmations: typeof ordinaryImportConfirmations;
  ordinaryImportRuns: typeof ordinaryImportRuns;
  permissions: typeof permissions;
  privateData: typeof privateData;
  projects: typeof projects;
  dictionaries: typeof dictionaries;
  dictionaryAccess: typeof dictionaryAccess;
  projectStructure: typeof projectStructure;
  rateLimits: typeof rateLimits;
  reconciliationReports: typeof reconciliationReports;
  releaseBundleModel: typeof releaseBundleModel;
  releaseBundles: typeof releaseBundles;
  releaseRecordModel: typeof releaseRecordModel;
  releaseRecords: typeof releaseRecords;
  restoreProposals: typeof restoreProposals;
  snapshotCatalog: typeof snapshotCatalog;
  snapshotOriginIndex: typeof snapshotOriginIndex;
  snapshots: typeof snapshots;
  sourceProposals: typeof sourceProposals;
  translationResidue: typeof translationResidue;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  aggregate: import("@convex-dev/aggregate/_generated/component.js").ComponentApi<"aggregate">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
