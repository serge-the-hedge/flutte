# Locale-adding readiness review

Reviewed 2026-09-07 against commit `e33bd6c1ad2e032a58f9d55c90034b23f97ac084`.
Concurrent Dictionary and Voice Guide changes are outside this review.

**Not ready to introduce a handful of new languages.** Translation, review, and
local Git delivery have a substantial Portuguese implementation. The workflow
does not yet support arbitrary new Locales, and two independently reproduced
problems prevent calling even the Portuguese lifecycle complete.

## What works

| Step | Current capability |
| --- | --- |
| Existing catalog setup | Human editors can create canonical Locale identities and bind repository paths in Sync. The CLI discovers committed ARBs in the bound directories and reports unbound files. |
| New-Locale preparation | One resumable Portuguese proposal per project and Baseline, separate from active Locale Bindings. |
| Translation | Generic Translation Tasks expose bounded source pages, immutable agent candidates, revisions, and correction feedback. Human editing also works. |
| Review | Human review or separately authorized independent agent review; unreviewed agent values cannot finalize. Complete source coverage, source fingerprints, ICU contracts, and reasoned blanks are checked. |
| Source advances | A fresh proposal can carry compatible reviewed values forward; changed contracts remain review work. |
| Delivery | Hash-checked Portuguese artifact; optional combination with existing-Locale release work from the same source evidence. The Dart adapter validates Git and Flutter state, creates a local review commit, and leaves pushing/merging to the developer. |
| Becoming an ordinary active Locale | Manual binding exists, but capacity and review-evidence transfer are blockers described below. |

