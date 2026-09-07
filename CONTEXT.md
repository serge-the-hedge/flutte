# Blabla localization

Blabla is a localization control plane for versioned application catalogs. It
keeps translation work reviewable without becoming the application’s runtime or
release authority.

## Language

**Source Contract**:
The exact source-language localization definition: a message identifier, source
text, and executable metadata such as its placeholder schema.
_Avoid_: source string, master translation

**Release Truth**:
The merged application repository state that supplies the files compiled and
shipped in a release.
_Avoid_: live catalog, latest service state

**Translation Control Plane**:
The Blabla workspace where a Git-addressed catalog snapshot gains context,
translation proposals, review decisions, and readiness evidence.
_Avoid_: runtime translation service, source of release files

**Localization Sync Module**:
The deep Blabla Module that owns Source Snapshot ingestion, Release Record
assessment, and deterministic Release Bundle creation. Its web, agent,
repository, and transport clients are adapters, not separate workflow
implementations.
_Avoid_: export endpoint, release UI

**Repository Adapter**:
A delivery client that submits a complete Git commit and file manifest to the
Localization Sync Module, then applies its Release Delta onto a branch or pull
request. It owns Git transport and credentials, not localization policy.
_Avoid_: Release Truth, Localization Sync Module

**Source Snapshot**:
An immutable, Git-addressed representation of a catalog's source contract at a
specific repository commit.
_Avoid_: live catalog, latest translations

**Catalog Document**:
The complete ARB material for one Locale in a Source Snapshot: its message
values, per-message metadata, and document globals. It remains snapshot-bound
evidence; catalog state exposes only the workflow facts derived from it.
_Avoid_: message table, editable metadata

**Catalog Message**:
A stable message identifier joining one Source Contract to its target-Locale
values and history. The identifier is the key; each Locale's text is a value,
so neither should be called the string when the distinction matters.
_Avoid_: string, translation row

**Target Value**:
The content one target Locale currently renders for a Catalog Message, together
with the Source Fingerprint it answers. Presence, validity, and Translator
Confirmation are independent facts about it.
_Avoid_: translation status, translated string

**Baseline Snapshot**:
A Source Snapshot from the configured release ref that anchors the accepted
working catalog.
_Avoid_: current catalog, latest branch

**Integration Branch**:
The project-level Git ref from which Repository Adapter syncs are accepted and
against which reviewed locale delivery pull requests are based. For the current
Brickit integration this is `develop`; a checkout on another branch is not a
valid sync or delivery source.
_Avoid_: whatever branch happens to be checked out, latest branch

**Baseline Lineage**:
The Git ancestry relationship that determines which Source Snapshot may advance
a Baseline Snapshot, independent of upload order. Blabla holds no Git
credential, so it never computes this itself: the Repository Adapter reports the
relationship it observed in its own clone, and only a reported descendant
advances the baseline. Trusting that report adds nothing, since the same adapter
is already the sole source of the catalog bytes.
_Avoid_: latest upload, snapshot timestamp, verified ancestry

**Preview Snapshot**:
A Source Snapshot from an unmerged branch or pull request, used only for
provisional work.
_Avoid_: baseline, release candidate

**Locale**:
A stable language or language-region unit with a canonical catalog code and a
human-readable label, independent of its catalog file and runtime selection.
Its identity survives label, binding, and legacy-code changes.
_Avoid_: filename, runtime locale, locale string

**Locale Binding**:
A project setup association between a Locale and its catalog file path; source
snapshots use the binding rather than inferring locale identity from filenames.
_Avoid_: filename convention, inferred locale

**Locale Contract**:
The requirement that a bound catalog file declares the Locale's canonical
catalog code in its format metadata. A file path may vary, but a metadata
mismatch prevents snapshot publication.
_Avoid_: filename identity, compatibility alias

**Locale Code Migration**:
A deliberate change to a Locale's canonical catalog code that retains its
identity, history, and translation status, and is recorded as an explicit
migration event. Its former code is not a valid setup, API, or snapshot alias
after migration.
_Avoid_: locale replacement, dual code

