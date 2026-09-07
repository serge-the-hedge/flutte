import { ConvexError } from "convex/values";

import {
	type CatalogDocument,
	parse,
	patchMessageValues,
	withMessage,
	withValue,
} from "./catalogDocument";

export type ReleaseBundleArtifact = {
	version: 1;
	releaseRecord: {
		id: string;
		projectId: string;
		baselineSnapshotId: string;
		repository: string;
		baselineCommit: string;
		manifestHash: string;
		integrationBranch: string;
	};
	catalogs: Array<{
		localeCode: string;
		catalogPath: string;
		isSource: boolean;
	}>;
	changes: Array<{
		catalogIndex: number;
		messageId: string;
		baselineSourceValue: string;
		values: Array<{
			localeCode: string;
			catalogPath: string;
			isSource: boolean;
			baselineValue: string;
			value: string;
		}>;
	}>;
};

export type ReleaseBundleManifest = Omit<
	ReleaseBundleArtifact,
	"version" | "changes"
> & {
	version: 2;
	changeKeyCount: number;
	chunks: Array<{
		catalogPath: string;
		storageId: string;
		contentHash: string;
		byteLength: number;
		changeKeyCount: number;
	}>;
};
export type StoredReleaseBundle = ReleaseBundleArtifact | ReleaseBundleManifest;

export type DeliveryTreeResult = {
	files: Array<{ catalogPath: string; content: string }>;
	applied: string[];
	skipped: Array<{
		messageId: string;
		reason: "missing_source" | "source_changed";
	}>;
};

function invalid(message: string): never {
	throw new ConvexError({ code: "VALIDATION", message });
}

function messageValue(document: CatalogDocument, messageId: string) {
	return document.messages.find((message) => message.id === messageId)?.value;
}

/** Apply a server-authored Release Delta to the exact catalog tree a local
 * Repository Adapter is about to write. Target drift is intentionally
 * overwritten; a missing key or changed Source Contract skips the whole key.
 * The returned files are complete, deterministic catalog bytes. */
export function applyReleaseBundleToDeliveryTree(
	bundle: ReleaseBundleArtifact,
	files: readonly { catalogPath: string; content: string }[],
): DeliveryTreeResult {
	if (bundle.version !== 1) invalid("Unsupported Release Bundle version.");
	const catalogByPath = new Map(
		bundle.catalogs.map((file) => [file.catalogPath, file]),
	);
	if (catalogByPath.size !== bundle.catalogs.length) {
		invalid("Release Bundle contains duplicate catalog paths.");
	}
	const contentByPath = new Map<string, string>();
	for (const file of files) {
		if (contentByPath.has(file.catalogPath)) {
			invalid(`Delivery tree repeats ${file.catalogPath}.`);
		}
		if (!catalogByPath.has(file.catalogPath)) {
			invalid(`Delivery tree contains unbound catalog ${file.catalogPath}.`);
		}
		contentByPath.set(file.catalogPath, file.content);
	}
	if (contentByPath.size !== bundle.catalogs.length) {
		const missing = bundle.catalogs.find(
			(catalog) => !contentByPath.has(catalog.catalogPath),
		);
		invalid(
			`Delivery tree is missing ${missing?.catalogPath ?? "a bound catalog"}.`,
		);
	}
	const sourceCatalog = bundle.catalogs.find((catalog) => catalog.isSource);
	if (
		!sourceCatalog ||
		bundle.catalogs.filter((catalog) => catalog.isSource).length !== 1
	) {
		invalid("Release Bundle needs exactly one Source catalog.");
	}
	const documents = new Map<string, CatalogDocument>();
	for (const catalog of bundle.catalogs) {
		const content = contentByPath.get(catalog.catalogPath);
		if (content === undefined)
			invalid(`Delivery tree is missing ${catalog.catalogPath}.`);
		documents.set(catalog.catalogPath, parse(content));
	}

	const applied: string[] = [];
	const skipped: DeliveryTreeResult["skipped"] = [];
	const updatesByCatalogPath = new Map<
		string,
		Array<{ id: string; value: string }>
	>();
	for (const change of bundle.changes) {
		const source = documents.get(sourceCatalog.catalogPath);
		if (!source) invalid("Delivery tree lost its Source catalog.");
		const treeSourceValue = messageValue(source, change.messageId);
		if (treeSourceValue === undefined) {
			skipped.push({ messageId: change.messageId, reason: "missing_source" });
			continue;
		}
		if (treeSourceValue !== change.baselineSourceValue) {
			skipped.push({ messageId: change.messageId, reason: "source_changed" });
			continue;
		}
		for (const value of change.values) {
			if (!catalogByPath.has(value.catalogPath)) {
				invalid(`Release change targets unbound catalog ${value.catalogPath}.`);
			}
			const document = documents.get(value.catalogPath);
			if (!document) invalid(`Delivery tree is missing ${value.catalogPath}.`);
			const currentValue = messageValue(document, change.messageId);
			if (currentValue === value.value) continue;
			const next =
				currentValue === undefined
					? withMessage(document, change.messageId, value.value)
					: withValue(document, change.messageId, value.value);
			documents.set(value.catalogPath, next);
			const updates = updatesByCatalogPath.get(value.catalogPath) ?? [];
			updates.push({ id: change.messageId, value: value.value });
			updatesByCatalogPath.set(value.catalogPath, updates);
		}
		applied.push(change.messageId);
	}

	return {
		files: bundle.catalogs.map((catalog) => {
			const document = documents.get(catalog.catalogPath);
			if (!document)
				invalid(`Delivery tree is missing ${catalog.catalogPath}.`);
			return {
				catalogPath: catalog.catalogPath,
				content: patchMessageValues(
					contentByPath.get(catalog.catalogPath) as string,
					updatesByCatalogPath.get(catalog.catalogPath) ?? [],
				),
			};
		}),
		applied,
		skipped,
	};
}
