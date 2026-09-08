# Blabla as Brickit's localization control plane — ready-to-build specification

Status: **accepted design, partly implemented**. This document defines the
intended product rules; it is not a claim that every specified surface ships.
The Agent API guide describes the callable workflow, and the catalog message
lifecycle describes the implemented review boundary. Keep all three aligned
when a product decision changes.

| Area | Implementation status |
| --- | --- |
| Snapshot ingest, reconciliation, catalog navigation and manual editing | Implemented |
| Translation Tasks, immutable agent candidates, human or authorized independent agent review | Implemented; human review is the default |
| Release assessment, bundles, configured language delivery and binding | Implemented; exact delivery observation preserves review evidence, and binding realizes the current Snapshot without re-ingestion. See [workflow and capacity](../adding-languages.md). |
| Introduced Messages and per-Locale First Review | Implemented; batches cannot complete pending First Review |
| Code Context Manifest, source AST extraction and context scopes (§10) | Planned; sync currently submits bound catalog files and Git provenance |
| Dictionary and project voice guidance | Human-maintained general Voice Guide with optional Locale add-ons; Dictionary authoring by editors or explicitly scoped agents, immutable citations, and bounded reads implemented; derived Dictionary observations remain planned |
| Agent retrieval | Literal source/target search with continuation, confirmation evidence, and authorized reviewed new-Locale examples implemented |
| Coding-agent workflows | Portable Context, Translation, Review, and Dictionary skills plus a bounded HTTP helper implemented; see [agent kit](../../agent-kit/README.md). |
| MCP adapter | Deferred; terminal-equipped agents use the portable skills and supported HTTP transport |
| Managed marketing content and multiple content collections | Not implemented; see the [proposed collection architecture](content-collections.md) |