**Runtime Locale Mapping**:
An adapter-specific mapping from a Locale's catalog code to the application's
runtime selection, such as Flutter's `zh-CN`. It does not create another
catalog Locale.
_Avoid_: catalog locale, ARB locale

**Locale Variant**:
A distinct Locale with its own catalog file and canonical code because its
translatable content differs by script or region. It exists only when the
Source Contract actually contains that separate catalog.
_Avoid_: runtime fallback, compatibility alias

**Locale Proposal**:
A Blabla-authored candidate to add one target Locale and its complete Catalog
Document, pinned to a Source Snapshot and carrying its Runtime Locale Mapping.
An agent's Candidate Values can contribute only through authorized review; a ready
artifact is delivery evidence, not an activation or a second approval stage.
It remains a proposal until a Repository Adapter delivers it under developer
Git credentials and a later Source Snapshot establishes its Locale Binding; it
never mutates active Locale bindings or snapshot evidence by itself.
_Avoid_: Source Proposal, Unbound Locale File, direct locale creation

**Unbound Locale File**:
A catalog file found in a Source Snapshot without a Locale Binding; it is
reported for setup but excluded from active translation and release work.
_Avoid_: new locale, invalid snapshot

**Locale Delivery Observation**:
A durable link between a ready Locale Proposal artifact and an exact matching
Unbound Locale File in a later Source Snapshot. It proves only that delivery
reached Source Snapshot evidence; it neither creates a Locale Binding nor
makes a Locale active.
_Avoid_: activation, merge status, delivery command receipt

**Binding Realization**:
The bounded, atomic derived-projection transition that follows an editor
binding a matching Unbound Locale File from the current Baseline Snapshot. It
adds the deliberately bound Locale to the active Catalog Workspace without
changing Snapshot Identity or advancing the Baseline Snapshot.
_Avoid_: re-ingest, second Source Snapshot, activation command

**Store Listing Content**:
Localizable App Store or Google Play text held manually in the Translation
Control Plane. It shares Locale identity but is outside ARB snapshots, release
bundles, and ARB reconciliation.
_Avoid_: ARB catalog, app release bundle

**Snapshot Identity**:
The project, repository, commit, and complete file manifest that uniquely
identify a Source Snapshot; a repeat submission resumes or returns it.
_Avoid_: latest import, upload attempt

**Atomic Snapshot Publication**:
The all-or-nothing promotion of a validated snapshot and its reconciliation;
a failed snapshot cannot partially change the accepted catalog.
_Avoid_: partial import, incremental publish

**Snapshot Ingestion Run**:
A durable, idempotent work record for validating and publishing one complete
Source Snapshot. It ends with a published snapshot or durable diagnostics, not
merely request acceptance.
_Avoid_: import request, partial upload

**Code Context Manifest**:
An immutable record of where the application's own source references each
message, observed by parsing that source and bound to the commit and parser
versions it was observed at. A Repository Adapter submits it; it attaches to a
Source Snapshot without joining Snapshot Identity, and its absence never
prevents publication.
_Avoid_: snapshot identity, inferred metadata, release gate

**Complete Scan**:
The property that every file in a Code Context Manifest's declared scope was
read and parsed into a syntax tree. A file carrying parse diagnostics still
counts as scanned, because recovery is local; only an unreadable or undecodable
file breaks it. Unreferenced Key Evidence alone depends on it.
_Avoid_: clean parse, zero diagnostics

**Code Context**:
The translator-facing material derived from a Code Context Manifest and the
catalog: call sites, Code Area, Sibling Sets, Placement, Argument Expressions,
expansion ratio, and Unreferenced Key Evidence. It is recomputed from the
current manifest and grading rules rather than stored, never reaches ARB, never
becomes a Source Proposal, and gates nothing. It is also the only context that
exists — the catalog holds one description and no placeholder examples in 1,434
keys.
_Avoid_: ARB metadata, stored finding, readiness signal

**Unreferenced Key Evidence**:
The observation that a message is referenced nowhere in a completely scanned
source tree, retained against the commit it was observed at. It is evidence a
human acts on, never an Archive Reconciliation or a Source Proposal, and it is
withheld entirely whenever the scan was incomplete.
_Avoid_: dead key, automatic archive

