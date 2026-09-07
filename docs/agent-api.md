# Agent Translation Guide

This app exposes a compact HTTP API for LLM agents working on translations.
Agents use project-scoped API tokens to discover the accepted Catalog Workspace,
submit immutable translation candidates, and leave the final value change to
a human or an explicitly authorized independent Reviewer Agent. Legacy catalog
operations are retired; their HTTP addresses return migration errors rather than
accepting work into a disconnected corpus.

Use this document as the canonical workflow guide for translation agents.

Base path:

```text
/api/agent/v1
```

Authentication:

```text
Authorization: Bearer <project_api_token>
```

Rate-limited requests return `429`, a JSON `retryAfter` duration in
milliseconds, and the standard `Retry-After` response header in seconds. Honor
the header and retry with backoff; do not treat a rate limit as validation
failure.

Translation, discovery, and candidate-review requests do not require CLI version
headers. The project CLI protocol floor applies to Repository Adapter endpoints
and delivery artifact reads `GET /locale-proposals/artifact`. The legacy reads
`GET /locale-proposals/pt` and `GET /locale-proposals/pt/artifact` retain the same
floor. Those clients send
`X-Blabla-CLI-Protocol`; an incompatible or missing protocol returns `426` with
`CLI_UPGRADE_REQUIRED`. Successful CLI responses advertise any configured minimum
version and protocol in `X-Blabla-Minimum-CLI-Version` and
`X-Blabla-Minimum-CLI-Protocol`.

## Human Setup

1. Open the project in the web app.
2. Go to **Settings -> API tokens**.
3. Create a project-scoped token with the minimum scopes:
   - Translation agents: `read`, `search`, `propose`.
   - Dictionary authors: `read`, `dictionary-write`; owners enable **Allow Dictionary editing** when creating the token. This directly updates active shared terms.
   - Independent Reviewer Agents: `read`, `search`, `review`, using a separate credential.
   - Local Repository Adapter delivery: `export`.
   - The default workspace connection has `read`, `search`, `propose`, `export`,
     and `snapshot-submission` for the complete local workflow. It never has
     `review`; the Reviewer Agent uses a separate credential.
4. Copy the raw token immediately. The app stores only a hash and cannot show
   the raw value again.
5. Give agents the site base URL and token:

```text
https://<convex-site>.convex.site/api/agent/v1
Authorization: Bearer <project_api_token>
```

If token creation is blocked in development, fix the UI/auth route first and
then create the token through the app. Do not seed raw tokens directly in the
database: the API authenticates against the stored token hash and tokens are
intentionally one-time visible.

## Preferred Agent Workflow

1. Discover the project with `GET /projects/current`.
2. Find examples with `GET /workspace/search`, usually using `localeCode`,
   `quality=confirmed`, and `view=compact`. Choose `searchIn=source` or `target`
   when the field matters. Follow `nextCursor` until it is null, including
   empty intermediate pages. Broaden to `quality=all` to inspect unconfirmed
   imports, with their evidence labels intact.
   For an exhaustive repair run, page `GET /workspace/work` instead; its
   projection-pinned cursor covers missing, Source-identical, same-key repeated,
   and stale target values without treating equal text on unrelated keys as a
   problem.
   To audit imported baseline state, read the conservative human-confirmation
   plan with `GET /workspace/ordinary-confirmations`; this endpoint never
   confirms values itself.
3. For a human-selected task, read it with
   `GET /translation-tasks/:id?cursor=...&limit=...`. Each page also includes
   the general project Voice Guide, applicable Locale add-ons and Dictionary terms once, with immutable
   citations. To start an agent-owned
   task instead, call `POST /translation-tasks`. Existing-Locale tasks freeze
   up to 32 selected message ids; a new-Locale task covers the complete pinned
   Source template and needs no client-supplied ids.
4. Submit 1–16 candidates at a time to
   `POST /translation-tasks/:id/candidates`. The server resolves and validates
   the frozen concurrency basis; the agent supplies only message ids and
   values.
5. Open the task in the human review workbench. One **Save review** action
   accepts whatever is currently in the field; the server records whether that
   was the exact candidate, a human edit, or an explicit keep on a newer Source
   basis. Re-saving an already reviewed field appends immutable human review
   evidence. Rejection and Intentional Blank remain explicit decisions. Only an
   editor save or authorized independent agent acceptance changes the Catalog
   Workspace or new-Locale draft.
6. Report a value as **proposed** until authorized review succeeds. The API
   never claims that an agent submission is live.

The authenticated Proposals workbench is at `/projects/:projectId/proposals`.

