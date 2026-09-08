# Translation Task API

## Translation Rules

- For App messages, preserve ICU syntax, placeholders, and interpolation
  markers. Managed `format: "plain"` messages treat braces literally. Preserve
  meaningful whitespace and product terminology in both.
- Preserve casing, symbol spacing, and punctuation that may reflect UI
  composition unless the assignment requests formatting cleanup.
- Source-copy changes require an explicit human assignment.

### `POST /translation-tasks`

Creates or resumes a Translation Task. An existing-Locale task freezes the
selection of at most 32 keys and one Locale. Source, target values, and concurrency
basis remain live on the server:

```json
{
  "clientTaskKey": "checkout-de-polish-1",
  "target": { "kind": "existingLocale", "localeCode": "de" },
  "scope": {
    "kind": "selectedMessages",
    "messageIds": ["checkout.payButton", "checkout.total"]
  }
}
```

Managed copy uses the same selected-message task with a collection target:

```json
{
  "clientTaskKey": "store-de-v1",
  "target": { "kind": "managedLocale", "collectionId": "<id>", "localeCode": "de" },
  "scope": { "kind": "selectedMessages", "messageIds": ["store.subtitle"] }
}
```

Choose an enabled Locale from [collection discovery](collection-api.md#discovery).
Managed tasks expose `collectionId` and `format: "plain"`; Source context notes
are included. They use the same candidate and review endpoints, with live
revision checks and no Snapshot or repository path requirement.

The original top-level `"localeCode": "de"` and `"messageIds"` request remains
readable for compatibility. New clients should use explicit target and scope.
A new-Locale task covers every message in the pinned Source Snapshot:

```json
{
  "clientTaskKey": "portuguese-complete-v1",
  "target": { "kind": "newLocale", "localeCode": "pt" },
  "scope": { "kind": "completeCatalog" }
}
```

Choose `localeCode` from `capabilities.newLocaleTargets`. Requesting an
unconfigured code fails before proposal creation.

Human-created tasks are fillable by project-scoped translation tokens; agent-owned
tasks remain private to their creating token. A token has one visible task per
complete new-Locale proposal: creation resumes it even with a different title.
Different tokens can have separate private tasks for that proposal. New-Locale
tasks remain `open` until finalization creates an immutable artifact (`accepted`).

### `GET /translation-tasks`

Returns the bounded task inbox visible to the current token: project tasks
created by a human and private tasks created by that token. Optional `status`
is `open`, `accepted`, or `rejected`. Each row states its task kind, ownership,
Locale, frozen target count, candidate count, and update time. Use this endpoint
to discover and resume work instead of guessing task ids or creating duplicates.

### `GET /translation-tasks/:id`

Returns a task page with `limit` 1–16 and `nextCursor`. Existing-Locale tasks
retain their key selection while resolving current Source and target values;
new-Locale tasks read the pinned Source template. Internal concurrency basis
fields are not exposed.

Each target has `candidate: null` or its newest revision (`revisionId`, `revision`,
`value`, optional blank reason, `latestReview`). Review feedback includes the
decision, reason, reviewer, authorization, timestamp, and any final fingerprint;
it is null until that exact revision is reviewed. It is historical evidence,
not a guarantee that current target text still matches.

Pages stop at 16 targets or 1 MiB of target/candidate payload. Shared `guidance`
appears once; `matchedTextIndexes` refer to the page's targets. Source texts for
guidance have a separate 512 KiB cap; reduce `limit` for large messages.

### `POST /translation-tasks/:id/candidates`

Submits candidate decisions without exposing Convex ids or asking the agent to
copy internal basis facts. The explicit shape is:

```json
{
	"items": [
		{
			"messageId": "checkout.payButton",
			"candidate": { "kind": "value", "value": "Jetzt bezahlen" }
		},
		{
			"messageId": "checkout.optionalLabel",
			"candidate": {
				"kind": "intentionalBlank",
				"reason": "This label is not shown in this Locale."
			}
		}
	]
}
```

Accepts 1–16 decisions. The original `{ "messageId", "value" }` shape remains
compatible. Exact retries are idempotent; corrections or changed Source/target
basis create a new immutable revision, even if the text is unchanged. The server
resolves task-owned evidence.

Candidates remain inert until authorized review. Intentional Blanks require a
reason and individual review; they cannot use exact-batch acceptance. Human
review behavior is defined in the [review contract](https://github.com/serge-the-hedge/flutte/blob/main/docs/catalog-message-lifecycle.md).

### New-Locale Translation Task

Use [Translation Tasks](#post-translation-tasks) for agent work. A changed
Baseline makes staging/finalization fail with `STALE_SOURCE`. An editor can
continue against current Source, carrying forward still-compatible reviewed
values and exposing the residue. For configuration, continuation, delivery, and
binding, follow [Adding languages](https://github.com/serge-the-hedge/flutte/blob/main/docs/adding-languages.md).