**Source Proposal**:
A Blabla-authored candidate change to the source-language value of a message
that already exists, held alongside the ingested value rather than over it and
provisional until Git merges and Blabla re-ingests it. It reaches Git on an
ordinary Release Bundle rather than a path of its own, and it can never add,
rename, or remove a key or alter a placeholder or ICU shape.
_Avoid_: source snapshot, new key, separate pull request

**Agent Translation Proposal**:
A durable agent-authored collection of Candidate Values for either existing
Catalog Workspace targets or one Locale Proposal, never both. It records its
agent provenance and basis, but changes neither target until a person or an
authorized independent Reviewer Agent reviews a candidate through that target's
own workflow.
_Avoid_: Change Set, direct edit, automatic translation

**Reviewer Agent**:
An agent assigned to review another agent's exact Candidate Value revision. Human
review is the default. A project owner may enable agent review for the project,
or an editor may authorize a named reviewer for one revision. The reviewer uses
a separate credential that cannot submit translations; every review records its
real agent identity and the human authorization. A translation agent cannot
review its own work. See [Agent Review](docs/agent-review.md).
_Avoid_: self-review, automatic approval, human reviewer

**Candidate Value**:
A durable proposed target value inside an Agent Translation Proposal, tied to
its message, Locale, Source Fingerprint, and current target facts. Competing
candidates may coexist; a changed basis makes a candidate stale rather than
letting it overwrite current work. A correction is a visible new revision, not
an erasure of the earlier proposal.
_Avoid_: draft value, live value, Translator Confirmation

**Archive Reconciliation**:
A recorded automatic archive of a key or target Locale absent from a complete,
accepted source update; it retains history and supports restoration.
_Avoid_: deletion, cleanup

**Restore Proposal**:
A Source Proposal seeded from an archived key and its retained history when Git
does not currently contain that key.
_Avoid_: direct unarchive, undo

**Reconciliation Report**:
A durable, snapshot-bound record of detected changes and automatic actions,
with recovery links but no pre-approval gate.
_Avoid_: toast, approval queue

**Introduced Message**:
A Catalog Message first accepted from Git after the bootstrap Baseline. This is
permanent provenance, not a temporary review state or content quality guess. Its
target Locales active at introduction form a frozen First Review scope; the
message appears under New from Git while any Locale in that scope still lacks
First Review. Archive and restoration preserve the introduction rather than
creating another one.
_Avoid_: new string, Unconfirmed Import, recent key

**First Review**:
The first deliberate authorized decision for one target Locale of an Introduced
Message: a human confirms, edits and saves, accepts a candidate, or records an
Intentional Blank; an authorized independent Reviewer Agent may also accept an
exact candidate, including its reasoned blank. Agent submission and ordinary-import
batches never supply First Review. Later content changes remain governed by
Translator Confirmation and Source Fingerprints.
_Avoid_: automatic approval, bootstrap confirmation, translation presence

**Release Scope**:
The active, bound target Locales on a Baseline Snapshot that must be assessed
together for a release. Omitting one requires a deliberate setup or source
change, not a per-release bypass.
_Avoid_: selected export, ad hoc locale waiver

**Release Posture**:
The result of assessing a Release Scope: Blocked for non-waivable contract
failures, Needs Decisions while any value is undecided or its meaning changed
under it, or Ready when every target is current or has confirmed intentional
output.
_Avoid_: binary pass/fail, transient notification, ready with deviations

**Release Finding**:
An exact fact from a release assessment that needs a delivery disposition, such
as a missing value for one Locale and source fingerprint.
_Avoid_: inferred group, notification

**Release Record**:
A durable record of a release assessment, its findings, decisions, output, and
evidence. The latest record is presented before release approval while prior
records remain as history.
_Avoid_: warning, transient toast

**Release Assessment**:
The deterministic calculation of Release Findings and Release Posture for one
Source Snapshot and catalog revision. A Release Record preserves an assessment
used for delivery.
_Avoid_: live dashboard counter, export attempt