Separate language issues from app-context artifacts. Note intentionally preserved
casing, spacing, and punctuation so later agents do not repeat cosmetic changes.
An editor builds a Release Bundle from a Ready Release Record; the local
Repository Adapter delivers it through the dedicated release endpoints.

### New-Locale Translation Task

An agent can prepare any editor-configured new Locale. The public agent
workflow is the same Translation Task
interface used for existing Locales. Its private Locale Proposal adapter keeps
the complete Source template and review evidence without copying the catalog
into task documents. This workflow needs only `read` and `propose` scopes. It
never creates an active Locale Binding, writes to Git, opens a pull request, or
changes the working catalog.

1. Start or resume one complete task with `POST /translation-tasks`, target
   `{ "kind": "newLocale", "localeCode": "pt" }`, and scope
   `{ "kind": "completeCatalog" }`.
2. Page its exact Source Snapshot template with
   `GET /translation-tasks/:id?cursor=...&limit=...`.
3. Submit at most 16 value or Intentional Blank candidates at a time to
	 `POST /translation-tasks/:id/candidates`. The server owns and validates the
	 pinned Source evidence; callers do not copy fingerprints or Convex ids.
4. Review values from the task in
   `/projects/:projectId/proposals/:taskId`. It mounts the same new-Locale
   workbench for every configured target. Agent values remain awaiting
   review; corrections append immutable candidate revisions while the newest
   revision becomes current. Only human-applied or explicitly authorized
   agent-reviewed values can finalize.

The `/locale-proposals` endpoints provide a lower-level interface for clients
that need explicit fingerprints,
diagnostics, finalization, or artifact access.

The proposal is pinned to the accepted Baseline Snapshot. If Git advances,
staging and finalization return `STALE_SOURCE`, but the work is not assumed to be
globally obsolete. An editor can continue the old task in the web app: Blabla
creates a current-source task, carries forward human-authored or reviewed values
whose exact source text and executable placeholder metadata still match, and
exposes only changed, contract-incompatible, or added Source values as residue
for the agent. The old proposal remains available as a read-only historical
view, and its artifact stays immutable. A ready current-source artifact is
review-ready evidence for the later local Repository Adapter, not proof that
Brickit has accepted it.

Discover configured targets through `/projects/current` and message identifiers
through `/workspace/search` or `/workspace/work`. Editors configure the code,
label, catalog path, and Runtime Locale Mapping in **Settings → Languages**.
Prepare and deliver one reviewed catalog at a time; see [Adding languages](adding-languages.md). A later accepted descendant
Snapshot observes the exact delivered artifact; an editor then binds the observed
file to realize the Locale in the Workspace with its original review evidence
and Intentional Blank reasons. Observation alone never activates a Locale.
The original message First Review scope stays frozen when a later Locale joins.
Respect the advertised `maxBoundLocales` capacity, which includes Source; the
configured-target list is a queue and does not reserve working-catalog capacity.

## Independent Reviewer Agent workflow

Human review is the default. Read [Agent Review](agent-review.md) for the full
permission and evidence contract. A project owner can enable agent review for
the project; alternatively, an editor can delegate the exact candidate revision
to the named reviewer. Use a dedicated Reviewer token assigned to a separate agent;
do not pass both translation and reviewer credentials to one agent.

1. Get the candidate revision's review URL from the human review workbench.
2. Read `GET /candidate-reviews/:revisionId` using the reviewer token. A
   `kind: "candidate"` response contains Source, current target, candidate text,
   blank reasons, basis status, authorization, applicable project guidance, and an
   opaque `reviewToken`.
   Inspect these facts. A `kind: "recordedReview"` response instead contains
   `latestReview`: the recorded decision, actual reviewer, authorization,
   timestamp, and any final value fingerprint. It has no `reviewToken` and
   requires no new decision.
   Use `/workspace/search` and `/workspace/context` with the same reviewer
   credential to inspect established wording for related messages before
   deciding. Catalog access does not authorize reviewing another revision; each
   candidate still requires project policy or its own human delegation.
3. Submit `POST /candidate-reviews/:revisionId` with the returned opaque
   `reviewToken` and a decision, for example:

   ```json
   { "reviewToken": "<from GET>", "decision": { "kind": "accept" } }
   ```

   To reject, use `{ "kind": "reject", "reason": "Explain the defect" }`.
   Acceptance applies exact candidate bytes; it cannot supply an edited value.
   An Intentional Blank must already have its reason in the candidate.
