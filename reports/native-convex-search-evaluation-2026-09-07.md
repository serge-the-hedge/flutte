# Native Convex text search evaluation

## Decision

Keep literal retrieval as the Agent API's search foundation. Native Convex text
search is useful for ranked word discovery, but it cannot replace the multilingual
term-occurrence search this app needs. Do not introduce a second search mode yet.

The decisive result came from the real local Convex backend: searching Chinese
`积木` returned 10 catalog values, while 122 contain that term. An agent checking
established terminology would miss 112 relevant examples. Adding a post-filter
to native results cannot recover documents absent from its candidate set.

This decision concerns matching behavior, not the quality of Convex's indexing.
Native search provides indexing, transactionally current results, equality
filters, relevance ranking, and pagination. Its tokenizer separates words at
whitespace and punctuation, lowercases them, and limits token length. Only the
last query term supports prefix matching; internal substring matching is not its
contract. Results use relevance order, with newest documents breaking ties;
alternative ordering is unavailable. The documentation explicitly identifies
Latin-script text as its strongest fit. [Convex text search](https://docs.convex.dev/search/text-search)

The current source constructs `SimpleTokenizer`, `RemoveLongFilter`, and
`LowerCaser`; it does not configure Chinese word segmentation or accent folding.
This supports the observed behavior without assuming that every Tantivy feature
is available through Convex. [Pinned Convex tokenizer source](https://github.com/get-convex/convex-backend/blob/849a6fc605b5a910c9834b61a77c5475cc24d189/crates/search/src/constants.rs)

## Actual fixture experiment

Indexed all 8,604 message/Locale pairs from the six checked-in ARB fixtures:
English, German, Spanish, French, Russian, and Chinese. Each Locale contains
1,434 messages; metadata was excluded. Their Brickit origin and checksums are in
the [fixture README](../packages/backend/fixtures/arb/README.md).

The isolated table stores `{key, locale, text}` and has separate native indexes
on `key` and `text`, both filtered by `locale`. Each query used
`withSearchIndex(...).paginate({numItems: 25, cursor})` until completion.
The comparison counts case-insensitive literal substrings in the same fixture
field. Counts describe these specific queries, not overall search quality.

| Locale / field | Query | Native results | Literal occurrences |
| --- | --- | ---: | ---: |
| Chinese text | `积木` | 10 | 122 |
| English text | `build` | 103 | 112 |
| English text | `license agreement` | 6 | 5 |
| English text | `agreement license` | 6 | 0 |
| French text | `créé` | 8 | 9 |
| French text | `cree` | 0 | 0 |
| German text | `Steine` | 103 | 107 |
| Spanish text | `piezas` | 161 | 161 |
| Russian text | `детали` | 103 | 103 |
| English key | `about_app_disclaimer` | 27 | 2 |
| English key | `disclaimer` | 3 | 3 |
| English key | `aboutapp` | 5 | 5 |
| English text | `rickit` | 0 | 57 |
| English key | `trial_screen_family_sharing_bottom_line_1_trial_three_days` | 209 | 1 |

Important interpretations:

- `积木` misses values such as `把积木颗粒摊开，让所有特征都清晰可见`.
  The term occurs inside an unspaced segment rather than at its beginning.
- Reversing `license agreement` still returns the same six results. Native
  search does not enforce the literal phrase's word order in this experiment.
- The two full-key queries rank their exact key first, but also return many
  other keys. Exact message lookup should use a normal equality index.
- Long identifiers are not automatically lost: underscores separate their
  tokens. Although 396 fixture keys exceed 32 characters overall, their longest
  individual underscore-delimited token is only 14 characters. The 58-character
  longest key was found. Do not infer identifier failure from total key length.
- Unaccented `cree` does not retrieve `créé`; neither does the existing literal
  baseline. Accent-insensitive search would be a deliberate additional contract.
- Pagination worked: 161 Spanish results took seven pages; the longest-key query
  took nine. This does not measure cursor behavior during concurrent edits or
  production latency. Ranking between equal-scoring texts reflected insertion
  order, which is not evidence of editorial quality.

## Reproduction and limits

Run the [isolated experiment](experiments/native-convex-search.py) after installing
repository dependencies, with an explicit local backend binary:

```sh
python3 reports/experiments/native-convex-search.py \
  --backend ~/.cache/convex/binaries/precompiled-2026-08-25-7cce8fb/convex-local-backend \
  --output /tmp/native-convex-search-results.json
```

The script creates a temporary Convex project and database, deploys only to
`127.0.0.1:3310`, imports the fixtures, queries the real search indexes, writes
results, and stops its backend. Ports 3310 and 3311 must be free. It strips
inherited Convex deployment variables and generates an isolated local credential.
It neither uses `convex-test` nor changes application code or cloud deployments.

Measured on 2026-09-07 using the cached backend release
`precompiled-2026-08-25-7cce8fb`, Convex client/CLI 1.45.0, Node 24.20.0, and
Python 3.14.7. The backend's `--version` reports `local_backend unknown`, so the
release-directory identifier is recorded instead. Results were reproduced in a
second fresh database with the retained script; both backend processes stopped.
The separately inspected upstream source was current at commit `849a6fc`.
Cloud deployment behavior was not tested.

## Backend direction

Use one shared module to compose the effective Source, current Target, and
review/confirmation evidence. Build Agent API search and context on that model,
reusing existing Catalog Workspace Navigation derivation where it expresses the
same facts. Keep project/Locale scoping indexed, scan bounded pages for literal
matches, expose continuation explicitly, and hydrate only selected results.
Exact key lookup should avoid a search scan.

Apply the same matching contract to authorized reviewed new-Locale examples,
while preserving their separate proposal provenance. Keep curated Dictionary
and voice rules distinct from observed catalog usage.

Reconsider native ranked discovery only if an evaluation demonstrates that
agents cannot find useful examples with these explicit retrieval tools. It
would then be a named approximate mode over the same read model, with literal
occurrence search still available. Building an n-gram expansion, custom Chinese
tokenization, or combined native/fallback engine now would add substantial
maintenance before that need is established.