Charted by [Wayfinder: Make Blabla Brickit's trusted localization control
plane](https://github.com/serge-the-hedge/flutte/issues/4) and locked by [Lock
the ready-to-build specification](https://github.com/serge-the-hedge/flutte/issues/14).

Vocabulary is `CONTEXT.md` at the repo root. Every capitalized term here is
defined there, and no synonym it lists under _Avoid_ appears in this document.
Where a resolution and this document disagree, this document wins — see
[Superseded register](#superseded-register), which lists every place an earlier
resolution has been overtaken.

---

## 1. What is being built

Blabla becomes the place Brickit's five target Locales are written, reviewed,
and released from, while `brickit-flutter` stays the app's Release Truth and the
sole author of its executable Source Contract.

The first supported surface is the six-file Flutter ARB catalog in
`../brickit-app/brickit-flutter`: `intl_en.arb` plus `de`, `es`, `fr`, `ru`,
`zh`, at `packages/brickit_generated/lib/l10n/`. 1,434 keys, 7,170 target
values across five target Locales (8,604 values including English), one translator.

Three properties define the system, and everything else follows from them.

**Git writes English; Blabla writes the rest.** Message identifiers, English
values, and executable ARB metadata originate in a Flutter pull request. Blabla
may propose an English *value* change and may never author anything else on the
source side. [Decide where localization source changes
originate](https://github.com/serge-the-hedge/flutte/issues/5), [Decide how
Source Proposals reach Git](https://github.com/serge-the-hedge/flutte/issues/21)

**Blabla holds no Git credential.** It cannot fetch, push, open a pull request,
or read a PR feed. Everything that touches the repository is done by a developer
running a command in their own checkout under their own identity. [Decide the
first Flutter repository adapter](https://github.com/serge-the-hedge/flutte/issues/12)

**Nothing begins unattended.** No scheduler, poller, webhook, or reconciliation
loop may initiate work. Every ingest, assessment, delivery, or maintenance run
begins with an explicit person or developer command. Once started, a durable
run may continue through bounded server-owned steps; its progress, terminal
state, and diagnostics remain visible and retryable. This is a consequence of
the credential contract — Blabla cannot reach Git, so it cannot act on Git's
schedule — while still allowing a started operation to finish without keeping a
browser tab open.

---

## 2. Architecture

### 2.1 One deep module, everything else an adapter

The **Localization Sync Module** owns the whole lifecycle from a Git-addressed
Source Snapshot to a deterministic Release Bundle. Web, agent API, HTTP, and the
developer CLI are adapters into it, never parallel implementations of the
workflow. [Design the Localization Sync module
interface](https://github.com/serge-the-hedge/flutte/issues/9)

External workflow commands:

```ts
ingestSnapshot(input: SnapshotSubmission): Promise<SnapshotIngestionRun>
attachContextManifest(input: ManifestSubmission): Promise<ManifestAttachment>
openRelease(input: ReleasePreparation): Promise<ReleaseRecord>
buildRelease(input: ReleaseBuildRequest): Promise<ReleaseBuildRun>
```

`recordFallbackApproval` from the original interface **does not exist** — the
decision it served was deleted. `attachContextManifest` is new, because [Decide
how the code-context manifest is
produced](https://github.com/serge-the-hedge/flutte/issues/18) made a manifest
separately submittable against a commit Blabla already holds.

Behind the seam: ARB parsing and losslessness, ICU and generated-interface
compatibility, snapshot lineage and reconciliation, file storage, run progress
and diagnostics, Release Scope assessment, bundle serialization, hashes and
manifests. Reads of a run, a Release Record, or a completed bundle are ordinary
adapter queries, not further workflow commands.

Raw input files and complete Release Bundles live in file storage. Indexed
tables hold small queryable facts: snapshot identity and manifest, entries,
findings, provenance, Release Records, run progress.

### 2.2 The developer CLI

One **Dart** binary, compiled by Blabla's CI as `dart compile exe` for macOS
arm64 and Linux x64, attached to a GitHub Release, installed by a one-line
script. Never `dart pub global activate` — it demonstrably ignores the committed
lockfile and hands each developer a different parser. Source lives in a
top-level `cli/` directory outside the Bun workspace globs, with its own build
matrix. [Decide the developer command's distribution and toolchain
contract](https://github.com/serge-the-hedge/flutte/issues/20)

It is a **thin client**: Git and toolchain I/O only. Every byte that lands in a
catalog is decided server-side, so two developers on different CLI versions
cannot deliver the same release differently. The version floor lives in Blabla's
project setup, is sent on every call, guards protocol rather than output, and
warns below the floor — refusing only on a breaking protocol change.

It does two things across a release cycle:

- **Submit** — read the bound ARB files at the current commit, parse
  `packages/*/lib` into a Code Context Manifest, send both plus the commit and a
  content-hashed file manifest.
- **Deliver** — upload the delivery tree's bound catalogs, receive edited
  existing-Locale bytes, optionally combine a ready new-Locale artifact pinned
  to the same Baseline, regenerate with the repo's Flutter, commit to one local
  branch, and stop.

It stops at the local branch on purpose: nothing beyond the developer's own
`git push` reaches GitHub, and the commit still arrives with ARB and generated
Dart correctly paired.

### 2.3 Trust boundaries

| Boundary | Who is trusted, for what |
|---|---|
| Git → Blabla | Git is Release Truth for every byte in the repository. Ingest never refuses a target value; a broken target lands as residue. |
| CLI → Blabla | Trusted for the bytes it submits and for the Git facts it reports (commit, ancestry, dirty state). It is already the only source of the catalog contents, so trusting it for ancestry adds no new trust surface. |
| Blabla → Git | Nothing. No credential, no network path. |
| Translator → catalog | May edit any target value and propose an English value. May never edit imported metadata or document globals. |

---

## 3. Invariants

Non-negotiable. Each is enforced somewhere concrete, named here.

1. **`@@locale` matches the Locale Binding.** A bound file declaring a different
   canonical code rejects snapshot publication. [Decide locale identity and
   migration](https://github.com/serge-the-hedge/flutte/issues/10)
2. **Snapshot Identity is project + repository + commit + content-hashed file
   manifest**, and ingestion is idempotent on it. A resubmission resumes or
   returns the existing run. [Decide snapshot sync and reconciliation
   semantics](https://github.com/serge-the-hedge/flutte/issues/7)
3. **Publication is atomic.** A snapshot and its reconciliation appear together
   or not at all; failure yields diagnostics and no partial baseline, archive,
   or catalog change.
4. **Message identifiers survive exactly.** They are generated Dart API
   identity. Normalization is forbidden; unsupported identifiers are rejected.
   [Define what lossless Flutter round-tripping
   means](https://github.com/serge-the-hedge/flutte/issues/6)
5. **Absence, intentional emptiness, and source fallback stay distinct.** Export
   never invents `""`. It writes `""` only where an Intentional Blank records
   why. [Prototype the release record and batch-decision
   experience](https://github.com/serge-the-hedge/flutte/issues/16)
6. **Contract Validity is non-waivable.** Invalid ICU, or a target that does not
   leave its Message Signature and the source's declared metadata intact, leaves
   the release Blocked. [Set the Brickit release-readiness
   policy](https://github.com/serge-the-hedge/flutte/issues/8)
7. **A target value's argument set is a subset of the source's**, checked at
   save. A target may not introduce an argument. [Decide the automatic transform
   catalogue for contract
   changes](https://github.com/serge-the-hedge/flutte/issues/23)
8. **Every plural and select block carries `other`**, in every Locale, or
   `gen-l10n` aborts. [Decide how compound ICU shapes are
   edited](https://github.com/serge-the-hedge/flutte/issues/26)
9. **A Release Bundle never contains a Source Fallback.** An undecided value
   blocks its Locale instead.
10. **Release Scope is every active bound target Locale.** A Locale leaves scope
    only through deliberate setup or a source change, never a per-release
    selection. Posture, however, is computed over the keys in the record's
    delta. [Decide how Source Proposals reach
    Git](https://github.com/serge-the-hedge/flutte/issues/21)
11. **Blabla-side context never reaches ARB and never becomes a Source
    Proposal.** [Bound automatic code-context
    inference](https://github.com/serge-the-hedge/flutte/issues/11)
12. **Delivery applies a Release Delta, never a complete file write.** Any key
    the release does not name keeps whatever the tree already holds. [Define the
    adapter's baseline-drift
    contract](https://github.com/serge-the-hedge/flutte/issues/19)
13. **A deleted key is never resurrected** by a delivery.
14. **Imported metadata and document globals are immutable** in Blabla. Only
    target values and Blabla-side provenance are editable. [Choose the lossless
    ARB metadata storage
    model](https://github.com/serge-the-hedge/flutte/issues/17)

---

## 4. Authorship and the Source Contract

**Git is the sole author** of message identifiers, English values, and
executable ARB metadata, and it remains Release Truth.

**A Source Proposal may change only the English *value* of a message that
already exists.** No new keys, no renames, no deletions, no placeholder or ICU
shape change, no descriptions. This scope is what makes the rest safe: a copy
edit regenerates exactly two lines and zero declarations, while a key added to
`intl_en.arb` alone regenerates into all six locale classes carrying the English
string — English shipped into five translated Locales by the one route no
Release Record can see.

**A Source Proposal has no delivery path of its own.** It rides the ordinary
release: one command run, one branch, one pull request, one Release Record with
English in scope. There is no propose verb, no proposal queue, no approval step.

**Blabla holds two English values per key** — the ingested Git value, which is
the Source Contract, and any pending proposal sitting on top of it. An ingest
overwrites the former and never the latter.

**Currency is a comparison, not an event.** A target records a **Source
Fingerprint**: the English it was authored against, whether or not Git holds
that English yet. Land the pair together and the target is current on arrival;
land English alone and untouched targets stale correctly. One rule in both
directions.

**A proposal resolves by observation.** The next ingest of `intl_en.arb`
decides: value equals the proposal → landed; value moved elsewhere →
superseded; unchanged → still open. The CLI additionally reports pull-request
state using the *developer's* `gh` credential, which contributes the one fact
observation cannot produce — closed without merging → rejected. Abandonment is
an explicit human dismissal, never a timeout.

**Blocking turns on authorship.** A Git-originated semantic English change
blocks its targets until confirmed or updated. A Blabla-authored one never
blocks and is reported instead, because the edit was made with all six Locales
on screen. A cosmetic change never blocks in either direction.

---

## 5. Ingestion, lineage, and reconciliation

### 5.1 Submission and baseline advancement

The CLI submits a commit, the bound catalog files, and the Git facts it
observed in the clone: the ancestry relationship between the submitted commit
and the current Baseline Snapshot's commit, plus their merge-base.

**Only a submission the adapter reports as a descendant of the current baseline
advances it.** An older, unrelated, or unreported-relationship commit is
retained as a **Preview Snapshot**: it supports provisional work, never replaces
the baseline, and never builds a release. This is what stops the baseline
flapping between `develop` and a release branch carrying 51 keys develop lacks.

Ancestry is a *reported* fact, not a verified one, because Blabla has no Git
access and never will. That is acceptable for the reason given in §2.3: the
adapter is already the only source of the catalog bytes, so trusting its
`merge-base` result adds no attack surface that the byte submission did not
already have.

### 5.2 Reconciliation actions

- A source key absent from an accepted baseline is **soft-archived**. History
  and translations are retained. Restoring while Git lacks the key creates a
  **Restore Proposal**.
- An archived key whose English returns **byte-identical** restores its archived
  targets automatically. Measured: 589 of 593 re-adds in Brickit history were
  byte-identical, and one accidental 571-key deletion was restored 564 at a
  stroke.
- A configured target Locale file absent from an accepted baseline is
  soft-archived. A missing source ARB, or malformed JSON in any bound file,
  fails the snapshot — no faithful Catalog Document can be formed.
- A catalog file with no Locale Binding is an **Unbound Locale File**: reported
  for setup, never activated automatically, never blocking.
- Values changed in Git by hand: **Git wins the value and the change is
  surfaced as reviewable.** Blabla's previous value stays in snapshot lineage.

### 5.3 The Reconciliation Report

One accepted transition, one report. It is a **worklist that ages into the
durable record**: a dispositioned consequence stays listed, struck through, with
who and when. There is no separate report view and action view, and no moment
where acting on something destroys the evidence it happened. [Prototype the
reconciliation review and recovery
experience](https://github.com/serge-the-hedge/flutte/issues/15)

Grouping, in order: Locale setup → Broken by a source change → Changed in Git →
Archived by sync → To review → To translate. Scope first, then severity, then
routine work.

A row is **key-level with Locales inside**, carrying per-Locale state chips, so
a mixed key reads at a glance. A Release Finding stays per-Locale in the model;
the row is a presentation grouping.

Work left from an earlier snapshot is not carried in — it is simply still true —
and is reached through one report-level `Open N in Strings`. Nothing gates
ingestion; every automatic action has already happened by the time the report is
read. Routine no-op syncs stay quiet. Nothing a translator does themselves ever
appears here.

Editing happens inline beneath the row, using the same block as Strings. Buttons
exist only where clicking the row would not do the same thing: bind a Locale,
restore an archived key, confirm a set, save.

Translation review uses that same editing language for existing and new
Locales: the Source Contract, the shared ICU-aware field, one **Save review**
action for its current contents, a **Revert changes** action only while the
local draft differs, and an explicit saved/unsaved phrase. Whether the save
lands in the Catalog Workspace or a new-Locale draft is a private adapter
choice. Exact agent text, human edits, and a human keep after Source drift are
recorded as distinct immutable review evidence behind that one action.

### 5.4 There is no rebase step

Blabla **transforms automatically wherever the transform loses nothing** and
surfaces the residue as ordinary translation work with a per-Locale reason.
Because ICU plural categories are per language, one contract change lands as a
different amount of work in each Locale — and Chinese is often already finished.

The same rule applies to a reviewed **new-Locale proposal** when Source advances.
The old proposal and artifact remain immutable evidence; they are not globally
obsolete. Continuing creates or resumes a proposal pinned to the current Source,
materializes each human-authored or reviewed value whose Source Fingerprint is
unchanged **and whose executable Source Contract remains compatible**, never
overwrites work already present there, and leaves added, changed, or
contract-incompatible Source values as ordinary residue. The prior proposal is
still available as a bounded read-only view over its historical projection. An
interrupted continuation is safe to retry, and carried human authorship remains
valid review evidence. Final delivery remains strict: only the resulting
current-source artifact can compose with a Release Bundle.

---

## 6. Storage

Every ARB file in a Source Snapshot is stored as a **lossless parsed Catalog
Document**: ordered JSON members, all document globals, every message value,
complete per-message metadata, raw placeholder objects, unknown extensions. The
original bytes are kept as immutable snapshot evidence. There is no surgical
raw-file overlay. [Choose the lossless ARB metadata storage
model](https://github.com/serge-the-hedge/flutte/issues/17)

The normalized catalog is a **derived workflow projection**, not a second source
of truth: message identity, source and target values, provenance, Locale
Binding, and the known ICU and placeholder facts validation needs. Unknown
metadata stays opaque — displayable and re-emittable, never independently
indexed.

Update rules:

- Existing target entries keep their own complete metadata unchanged. Target `@`
  blocks stay exactly as ingested — which is precisely what makes a placeholder
  retype a hard `exit 1` across six files instead of a silent signature
  mutation.
- Materializing a source key absent from a target seeds the new entry with the
  source entry's metadata. Unknown fields never propagate into an existing
  entry.
- Document globals are per-file immutable. Only `@@locale` is interpreted, and
  only against the Locale Binding. Unknown globals are never copied between
  files.

**Serialization** is a deterministic complete-file writer from the Catalog
Document, preserving document order and Brickit's formatting policy: 2-space
indent, literal non-ASCII for BMP characters, **astral characters re-escaped as
UTF-16 surrogate pairs**, and **no trailing newline**. Those two rules are the
entire difference between a naive writer and a byte-identical one across all six
catalogs.

At **arm granularity**, the model additionally keeps each Plural Arm's leading
whitespace, inter-token padding, and token as written (`=0` versus `zero`), plus
the block's head and tail, and preserves arm order exactly. This is not
fastidiousness: `workshop_page_sets_widget_subtitle` stores pretty-printed ICU
in five of six Locales, and a serializer emitting its own spacing would rewrite
that key everywhere on the first release for a value nobody edited.

New Blabla-side stored fields the projection needs, beyond what exists today:
**Source Fingerprint** per target value, the **Intentional Blank** reason, and
the **Translator Confirmation** record (key, Locale, value fingerprint).

---

## 7. Contract change

### 7.1 The rule that decides everything

**A message's Message Signature is the union of the template's declared
placeholders and every undeclared argument reference found in *any* Locale.**
The template does not own the signature by itself. This — not the shape of the
ARB diff — determines severity in every case: adding a placeholder is free,
while removing one silently ships the literal text `null`.

### 7.2 The catalogue

| # | Contract change | Result | Automatic transform | Residue |
|---|---|---|---|---|
| 1 | Source **adds** placeholder | targets gain an unused parameter | none needed | stale by fingerprint |
| 2 | Source **removes** placeholder, target still uses it | ships `…nächstes null` | **none possible** | whole value, per Locale |
| 3 | Source **renames** placeholder | `Undefined name` in de, fr, zh | rename the token in every target value and its metadata | none |
| 4 | Source **retypes** placeholder | `gen-l10n` exit 1 | propagate the type to all six `@` blocks | none |
| 5 | Source **plain → plural** | target renders flat for every count | wrap the target in `other{…}` | the arms that language needs |
| 6 | Source **plural → plain** | **whole value becomes `null`** | unwrap `other{…}` only if it references no arguments | whole value, otherwise |
| 7 | Source **adds/removes a plural arm** | nothing happens to targets | none — arms are the target language's business | none |
| 8 | Target **loses `other`** | ICU syntax error, exit 1 | none | invalid, must be repaired |
| 9 | **Key removed** from template | vanishes everywhere | archive target values | none |
| 10 | **Key re-added** | reappears everywhere | restore archived targets when English is byte-identical | restore nothing on a changed value |
| 11 | **Key only in a target** | silently dropped from generation | none | none |
| 12 | Target **introduces an argument** | **changes the abstract signature** | **rejected at save** | n/a |
| 13 | `select`, `selectordinal`, nested plural | supported; signature by the same union rule | same rule, no bespoke transform | unattested |
| 14 | Value needs a literal `{` | ICU lexing error | not expressible | rejected at save |

Rows **2, 6, and 12 are silent** — they pass `gen-l10n` with no warning and
`dart analyze` with no error, and reach users as wrong text or a broken build.
They are why the catalogue exists.

**A Contract Transform never updates a Source Fingerprint.** It preserves
deliverability, not currency, so mechanical repair never reads as finished work.

**A translator can break Brickit's build, and Blabla is the only thing that can
stop it.** Typing `{Instagram}` into a German value changes the abstract
declaration and breaks two real call sites; Brickit's CI never regenerates
localization and its APK build step is commented out. Two guards, both required:
the save-time subset invariant (§3.7), and the delivery command diffing
regenerated signatures against the baseline and refusing on any signature change
outside the delta.

**A broken contract can arrive from Git**, and ingest never refuses it — the
offending thing is a target value, which is Blabla's. It lands as residue with
the token named. Only the two states Blabla cannot express as residue are
Contract Validity failures: a value that fails ICU lexing, and a placeholder
type conflict.

---

## 8. The translator's surfaces

### 8.1 Strings: compact Navigation and bounded card windows

**Catalog Order, always** — the ARB's own order, verified exactly alphabetical
ignoring underscores, 96% prefix-contiguous, maintained by nobody. Waiting work
marks itself and **never sorts ahead**: a list that rearranges as you work it is
the failure this map has rejected twice. [Decide how a translator finds their
way through the catalog](https://github.com/serge-the-hedge/flutte/issues/25)

**Navigation is paged in Catalog Order.** Strings defaults to all active, bound target
Locales alongside Source. A searchable multi-select supports a subset or Source
only. Explicit selections live in the URL; an omitted selection means All,
including newly bound languages. Strings reads compact key digests in bounded
pages and hydrates at most 32 nearby cards through a Window, reducing key
lookahead as the selected Locale count grows. The index retains identifiers and state facts,
not a copy of every translated value. A browse query scans at most 64 digests
with a 512 KiB read budget. Search stops when its effective-text reads reach
2 MiB, allowing the final bounded value read to cross that threshold. Search also caps hydrated targets at 64 per query. Empty pages can have a
continuation when a scan budget is exhausted, including an offset within a key
so later selected Locales are not skipped.
The browser shows page counts, rather than presenting them as catalog totals.

The older whole-Navigation endpoint remains capped at 8 MiB for compatible
callers. It is no longer the Strings loading path. Windows select Source and
requested target Locales, with at most four targets per backend request. The UI
loads selected languages progressively with at most four pending requests,
splitting oversized reads by keys and then languages. Completed batches remain
reactive and merge into one card per key. Changing the language selection
preserves the unsaved-edit navigation guard. Publication changes invalidate
browse generations.

An upgraded deployment whose active Navigation generation predates the
materialized ordinary-import counts is explicitly incomplete for the Agent
preview. A developer or operator starts the resumable Navigation backfill, and
the status read must show `ready` together with the counts envelope before the
preview is served. The status is also durably `failed` with a diagnostic if a
scheduled step cannot finish; an explicit retry clears that diagnostic and
re-arms the bounded worker. This is a maintenance command, not an unattended
repair. The ordinary-import run uses the same readiness gate, so neither its
preview nor its confirmation mutation can start against an incomplete index.

**Search is a literal substring scan over key, Source, and any selected Locale.**
It runs through bounded backend reads of effective workspace values, preserves
Catalog Order, and does not rank. Native Convex tokenization misses internal
terms in unspaced Chinese: a real-backend fixture evaluation found only 10 of
122 literal usages of `积木`; see the
[native search evaluation](../../reports/native-convex-search-evaluation-2026-09-07.md).
Code Area and tag remain separate context and metadata concerns.

**A key is a genuine way to find a string**, never the only one: it is on the
card, a search term, the disambiguator that 382 keys sharing an English value
demand, a clickable prefix scope, and a `?key=` permalink that scrolls and
highlights rather than filtering.

**Catalog Scopes** compose as AND, live in the URL, and render as dismissible
chips with live counts. The initial Navigation contract supports search text,
selected Locales, a waiting state, an **Unconfirmed Import**, and a Work
Hand-off. Code Area, tag, a **Sibling Set**, expansion, and archived keys remain
valid domain concepts, but require their own bounded context or metadata reads.
The selected Locales choose the targets shown alongside Source; a target-state
scope matches a key when any selected target matches. A Work Hand-off narrows the keys without changing Catalog Order.

First-class filters in the initial Navigation contract are **the four phrases a
value already says** — `needs a value`, `English changed`, `English, not chosen`,
`broken` — with the currently implemented value-state subset exposed in the
counts strip. Source Echo filters but never sits with those four, because it
blocks nothing. Nothing auto-tags, ever: a tag is the only axis no machine
writes, and that is exactly its value.

**`Open N in Strings` hands over a Work Hand-off** — a frozen key set plus a
link back to the record that produced it — never a re-evaluated predicate, so a
worklist does not evaporate as you work it.

The page lands on **everything, with no default filter**, and a counts strip
where every count is a one-click scope. Measured, only 14 of 1,434 keys wait on
day one. Archived keys are an explicit scope with no prominence: 8 in two and a
half years.

### 8.2 The per-key editor

Every Locale of a key, **open, full width, in one scroll**. No source panel, no
disclosure, nothing to operate before typing. [Prototype the per-key translation
editor](https://github.com/serge-the-hedge/flutte/issues/24)

- **Every value is a live field from first paint.** The caret lands where you
  click. Fields are borderless at rest, so a page of values reads as text.
- **One commit gesture.** `⌘↵` commits and jumps to the next value still
  waiting, wrapping at the end. Touched it → an edit. Left it alone while it was
  stale → a confirmation. Left it alone and it was not stale → nothing happened.
  `Tab` walks every field, `Esc` reverts.
- **A settled value says nothing.** Silence is the resting state. Only values
  still waiting speak, in one short lowercase phrase. One accent colour, spent
  only on what stops a release.
- **English is a Locale, not a source** — first in the list, editable like any
  other, and editing it produces a Source Proposal. English gets plural arms
  like everyone else.
- **Putting English in a target is not a feature**: you type it, and the field
  says *identical to English — saving records that as the decision*.
- **The only click charged for is a deliberate empty**: one click, a reason,
  Enter. Clearing a field and walking away means *undecided*, which must not be
  the same gesture. Afterwards the value reads `Renders nothing — <reason>`.
- **Multi-column grids are ruled out, not merely unchosen.** Five Locale columns
  in a 1000px pane cannot hold a paragraph.

**Three value states**, not two: **Waiting** (no content, loud), **Unconfirmed
Import** (shipping content nobody here has affirmed — an ordinary field, never
styled as missing, but the key carries a mark), and **Settled** (silent). The
mark is cleared by the confirm gesture that already exists, so dismissing a
correct `Unlock` costs one click.

**Introduced Message is orthogonal, key-level work.** A key first accepted from
Git after bootstrap remains in the **New from Git** Catalog Scope until every
target Locale active at introduction receives a deliberate First Review. Its
populated targets are still Unconfirmed Imports and its empty targets are still
Waiting; the introduction does not invent a fourth value state. See the
[Catalog Message Lifecycle](../catalog-message-lifecycle.md).

### 8.3 ICU shapes

A message is a stack of **Message Segments** in reading order, and **every**
top-level plural and select decomposes — not just the first. A target's segment
stack is independent of its source's, which is why a Chinese value that drops
the plural entirely is an ordinary value here rather than an escape hatch.
[Decide how compound ICU shapes are
edited](https://github.com/serge-the-hedge/flutte/issues/26)

**A plural block is inline text carrying a dotted underline**, showing the
`other` arm as the **Representative Arm**. Typing into it lands on **every arm**
through a character-level alignment; selecting inside it highlights where that
selection lands in each arm, in a mirror layer behind each field so the caret is
never taken away. Each arm remains individually editable in the strip below,
because Russian's five arms exist precisely for the endings the alignment
refuses to touch.

**The live highlight is the safety mechanism, not decoration.** The gesture is
silent and touches text that is off screen; the prototype corrupted an arm's
ending proving it. Any implementation that keeps the multi-arm edit and drops
the highlight has kept the risk and thrown away the mitigation. Insertions
collapse to the right edge; replacements and deletions cover the corresponding
region. The Representative Arm shows placeholders verbatim as `{count}` — it has
to, or every character offset lies.

**Which arm fields appear**: the arms the ingested value carries, in file order,
then any CLDR category the Locale needs and the value lacks. A value with no
content yet gets the CLDR categories plus any Exact-number Case the source uses.

**`zero`/`one`/`two` are Exact-number Cases, not categories** — Flutter's
`pluralCases` maps `'0' → 'zero'` and `Intl.pluralLogic` tests exact numbers
before consulting CLDR — so they are labelled `= 0` and `= 2` and are available
in every Locale.

**Adding an arm is a closed six-item menu.** `gen-l10n` accepts nine tokens but
`=0`/`=1`/`=2` are aliases of the first three on the same generated argument,
and `=3` is a hard build error, so a block has at most six arms ever. Each row
says what the arm does *in this language*. Removal is a per-row `×`, disabled
for `other`.

**A degenerate block collapses for display only** — 26 of 74 blocks have
identical arms — and never writes on its own, so an untouched value stays
byte-identical.

`select` decomposes into a plain arm strip with **no Representative Arm**: its
arms are different words by design and its categories come from the code.
**Nesting is allowed but never decomposed.** The **raw-ICU escape is available
on every value and every shape, always**, as a deliberate per-value toggle, and
is never the default view for a shape that decomposes.

### 8.4 Code context

**One Context Disclosure per key card, present on all 1,434 keys** — including
the 460 with nothing to show, so that absence reads as a sentence inside it
rather than as a signal from a missing control. [Decide how code context reaches
the translator](https://github.com/serge-the-hedge/flutte/issues/27)

The split is decided by one test: **does this finding change the sentence you
write, or does it only tell you where you are?** Only two things sit at rest on
the card:

- the **Sibling Set** mark (49 keys)
- the **Argument Expression** gloss on a placeholder token (33 keys)

Everything else lives inside the disclosure: call sites, Code Area, Placement,
the unreferenced observation, provenance. **Expansion ratio is rendered nowhere
per key at all** — the stacked six-Locale layout already shows it physically, a
badge would fire on 29% of the catalog, and it is blind or near-blind on 11 of
the 14 keys that actually need writing. It survives as a Catalog Scope for a
deliberate sweep.

A **Sibling Set is a Catalog Scope**, identified by key membership rather than
by the helper that selects it. Seven of twelve sets are already contiguous in
Catalog Order; the scope earns its place on the five that are not, one spanning
1,227 keys.

The **unreferenced observation** is one factual line carrying its own boundary —
*No reference found in `packages/*/lib` at `4c6b654`* — never "unused", never a
warning colour, never a count, and **absent entirely** when the scan did not
reach every file. A suppressed finding must not degrade into a hedged one.

**Provenance is always in the disclosure and never on the card**: one line
naming the commit and scan scope, shown even when current, because a stamp that
appears only on staleness makes *current* indistinguishable from *not
implemented*. Staleness never escalates.

A call site renders as **path, line, and a deep link, with no snippet** — Blabla
holds references, not source. The link resolves against the reader's own GitHub
access and asks nothing of Blabla's credentials.

### 8.5 The Dictionary

Blabla-owned, project-scoped, translator-facing, never written to Git. Two entry
kinds: an **Untranslatable Term** (never translated anywhere) and a translatable
entry (one definition plus a rendering per Locale). [Decide the disposition of
imported source-identical
values](https://github.com/serge-the-hedge/flutte/issues/22)

It supplies explicit wording guidance to translators and independent reviewers.
Its planned derived observations silence a **Source Echo** and flag a
**Dictionary Conflict**; those observations are not implemented yet. There is no
automatic term promotion, autocomplete, or release enforcement.

An entry silences an echo only when declared terms account for the value's whole
translatable content, after setting aside placeholders and punctuation. Terms
match **case-sensitively**. **It starts empty and nothing is seeded** — the
eleven all-Locale-identical keys include `Start`, which is plainly untranslated
in Russian, and auto-seeding would write that bug in as a permanent excuse.

Editors maintain one general **Voice Guide** for the project and optional
Locale-specific add-ons. The general guide states the shared audience, tone and
editorial conventions; add-ons supply local details. Both retain immutable
authored revisions and start empty. Catalog frequency never creates policy.

Editors or agents explicitly granted `dictionary-write` may fill and maintain the
Dictionary. Agent writes update active entries directly, record the actual agent
identity, and check the current guidance revision. Batch writes are atomic;
read access and translator credentials alone do not authorize them. Reviewer
credentials cannot also author the Dictionary. No credential can authorize an
agent to create its own translation review evidence.

Context includes the general guide once, applicable Locale add-ons, and matching
terms with immutable citations. A changed guide or Dictionary revision requires
fresh reviewer assessment. These entries never become release authority.

A **Source Echo** is derived and never stored: recomputed whenever either value
changes, never cleared by a human saving the value, and independent of how the
value arrived.

---

## 9. Release

### 9.1 Assessment

**Release Scope** is every active bound target Locale on the Baseline Snapshot —
you cannot ship German alone. **Release Posture** is computed over the keys in
the record's delta, so an English-only delivery is not held hostage to the
catalog's standing backlog.

Three postures, and no others:

| Posture | Meaning |
|---|---|
| **Blocked** | Contract Validity fails. Non-waivable. |
| **Needs Decisions** | A value is undecided, empty with no recorded reason, or its English changed semantically under it in Git. |
| **Ready** | Every target is current or carries confirmed intentional output, and every Introduced Message has completed First Review. |

What blocks, precisely:

| | Blocks |
|---|---|
| Invalid for the contract | Yes, non-waivable |
| No value, no decision | Yes |
| Empty with no recorded reason | Yes |
| English changed **meaning**, in Git | Yes, until confirmed or updated |
| English changed **meaning**, authored in Blabla | No — reported |
| English changed **cosmetically** | No — stale for the translator, ships unchanged |
| Source Echo | No |
| Dictionary Conflict | No |
| **Unconfirmed Import** | **No** |
| **Introduced Message with First Review pending** | **Yes** |

**Unconfirmed Imports never block, and add no posture.** They are present,
plausible, and in the right language — exactly what Brickit ships today. Gating
~195 target slots a month would make Blabla strictly slower to release than the
workflow it replaces. A release containing 39 unconfirmed keys assesses
**Ready**. [Decide how machine-generated placeholder translations are
handled](https://github.com/serge-the-hedge/flutte/issues/28)

That non-blocking rule applies to ordinary imported backlog, not to a known
post-bootstrap introduction. New Git keys commonly carry provisional target
text; presence is not First Review, `ordinary-v1` cannot supply it, and a release
assessment remains **Needs Decisions** until its frozen introduction scope is
reviewed.

### 9.2 The surface

A **pre-flight card, not a workbench**: posture, scope, what stands in the way
with per-Locale spread, what the build would ship and why each part of it is
deliberate, the count of unconfirmed values as a stated fact, earlier records,
and one Build button. **No work happens there** — a single Work Hand-off opens
Strings, which is also where the Reconciliation Report sends its cross-snapshot
backlog. Two surfaces, one workbench.

Evidence stays listed rather than counted away: deliberate blanks appear with
their reasons, source-identical values appear as what they are. Reasons live in
Blabla only — the ARB stays a pure executable contract.

Every assessment produces a durable **Release Record**. Records are history and
are never rewritten.

### 9.3 Delivery

**The command never writes a catalog file. It applies the Release Delta onto the
tree it finds.**

`blabla deliver --release <id>` is the delivery seam. An optional
`--locale-proposal <id>` composes a ready new Locale into the same local
transaction. Both artifacts must name the same repository, Baseline/Source
Snapshot, source manifest and integration branch. The combined form creates
one staging worktree, preflights generation against the untouched tree, then
regenerates after both catalog operations. It produces one commit carrying both
provenance identities. The new-Locale-only command remains a compatibility
adapter, not a second product workflow.

- **Drift is content, not distance.** The predicate compares the Baseline
  Snapshot's catalogs against the delivery tree's, over the bound files only.
  Commit distance is reported for the human and never gates. ARB-touching
  commits run 13–21 a month out of a much larger stream, so distance predicts
  nothing: a HEAD two hundred commits ahead can be byte-identical, and a HEAD
  one commit ahead can carry six rewritten German strings.
- **No lineage gate.** The tree need not descend from the baseline. The command
  requires only that the baseline commit is *reachable* in the local clone, so
  it can compute the delta, and refuses with a `git fetch` instruction when it
  is not.
- **A collision is decided by whether English moved.** If English is unchanged
  since the baseline, the release's value wins — Blabla holds a real translation
  and the tree almost certainly holds a placeholder. If English changed, the key
  is **skipped and reported** as a **Superseded Translation**; the next ingest
  surfaces it as a Stale Translation where it can be retranslated.
- **A key absent from the tree is never resurrected**: skipped, listed, left to
  Archive Reconciliation.
- **Files are edited minimally, never re-serialized.** Only the value strings of
  delta keys change; a key the target file lacks is inserted in the file's
  existing alphabetical position. Canonical serialization survives as a
  **verification oracle**: after editing, the result must parse to exactly the
  intended key/value map or the command aborts without writing. This applies to
  `intl_en.arb` too — rewriting it in canonical sorted order with zero content
  change produces ~1,560 changed generated-Dart lines.
- **Pre-existing generated-Dart drift stops every delivery.** It regenerates
  from the untouched tree's ARB *before* applying anything and stops if the
  output differs from committed `app_localizations*.dart`. Combined delivery
  then runs generation again after both catalog operations and admits only the
  generated files corresponding to target catalogs changed by the Release
  Delta plus the new Locale's declared generated surface.
- **A dirty tree blocks narrowly for existing-only work** — only uncommitted
  changes to bound catalogs or generated localization Dart. Combined delivery
  requires the whole checkout to be clean because it introduces a catalog,
  runtime registration, and generated files in one indivisible candidate.

The commit message carries the trailers, which survive the merge into `git log`
and let a later ingest correlate a commit to the release that produced it:

```
Blabla-Release-Record: <id>
Blabla-Baseline-Commit: <sha>
Blabla-Applied-Onto: <sha>
```

plus the counts. Combined delivery also carries `Blabla-Locale-Proposal`,
`Blabla-Locale-Values`, and `Blabla-Source-Snapshot`. User-facing release and CLI
summaries keep existing-Locale keys/target values separate from the new Locale's
complete catalog value count; a small existing-Locale delta must never visually
hide a much larger new Locale. The full skipped-key body, with a reason per key,
goes to a **file**, and the command prints a ready-to-run `gh pr create --body-file`
invocation — printing the path alone when `gh` is absent. The durable copy is
the Release Record.

The delivery-time catalog upload is a **Delivery Tree Capture**: transient
evidence on the Release Record, never a Source Snapshot. Ingesting it would fire
reconciliation about a tree whose pull request may never merge.

### 9.4 Toolchain

The Flutter SDK is resolved in order — explicit `--flutter-sdk` → `FLUTTER_ROOT`
→ the repo's `.fvm/flutter_sdk` symlink → `.fvmrc` through `fvm` if installed →
`flutter` on `PATH` — then checked against `environment.flutter` in
`pubspec.yaml`, the only pin actually committed. **The version string never
gates anything.** The pre-flight regeneration *is* the toolchain check: an SDK
that generates different Dart fails it whatever it calls itself. The abort
message prints the resolved SDK path and version, because the pre-flight cannot
distinguish "your SDK is wrong" from "the committed Dart is stale" and a human
can.

`gen-l10n` failure aborts before anything is written. The command computes,
verifies, then writes.

---

## 10. Code context production

Produced by the developer command **at submit time**, from a **parse-only** Dart
syntax tree, carrying **raw references rather than findings**. Nothing is added
to `brickit-flutter`: no workflow, no checked-in artifact, no `tool/` directory.
[Decide how the code-context manifest is
produced](https://github.com/serge-the-hedge/flutte/issues/18)

Parse-only is what makes this possible: the checkout is neither bootstrapped nor
code-generated — `.dart_tool/package_config.json` exists in neither package and
there are zero `*.g.dart` on disk — so a resolved analysis cannot run there at
all without minutes of `melos bootstrap` and `build_runner`. A parse-only
producer runs on a bare clone with no `pub get`, no codegen, and no network:
796 files in **711 ms**, serializing to **58 KB**.

- **Grading lives in Blabla**, so a revision re-derives over manifests already
  held rather than re-entering the Flutter repository. **Code Context is derived
  per query and never stored** — including Code Area, which is never written to
  `translationKeys.screenId`.
- **The manifest is an attachment keyed to a commit, never part of Snapshot
  Identity.** It is rejected if it claims a different commit, and it may be
  submitted on its own against any commit Blabla already holds.
- **The producer scans the working tree**, stamped with the commit plus the list
  of scanned files that differ from it. **A manifest observed on a dirty tree
  never replaces one observed clean at the same commit.**
- **It can never block publication.** Absence is loud, not silent: the command
  warns, and the snapshot records that it has none. When a snapshot arrives
  without one, context carries forward under its commit stamp.
- **On partial failure, positive observations survive and the negative one does
  not.** The unreferenced-key finding — 665 keys, 46.4% of the catalog — is
  suppressed whenever the **Complete Scan** property fails. Completeness means
  **files reached, not files free of diagnostics**: a file that could not be read
  or decoded was not scanned; a file that parsed with recovery was. The command
  reports diagnostics as raw observation and applies no suppression itself.
- **Scan scope is project setup**, seeded with `packages/*/lib` in, and `test/`,
  `integration_test/`, `*.g.dart`, `*.freezed.dart`, and generated
  `app_localizations*.dart` out. Tests are excluded deliberately: a key
  referenced only by its own widget test is dead product code.
- The manifest stamps the producer version, the analyzer version, and the SDK's
  Dart version, so a diagnostics spike after a Flutter bump reads as a signal to
  rebuild the CLI.

Findings derived from it: **call sites**, **Code Area**, **Sibling Sets**,
**expansion ratio**, **Unreferenced Key Evidence** (evidence only, never
archiving or proposing), plus **Argument Expression** and **Placement**.

**Layout constraints remain unbuilt.** They are the one finding that genuinely
needs a resolver following a string through the widget tree, and they carry the
bootstrapped-checkout price. Placement is not that finding returning: it says a
string is a tooltip, never how wide the tooltip is.

---

## 11. Security and credentials

- **Git**: none held by Blabla, in either direction. The developer pushes under
  their own credentials and opens the pull request themselves. A read-only
  GitHub token was considered and rejected on measurement, not principle: the
  two purest English-only copy commits in the repository were direct pushes with
  no pull request at all.
- **Blabla API**: the existing hashed `apiTokens` mechanism, project-scoped and
  revocable per token, gaining a **snapshot-submission scope** alongside `read`,
  `search`, `propose`, and `export`. The same scope covers standalone manifest
  submission.
- **CLI credential handling**: token from `BLABLA_TOKEN` or
  `~/.config/blabla/credentials.json` at mode 0600, written by a `login`
  subcommand. **Nothing is written into the checkout** — no `.blabla` file, no
  `.gitignore` line. The project is resolved **server-side** from the Git remote
  URL, with `--project` only to disambiguate.
- **In-product authorization** is the existing project membership model —
  `owner` / `editor` / `viewer` on `projectMembers`, enforced by
  `requireProjectRole`. No new role is introduced by any decision in this map.
- **Rotation** happens at cutover: all six existing tokens are revoked and fresh
  ones issued, because their distribution after months of agent use is
  unaudited.
- **Deep links into GitHub** resolve against the reader's own access. Blabla
  never proxies repository content.

---

## 12. Observability

The system has **no unattended initiator**, which is what keeps this section
small rather than deferred. Blabla cannot reach Git, so it cannot poll or be
triggered by a push. Every operation — ingest, manifest attachment, release
preparation, release build, delivery, and maintenance — begins with a person or
developer command. A started durable run may then execute bounded scheduled
steps without supervision, and must expose progress, terminal state, and
durable diagnostics to the initiating surface. There is no hidden class of
work that starts while nobody has asked for it.

What the decisions do provide, and what implementation must preserve:

- A **Snapshot Ingestion Run** and a **Release Build Run** are durable and
  idempotent, and each ends with its artifact **or with durable diagnostics** —
  never with mere request acceptance.
- A failed snapshot leaves **no partial state**, so recovery is a resubmission.
- A **Navigation Index backfill** and an **ordinary confirmation run** are
  explicit, resumable durable runs. Each exposes bounded progress, a terminal
  status, and a durable diagnostic on failure; retry begins with an explicit
  command rather than a hidden repair.
- Every accepted transition produces a durable **Reconciliation Report** whose
  consequential items stay visibly unread until dispositioned.
- Every assessment produces a durable **Release Record**, and prior records
  remain as history.
- **Staleness is visible rather than announced**: the Baseline Snapshot's commit
  says how current the catalog is, and the Context Disclosure's provenance line
  says how current the context is, always — not only when behind.
- The CLI reports every skipped key with its reason, and warns when it produced
  no manifest and why.

Alerting, notification channels, and dashboards are **not part of this
specification** and no decision above waits on them; see §16.

---

## 13. Cutover

An **ordered sequence, not a data migration**. 121 of Blabla's 125 live keys
already exist in the source catalog, and 120 of 121 target values per Locale are
byte-identical to Git — there is no catalog to map. [Define live-data migration
and cutover](https://github.com/serge-the-hedge/flutte/issues/13)

1. **Purge the test debris** — the four test keys (`for_testing_1..3`,
   `testing`), their values and history rows, the `testing` and `for-testing`
   tags; close the open and rejected test change sets. Letting Archive
   Reconciliation take them would seed the very first Reconciliation Report with
   junk that never leaves it.
2. **Migrate `ch` to `zh` in place.** Forced, not chosen: `intl_zh.arb` declares
   `@@locale: "zh"`, and the Locale Contract rejects a snapshot whose bound file
   declares a different code, so the first ingest cannot succeed otherwise.
   Identity, values, history, and statuses are retained; a migration event is
   recorded; nothing goes stale for the correction. Flutter's `zh-CN` selection
   stays a Runtime Locale Mapping.
3. **Capture the twelve unlanded English copy edits as Source Proposals**,
   before the ingest overwrites them. The thirteenth divergent value —
   `ideas_search_selection_ideas`, which Blabla holds in invalid plural syntax —
   gets no proposal: Contract Validity is non-waivable and Git's form is
   correct. The same reasoning covers the seven keys whose placeholder metadata
   Blabla lacks entirely.
4. **Fix the rollback point** — tag the baseline commit in Brickit and take a
   Convex snapshot export at the same moment. Blabla's pre-cutover state is not
   re-derivable from Git, so the export is its only copy.
5. **Archive pre-cutover history.** The 856 pre-cutover rows, 730 of them
   bulk-import creations, were never gated by any release contract.
6. **Rotate credentials** — revoke all six tokens, issue fresh ones with the
   snapshot-submission scope.
7. **Ingest the full catalog** as the first Baseline Snapshot: all keys across
   six Locales in one Atomic Snapshot Publication. Imported targets initially
   derive as Unconfirmed Imports; ingest does not silently turn repository text
   into a human decision.
8. **Preview and approve the `ordinary-v1` cutover batch once Navigation is
   ready.** It confirms only
   untouched, contract-valid, non-empty target values that differ from Source
   and do not repeat across target Locales of the same key. Reuse of the same
   text by unrelated keys is ordinary catalog content and does not affect
   confirmation state. Empty, source-identical, same-key cross-Locale repeats,
   locally modified, stale, and pending-Source-Proposal values remain visible
   for deliberate review. The one-time bootstrap records the named system policy
   only after a human approves this exact preview; ordinary product use records
   the authenticated editor instead.

A later Git introduction is excluded from `ordinary-v1` while any Locale in its
frozen First Review scope is pending, even when its targets look ordinary. Each
Locale needs a deliberate human decision or authorized independent agent acceptance. After that scope is complete, later
Git values follow the ordinary confirmation/currency rules; introduction
provenance remains permanent, but is not a permanent batch exclusion.

**Shadow release**, both gates mechanical, before any bundle is authoritative:
a **no-op** bundle reproducing the six ARB files byte for byte with a clean
`git diff` after regeneration, and a **one-change** bundle differing in exactly
one key and nothing else.

**After cutover**, delete `packages/brickit/crowdin.yml` — dead configuration
pointing at a path that has not existed since the monorepo restructure. This is
the sequence's only change to Brickit.

**The freeze on direct target-ARB edits is documented convention, not
enforcement.** A CI gate would be a Brickit structural change, and it would be
redundant: an out-of-band edit changes the catalogs and the next ingest sees it.

**Eighteen content bugs are handed to this sequence as a one-off list**, fixed
in Git as ordinary copy changes with no ongoing signal in Blabla: fifteen `= 0`
arms that change what renders at zero (all fifteen wrong — English and Spanish
put the singular where the language wants a plural, French does the reverse in
nine blocks; the fix in every case is to delete the `zero` arm), and three
German values carrying no plural at all where English distinguishes. The two
flattened Russian blocks are correct and must be left alone.

---

## 14. Acceptance tests and oracles

The final oracle everywhere is **the pinned Flutter SDK's own output**.
Regeneration is a pure function of the six catalogs — no `pub get`, no Brickit
dependencies, no app source, no network, 0.78 s warm — so it can run wherever a
pinned SDK exists.

| # | Test | Oracle |
|---|---|---|
| 1 | **Byte-identical round trip** | Parse all six catalogs to Catalog Documents and re-serialize: byte-identical output, including surrogate-pair escaping and no trailing newline. |
| 2 | **Arm-level round trip** | Every plural value re-serializes byte-identically, preserving arm order, token spelling, and pretty-printed spacing. |
| 3 | **No-op bundle** | A bundle built with no translation change reproduces the baseline's six files exactly; regenerating leaves a clean `git diff`. |
| 4 | **One-change bundle** | A single-key change produces a bundle differing in exactly that key and nothing else. |
| 5 | **Generated-interface equality** | Export the complete Locale set, run `gen-l10n`, and compare generated public getters and method signatures against the baseline. |
| 6 | **Signature subset invariant** | A target value introducing an argument the source lacks is rejected at save; the assembled message is checked, not the raw string. |
| 7 | **Signature diff at delivery** | Regenerated abstract-file signatures are diffed against the baseline; any change outside the delta refuses the delivery. |
| 8 | **`other` arm invariant** | A target plural or select block missing `other` is rejected at save. Verified as a hard `gen-l10n` abort in a target file. |
| 9 | **Contract catalogue** | Each of the fourteen rows in §7.2 reproduces its stated transform and residue, with `dart analyze` — not the `gen-l10n` exit code — as the oracle for rows 2, 3, 6, and 12. |
| 10 | **Delta apply against a moved tree** | Delivering a develop-assessed bundle into a `release-5.3.0`-shaped tree preserves the 51 keys the baseline lacks and the 7 it deleted. |
| 11 | **Collision rule** | A key whose English moved in the tree is skipped and reported; a key whose English did not is overwritten by the release. |
| 12 | **Idempotent ingest** | Resubmitting the same Snapshot Identity resumes or returns the existing run and duplicates no history. |
| 13 | **Atomic publication** | An ingest failing mid-batch leaves no baseline, archive, or catalog change. |
| 14 | **Restore on byte-identical re-add** | An archived key whose English returns unchanged restores its archived targets; a changed English restores nothing. |
| 15 | **Manifest partial scan** | An unreadable file suppresses Unreferenced Key Evidence entirely while every positive finding from parsed files survives. |
| 16 | **Clean beats dirty** | A manifest observed on a dirty tree never replaces one observed clean at the same commit. |
| 17 | **Confirmation binds to content** | An incoming Git value that differs from the confirmed one derives as an Unconfirmed Import; the Confirmation is neither cleared nor applied. |

Semantic equality tests protect the codec at TypeScript speed; the pinned-SDK
comparison protects the real corpus.

---

## 15. What this document makes explicit

Five things were consequences of the decisions rather than statements in them.
They are decided here, on the record, so that no implementer has to guess.

**1. Baseline lineage is a reported fact.** [Decide snapshot sync and
reconciliation semantics](https://github.com/serge-the-hedge/flutte/issues/7)
requires Git ancestry to control baseline advancement; [Decide the first Flutter
repository adapter](https://github.com/serge-the-hedge/flutte/issues/12) leaves
Blabla no way to compute it. The adapter reports the relationship it observes in
the clone, and only a reported descendant advances the baseline — §5.1. The
alternative readings both fail: verifying it needs the Git credential this map
has twice refused, and dropping the rule lets the baseline flap between branches
that carry different keys.

**2. Translation Review Mode is not built in the first version.** The term and
its `Unreviewed Translation` stay reserved in `CONTEXT.md` for a project that
needs a separate reviewer, but nothing renders it: [Prototype the per-key
translation editor](https://github.com/serge-the-hedge/flutte/issues/24) made
confirming and saving the same gesture, the postures in §9.1 have no
awaiting-review state. This is separate from allowing a human-authorized agent
to review a translation candidate before it becomes current.

**3. A staged change set is not the translator's unit of work.** The editor's
single commit gesture saves one value. The durable grouping devices that survive
are the Release Record's delta, the Reconciliation Report, the Work Hand-off,
and the tag — all of which are sets of keys rather than staged edits.

**4. An agent submits a Candidate Value, not a current value.** The agent API
appends immutable candidates inside Translation Tasks. Submission changes
neither the Catalog Workspace nor confirmation evidence. An authenticated
editor accepts, edits, or rejects the candidate through the task's review
workflow; accepting a value records its applied basis and Translator
Confirmation. Imported text from Git remains a separate path and may derive as
an Unconfirmed Import. A separate Reviewer Agent may accept or reject exact
candidate revisions when a project owner enables agent review or an editor
delegates that revision to a named reviewer. The reviewer uses a credential
that cannot translate and records its actual identity plus the human authority.
Authorized acceptance may complete First Review and Translator Confirmation;
submission alone never does. See [Agent Review](../agent-review.md) and the
[Agent Translation Guide](../agent-api.md).

**5. English is never an Unconfirmed Import.** Git authors it, and making
English an editable peer Locale in the editor does not change who writes it in
the repository.

---

## 16. Deliberately not specified

None of these blocks implementation, and no decision above reopens if they are
answered differently later.

- **Alerting, notification channels, and operational dashboards.** §12 explains
  why there is nothing running unattended to alert about. A team that later
  wants "nobody has submitted a snapshot in three weeks" as a push rather than a
  visible fact can add it without touching anything here.
- **The production operating and ownership model** — who owns credentials and
  failures, who watches the toolchain pins as Brickit's Flutter moves, what
  response time the workflow needs. Organizational, and answerable only once the
  thing is running.
- **A Dictionary management surface.** Its semantics are fully specified in
  §8.5; where entries are typed is implementation.
- **Layout-constraint context**, which needs a resolver and a bootstrapped,
  fully code-generated checkout. It travels with that price or not at all.
- **Performance and retention targets beyond the measured Brickit catalog.**
  §8.1 defines bounded Navigation and Window reads. See
  [capacity and storage trade-offs](../adding-languages.md#several-languages-and-capacity);
  structural guards do not establish latency or quota guarantees for 50 or
  100 full-size languages.
- **Content beyond Flutter ARB.** The [collection proposal](content-collections.md)
  covers directly authored marketing copy and its relationship to the existing
  repository workflow. Store Listing Content remains outside ARB snapshots,
  release bundles, and reconciliation; implementation is pending.

### Standing risks, recorded rather than solved

- **Brickit's CI checks nothing about localization.** `flutter_bloc_tests.yml`
  runs `build_runner` and `flutter test test/` — never `gen-l10n` — the APK
  build step is commented out, and 2 of 62 test files reach any screen. Blabla's
  save-time invariant and delivery-time signature diff are therefore the only
  things standing between a target-value edit and a broken build.
- **`.fvmrc` is not committed.** A fresh clone has no Flutter pin beyond
  `pubspec.yaml`'s range. Verification by regeneration output (§9.4) makes this
  harmless for correctness, which is why committing it did not clear this map's
  bar for a Brickit change.

---

## 17. Superseded register

Read a resolution comment and you may find a rule that has since been retired.
This is every such case.

| Retired | By | Now |
|---|---|---|
| `Fallback Approval`, `Batch Decision`, `Ready with Deviations` | [#16](https://github.com/serge-the-hedge/flutte/issues/16) | Deleted. Postures are Blocked / Needs Decisions / Ready. A translator wanting English types it. |
| `recordFallbackApproval` in the module interface | [#16](https://github.com/serge-the-hedge/flutte/issues/16) | Removed; `attachContextManifest` added by [#18](https://github.com/serge-the-hedge/flutte/issues/18). |
| Posture name `Requires Approval` | [#16](https://github.com/serge-the-hedge/flutte/issues/16) | `Needs Decisions`. |
| `Source-identical Translation` as a state | [#22](https://github.com/serge-the-hedge/flutte/issues/22) | Retired. Identity is a derived **Source Echo**; the value is ordinary and current. |
| Cutover's "first release reproduces Git as Ready with Deviations" | [#16](https://github.com/serge-the-hedge/flutte/issues/16) | Undecided values block; nothing is grandfathered because pre-cutover content is exported and discarded. |
| "Reliable inference needs a real Dart resolver" | [#18](https://github.com/serge-the-hedge/flutte/issues/18) | Parse-only reaches every applied finding. The case against **regex** survives; the resolver is needed for layout constraints alone. |
| "A target-only change cannot break the build" | [#23](https://github.com/serge-the-hedge/flutte/issues/23) | False for an edit that introduces an argument, which changes the shared abstract signature silently. |
| Scan completeness meaning "free of diagnostics" | [#20](https://github.com/serge-the-hedge/flutte/issues/20) | Files **reached**. Two files with modern-analyzer diagnostics would otherwise cost 665 keys of evidence permanently. |
| "One field per plural category the target language needs" | [#26](https://github.com/serge-the-hedge/flutte/issues/26) | `zero`/`one`/`two` are Exact-number Cases, live in every language; the rule as written would delete a live arm from all 74 blocks. |
| The filter axis named `screen` | [#27](https://github.com/serge-the-hedge/flutte/issues/27) | **Code Area** — 47 areas, only 17 of them `screens/*`. Placement unchanged: second-class, in the filter bar. |
| "The delivery command writes the target catalogs" | [#19](https://github.com/serge-the-hedge/flutte/issues/19) | It applies a Release Delta. A wholesale write from a month-old baseline silently drops every key added since. |
| A contract-breaking change requiring an explicit rebase | [#15](https://github.com/serge-the-hedge/flutte/issues/15) | No rebase step. Transforms run automatically where nothing is lost; the residue is per-Locale translation work. |
| Cutover's Crowdin mapping question | [#13](https://github.com/serge-the-hedge/flutte/issues/13) | `crowdin.yml` is dead configuration pointing at a nonexistent path; it is deleted, not mapped. |
| A Blabla-held read-only GitHub token | [#21](https://github.com/serge-the-hedge/flutte/issues/21) | Rejected on measurement — the commits it would watch were direct pushes with no pull request. |
| A TypeScript CLI with a Dart helper | [#20](https://github.com/serge-the-hedge/flutte/issues/20) | One Dart binary. `tree-sitter-dart` is a 2023 "grammar attempt"; `package:analyzer` parses 796 files in 711 ms. |

---

## 18. Splitting this into implementation tickets

A suggested order, chosen so each stage is testable against a named oracle from
§14 before the next depends on it.

1. **Catalog Document and codec** — parse, store, re-serialize; tests 1 and 2.
   Everything else reads through this.
2. **Snapshot ingestion** — Snapshot Identity, atomic publication, runs; tests
   12 and 13.
3. **Catalog projection and reconciliation** — archive, restore, transforms,
   residue, the Reconciliation Report; tests 9 and 14.
4. **Strings** — Catalog Order, the initial bounded Catalog Scopes in the URL,
   client-side search, virtualized DOM, counts strip, and card Windows.
5. **The per-key editor** — live fields, the single commit gesture, Message
   Segments and arms, Intentional Blank, Translator Confirmation; tests 6 and 8.
6. **Release assessment and bundle** — postures, findings, Release Record,
   deterministic bundle; tests 3, 4, and 5.
7. **The Dart CLI, submit half** — ARB read, parse-only manifest, snapshot
   submission; tests 15 and 16.
8. **The Dart CLI, delivery half** — delta apply, minimal edit, regeneration
   pre-flight, trailers and skipped-key body; tests 7, 10, and 11.
9. **Code context derivation and the Context Disclosure** — grading server-side,
   the two at-rest findings, the Sibling Set and expansion scopes.
10. **The Dictionary** — entries, Source Echo silencing, Dictionary Conflict.
11. **Cutover** — the seven-step sequence, the two shadow-release gates, and the
    eighteen content bugs fixed in Git.

Stages 4–6 are what a translator sees and 7–8 are what a developer runs; they
can proceed in parallel once 1–3 exist, because the module interface in §2.1 is
the only thing between them.
