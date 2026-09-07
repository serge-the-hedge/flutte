# Agent API review: search, examples, and translation guidance

Reviewed 2026-09-07 at commit
[`4095bb3`](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a), including the unmerged independent-reviewer
changes. This is an assessment and proposed direction, not an accepted product
contract or implementation. Findings refer to this commit even after code moves.

Follow-up: native Convex text search was subsequently tested against the actual
catalogs; see the [evaluation](native-convex-search-evaluation-2026-09-07.md).
The current [Agent API guide](../docs/agent-api.md) documents the implemented
retrieval, guidance, access, and feedback improvements. Code Context production
and Dictionary observations remain planned. Findings below preserve the reviewed
commit's original behavior rather than rewriting historical evidence.

## Assessment

The API has a useful proposal/review boundary and a bounded repair queue. Its
retrieval side is substantially less complete. Agents can find literal wording,
but cannot reliably ask “what established wording should I follow here?” They
lack both the evidence needed to judge examples and an efficient way to retrieve
some of that evidence.

Prioritize search correctness, reviewer access, and trustworthy bilingual
examples. Add a small curated Dictionary and locale-specific voice guidance.
Code Context is already designed and remains useful for disambiguation. Semantic
search should follow a measured retrieval gap.

## What already works

- Project-scoped credentials, immutable candidates, and exact-revision independent
  review keep retrieval separate from permission to apply translations.
- Workspace search already matches message identifiers, Source text, and current
  Target Value text using case-folded literal substrings. Target-language lookup
  is present; it does not require English queries.
- Context accepts selected keys and Locales, bounded to 50 keys, 20 Locales,
  128 pairs, and a 512 KiB response. Translation Tasks hide write-basis machinery
  from the normal candidate-submission workflow.
- The work queue uses bounded Navigation reads and an opaque continuation cursor.
  It is useful for finding unfinished work, rather than choosing good examples.
- Existing value decisions, source identity, immutable reviews, and Navigation
  state supply much of the evidence a better retrieval API needs. A separate
  writable translation-memory corpus is unnecessary for the first improvement.

