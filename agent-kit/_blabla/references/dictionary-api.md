# Dictionary API

### `GET /dictionary`

Requires `read`. Returns `{ revision, terms, nextCursor }` with complete term
entries, all authored Locale renderings, author, timestamp, and `revisionId`.
A connected Dictionary also returns `dictionaryId` and `connectionRevision`.
Its terms are shared with other connected projects; voice guidance stays local.
`sourceTerm` performs a case-sensitive exact lookup; optional `q` matches literal,
case-insensitive substrings of names, definitions and rendering values.
`limit` is 1–50 (default 16). Reads scan at most 64 entries and responses stay
below 256 KiB. Guidance changes or changed search filters invalidate a cursor
with 409.

### `POST /dictionary/terms`

Requires `dictionary-write` and a Dictionary-editor grant enabling agent writes
for this project connection. A typed project needs a connected Dictionary first.
Atomically creates or replaces 1–32 complete terms,
at most 256 KiB per batch:

```json
{
  "expectedRevision": 0,
  "expectedDictionaryId": "<from GET>",
  "expectedConnectionRevision": 1,
  "terms": [
    { "kind": "untranslatable", "sourceTerm": "Brickit", "definition": "Product name; preserve spelling." },
    { "kind": "translated", "sourceTerm": "Build", "definition": "Assemble a model.", "renderings": [{ "localeCode": "de", "value": "Bauen" }] }
  ]
}
```

For a connected Dictionary, both identity and connection revision are required
on writes, including deletions. Disconnecting, reconnecting, replacing the
Dictionary, or changing its agent-write grant invalidates old connection facts.
Legacy unconnected project terms retain their revision-only compatibility shape.

Existing terms are replaced in full, including all Locale renderings. Unchanged
writes at the current revision create no history. Storage permits 256 terms,
128 renderings per term, 256 UTF-8 bytes per source term, and 16 KiB per entry,
within the shared 448 KiB active-guidance budget.

Returns the current shared `revision` and `entries`, each containing `sourceTerm`
and its immutable `revisionId`. Every changed term advances its Dictionary revision. Duplicate names, invalid renderings, or a stale basis roll back the
whole batch. Invalid input returns 400, exceeded bounds 413, and concurrent
Dictionary changes 409. The project and author come from the token; the supplied
Dictionary identity verifies its current connection and cannot choose another one.

### `DELETE /dictionary/terms`

Requires `dictionary-write`. Body:
`{ "expectedRevision": 2, "sourceTerm": "Build" }`.
Removes the active entry and returns `{ revision, revisionId }`. Earlier
citations remain readable while their project or Dictionary access still applies. Deleting an already
absent entry at the current revision is a no-op with a null `revisionId`.

Standalone Dictionary renderings accept canonical Locale codes independently of
which languages a connected project currently uses.
