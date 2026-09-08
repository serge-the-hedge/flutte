# Managed collection API

## Discovery

`GET /collections` (`read`) lists the project’s collections. `app` identifies the
repository collection: use the existing `/workspace` endpoints for it. Managed
collections have durable IDs and independent key namespaces.

`GET /collections/:id` (`read`) returns collection identity, membership revision,
source Locale, enabled target Locales, and `syntax: "plain"`. Choose languages
from this response; `/projects/current.locales` describes App file bindings.
Managed source authoring and membership changes currently use the editor.

## Search

`GET /collections/:id/search` (`search`) accepts `q`, `localeCode`, `searchIn`
(`all`, `key`, `source`, `target`), `match` (`substring`, `exact`), `keyPrefix`,
`quality` (`all`, `confirmed`), `limit` (1–50), and `cursor`.

Hits carry collection/key/Locale identity, Source and target values, fingerprints,
revision basis, value state, matching fields, and confirmation attribution.
Plain text is searched literally, including braces. Search scans at most 64
key/Locale pairs per page and caps result payload at 1 MiB; a short or empty page
can have `nextCursor`. The terminal helper supports this endpoint with `scan`.

Cursors bind the collection, filters, and membership revision. Changed membership
or filters require a fresh scan. `consistency: "live"` means values can change
between pages; finish repair work with a fresh verification pass.

## Exact context

`POST /collections/:id/context` (`read`):

```json
{ "keys": ["store.subtitle"], "locales": ["de", "fr"] }
```

Returns selected source/target pairs with edit bases and shared project guidance.
`guidanceSourceKeys` maps guidance text indexes to keys. Limits: 50 keys,
20 languages, 128 pairs, and 1 MiB of context. Split selections when necessary;
guidance also enforces its own text budget. Braces are ordinary text.

## Download

`POST /collections/:id/download` (`read`) accepts the same `keys`/`locales` and
`mode`: `reviewed` (default), `partial`, or `draft`. Returns JSON `text` keyed by
message then Locale, omissions, and revision evidence for that read.

- `reviewed`: every selected pair must be current and confirmed, including
  explicitly confirmed blanks; otherwise returns `NEEDS_REVIEW` (409).
- `partial`: includes only reviewed pairs and reports omissions.
- `draft`: includes working values and identifies the output as draft.

Each response is a consistent bounded read: at most 128 keys, 1,000 languages,
1,024 pairs, and 1 MiB. Separate downloads are separate reads, not a frozen release.
No Git delivery scope is required.

## Translation and review

Use the shared [Translation Task API](translation-api.md#post-translation-tasks)
with `target.kind: "managedLocale"`, the collection ID, and enabled Locale code.
Candidate submission and independent review retain their existing authorization
rules. Managed task and review metadata include `collectionId` and
`format: "plain"`; review acceptance applies through the same managed edit rules
as the editor. Source, target, or membership changes invalidate stale candidates.
