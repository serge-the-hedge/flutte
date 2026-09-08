# Basic project API

## Discovery

`GET /projects/current` identifies the token’s project and its `type`: `basic`
or `repository`. A Basic project owns one plain-text workspace. Its enabled
languages come from `locales`; source authoring and language setup use the editor.
Project-scoped routes below need no collection selector or extra credential.
Strings have stable `messageId`/`key` identities and a separate nullable `name`.
Names are editable plain text and need not be unique. Always address reads and
tasks by the returned identity, never by name; old keys initially serve as names.

## Search

`GET /workspace/search` (`search`) accepts `q`, `localeCode`, `searchIn`
(`all`, `key`, `source`, `target`), `match` (`substring`, `exact`), `keyPrefix`,
`quality` (`all`, `confirmed`), `limit` (1–50), and `cursor`.

Hits carry project content/key/Locale identity, `name`, Source and target values, fingerprints,
revision basis, value state, matching fields, and confirmation attribution.
Plain text is searched literally, including braces. `searchIn: "all"` also matches
names and can return `"name"` in `matchedFields`; `"key"` still matches identity.
Search scans at most 64
key/Locale pairs per page and caps result payload at 1 MiB; a short or empty page
can have `nextCursor`. The terminal helper supports this endpoint with `scan`.

Cursors bind the project’s content, filters, and language membership revision. Changed membership
or filters require a fresh scan. `consistency: "live"` means values can change
between pages; finish repair work with a fresh verification pass.

## Exact context

`POST /workspace/context` (`read`):

```json
{ "keys": ["store.subtitle"], "locales": ["de", "fr"] }
```

Returns selected source/target pairs with edit bases and shared project guidance.
`guidanceSourceKeys` maps guidance text indexes to keys. Limits: 50 keys,
20 languages, 128 pairs, and 1 MiB of context. Split selections when necessary;
guidance also enforces its own text budget. Braces are ordinary text.

## Download

`POST /workspace/download` (`read`) accepts the same `keys`/`locales` and
`mode`: `reviewed` (default), `partial`, or `draft`. Returns JSON `text` keyed by
message then Locale, omissions, and revision evidence for that read. The JSON
contains `values` and a separate `names` map keyed by the same stable identities;
unnamed strings have `null` names.

- `reviewed`: every selected pair must be current and confirmed, including
  explicitly confirmed blanks; otherwise returns `NEEDS_REVIEW` (409).
- `partial`: includes only reviewed pairs and reports omissions.
- `draft`: includes working values and identifies the output as draft.

Each response is a consistent bounded read: at most 128 keys, 1,000 languages,
1,024 pairs, and 1 MiB. Separate downloads are separate reads, not a frozen release.
No Git delivery scope is required.

## Translation and review

Use the shared [Translation Task API](translation-api.md#post-translation-tasks)
with `target.kind: "existingLocale"` and an enabled Locale code. The project type
selects the implementation.
Candidate submission and independent review retain their existing authorization
rules. Managed task and review metadata include `collectionId` and
`format: "plain"`; review acceptance applies through the same managed edit rules
as the editor. Source, target, or membership changes invalidate stale candidates.

## Compatibility addresses

Existing `/collections` discovery and `/collections/:id/{search,context,download}`
addresses retain their explicit content-store IDs for older clients and citations.
They do not create nested collections. New assignments use the project workspace
routes above; project promotion requires a new project-scoped credential.