4. If Source, target, candidate, prior review, guidance, or authority changed, fetch fresh
   context and reassess it. Do not reuse the prior verdict automatically.
5. Report the recorded review result. Rejection leaves the live value unchanged;
   acceptance records the reviewer identity and human authorization. The reviewer
   credential cannot finalize proposals, build releases, or deliver to Git. If a
   response was lost, read the same URL to inspect its latest review result.

Revoking a token blocks its future requests. Disabling project agent review
stops reviews authorized by that setting; a separate active per-revision grant
can still authorize its named reviewer. Completed evidence remains valid after
later revocation. With current access, recorded results remain readable after
candidate supersession, target removal, or Locale Proposal finalization; they do
not depend on a currently editable target.

## Translation Rules

- Preserve ICU syntax, placeholder names, interpolation markers, whitespace that
  is semantically meaningful, and product terminology.
- Preserve casing, extra spaces around symbols, compact symbols, and similar
  punctuation when they may come from UI composition or app context. Do not
  normalize these as style edits unless the human explicitly asks for UI-copy
  formatting cleanup.
- Treat the source locale as the source of truth. Only edit source strings when
  the human explicitly asks for source-copy changes.
- Page `/workspace/work` by Locale and reason to find unfinished work. Preserve
  already reviewed values unless the task explicitly calls for further edits.
- Keep each existing-Locale Translation Task focused on at most 32 selected
  messages. Submit at most 16 candidates per request.
- Report candidates as proposed until a human or authorized independent reviewer
  accepts them. A translation credential cannot review its own work.

## Scopes

- `read`: project metadata, workspace context, and task/proposal reads.
- `search`: workspace search and work discovery.
- `propose`: Translation Task and candidate creation; it cannot apply values.
- `dictionary-write`: create, replace, or remove active Dictionary entries with
  revision checks and agent attribution. It does not author Voice Guides or
  grant translation review or release powers.
- `review`: independent exact candidate acceptance or rejection, subject to human
  authorization. It cannot coexist with `propose`, `dictionary-write`, `export`, or
  `snapshot-submission` on a token.
- `export`: immutable Release Bundle delivery through the local Repository
  Adapter; it does not grant a remote Git write.
- `snapshot-submission`: repository snapshot submission through the local adapter.

Create tokens in the web app under project settings. Pick the minimum scopes the
integration needs.

## Endpoints

### `GET /projects/current`

Returns project identity, source and active Locale codes, the current token's
scopes, and supported retrieval capabilities and bounds. `capabilities.newLocaleTargets`
lists configured introduction codes that are not active. `localeIntroductionTargets`
provides each target's `localeCode`, `label`, `catalogPath`, and explicit
`runtimeLocale`, so agents can see regional and script intent before translating.
`capabilities.maxBoundLocales` includes the Source Locale.

An editor configures targets in **Settings → Languages**. Configuration is
project setup; translation tokens cannot create or change it. The current Flutter
adapter accepts language-only catalog codes such as `pt`, with an explicit
Runtime Locale Mapping such as `pt-BR` or `sr-Latn-RS`. Script or regional catalog
variants require a separate ARB identity migration and are rejected during setup.
The configured runtime language must match the catalog language. Paths must
name an ARB file beside the bound Source catalog, with letters, numbers,
underscores or hyphens in its filename, and must not conflict with another
configured target or Locale Binding. The shipped Repository Adapter targets the
Brickit Flutter repository layout; it is not a generic Flutter source rewriter. Prepared proposals pin their
configuration; later edits or removal affect future preparation and discovery,
not an existing artifact's identity or review evidence.
`context.codeContext` is `unavailable` until source-code context is implemented.
`dictionary.canWrite` reports whether this credential has the explicit
`dictionary-write` scope; `dictionary.batchWrites` advertises the batch interface.
Historical screens and tags are no longer advertised as usable context.

### `GET /workspace/search`

Searches effective Source and current Target Values in Catalog Order. It uses
case-folded literal substrings, preserving punctuation, accents, and unspaced
scripts. It does not stem words, repair typos, or rank semantic similarity.
Native Convex text search was evaluated against the six real catalogs and
missed internal Chinese term occurrences; see the
[evaluation](../reports/native-convex-search-evaluation-2026-09-07.md).

| Parameter | Meaning |
| --- | --- |
| `q` | Search text, at most 2,048 UTF-8 bytes; optional for browsing |
| `localeCode` | Restrict Target Values to one active Locale |
| `searchIn` | `all` (default), `key`, `source`, or `target` |
| `match` | `substring` (default) or case-sensitive, byte-exact `exact` |
| `keyPrefix` | Optional case-sensitive message identifier prefix |
| `quality` | `all` (default) or `confirmed` |
| `view` | `full` (default) or `compact` for example discovery |
| `limit` | Integer 1–50, default 16 |
| `cursor` | Opaque `nextCursor` from the preceding page |