Evidence: [apps/web/src/routes/projects.$projectId.sync.tsx:177](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/apps/web/src/routes/projects.$projectId.sync.tsx#L177),
[cli/lib/snapshot_sync_adapter.dart:390](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/snapshot_sync_adapter.dart#L390),
[packages/backend/convex/localeProposals.ts:889](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/packages/backend/convex/localeProposals.ts#L889), `:1411`, `:3147`,
[cli/lib/release_delivery_adapter.dart:168](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/release_delivery_adapter.dart#L168), and
[cli/lib/locale_proposal_adapter.dart:331](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/locale_proposal_adapter.dart#L331).

## Findings

### P1 — The seventh bound catalog cannot enter the Baseline

The working catalog permits **six Locales including Source**. Brickit's existing
English plus five targets already uses all six. Adding Portuguese therefore
exceeds the cap before normal ingestion can publish it.

Reproduction: ingest six one-message bound catalogs; create and bind `pt`; submit
a descendant with all seven catalogs. The second ingestion records a failed
run containing `A catalog projection supports at most 6 bound Locales.` The
previous Baseline remains intact. This is a functioning failure boundary, but
it blocks the advertised next-Locale journey.

Evidence: [packages/backend/convex/catalogProjection.ts:34](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/packages/backend/convex/catalogProjection.ts#L34) and
[packages/backend/convex/snapshots.ts:1770](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/packages/backend/convex/snapshots.ts#L1770). The separate row cap is 10,038,
exactly 1,434 keys × seven catalogs; an eighth full Brickit catalog also exceeds
that cap (`snapshots.ts:1229`). Snapshot and working-catalog byte caps are 8 MiB.

Setup currently accepts these bindings and reports `canSubmit: true` because it
checks for a Source and a target, not working-catalog capacity. Its `maxFiles`
advertises the separate 1,000-file ingestion envelope. Capacity failure is
discovered only after submission (`snapshots.ts:167`, `:469`).

### P1 — Importing a finalized proposal strands its review evidence

Reproduced independently below the Locale cap: create a source-only Baseline;
human-author Portuguese text and an Intentional Blank with a reason; finalize;
bind Portuguese; ingest the exact artifact as a descendant. Ingestion succeeds,
but the imported text has no Translator Confirmation and the blank becomes
**Waiting**, without its reason. The original evidence remains in the proposal;
it is not connected to the new Catalog Workspace identity.

The proposal stores its reviewer, authorization, and blank reason in
`localeProposalValues` (`localeProposals.ts:1731`). Snapshot projection derives
ordinary Git rows (`snapshots.ts:1260`). Current-value confirmation looks only
in `catalogWorkspaceDecisionRecords`
(`catalogWorkspaceDecisionQueries.ts:12`). There is no implemented proposal
realization step connecting those identities. Proposal delivery status itself
only distinguishes current/stale source evidence (`localeProposals.ts:737`),
not observation of the delivered artifact.

This needs a source- and value-exact realization transition, preserving original
review provenance and blank reasons. The domain model already separates a
**Locale Delivery Observation** at ingestion from **Binding Realization** after
an editor binds the observed file ([CONTEXT.md:137](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/CONTEXT.md#L137), [CONTEXT.md:144](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/CONTEXT.md#L144)). Neither is currently
implemented. Realization must not infer approval from arbitrary matching
translations or from a developer merely having created a branch.

### P1 for the planned rollout — New-Locale identity is hardcoded throughout

`localeProposals` schema permits only `pt` / `pt-BR`
([packages/backend/convex/schema.ts:543](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/packages/backend/convex/schema.ts#L543)). Human task creation rejects other
codes (`agentTranslationProposals.ts:745`); the HTTP behavior is explicitly
covered by the Italian-rejection test (`localeProposals.integration.test.ts:1633`).
“Configured” currently means compiled-in Portuguese, not a project setting that
can be filled in for Italian, Japanese, or other languages.

The task launcher says Prepare Portuguese
([apps/web/src/routes/projects.$projectId.proposals.index.tsx:45](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/apps/web/src/routes/projects.$projectId.proposals.index.tsx#L45)), and the
workbench is Portuguese-specific. Release selection returns one optional
Portuguese proposal (`releaseBundles.ts:59`, `:169`). The CLI accepts one
`--locale-proposal`, instantiates `PortugueseLocaleDelivery`, and validates its
fixed identity ([cli/lib/release_delivery_adapter.dart:166](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/release_delivery_adapter.dart#L166),
[cli/lib/locale_proposal_adapter.dart:197](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/locale_proposal_adapter.dart#L197)).

Runtime registration is also specific: `_addPortugueseRuntimeMapping` inserts
`Locale('pt', 'BR')` using exact French registration anchors
([cli/lib/locale_proposal_adapter.dart:668](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/lib/locale_proposal_adapter.dart#L668)). Drift safely rejects delivery.
Renaming the HTTP route or changing schema strings alone cannot generalize this
pipeline.

### P2 — Task history disappears from the UI after the first 50 results

The task list requests a single page of 50 with a permanently null cursor and
provides no continuation control
([apps/web/src/routes/projects.$projectId.proposals.index.tsx:41](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/apps/web/src/routes/projects.$projectId.proposals.index.tsx#L41), `:170`).
Older unfinished tasks remain addressable by ID but cannot be discovered there.
Dozens of Locales and repeated source continuations make this a practical
workflow issue. Use the existing backend pagination with a modest Load more
control and Locale filtering.

## Coherent implementation path

1. **Finish the lifecycle and establish a measured capacity contract.** Make
   setup, task capability discovery, and ingestion agree on supported capacity.
   Record exact Locale Delivery Observations during accepted ingestion. Follow
   deliberate binding with bounded, atomic Binding Realization over the current
   Baseline's observed file; do not require re-ingestion or advance Snapshot
   Identity to apply that setup decision. Preserve review evidence without
   reopening historic First Review scope. Test six existing catalogs → reviewed
   seventh artifact → local delivery → merged descendant observation → explicit
   binding and realization → ordinary edits and release. Also handle explicit
   binding before the delivery commit is ingested.
2. **Generalize identity once.** Add project-configured introduction targets
   containing canonical code, label, catalog path, and Runtime Locale Mapping.
   Pin that configuration into immutable proposal/artifact evidence. Parameterize
   the existing task, proposal, review, search, and delivery modules; retain one
   implementation. Offer one searchable Locale selector, with the same workbench.
   Resolve regional/script variants explicitly instead of deriving runtime
   identity from a language-only code.
3. **Scale the bounded pipeline before promising dozens.** Raising six to seven
   alone fits the present 10,038-row ceiling but does not establish a safe larger
   capacity. Audit per-key reads shared by Navigation, release, restoration, and
   ordinary confirmation; the complete 8 MiB working-catalog read; the 4 MiB
   Navigation result; and accumulated archive/reconciliation evidence. Reuse
   existing staged workers and cursor reads where possible, with row and byte
   budgets per step. At 30 catalogs, the current corpus needs 43,020 rows.
   Exercise introduce/archive/restore/source-change/release scenarios at the
   intended count and realistic message sizes before choosing the new limits.
4. **Support a handful of introductions operationally.** A repeatable single
   Locale delivery is sufficient initially if deliberately documented. If the
   product wants one release containing several new Locales, use a list of
   source-compatible artifacts and one runtime-registration/generated-output
   verification pass. Do not add a parallel command for each language.

Relevant capacity seams: `catalogProjection.ts:2473`,
`catalogWorkspaceNavigation.ts:55`, `:990`, `:2264`,
`snapshots.ts:1332`, `:1414`, `releaseRecords.ts:549`, and
`archiveReconciliation.ts:1291` (all under `packages/backend/convex/`).

## Validation and limits

- 42 existing backend tests passed across `localeProposals.integration.test.ts`
  and `locales.integration.test.ts`.
- Two temporary focused integration reproductions confirmed the seventh-Locale
  failure and stranded confirmation/Intentional Blank evidence. Removed after
  review; the reproduction steps are retained above.
- 39 Dart tests passed across repository delivery, snapshot sync, and Agent API
  gateway suites. They use Git fixtures and simulated generation where specified.
- No cloud deployment, application server, external repository mutation, or live
  Flutter acceptance run was performed.

The existing real-corpus proof checks English ingestion through Portuguese local
delivery, not later merged re-ingestion ([cli/README.md:195](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/README.md#L195)). Its passing result
does not cover the two lifecycle blockers. The Flutter integration test requires
an explicitly supplied Brickit checkout ([cli/test/brickit_flutter_integration_test.dart:56](https://github.com/serge-the-hedge/flutte/blob/e33bd6c1ad2e032a58f9d55c90034b23f97ac084/cli/test/brickit_flutter_integration_test.dart#L56)).

**Launch decision:** continue preparing terminology, voice, and reviewed draft
translations where supported; finish the above lifecycle and identity work
before starting a multi-language rollout through Blabla.
