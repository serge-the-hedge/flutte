# Catalog Message Lifecycle

This is the normative travel map for Catalog Messages and Target Values. The
[control-plane specification](spec/localization-control-plane.md) defines the
full system; this document keeps its lifecycle decisions in one place.

## Boundary and route

```text
merged application repository (Release Truth)
  -> Repository Adapter submits one complete commit
  -> immutable Source Snapshot and, for a reported descendant, Baseline advance
  -> Catalog Projection and Catalog Workspace decisions
  -> Release Preparation and a durable Release Record
  -> Release Build Request and immutable Release Bundle
  -> Repository Adapter computes the Release Delta against the delivery tree
  -> Flutter localization regeneration and a local review branch
  -> developer push, review, and merge
       |-> a later ordinary ingest observes the merged result
       `-> the application's independent build and release process ships it
```

Blabla is a control plane, not the runtime source of text. It records bundle
creation and the Release Delta computed against a captured delivery tree. Only
later ordinary ingestion proves that result reached the merged repository, and
Blabla cannot prove that the application was built or released.

## Independent facts

Do not compress a Target Value into one `status`. Blabla tracks:

1. **Presence** — content, an Intentional Blank, or neither.
2. **Contract Validity** — valid syntax and Message Signature preservation.
3. **Currency** — whether its Source Fingerprint answers the current Source
   Contract.
4. **Translator Confirmation** — whether a Translator Confirmation matches this
   exact value and Source Contract.
5. **Provenance** — Git, a person, an agent candidate, restoration, or a Locale
   Proposal.

At key level, an Introduced Message has permanent post-bootstrap provenance and
a frozen First Review scope. At release level, immutable records preserve what
was assessed, bundled, applied, and later observed.

These facts are independent. A populated value can be valid and current but
unconfirmed. A confirmed value becomes stale when its source changes. An
Introduced Message may contain plausible text everywhere while First Review is
still pending.

## Import transitions

| Incoming evidence | Result |
|---|---|
| First accepted Baseline | Non-empty targets become Unconfirmed Imports; absent or empty targets become Waiting. The explicitly approved `ordinary-v1` sweep may confirm conservative ordinary values. |
| Existing message, source and target unchanged | Exact Translator Confirmations and Intentional Blanks continue to apply. |
| Existing target changed in Git | Git becomes visible and the Reconciliation Report records the change. An exact historical decision for the same value and Source Contract applies again; otherwise a non-empty replacement is an Unconfirmed Import and an empty replacement is Waiting. |
| Existing source changed in Git | An unchanged target retains the Source Fingerprint it answered, so every source change makes it stale. Semantic change blocks; cosmetic change remains visible but non-blocking. A Contract Transform preserves validity, not confirmation or currency. |
| Source and target changed together | The imported target may answer the new Source Contract. An exact historical decision for that pair applies again; otherwise it remains unconfirmed until an authorized reviewer affirms the pair. |
| Message first accepted after bootstrap | It becomes an Introduced Message permanently. Locales active at introduction form its frozen First Review scope. |
| Source identifier or bound Locale absent | Its retained state is soft-archived. An unbound file is setup evidence, not an active Locale. |

Bootstrap permits the initial broad confirmation. A later introduction must
complete First Review through deliberate per-Locale authorized decisions before any
subsequent value can qualify for ordinary batch confirmation.

For an Introduced Message:

- populated imported targets are Unconfirmed Imports;
- absent or empty targets are Waiting;
- imported text is starting material, not review evidence;
- `ordinary-v1` excludes the entire message while First Review is pending;
- each Locale completes First Review only through a deliberate human decision or authorized independent agent acceptance;
- **New from Git** includes the key while any Locale in the frozen scope still
  lacks First Review.

Locales added later are outside that frozen scope and do not reopen it. They
follow their actual setup path, such as binding an Unbound Locale File or
realizing a Locale Proposal.

Removing and restoring a key preserves introduction provenance. A
byte-identical re-add can restore archived targets automatically. If the source
returns changed, archived targets are not restored automatically and the target
work remains unresolved.

Preview Snapshots support provisional work but never create introductions,
advance the Baseline, or establish delivery truth.

## Human and agent decisions

| Gesture or route | Visible result | Translator Confirmation |
|---|---|---|
| Save a target edit in Strings | Updates the Catalog Workspace | Yes |
| Approve an unchanged target | Keeps the value | Yes |
| Record an Intentional Blank for an empty target | Keeps deliberate empty output and its reason | Deliberate equivalent |
| Submit an Agent Translation Proposal | Candidate remains inert | No |
| Accept an exact or edited candidate | Applies it to the target workflow | Yes, from the reviewing person |
| Authorized independent agent accepts an exact candidate | Applies unchanged candidate bytes and any blank reason | Yes, with agent identity and human authorization |
| Edit Source in Strings | Creates a Source Proposal for Git delivery | Not a target confirmation |
| Review and finalize a Locale Proposal | Creates a complete candidate catalog artifact | Only for reviewed candidate applications |
| Automatic restore or Contract Transform | Updates derived catalog state | No new confirmation |

Translation agents may propose and revise content. Human review is the default.
An owner can enable independent agent review for the project, or an editor can
authorize a named reviewer for an exact candidate revision. The Reviewer Agent
must use a separate credential and cannot translate with it. Authorized exact
acceptance can create a Translator Confirmation or complete First Review;
submission and rejection cannot. See [Agent Review](agent-review.md) for the
permission, concurrency, and evidence contract.

## Working presentation

| Facts | Presentation | Required action |
|---|---|---|
| Contract invalid | **Blocked** | Repair the value or Source Contract |
| No target content and no Intentional Blank | **Waiting** | Write a value or record a reasoned blank |
| Current non-empty content lacks exact confirmation | **Unconfirmed Import** | Approve unchanged or edit and save |
| Confirmed content answers older semantic source | **Source changed** | Confirm it remains correct or edit and save |
| Confirmed content answers older cosmetic source | Quiet source-change mark | Optional review |
| Exact current confirmation or valid Intentional Blank | Settled and silent | None |
| A frozen-scope Locale still lacks First Review | **New from Git** on the key | Complete deliberate First Review |

**New from Git** is key-level provenance layered over ordinary per-value states;
it never replaces Waiting, Unconfirmed Import, or Stale Translation.

Identical text on unrelated keys is ordinary reuse. Identical target text across
different Locales of one key remains suspicious and is excluded from ordinary
batch confirmation. Source-identical content is likewise a visible fact, not a
workflow state.

## Batch policy

The ordinary-import batch retires conservative imported backlog, especially at
bootstrap. It may confirm only untouched, contract-valid, non-empty,
source-different, non-repeated current values with no pending Source Proposal.
It excludes every Introduced Message whose First Review is still pending.

Translation Tasks and Locale Proposal review may accept many values at once
because they preserve an explicit candidate set and a person reviews that set.

## Release, delivery, and observation

Release Posture is computed for every active bound target Locale in its Release
Scope, over only the keys in the Release Record's delta:

- Contract Validity failures are **Blocked**.
- Waiting or semantically stale targets produce **Needs Decisions**.
- An Introduced Message produces **Needs Decisions** while any Locale in its
  frozen scope lacks First Review.
- Ordinary Unconfirmed Imports remain visible, non-blocking legacy backlog.

Release records keep existing-Locale changes, complete new-Locale additions,
ordinary imports, pending First Reviews, and Source Proposals distinct.

A Release Bundle is immutable evidence from one ready Release Record. The
Repository Adapter captures the delivery tree, computes and applies the exact
Release Delta, regenerates Flutter localization output, and creates a local
review branch. Git review, push, merge, and application release remain developer
or application-CI actions.

Returning to previously confirmed target bytes makes the historical affirmation
relevant again, but does not transfer it across Source Contracts. The value is
settled only when a decision matches both its current content and current Source
Contract.

The repository-observation loop closes when a later ordinary ingest accepts the
merged commit as a Baseline descendant. A complete organizational release gate
would additionally require application CI to consume Blabla readiness evidence.

## New Locale delivery

A finalized Locale Proposal becomes delivery evidence. An accepted descendant
Snapshot records an exact artifact-path/content observation only when the pinned
Source Contract still matches. Reviewed authorship, review authorization, and
Intentional Blank reasons transfer with publication; failed private staging
never supplies visible confirmations.

An editor can bind a matching Unbound Locale File from the current Baseline.
Binding Realization stages and atomically publishes the refreshed projection
and binding, without changing Snapshot Identity. A binding made before delivery
is handled during ordinary ingestion. Existing messages retain their original
First Review scope. See [Adding a language](adding-languages.md).

## Compatibility note

Introduction provenance is recorded exactly beginning with the first Baseline
accepted by an implementation that supports it. Older projections must not infer
that every unconfirmed key is post-bootstrap. A historical migration may
reconstruct earlier introductions from immutable Snapshot evidence, but it must
be explicit, bounded, and previewed.