`quality=confirmed` requires a nonempty, contract-valid value confirmed against
its current effective Source and no pending First Review. It is a reliable
starting set, not a claim that each value is a curated voice example. Inspect
`evidence.confirmation` for its real actor and authorization; batch confirmation
and editorial curation are different acts. A settled Git value may still differ
from a pending Source Proposal, so use `sourceMatchesCurrent` instead of
inferring currency from `valueState` alone.

Each result includes bilingual text, matched fields, and evidence: current value
state, source currency, contract validity, First Review, confirmation provenance,
blank reason when applicable, and a stable reference. Full results additionally
carry bounded ICU facts and the legacy candidate `basis`; use context when those
facts are needed. Search uses the same effective values as submission and review.

Pages scan at most 64 Navigation keys within a 512 KiB index-read budget and
hydrate at most 64 candidate pairs or 2 MiB of values; responses stay below
512 KiB. An exact key query uses the existing equality index.
`nextCursor: null` means completion. A non-null cursor can accompany an empty
page or a page with fewer than `limit` results; `hasMore` means there is more
scope to scan, not that another match is guaranteed. Changing filters requires
starting again. Catalog or Source Proposal changes return `STALE_BASIS` (409)
instead of silently mixing evidence. Invalid parameters return 400; unknown or
archived requested Locales return 404.

### `POST /proposal-examples/search`

Finds reviewed examples inside a new-Locale proposal before it is bound into the
Catalog Workspace. Requires `read` and `search`. It accepts the same `q`,
`searchIn`, `match`, `keyPrefix`, `limit`, and `cursor` fields as Workspace search,
plus one access scope:

```json
{
  "scope": { "kind": "task", "taskId": "<new-Locale task>" },
  "q": "peças",
  "searchIn": "target",
  "limit": 8
}
```

An independent reviewer instead supplies
`{ "kind": "review", "candidateRevisionId": "<authorized revision>" }`.
The server checks current human authorization for every request. Task scope
preserves token-owned task privacy; a reviewer never needs the translating
credential or `propose` scope. Existing-Locale examples use Workspace search.

Results contain `items`, proposal/snapshot identities and revision, and an opaque
`nextCursor`. Each item has exact Source/target text, matched fields, and
`provenance.kind: "reviewedDraft"` with the real author/reviewer evidence.
Only human-authored or authorized reviewed values matching the current pinned
Source and contract qualify; unreviewed submissions are excluded. A deliberate
blank retains its reason. These examples are draft evidence, not Release Truth.

Reads scan at most 64 staged values, stop at their byte budget, and fetch Source
rows by index instead of downloading the Source template repeatedly. Continue
through empty pages until `nextCursor` is null. Changed proposal content, search
scope, or Snapshot requires a fresh search. Old snapshot examples are not silently
presented against a newer baseline.

### `POST /guidance/context`

Reads the project Voice Guide, optional Locale add-ons and applicable Dictionary
terms. Requires `read`:

```json
{ "texts": ["Build with Brickit"], "locales": ["de", "pt"] }
```

Returns the current guidance `revision`, `projectGuide` (null if unset), applicable
`terms`, and Locale add-ons in `guides`. The general guide applies across every
Locale and appears once, even when `locales` is empty. Add-ons contain local
details; an absent add-on leaves the general guidance intact.
Each term is returned once with `matchedTextIndexes` into `texts`, its definition,
requested Locale renderings, author, timestamp, and immutable `revisionId`.
Untranslatable Terms have no Locale variants. Matching is case-sensitive within
literal message text; ICU argument names, selectors and formatter options do not
become terminology matches, and plural counts separate literal runs. Word
boundaries prevent `Start` matching `Restart`;
unspaced scripts can match inside a literal segment. No fuzzy term inference is
performed. Authorship identifies the actual human or authorized agent that last
changed the entry; an agent-written term is never labelled human-reviewed.

General-guide examples retain the `source` and `target` field names, meaning
“Before” and “Preferred wording.” They are editorial examples, not translations
into a particular Locale. Locale add-on examples remain bilingual.

Limits: 50 Source texts, 20 canonical target Locale codes, and 512 KiB for Source
texts or returned guidance. Guidance for any configured introduction target is
available before its Locale Proposal is created. Guidance starts empty; missing entries are not instructions
to infer a project policy from popular wording.

