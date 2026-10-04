# Translation Task API

## Translation Rules

- For App messages, preserve ICU syntax, placeholders, and interpolation
  markers. Managed `format: "plain"` messages treat braces literally. Preserve
  meaningful whitespace and product terminology in both.
- Preserve casing, symbol spacing, and punctuation that may reflect UI
  composition unless the assignment requests formatting cleanup.
- Source-copy changes require an explicit human assignment.
- Respect optional `characterLimit` from context or task reads. It applies to
  every language and counts Unicode code points, including whitespace and literal
  ICU syntax. Over-limit writes return HTTP 400 with
  `code: "CHARACTER_LIMIT_EXCEEDED"`, `messageId`, `characterLimit`,
  `characterCount`, `overBy`, and an actionable `error` message. Shorten the text
  and resubmit; never truncate automatically. Limits are rechecked when applying
  a reviewed candidate, since they may have changed after submission.

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

Basic projects use the same `existingLocale` target and `selectedMessages` scope.
Their task/review metadata includes `format: "plain"`; Source context notes are
included. The server resolves the project’s content store and revision basis.
An explicit `managedLocale` target with `collectionId` remains a compatibility
shape for older clients. Project promotion preserves tasks and authorship but
requires credentials scoped to the new project.

The original top-level `"localeCode": "de"` and `"messageIds"` request remains
readable for compatibility. New clients should use explicit target and scope.
A new-Locale task covers every message in the pinned Source Snapshot:

```json
{
  "clientTaskKey": "italian-complete-v1",
  "target": { "kind": "newLocale", "localeCode": "it" },
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
to resume matching work instead of guessing task ids or creating duplicates.
Its locales describe those tasks only. Discover the project’s current target
languages from `GET /projects/current`, independently of this inbox; an absent
task means the assigned scope may need a new task.

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

### `POST /translation-tasks/:destinationId/reuse`

Explicitly requests reviewed candidate text from one accessible task as **fresh
pending candidates** in another. Both tasks must be in the credential’s project
and obey normal task visibility; Basic tasks must share a source workspace.
Requires `read` and `propose`. The destination must be open and editable. This
works across the same or different Locale identities and asserts no equivalence.

```json
{"sourceTaskId":"SOURCE_TASK_ID","clientReuseKey":"assigned-reuse-v1","cursor":0}
```

Each page scans at most 16 messages in the source task’s frozen scope and returns
`items` plus numeric `nextCursor` or null. Large values produce smaller pages to
preserve transaction read/write headroom; the cursor identifies the first
unprocessed message. Use one `clientReuseKey` per task pair
and pass the returned cursor unchanged. Page receipts are durable and replayable:
retry the exact request after an unknown response. A completed page’s outcomes
stay fixed even if later review or source changes occur. A new explicit pass needs
a new key; existing destination work remains protected.

Frozen membership reads are byte bounded, including captured Source and target
text. Each complete item, its supporting records and its receipt must fit one
transaction. Extremely large project, token, task, Locale or collection metadata
can exceed this reuse envelope even when other APIs accept those records. A page
also bounds its outcome payload to 512 KiB. If even the first item cannot fit, the server
returns actionable `LIMIT_EXCEEDED` without a candidate or empty receipt for that
item; an earlier successful prefix keeps its receipt and continuation. Reduce the
unusually large metadata or use ordinary candidate submission, then resume the
same request and state directory. Retrying unchanged or choosing a new reuse key
does not increase capacity.

`status` is `copied`, `alreadyCopied`, `unreviewed`, `sourceChanged`,
`incompatibleSource`, `outsideDestination`, `occupiedDestination`, or
`invalidDestination`; validation failures include a reason. Successful items
identify the new exact `revisionId`. Reuse reads the latest source revision, whose
recorded authorized review must preserve its exact value and blank reason.
Rejected/pending revisions and edited review output are skipped. Original and
destination Source must match in exact text and complete message metadata,
including descriptions, placeholder examples and unknown attributes (object key
order is ignored). Basic Source name and context are reconstructed from the
origin's captured source revision and rechecked in the write transaction;
Snapshot comparisons read immutable complete Catalog Documents (up to 4 MiB).
If a historical basis cannot be reconstructed exactly (including a retained
semantic fingerprint that differs from its raw Snapshot text), reuse conservatively
reports `incompatibleSource`. The server rechecks Source/target drift and ordinary destination ICU, placeholder,
and character-limit rules before writing. Existing candidates or applied values,
including reasoned blanks, are never replaced. Item validation failure does not
undo successful items; unexpected failures roll back the page and its receipt.

The new revision records the initiating agent and `reusedFrom` containing the
historical task, revision and review IDs. Task reads and independent review
context expose this pointer. It supplies provenance only: acceptance, reviewer
authorization, Translator Confirmation and human authorship are not copied.
Ordinary task read/status/review paths apply; hand off the new exact revisions.
Use the [resumable reuse command](workflow.md#reuse-reviewed-authorship) for paging,
receipts and review handoffs instead of writing a bulk posting script.

### New-Locale Translation Task

Use [Translation Tasks](#post-translation-tasks) for agent work. A changed
Baseline makes staging/finalization fail with `STALE_SOURCE`. An editor can
continue against current Source, carrying forward still-compatible reviewed
values and exposing the residue. For configuration, continuation, delivery, and
binding, follow [Adding languages](https://github.com/serge-the-hedge/flutte/blob/main/docs/adding-languages.md).