Implementation:
[discovery and context](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1781),
[work queue](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1924),
[Navigation evidence](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/catalogWorkspaceNavigation.ts#L232).

## Concrete findings

### 1. Reviewer credentials created by the UI cannot search

The reviewer preset is exactly `read, review`, and its scope customization is
hidden. Search and work discovery require `search`. The backend already permits
`read, search, review` together while rejecting translation/delivery scopes.

**Impact:** the supported reviewer setup prevents an independent reviewer from
finding examples, despite that being necessary to assess terminology and voice.

**Fix first:** include `search` in the reviewer preset and documented setup.
Keep the separate credential, human authorization, and self-review prohibition.

Evidence:
[token preset](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/apps/web/src/routes/projects.$projectId.settings.api-tokens.tsx#L59),
[hidden customization](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/apps/web/src/routes/projects.$projectId.settings.api-tokens.tsx#L238),
[allowed reviewer scopes](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/apiTokens.ts#L53).
A focused HTTP probe returned 401 with the preset and 200 after adding search.

### 2. Search and returned context disagree about effective Source text

Search matches the Source row from the Git projection. Its returned result goes
through `currentWorkspaceTarget`, which overlays a current Source Proposal.

**Reproduction:** change Source from `Hello {name}` to
`Welcome aboard {name}`. Searching for `aboard` returns nothing. Searching for
`Hello` returns a result whose visible Source is `Welcome aboard {name}`.

**Fix first:** search the same effective Source/Target composition used by
context. Preserve whether a Source Proposal is provisional; do not silently
represent it as merged Git evidence.

Evidence:
[search corpus construction](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1879),
[effective Source overlay](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L575).
The mismatch was reproduced through HTTP.

### 3. Results cannot be qualified as established examples

Discovery returns text and concurrency fingerprints, but omits current
confirmation, value state, review provenance, intentional-blank reason, and
First Review status. The target's exposed `sourceFingerprint` comes from the
raw projection even when its visible value comes from a newer Workspace head.

**Reproduction:** save a translation against the pending new Source. Its head
records the new Source Fingerprint, but context still returns the target's old
Git Source Fingerprint. Comparing the exposed hashes would misclassify it.

**Impact:** agents cannot reliably distinguish current confirmed wording from
unconfirmed imports or stale evidence. A nonzero workspace revision is not an
adequate substitute.

**Fix:** expose derived facts from the shared catalog evidence model, including
effective source basis, confirmation method, and a stable evidence reference.
Add an explicit filter for current, contract-valid, confirmed examples. Include
human-authored and authorized agent-reviewed values with honest provenance;
ordinary batch confirmation should not imply editorial curation. Keep imported
and historical examples available through explicit, labelled selection.

Evidence:
[discovery response](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L679),
[current value composition](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L598),
[existing state derivation](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/catalogWorkspaceNavigation.ts#L252).
The fingerprint mismatch was reproduced through HTTP.

### 4. Search has a result cap without continuation and reads the whole corpus

Each request loads the active projection and all project value heads, filters
in memory, and returns at most 50 pairs. It returns `hasMore` but no cursor.
A small `limit` reduces response size, not that initial database read.

**Impact:** agents cannot enumerate all occurrences of a common term. Repeating
the same query cannot reach later matches. Without a Locale filter, multiple
Locale pairs of the same message also consume the cap.

**Fix:** provide bounded, resumable lexical discovery with explicit completion;
hydrate only selected matches. Reuse or extend the disposable Navigation read
model and its canonical derivation. Its current all-Locale corpus loses field
attribution, so directly reusing it is insufficient for target-only search.
Provide indexed exact-key and exact-source lookup where appropriate; preserve
literal substring behavior for unspaced scripts.

There is no measured production latency claim here. Static inspection establishes
the read pattern: the catalog envelope permits 10,038 projected rows and 8 MiB
before heads and matched-row hydration. Measure before choosing further indexes.

Evidence:
[whole projection read](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/catalogProjection.ts#L2473),
[search scan and cap](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1857),
[catalog envelope](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/catalogProjection.ts#L35).
A limit-one HTTP probe confirmed `hasMore: true` without a continuation cursor.

### 5. New-Locale agents cannot search their developing body of reviewed wording

Workspace search only covers active Catalog Workspace target rows. Portuguese
Locale Proposal values remain outside it until binding. Task reads page the
Source template and attach staged values; there is no text search over that
draft. For a 1,434-message catalog, a complete pass at 16 messages per page
requires at least 90 requests. This is arithmetic, not a measured session.

Reviewers additionally cannot read a translating token's private task, and the
lower-level Portuguese values read requires `read + propose`, a combination
forbidden to reviewer credentials.

**Fix:** expose bounded example search within an explicitly authorized task or
Locale Proposal. Include reviewed draft values with their Source Snapshot and
review evidence. Distinguish them from released or active Workspace values.
A reviewer can receive this read context through its authorized candidate's
proposal without receiving the translator credential or access to unrelated
private candidates.

Evidence:
[active-row search](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1886),
[new-Locale task page](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/localeProposals.ts#L2089),
[private task access](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L420),
[Portuguese values scopes](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/http.ts#L1645).

### 6. Terminology and tone have no retrievable source of authority

The Dictionary and Code Context are explicitly planned. There is no implemented
voice-guide contract. Existing catalog usage is evidence of practice, but mixed
or repeated wording cannot tell an agent which choice the project prefers.

The accepted Dictionary design specifies definitions, Locale renderings, and
Untranslatable Terms; it starts empty and adds no release gate. Its current
scope is Source Echo explanation and conflict observation. Reading applicable
entries for agents is a compatible extension to discuss explicitly; automatically
mining and promoting terms would change that design.

**Add:**

- A bounded read of Dictionary entries applicable to supplied task messages,
  with definitions, exact Locale renderings, entry identity, and revision.
- A small human-maintained project/Locale voice guide: audience, formality,
  forms of address, capitalization/punctuation conventions, and a few curated
  example/counterexample pairs. Store it once and return its version/reference.
- A clear distinction between curated rules and observed usage. Where examples
  conflict, show the alternatives and their evidence instead of voting by count.

Broader terminology features such as forbidden variants, inflection rules, and
domain-specific overrides need explicit design; they are not existing contracts.

Evidence:
[implementation status](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/docs/spec/localization-control-plane.md#L9),
[Dictionary design](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/docs/spec/localization-control-plane.md#L630).

### 7. App context is still mostly unavailable

Existing-Locale discovery supplies values and bounded ICU argument facts. It
does not expose call sites, placement, sibling relationships, or usage areas.
New-Locale task pages can carry ARB metadata, but metadata availability is not
the same as implemented Code Context.

**Impact:** identical English text may need different translations as a button,
heading, or explanation. Key prefixes are a useful clue, not verified placement.

Implement the already specified Code Context manifest/read boundary. Return
message relationships and commit-stamped references; represent absent or stale
context explicitly. Do not build a second source-code store or invent layout
constraints. Available ARB descriptions/placeholder metadata should also be
accessible consistently through bounded context.

Evidence:
[existing-Locale context fields](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L693),
[new-Locale metadata](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/localeProposals.ts#L2125),
[Code Context design](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/docs/spec/localization-control-plane.md#L812).

### 8. Discovery has smaller correctness and integration traps

- **Archived Locales:** search can return an archived Locale still present in
  the active projection; context filters it out. Apply the same active-Locale
  eligibility to both. Reproduced through HTTP.
- **Malformed limits:** `/workspace/search?limit=abc` returns 200 with no results
  and `hasMore: false`. Reject invalid limits instead of claiming no matches.
- **Locale semantics differ:** work-queue `q` searches all Locale text in a
  Navigation key, then `localeCode` selects returned targets. A French query
  can therefore return a German item with no matching German or Source text.
  Search uses only the selected target plus Source/key. Name and document the
  distinction, or offer explicit `searchIn` and `targetLocale` controls.
- **Empty pages are not exhaustion:** work scans a bounded key window and can
  return zero items with a non-null cursor. The guide's “require an empty
  result” wording should require zero matches over a complete verification pass
  through `nextCursor: null`.
- **CLI policy leaks into every Agent request:** configuring a minimum CLI
  protocol makes even bearer-only `GET /projects/current` return 426. The guide
  does not document this header requirement. Keep repository-toolchain policy
  at the Repository Adapter boundary, or define a deliberate Agent protocol
  negotiation contract; generic agents should not claim CLI compatibility.
- **Project discovery exposes historical screens/tags but no capabilities:**
  advertise supported retrieval modes, request bounds, context availability,
  and guidance revision. Do not imply historical metadata is searchable context.

Evidence:
[search validation and Locale filtering](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1860),
[context Locale filtering](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L1799),
[work filtering](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L2020),
[completion wording](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/docs/agent-api.md#L250),
[CLI gate](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/http.ts#L461),
[project discovery](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentApi.ts#L84).
The archive, malformed-limit, cross-Locale, and CLI-gate behaviors were reproduced
through HTTP. The CLI error also omits the minimum-protocol response header.

### 9. Resuming a correction does not expose a consistent feedback summary

Existing-Locale task reads return Source and current Target text but no latest
candidate. New-Locale task reads do include the candidate. Reading existing
candidates through the lower-level proposal API still does not provide a compact
latest-review decision and rejection explanation for the translator.

**Improve:** return an optional latest candidate and latest-review summary in
both task kinds, including the reviewer's reason when available. This lets an
agent correct the actual rejected revision without rediscovering its history.
Keep full history behind a targeted read and preserve task ownership rules.

Evidence:
[existing task target shape](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L169),
[new-Locale candidate attachment](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/http.ts#L1194),
[lower-level candidate read](https://github.com/serge-the-hedge/flutte/blob/4095bb3c664d3101fea7d3919be8a410a608546a/packages/backend/convex/agentTranslationProposals.ts#L2617).

## Proposed retrieval contract

These are suggested capabilities, not promises of new endpoints.

| Agent question | Smallest useful response |
| --- | --- |
| Where is this exact key or phrase used? | Bilingual matches, matched field, explicit match mode, continuation |
| How have we translated this before? | Current confirmed examples, source/contract identity, context and review provenance |
| What terms apply to these messages? | Applicable curated definitions and Locale renderings, returned once per term |
| What voice should this Locale follow? | Versioned guidance and curated examples |
| What does this message do in the app? | Available metadata, placement/sibling references, observed commit and availability |
| What Portuguese wording have we already reviewed? | Authorized proposal-scoped examples, explicitly labelled draft evidence |

Prefer one bounded task-context request that combines shared guidance, applicable
terms, and a few relevant examples per selected message. Deduplicate shared
evidence and Source text; return references so an agent can fetch more. Keep
exact full text on demand, with explicit truncation for previews. Do not put
write-basis fingerprints into every compact search hit when the task workflow
resolves that machinery itself.

Use explainable match categories: exact identifier, exact Source with compatible
contract, literal source/target match, and verified related context. A ranked
example mode can coexist with Catalog Order browse; it should not silently
change the human Strings navigation contract. Group conflicting usages and
avoid filling the first page with duplicate text.

Separate the search language/field from the desired output Locale. Preserve exact
bytes for equality, ICU, and writes; document any normalization used for
discovery. Define cursor behavior under both Baseline changes and local edits:
projection identity alone does not freeze mutable Workspace values.

The reviewer retrieves the same authoritative guidance independently. Evidence
references may support a verdict, but the translator's selected examples must
not be its only available evidence. Retain the existing exact candidate review
token and authorization checks.

## Implementation order and verification

1. **Correctness and access:** reviewer search scope, effective Source matching,
   target-basis metadata, active-Locale filtering, input validation, completion
   wording, and the CLI/Agent policy boundary.
2. **Useful retrieval:** resumable lexical search, compact results, explicit
   field/Locale filters, trustworthy example facts, and authorized new-Locale
   example access. Share canonical composition and state derivation. Include
   consistent latest-candidate/review summaries for correction work.
3. **Guidance:** the small Dictionary and voice-guide reads, then integrate
   available Code Context into bounded task context. Amend the accepted design
   for genuinely new terminology/voice semantics.
4. **Measured expansion:** add semantic retrieval only if concrete questions
   still fail after the preceding work.

A focused evaluation should cover exact keys, source/target phrases, Chinese
substrings, accents, ICU messages, changed Source Proposals, conflicting
translations, stale/imported examples, and reviewed new-Locale values. Record
useful evidence in the first few results, request count, response bytes, latency,
and database rows/bytes read. Check complete enumeration and authorized reviewer
access separately. Establish the baseline before setting numerical targets.

The read implementation belongs behind one shared module used by HTTP, human
context, and a future MCP adapter. MCP is a transport convenience; wrapping the
current endpoints alone would preserve these retrieval gaps.

## Primary-source research

Convex full-text search is transactional and paginatable, with BM25-based
ranking and final-term prefix matching. Its tokenizer splits on whitespace and
punctuation and is documented as working best for Latin-script languages.
It is not a drop-in replacement for literal multilingual substring lookup.
The current spec's claim that it “cannot search Chinese at all” is too absolute:
the relevant limitation is segmentation and substring recall.
[Convex full-text search](https://docs.convex.dev/search/text-search)

Text queries have a documented 16-term and 1,024-scanned-result limit. The limits
table says a term is at most 32 bytes, whereas the text-search prose says 32
characters; verify multibyte behavior before selecting that index contract.
[Convex limits](https://docs.convex.dev/production/state/limits)

Vector search runs in actions, uses approximate cosine similarity, and hydrates
matches separately from the search. If added, filter by an authorized partition
and revalidate current source/value/confirmation facts on hydration; a similarity
score cannot confer terminology authority.
[Convex vector search](https://docs.convex.dev/search/vector-search)

Established translation APIs separate bilingual concordance from curated terms.
Crowdin accepts multiple concordance expressions and returns paired text and
memory provenance; its glossary API returns term concepts separately.
[Crowdin translation-memory SDK](https://raw.githubusercontent.com/crowdin/crowdin-api-client-js/master/src/translationMemory/index.ts),
[Crowdin glossary SDK](https://raw.githubusercontent.com/crowdin/crowdin-api-client-js/master/src/glossaries/index.ts)

Phrase can find applicable terms inside supplied text and return match offsets,
definitions, usage, and preferred/forbidden status. This supports the proposed
batch “terms for these messages” capability.
[Phrase terms in text](https://developers.phrase.com/en/api/tms/v2/term-base/search-terms-in-text)

Identical Source text is not sufficient context for identical translations:
Phrase distinguishes key/surrounding-context matches and accounts for conflicting
matches. Crowdin supports approved-only translation-memory population. These
are useful precedents for contextual examples with explicit quality evidence;
they do not require copying either vendor's full product.
[Phrase match context](https://support.phrase.com/hc/en-us/articles/9386879839900-Translation-Memory-Match-Context-TMS),
[Phrase match optimization](https://support.phrase.com/hc/en-us/articles/9386873028892-Optimize-Translation-Memory-Matches-TMS),
[Crowdin translation memory](https://support.crowdin.com/translation-memory/)

## Review method and limits

Inspected HTTP routes, token setup, discovery/context/task/reviewer functions,
catalog projections and derived value state, and current product/API docs.
Independent agents reviewed search behavior, transport ergonomics, and primary
sources. Five temporary focused integration tests passed assertions reproducing
the behaviors described above; the probes were removed after the review.

No production benchmark, live catalog audit, or translation-quality evaluation
was performed. No production code, deployed service, existing PR, or project
setting was changed. This report is the sole retained review artifact.
