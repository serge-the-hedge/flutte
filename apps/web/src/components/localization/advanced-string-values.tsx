import { useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, convexId } from "@/lib/convex-api";
import {
	readStringsCatalogKey,
	type StringsCatalogKey,
} from "@/lib/strings-catalog";
import {
	CatalogWorkspaceValueField,
	type CommitCatalogValue,
} from "./strings-catalog-view";

export function ManagedAdvancedValue({
	projectId,
	collectionId,
	catalogKey,
	localeId,
	canEdit,
	onCommitValue,
}: {
	projectId: string;
	collectionId: string;
	catalogKey: StringsCatalogKey;
	localeId: string;
	canEdit: boolean;
	onCommitValue: CommitCatalogValue;
}) {
	const address = {
		projectId: convexId<"projects">(projectId),
		collectionId: convexId<"contentCollections">(collectionId),
	};
	const collection = useQuery(api.contentCollections.get, address);
	const isSource = localeId === catalogKey.source.localeId;
	const results = useQueries({
		source: {
			query: api.managedContent.page,
			args: { ...address, focusKey: catalogKey.id, limit: 1 },
		},
		...(!isSource
			? {
					target: {
						query: api.managedContent.context,
						args: {
							...address,
							messageIds: [catalogKey.id],
							localeIds: [convexId<"locales">(localeId)],
						},
					},
				}
			: {}),
	}) as {
		source:
			| FunctionReturnType<typeof api.managedContent.page>
			| Error
			| undefined;
		target?: FunctionReturnType<typeof api.managedContent.context> | Error;
	};
	const error =
		results.source instanceof Error
			? results.source
			: results.target instanceof Error
				? results.target
				: null;
	if (error)
		return (
			<p role="alert" className="text-destructive text-sm">
				{error.message}
			</p>
		);
	if (
		!results.source ||
		results.source instanceof Error ||
		!collection ||
		(!isSource && !results.target)
	)
		return <p role="status">Loading language…</p>;
	const source = results.source.items.find(
		(item) => item.messageId === catalogKey.id,
	);
	if (!source) return <p role="status">This string is no longer available.</p>;
	const target =
		results.target && !(results.target instanceof Error)
			? results.target.items[0]
			: undefined;
	const value = isSource
		? {
				...catalogKey.source,
				value: source.sourceValue,
				editBasis: {
					kind: "managedSource" as const,
					collectionId,
					sourceRevision: source.sourceRevision,
					sourceFingerprint: source.sourceFingerprint,
					membershipRevision: collection.membershipRevision,
				},
			}
		: target
			? {
					localeId: target.localeId,
					localeCode: target.localeCode,
					isSource: false,
					value: target.value,
					materialized: false,
					editBasis: target.basis,
					valueState: target.valueState,
					intentionalBlankReason: target.intentionalBlank ?? undefined,
				}
			: undefined;
	if (!value) return <p role="status">This language is no longer available.</p>;
	return (
		<CatalogWorkspaceValueField
			advanced
			messageId={catalogKey.id}
			messageLabel={catalogKey.name ?? catalogKey.id}
			value={value}
			sourceValue={source.sourceValue}
			characterLimit={source.characterLimit}
			canEdit={canEdit}
			onCommitValue={onCommitValue}
		/>
	);
}
export function RepositoryAdvancedValue({
	projectId,
	projectionId,
	catalogKey,
	localeId,
	canEdit,
	onCommitValue,
}: {
	projectId: string;
	projectionId: string;
	catalogKey: StringsCatalogKey;
	localeId: string;
	canEdit: boolean;
	onCommitValue: CommitCatalogValue;
}) {
	const result = useQueries({
		window: {
			query: api.catalogWorkspaceNavigation.window,
			args: {
				projectId: convexId<"projects">(projectId),
				expectedProjectionId: projectionId,
				messageIds: [catalogKey.id],
				localeIds:
					catalogKey.source.localeId === localeId
						? []
						: [convexId<"locales">(localeId)],
			},
		},
	}) as {
		window:
			| FunctionReturnType<typeof api.catalogWorkspaceNavigation.window>
			| Error
			| undefined;
	};
	if (result.window instanceof Error)
		return (
			<p role="alert" className="text-destructive text-sm">
				{result.window.message}
			</p>
		);
	if (!result.window) return <p role="status">Loading language…</p>;
	const raw = result.window[0];
	const key = raw ? readStringsCatalogKey(raw) : undefined;
	const value =
		key?.source.localeId === localeId
			? key.source
			: key?.targets.find((target) => target.localeId === localeId);
	if (!value || !key)
		return <p role="status">This value is no longer available.</p>;
	return (
		<CatalogWorkspaceValueField
			advanced
			messageId={key.id}
			messageLabel={key.id}
			value={value}
			sourceValue={key.source.value}
			characterLimit={key.characterLimit}
			canEdit={canEdit}
			onCommitValue={onCommitValue}
		/>
	);
}