**Release Preparation**:
A deliberate request to assess the current Release Scope and create or reuse
its Release Record. It is distinct from lightweight live translation status.
_Avoid_: page refresh, export attempt

**Release Bundle**:
The complete immutable target-catalog output and manifest produced from one
release-ready Release Record for a Repository Adapter to deliver to Git.
_Avoid_: latest export, pull request

**Release Delta**:
The exact key set a Release Bundle changes relative to its Baseline Snapshot's
own catalogs, derived at delivery rather than shipped. A Repository Adapter
applies it onto the tree it finds, so any key the release does not name keeps
whatever value that tree already holds.
_Avoid_: complete file write, patch file

**Baseline Drift**:
Content divergence between a Baseline Snapshot's bound catalogs and the tree a
Release Delta is applied to. It is measured in keys and values rather than in
commits, is repaired by the delta rather than refused, and never gates delivery.
_Avoid_: commit distance, merge conflict

**Delivery Tree Capture**:
The bound catalog files a Repository Adapter uploads at delivery so its Release
Delta can be computed against the tree it is about to write. It is retained as
Release Record evidence and never published: it reconciles nothing, advances no
Baseline Snapshot, and the next ordinary ingest reads that commit instead.
_Avoid_: Source Snapshot, baseline advance

**Superseded Translation**:
A translated value skipped at delivery because its source text changed in Git
after the Baseline Snapshot it was assessed against. It is reported rather than
written, and the next ingest surfaces it as a Stale Translation.
_Avoid_: merge conflict, rejected translation

**Release Build Request**:
The deliberate act that approves a current release-ready Release Record and
starts its Release Build Run. In the default one-translator mode, it is the
final release approval rather than a separate ritual.
_Avoid_: automatic export, separate mandatory approval

**Release Build Run**:
A durable, idempotent work record for creating one Release Bundle. It ends with
the complete artifact and manifest or durable diagnostics, not merely a queued
request.
_Avoid_: export request, bundle download

**Translation Review Mode**:
A project setting that decides whether a valid human-applied target value is
complete on save (the default) or awaits a separate reviewer. It is not a
delivery-deviation policy; when separate review is enabled, awaiting values
cannot be exported.
_Avoid_: mandatory second approval, release exception

**Unreviewed Translation**:
A target value awaiting the separate reviewer required by Translation Review
Mode. It is unfinished only when that optional mode is enabled.
_Avoid_: default manual edit, delivery deviation

**Message Signature**:
The generated public interface of one message, formed from the union of the
source's declared placeholders and every undeclared argument reference found in
*any* Locale. Because the union spans Locales rather than deriving from the
source alone, a target value can change it, so it is a catalog-wide property
rather than a source-side one.
_Avoid_: placeholder schema, source signature

**Contract Validity**:
The fact that a target message has valid format syntax and leaves its Message
Signature and its source's declared metadata intact. A failure cannot be
accepted as release-ready.
_Avoid_: translation completeness, content omission

**Contract Transform**:
The mechanical reshaping of an existing target value to fit a changed Source
Contract, applied automatically wherever it loses nothing. It preserves
deliverability rather than currency, so it never updates a Source Fingerprint
and a transformed value stays stale until an authorized edit or candidate
acceptance establishes its current Source basis.
_Avoid_: rebase, migration, auto-translation

**Translation Residue**:
The part of a contract change that no Contract Transform can repair, surfaced
per Locale with the reason it survived. It is what remains when the mechanical
part is already done, never the whole change.
_Avoid_: conflict, merge failure

**Source Fallback**:
The absence of a target message, causing its adapter to use the Source
Contract's template-locale output. It is unfinished translation work, not a
target translation or completed localization, and no Release Bundle may contain
it: an undecided value blocks its Locale instead.
_Avoid_: empty translation, copied source, approved deviation

**Dictionary**:
A Blabla-owned, project-scoped, translator-facing record of how particular
terms are handled, including definitions and chosen Locale renderings. It guides
wording, explains Source Echoes, and identifies Dictionary Conflicts without
becoming catalog content or release authority.
_Avoid_: ARB metadata, translation memory, glossary export