Editors maintain the general guide and optional Locale add-ons at
**Settings → Translation guidance**. A single selected Locale editor keeps the
page compact with dozens of Locales. Up to 128 Locale add-ons and 128 renderings
per Dictionary entry are supported, within the shared 448 KiB active-content
budget; individual guides allow 8 KiB and terms 16 KiB. Context requests still
select at most 20 Locales at a time. A project supports up to 256 Dictionary terms;
each source term is at most 256 UTF-8 bytes.

Editors and explicitly scoped Dictionary agents can maintain terms. Voice Guides
remain human-authored. Drafts survive failed/stale saves; editors compare changed saved
entries before deliberately retaining their draft. Updating or removing an entry
preserves its earlier citation. Read one with
`GET /guidance/revisions/:revisionId` using the same project's `read` credential.
Correcting a Locale code during initial setup carries its guidance forward
atomically and preserves earlier citations. Conflicting destination guidance must
be resolved before that correction can proceed.

### Dictionary authoring workflow

An owner can deliberately give an agent `dictionary-write` alongside `read`,
using **Allow Dictionary editing** in token setup. Existing translation and
reviewer credentials do not acquire that permission. Reviewer tokens cannot
combine it with `review`.

1. Read `/dictionary`, or use `?sourceTerm=Brickit` for an exact existing entry.
2. Choose terms and definitions from the human's assignment and inspected project
   examples. Catalog frequency alone does not establish policy.
3. Send a bounded batch with the read response's `revision` as `expectedRevision`.
   Existing entries are replaced in full: preserve other Locale renderings when
   adding one. These are active Dictionary changes, not translation candidates.
4. Keep the returned revision and immutable citations. If a response is lost or
   a write returns `STALE_BASIS`, read again and compare; do not blindly overwrite
   changes made by a human or another agent. An unchanged write at the current
   revision creates no extra history.

No automatic seeding runs. The authorized agent performs this workflow when a
human asks it to fill or maintain the Dictionary.

### `GET /dictionary`

Requires `read`. Returns `{ revision, terms, nextCursor }` with complete term
entries, all authored Locale renderings, author, timestamp, and `revisionId`.
`sourceTerm` performs a case-sensitive exact lookup; optional `q` matches literal,
case-insensitive substrings of names, definitions and rendering values.
`limit` is 1–50 (default 16). Reads scan at most 64 entries and responses stay
below 256 KiB. Follow opaque `nextCursor` through empty intermediate pages until
null. Guidance changes or changed search filters invalidate a cursor with 409.

### `POST /dictionary/terms`

Requires `dictionary-write`. Atomically creates or replaces 1–32 complete terms,
at most 256 KiB per batch:

```json
{
  "expectedRevision": 0,
  "terms": [
    { "kind": "untranslatable", "sourceTerm": "Brickit", "definition": "Product name; preserve spelling." },
    { "kind": "translated", "sourceTerm": "Build", "definition": "Assemble a model.", "renderings": [{ "localeCode": "de", "value": "Bauen" }] }
  ]
}
```

Returns the current shared `revision` and `entries`, each containing `sourceTerm`
and its immutable `revisionId`. Every changed term advances the shared guidance
revision. Duplicate names, invalid renderings, or a stale basis roll back the
whole batch. Invalid input returns 400, exceeded bounds 413, and concurrent
guidance changes 409. The project and author come from the token, never the body.

### `DELETE /dictionary/terms`

Requires `dictionary-write`. Body:
`{ "expectedRevision": 2, "sourceTerm": "Build" }`.
Removes the active entry and returns `{ revision, revisionId }`. Earlier
citations remain readable with the project's `read` scope. Deleting an already
absent entry at the current revision is a no-op with a null `revisionId`.

### `GET /workspace/work`

Pages the exhaustive translation work queue in Catalog Order. Query parameters
are `cursor`, `limit` (maximum 16), optional `localeCode`, optional `q`, and one
or more repeated `reason` parameters:

- `missing`: the target has no decided value;
- `sourceIdentical`: untouched imported target content equals Source, with no
  Source Proposal pending for the key;
- `sameKeyRepeat`: two target Locales of the same key carry equal untouched
  imported content;
- `stale`: a previously confirmed value's Source Contract changed.

