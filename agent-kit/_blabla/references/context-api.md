# Context API

### `GET /projects/current`

Returns project identity, Source/active Locale codes, token scopes, and current
capabilities/bounds. `capabilities.newLocaleTargets` lists configured inactive
codes; `localeIntroductionTargets` adds their label, catalog path, and Runtime
Locale Mapping. `capabilities.maxBoundLocales` includes Source. `capabilities.context.codeContext` is
`unavailable`; `capabilities.dictionary.canWrite` reflects this token's `dictionary-write`
scope, and `capabilities.dictionary.batchWrites` advertises batch support.

Targets are editor-configured. For setup, catalog-code/path restrictions, and
runtime mappings, see [Adding languages](https://github.com/serge-the-hedge/flutte/blob/main/docs/adding-languages.md#configure-and-prepare).

Basic projects use the [plain-text workspace contract](collection-api.md) below
the same project-scoped addresses. The following catalog details apply to repository projects.

### `GET /workspace/search`

Searches effective Source and current targets in Catalog Order using case-folded
literal substrings, including punctuation, accents, and unspaced scripts.

| Parameter | Meaning |
| --- | --- |
| `q` | Optional search text, at most 2,048 UTF-8 bytes |
| `localeCode` | Restrict targets to one active Locale |
| `searchIn` | `all` (default), `key`, `source`, or `target` |
| `match` | `substring` (default) or case-sensitive, byte-exact `exact` |
| `keyPrefix` | Optional case-sensitive message identifier prefix |
| `quality` | `all` (default) or `confirmed` |
| `view` | `full` (default) or `compact` |
| `limit` | 1–50, default 16 |
| `cursor` | Previous `nextCursor` |

`confirmed` requires a nonempty, contract-valid value confirmed against effective
Source, with no pending First Review. Results include bilingual text, matched
fields, state, Source currency, contract validity, First Review, confirmation
provenance, blank reason, and evidence reference. Full results add ICU facts and
legacy candidate `basis`. Inspect `evidence.confirmation` for the actual actor;
confirmation is not necessarily editorial curation. Use `sourceMatchesCurrent`,
not `valueState` alone, to assess currency against a pending Source Proposal.

Responses stay below 512 KiB. A page scans at most 64 Navigation keys/512 KiB and
hydrates at most 64 pairs/2 MiB; exact key lookup uses an equality index.
`hasMore` means more scope remains to scan, not guaranteed matches. Catalog or
Source Proposal changes return `STALE_BASIS` (409); invalid parameters return 400,
and unknown or archived requested Locales return 404.

### `POST /proposal-examples/search`

Requires `read` and `search`. Uses Workspace search's `q`, `searchIn`, `match`,
`keyPrefix`, `limit`, and `cursor`, plus an explicit access scope:

```json
{ "scope": { "kind": "task", "taskId": "<new-Locale task>" }, "q": "peças", "searchIn": "target", "limit": 8 }
```

A reviewer uses `{ "kind": "review", "candidateRevisionId": "<revision>" }`.
Task scope enforces token ownership; review scope checks current authorization
on every call. Existing-Locale examples use Workspace search.

Returns `items`, proposal/Snapshot identities and revision, and `nextCursor`.
Items contain exact Source/target text, matched fields, and `provenance.kind: "reviewedDraft"` with author/reviewer evidence. Only human-authored or authorized
reviewed values matching pinned Source and contract qualify. Intentional Blanks
retain their reasons. These are draft examples, not Release Truth.

Reads scan at most 64 staged values within the byte budget. Changed proposal
content, scope, or Snapshot invalidates continuation and requires a fresh search.

### `POST /guidance/context`

Optional `syntax` is `icu` (default) or `plain`. Use `plain` for supplied managed
copy so terms inside literal braces remain searchable. Collection/task context
already selects the correct syntax.

Requires `read`:

```json
{ "texts": ["Build with Brickit"], "locales": ["de", "pt"] }
```

Returns `revision`, `projectGuide` (null if unset), applicable `terms`, and Locale
add-ons in `guides`. The general guide appears once, including with no Locales;
an absent add-on leaves it intact. Each term includes its definition, requested
renderings, author, timestamp, immutable `revisionId`, and `matchedTextIndexes`
into `texts`. Untranslatable Terms have no renderings. Agent authorship is not
labelled human review.

Matching is case-sensitive within literal message text. In ICU mode it excludes arguments,
selectors, and formatter options; plural counts separate literal runs. Word
boundaries prevent `Start` matching `Restart`, while unspaced scripts can match
within a literal segment. There is no fuzzy inference.

General-guide examples use `source`/`target` for “Before”/“Preferred wording”;
Locale examples are bilingual. Limits: 50 texts, 20 canonical Locale codes, and
512 KiB for Source texts or returned guidance. Configured introduction targets
are supported before proposal creation.

`GET /guidance/revisions/:revisionId` with `read` retrieves immutable citations
after edits or removal. Voice Guides remain human-authored; Dictionary writes
use the [Dictionary API](dictionary-api.md). Human guidance setup is in
[Settings → Translation guidance](https://github.com/serge-the-hedge/flutte/blob/main/docs/spec/localization-control-plane.md#85-the-dictionary).

### `GET /workspace/work`

Returns the work queue in Catalog Order. Query: `cursor`, `limit` (maximum 16),
optional `localeCode`, optional `q`, and repeated `reason` values:

- `missing`: no decided target value;
- `sourceIdentical`: untouched imported target equals Source, with no pending
  Source Proposal;
- `sameKeyRepeat`: two targets of the same key have equal untouched imports;
- `stale`: a previously confirmed value's Source Contract changed.

Omitting `reason` includes all four. Items carry exact Source/target text and all
applicable reasons. `q` checks the key, effective Source, and returned target,
respecting `localeCode`; archived Locales are excluded. Reads use bounded
Navigation ranges and at most 64 targets/2 MiB. Baseline changes invalidate the
projection-pinned cursor with `STALE_BASIS`.

Use the [retrieval workflow](retrieval.md) for exhaustive repair and verification.

### `GET /workspace/ordinary-confirmations`

Read-only `ordinary-v1` confirmation preview. Query: opaque `cursor` (omit or use
an empty string initially), `limit` up to 100. A cursor may resume inside a key.
The summary separates empty, Source-identical, repeated, locally modified,
stale, already confirmed, and pending-Source-Proposal values. An authenticated
editor runs confirmation from Strings; this endpoint never confirms values.

### `POST /workspace/context`

Body:

```json
{
  "keys": ["checkout.payButton"],
  "locales": ["de"]
}
```

Returns exact Source/target values, bounded ICU facts, and the same evidence as
search for at most 50 unique keys, 20 unique Locales, and 128 pairs. Unavailable
pairs are listed in `missing`; they are never silently discarded. `guidance`
contains shared applicable terms and voice guides once; its text indexes refer
to the ordered `guidanceMessageIds`. `codeContext.status` is explicitly
`unavailable`. The entire response is bounded to 512 KiB; request fewer pairs if
it exceeds that envelope. The response's `basis` must be passed unchanged to the
lower-level `POST /translation-proposals/:id/candidate-revisions`. Normal task
submission does not require copying it.