**Voice Guide**:
A human-authored statement of the project's audience, tone and editorial
conventions, shared across Locales, with optional Locale-specific add-ons and
curated examples that translators and reviewers can cite. It expresses chosen
practice independently of how often wording appears in the catalog.
_Avoid_: inferred style, translation memory, release rule

**Untranslatable Term**:
A Dictionary entry naming a term that is never translated in any Locale, with a
description of why. It explains a Source Echo only when declared terms account
for a value's whole translatable content.
_Avoid_: locale-specific exception, release waiver

**Source Echo**:
The derived observation that a target value is character-identical to its
source, contains translatable content, and is unexplained by the Dictionary. It
is recomputed from current values rather than stored, is never cleared by a
human saving the value, and never blocks a release.
_Avoid_: workflow state, completed translation, release blocker

**Dictionary Conflict**:
The derived observation that a target value renders a Dictionary term
differently from the Locale rendering that Dictionary entry declares. It is
surfaced for attention and never blocks a release.
_Avoid_: contract failure, enforced terminology

**Intentional Blank**:
A target output deliberately set empty for exact keys in a Locale despite a
non-empty source, recorded by a confirmed direct action and bound to that
source. It is completed localized output, while a carried or imported blank
without that provenance remains unresolved.
_Avoid_: missing translation, unresolved blank

**Source Fingerprint**:
The exact source-language value a target value was authored against, recorded on
that target. It makes currency a comparison rather than an event: a target is
current while its fingerprint matches the Source Contract, so a value written in
the same pass as a Source Proposal is current the moment that proposal lands, and
one left untouched by that pass goes stale.
_Avoid_: snapshot commit, edit timestamp

**Stale Translation**:
A retained target-language value whose source wording changed and which must be
confirmed or updated before it can be exported for that Source Snapshot. It
remains current across releases while its source is unchanged.
_Avoid_: missing translation, rejected translation

**Contract-breaking Change**:
A source-contract change to a message identifier, placeholder schema, or ICU
shape that prevents existing target work from being carried forward unchanged.
_Avoid_: copy edit, formatting change

**Catalog Order**:
The canonical order of the keys in a catalog: alphabetical, ignoring
underscores. It is not imposed — it is the order Brickit's ARB files already
hold exactly, and because keys are prefixed by feature it clusters related
messages without anyone maintaining the grouping. It is the order Strings lists
in and never varies with workflow state.
_Avoid_: sort order, key index

**Navigation**:
The compact, project-wide read of the active Catalog Projection used to find
work in Strings. It carries one digest per key — Catalog Order, search text, and
small state facts — but not Locale values or ARB metadata.
_Avoid_: full catalog read, hydrated list

**Navigation Index**:
The disposable, projection-bound read model that stores Navigation digests and
its exact row/byte envelope. It is derived from canonical Catalog Projection
evidence and may be rebuilt without changing the accepted catalog.
_Avoid_: source snapshot, cache

**Navigation Generation**:
One complete Navigation Index for one exact Catalog Projection. A generation is
staged and verified before publication, and the active generation is replaced
atomically when the Baseline changes.
_Avoid_: catalog version, index snapshot

**Window**:
A bounded read of complete key cards selected from Navigation in Catalog Order.
It hydrates only the requested keys and never changes the order or meaning of
the Navigation Index.
_Avoid_: page, full catalog

**Catalog Scope**:
A composable narrowing of the catalog — search text, key prefix, Code Area, tag,
Locale, a waiting state, an Unconfirmed Import, a Sibling Set, expansion, or a
Work Hand-off — carried in the URL and shown as a dismissible chip. Scopes combine as AND and select whole keys rather than single
values, since every Locale of a key is on screen regardless.
_Avoid_: Release Scope, saved view

**Work Hand-off**:
A frozen set of keys passed from a human-facing origin into Strings or an
agent. It may come from a Reconciliation Report, Release Record, or deliberate
selection, and carries a reference back when a durable record produced it. It
is a set rather than a re-evaluated predicate, so a value settled while working
it stays listed and the count handed over remains the count.
_Avoid_: filter, queue