Omitting `reason` includes all four. Each item contains exact Source and target
strings plus every applicable reason. The opaque `nextCursor` is `null` at the
end; pass a non-null cursor back unchanged. It is pinned to the active Catalog
Projection, so a Baseline change returns `STALE_BASIS` instead of combining two
catalog versions. The queue scans only a bounded Navigation Index range and
hydrates candidate values within a 2 MiB / 64-target budget. An empty page
can still carry a continuation when either scan or hydration budget is exhausted;
always follow it until `nextCursor` is null. `q` searches the message identifier,
effective Source, and the returned target's text, respecting `localeCode`.
Archived Locales are excluded.

This is the discovery seam for claims such as “all missing translations.” Use
`GET /workspace/search` for open-ended terminology and similar-key lookup. A
queue item remains evidence of work to inspect, not permission to overwrite it;
the translator still submits an inert Translation Task candidate for authorized review.

For a complete repair run, page one `localeCode` at a time. Create one
Translation Task from each non-empty page, use `POST /workspace/context` to read
the same keys across the established Locales, and submit candidates to that
task. Do not interleave review acceptance with the initial discovery pass. After
review, restart the queue and require zero matches across a complete pass ending
at `nextCursor: null` before claiming the selected reasons are exhausted. An empty
intermediate page does not prove completion. This catches work invalidated or
introduced while the run was open.

### `GET /workspace/ordinary-confirmations`

Returns the `ordinary-v1` batch-confirmation preview for the accepted Baseline.
Use the opaque string `cursor` returned by the previous page and `limit
(maximum 100)` to page through eligible values; omit `cursor` or send an empty
cursor for the first page. A cursor can resume inside a key with multiple target
Locales, so clients must pass it through unchanged. The summary separates
empty, source-identical, repeated, locally modified, stale, already confirmed,
and pending-Source-Proposal values. This is a read-only audit seam: an
authenticated editor must run confirmation from the Strings UI.

The cursor is intentionally an opaque Catalog Order cursor rather than a
Convex document-pagination cursor. A candidate page is produced after
target-level revalidation and may resume inside a key with multiple target
Locales, which a document cursor cannot represent. The internal reads remain
bounded indexed ranges, and clients must not parse or manufacture the cursor.

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

### `POST /translation-proposals`

Creates or resumes an idempotent agent proposal. The first slice supports
existing target values in the Catalog Workspace:

```json
{
  "clientProposalKey": "checkout-de-pass-1",
  "target": { "kind": "catalogWorkspace" }
}
```

Retries with the same token, key, and target return the same proposal. Reusing
the key for a different target returns `IDEMPOTENCY_KEY_REUSED`.

### `POST /translation-tasks`

Creates or resumes a Translation Task. An existing-Locale task freezes the
selected keys and Locale. Its Source Contract, target values, and concurrency
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
unconfigured code fails before a Locale Proposal is created. Italian, Japanese,
and other configured targets use this same complete-catalog task workflow.

The same task shape is created from the Strings UI when an editor selects keys
and chooses **Start task**. A project-scoped propose token can fill a
human-created task; token-owned tasks remain private to their creating token.
For a given token, only one visible task can own a complete new-Locale
proposal. Creating it again—even with a different title—resumes the existing
task visible to that token; different tokens can own separate private tasks for
the same proposal.

A new-Locale task remains `open` while candidates are proposed and reviewed.
It becomes `accepted` only when finalization creates the immutable delivery
artifact; staging the final review batch is not itself task completion.

### `GET /translation-tasks`

Returns the bounded task inbox visible to the current token: project tasks
created by a human and private tasks created by that token. Optional `status`
is `open`, `accepted`, or `rejected`. Each row states its task kind, ownership,
Locale, frozen target count, candidate count, and update time. Use this endpoint
to discover and resume work instead of guessing task ids or creating duplicates.

### `GET /translation-tasks/:id`

Returns a bounded page of the task (`limit` 1–16) and a `nextCursor`, which is
`null` on the final page. Pass that cursor unchanged until it is `null`.
Existing-Locale targets come from their frozen selection but resolve exact
Source and current reviewed target text when each page is read. A Source
Proposal or target edit therefore updates the existing task rather than making
the entire key selection obsolete. New-Locale targets page the complete pinned
Source template. Each target returns `candidate: null` or its newest immutable
candidate revision: `revisionId`, `revision`, `value`, any Intentional Blank
reason, and `latestReview`. That review is `null` until this exact revision is
reviewed; otherwise it includes the decision, bounded reason, reviewer,
authorization, timestamp, and any final value fingerprint. Corrections do not
inherit an older revision's verdict. This is historical feedback; current target
text may have changed since that decision.

Pages stop at 16 targets or 1 MiB of target payload, whichever comes first.
Follow `nextCursor` even when fewer than the requested targets are returned.
Private Snapshot and workspace concurrency basis fields are not exposed.

Both task kinds return `guidance` once per page; `matchedTextIndexes` refer to
`targets` in that page. The general Voice Guide and Locale add-ons are
human-authored; Dictionary terms identify their human or authorized agent author.
Source texts supplied to guidance are capped at 512 KiB; reduce `limit` for large
messages. Target/candidate feedback has its separate 1 MiB page envelope.

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

The original `{ "messageId", "value" }` item remains readable for compatibility.
An Intentional Blank candidate and its reason remain inert, cannot be exact-batch
accepted, and must be accepted individually by a human or authorized independent
reviewer, preserving its reason.

An exact retry is safe. A correction appends an immutable revision and makes it
the candidate's current revision. A changed Source or target basis also creates
a new immutable revision even when the proposed target text is unchanged. The
server derives existing-Locale revision idempotency and new-Locale Source
fingerprints from task-owned evidence. Candidates remain inert until a human or authorized independent agent
reviews them. Existing-Locale review is in Translation Tasks; new-Locale review
is in the configured Locale Proposal workbench mounted by the task route. Both
task kinds can accept up to 16 exact current revisions atomically; stale
revisions remain visible evidence but are excluded from exact-batch acceptance.
When an existing-Locale Source Contract changes but the proposed translation is
still correct, the editor leaves the field unchanged and chooses **Save
review**. The server records that as `keepForCurrentSource`, validates it
against the live Source Contract, and stores the applied basis without altering
the agent's original revision. This avoids a needless agent rerun while
preserving which source the agent actually saw. A later human edit can be saved
again as another immutable review event. Edited acceptance, rejection, and
Intentional Blanks also remain individual decisions.

### `POST /translation-proposals/:id/candidate-revisions`

Body:

```json
{
  "items": [
    {
      "messageId": "checkout.payButton",
      "localeId": "k...",
      "value": "Jetzt bezahlen",
      "clientRevisionKey": "checkout-de-pass-1-r1",
      "expectedCandidateRevision": 0,
      "basis": {
        "projectionId": "k...",
        "snapshotId": "k...",
        "gitValueFingerprint": "sha256:...",
        "gitValueRevision": 0,
        "workspaceRevision": 0,
        "sourceFingerprint": "sha256:..."
      }
    }
  ]
}
```

Values are checked against the active Source Contract and exact basis. A stale
submission returns `STALE_BASIS` without writing evidence. Corrections append a
new immutable revision and name the current `expectedCandidateRevision`.

For a new Locale, first create or resume its configured Locale Proposal with
`POST /locale-proposals` and `{ "localeCode": "pt" }`. Then create the same generic
proposal with a Locale target:

```json
{
  "clientProposalKey": "pt-checkout-pass-1",
  "target": {
    "kind": "localeProposal",
    "localeProposalId": "k..."
  }
}
```

Its candidate basis carries the pinned `localeProposalId`, `snapshotId`, and
source fingerprint instead of a mutable target Locale id. The candidate is
reviewed in the same Proposals workbench; accepting it updates the staged
Locale Proposal with the actual reviewer and authorization, while rejecting it leaves no active
catalog change. This candidate/review contract is shared by every configured
introduction target.

### `GET /translation-proposals/:id`

Returns the proposal header for the token that created it.

### `GET /translation-proposals/:id/candidates`

Returns a bounded page of the proposal's current candidate revisions. Use
`limit` (maximum 16) and the returned `continueCursor` to continue.

### Retired catalog endpoints

`GET /strings/search`, `POST /context`, `POST /change-sets`,
`POST /strings/tags`, and `POST /export` return `410 Gone` with
`code: RETIRED_WORKFLOW`. Replace legacy search/context with the workspace
endpoints and proposed writes with Translation Tasks. There is no current
agent tag-authoring workflow.

`GET /change-sets/:id` remains an authenticated historical read. It returns
stored items, `retired: true`, and a migration explanation. It does not return a
review link or apply those items to the Catalog Workspace. Historical tables
and import/export job evidence remain stored; their old Convex writers have
been removed. For pending historic work, read its values and submit a new task
against the current Workspace basis for authorized review.

### Locale Proposal endpoints

All proposal endpoints require both `read` and `propose`. Prefer Translation
Tasks for normal agent work: they resolve the Source basis and preserve candidate
review feedback. These lower-level endpoints expose the same prepared catalog.