**Message Segment**:
One top-level part of a message, in reading order: a run of literal text, or a
plural or select block. A message is a stack of them, and a target's stack is
independent of its source's — which is why a Locale that needs no plural can
hold the same message as one text segment without leaving the editor.
_Avoid_: chunk, fragment, token

**Plural Arm**:
One case of a plural block. There are at most six, ever: `zero`, `one`, `two`,
`few`, `many`, `other`. gen-l10n accepts nine tokens but `=0`/`=1`/`=2` are
aliases of the first three on the same generated argument, and `=3` is a build
error — so the vocabulary is closed and can be offered in full rather than
guessed at. Every block must carry `other` or generation aborts.
_Avoid_: plural variant, plural form, case

**Exact-number Case**:
A Plural Arm selected by the number itself rather than by the language's rule —
`zero`, `one` and `two`, which Flutter tests before consulting CLDR and which
are therefore available in every Locale. It is not a plural category, and
labelling it as one is what makes it get filled by copying a neighbour: all 15
in Brickit that change what renders are wrong.
_Avoid_: plural category, zero case

**Representative Arm**:
The arm a plural block shows inline in the sentence, standing in for all of its
arms — `other`, since it is the only one guaranteed to exist. An edit made in it
lands on every arm through a character alignment, with the mapped span
highlighted in each arm first, because the gesture is silent and touches text
that is not on screen.
_Avoid_: default arm, primary form, source arm

**Context Disclosure**:
The single on-demand surface carrying a key's Code Context. It is present on
every key, including the 460 that have nothing to show, so that absence reads as
a sentence inside it rather than as a signal from a missing control. Everything
that merely orients a translator lives here; only what changes the words they
write is allowed outside it.
_Avoid_: context panel, metadata section, info badge

**Code Area**:
The directory a message is referenced from — `widgets/paywall`,
`screens/settings` — claiming provenance and nothing more. It is not a screen:
583 of 769 referenced keys never touch a `screens/` file, so naming it one
promises a place that cannot be opened. It is derived per query rather than
stored, and it is coarse by nature — one area holds 250 keys.
_Avoid_: screen, location, page

**Sibling Set**:
A set of messages one code path selects among, so that each must stay parallel
with the rest. It is identified by its key membership rather than by the code
that selects it, and it is a Catalog Scope rather than a per-key readout,
because six keys that must agree are readable as a narrowed list and unreadable
as six captions.
_Avoid_: dynamic key, key group, related keys

**Placement**:
The immediate syntactic parent of a call site — `Text(...)`,
`BrickitTooltip(tooltipText:)` — recording where a message is put, never how
much room it is given. It is an AST parent rather than a proximity window, which
is what separates it from the layout constraint that still waits for a resolver.
_Avoid_: layout constraint, width budget, container

**Argument Expression**:
The expression a call site passes for a placeholder — `part?.quantity ?? 0`,
`daysAgo` — recorded as written. It is the only thing that says what an opaque
placeholder holds, since no placeholder in the catalog declares an example, and
it is therefore one of the two findings shown at rest.
_Avoid_: example value, sample data, placeholder value

**Translator Confirmation**:
The stored record that a person or an authorized independent Reviewer Agent
affirmed an exact target value against an exact Source Contract: key, Locale, value fingerprint, and Source
Fingerprint. It is written by the same gesture that saves an edit or accepts a
Candidate Value, so confirming an untouched value costs no more than editing
one. Agent submissions never write it; authorized agent acceptance records the
reviewer identity and human authorization. A later content or source change does
not erase the record; it remains historical evidence but stops applying until
both fingerprints match again.
_Avoid_: reviewer sign-off, approval step, translated flag

**Unconfirmed Import**:
The derived observation that a current, non-empty target value has no applicable
Translator Confirmation matching its content and Source Contract — it arrived
from Git and nobody here has vouched for that pair. It says nothing about who or
what wrote the value: Blabla never tries to detect machine text, because content
cannot, and this catches a hand-typed target or a paste equally. It ships, never
blocks, and never expires,
but it is not settled either — 87% of the machine placeholders now entering the
catalog are rewritten by a human within a median of 8 days.
_Avoid_: machine translation, placeholder, Unreviewed Translation, Source Echo