The historical `/locale-proposals/pt` routes remain compatibility aliases.
Explicitly creating through that old route can establish the former default
Portuguese configuration (`pt`, `pt-BR`, sibling `intl_pt.arb`) if none exists.
Generic creation always requires an editor-configured target.

#### `POST /locale-proposals`

Body: `{ "localeCode": "it" }`. Creates or resumes that Locale's proposal pinned
to the current accepted Baseline Snapshot. It returns its id, progress, delivery status, and any current
validation diagnostics. It does not create an active Locale or bind a file.

#### `GET /locale-proposals?proposalId=...`

Returns the durable proposal review summary, including bounded diagnostics from
the last failed finalization attempt.

#### `GET /locale-proposals/template?proposalId=...&cursor=0&limit=16`

Returns up to 16 ordered source messages from immutable snapshot evidence. Each
message includes its id, source value, source fingerprint, opaque metadata JSON
when present, and whether a value has already been staged.

#### `POST /locale-proposals/values`

Body:

```json
{
  "proposalId": "k...",
  "items": [
    {
      "messageId": "welcome",
      "value": "Boas-vindas, {name}!",
      "sourceFingerprint": "sha256-of-the-returned-source-value"
    }
  ]
}
```

Each request accepts 1–16 values. Unknown ids, duplicate ids, ordinary blanks,
outdated source fingerprints, invalid ICU, and incompatible placeholders are
rejected. For an Intentional Blank, send `"value": ""` plus a concise
`intentionalBlankReason`.

#### `GET /locale-proposals/values?proposalId=...&cursor=0&limit=16`

Returns the submitted values for one bounded source-template page, including
their source fingerprints and any Intentional Blank reasons. Use it to resume
or review a draft without rebuilding an ARB document client-side.

#### `POST /locale-proposals/finalize`

Body:

```json
{ "proposalId": "k..." }
```

Derives the configured catalog from the pinned Source Snapshot and all staged values. A
complete successful result becomes `ready` only after every agent-authored
value has been reviewed by a human or authorized independent reviewer. A failed result exposes an actionable
diagnostic sample and persists it on the proposal.

#### `GET /locale-proposals/artifact?proposalId=...`

Returns the immutable, hash-checked delivery artifact. Version 1 contains the
complete derived catalog, source repository/commit/manifest provenance, the
project's integration branch, and the pinned `locale.code`, `locale.label`, and
`locale.runtimeLocale`. `catalog.catalogPath` is the exact repository-relative
delivery path; `catalog.fileName` remains its basename. Historical Portuguese
artifacts without `catalogPath` retain their original sibling-file convention.
The local Repository Adapter requires the checkout to be on that branch and
uses it as the pull-request base.

## Existing-locale delivery

When existing-locale review is complete, prepare a Release Record in the web
app. A `ready` posture can be built into one immutable Release Bundle. The
Repository Adapter API uses the site root rather than the `/api/agent/v1` base:

- `GET /api/repository-adapter/v1/releases/:recordId` returns the repository,
  Baseline, integration branch, exact bound catalogs, and change-key count.
- The current CLI uses `/api/repository-adapter/v1/snapshot-uploads` sessions
  with `kind: "release"` to upload and download each catalog independently. See
  [transport and artifact contracts](repository-adapter.md).
- `POST /api/repository-adapter/v1/releases/:recordId/delivery-tree` remains
  available for older clients, with its 8 MiB combined request limit.

The server overwrites target drift with the reviewed value. If the current
Source value changed or disappeared relative to the Release Bundle's Baseline,
it skips the entire key. Run the command from a clean Brickit integration
branch:

```sh
blabla deliver --release <release-record-id>
```

If a ready new-Locale task is pinned to the same Baseline, include its finalized
Locale Proposal in the same local transaction:

```sh
blabla deliver --release <release-record-id> --locale-proposal <proposal-id>
```

The combined form validates both immutable identities before checkout mutation,
preflights committed generated output, applies the existing-Locale delta, adds
the complete new catalog, and regenerates the combined candidate in a
disposable worktree. It creates one local
`blabla/release-...` commit with both provenance trailers, then prints push and
`gh pr create` commands without invoking either operation. The existing-only
form remains valid.

### `POST /export`

Retired. Returns `410 Gone`. The old endpoint synthesized output from the
pre-Catalog-Workspace model and is not a lossless Brickit release surface. Use
the immutable Release Bundle workflow above.

Repository checkout synchronization and release delivery use the separate
[Repository Adapter transport](repository-adapter.md). Its file-manifest uploads
keep catalog requests bounded as the number of languages grows.
