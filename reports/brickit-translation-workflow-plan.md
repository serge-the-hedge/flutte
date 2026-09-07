# Blabla as Brickit’s localization control plane

## Executive decision

Blabla should accompany Brickit’s Flutter localization workflow, not replace
Flutter localization or become a runtime dependency of the app.

The target operating model has two deliberately different kinds of truth:

- The merged Flutter repository is the **release truth**: it contains the ARB
  files that generate the app’s typed localization interface and ship in a
  build.
- An approved, Git-addressed Blabla snapshot is the **translation-work truth**:
  it contains values, review decisions, status, context, terminology, and
  history while a release is being prepared.

The bridge between them must be boring and exact:

```text
Flutter commit
  → ingest and validate one six-locale snapshot
  → translate and review against that immutable base
  → produce one deterministic release bundle
  → open or update a Flutter pull request
  → run gen_l10n and the app’s normal quality gates
  → re-ingest the merged commit idempotently
```

Blabla already has the difficult human-control nucleus: roles, scoped agent
tokens, reviewable change sets, conflict detection, history, and stale-on-source
change behavior. The current blocker is more basic. Its ARB path is lossy and its
bulk path cannot accept the real catalog.

## The evidence that governs the plan

The inspected Flutter commit is `4c6b65419745` on `main`, using Flutter 3.44.6.
The inspected Blabla worktree is `730526b53c39`; the relevant service
implementation still matches the behavior analyzed by the reports.

Brickit has six ARB files—`en`, `de`, `es`, `fr`, `ru`, and `zh`—with 1,434
message keys in each file. That is 8,604 locale values before history. The files
range from about 150 to 184 KiB and are consumed by Flutter’s built-in
`gen_l10n`; generated Dart is committed beside them
(`packages/brickit_generated/l10n.yaml` and
`packages/brickit_generated/lib/l10n/intl_*.arb`).

The configured Brickit project in Blabla currently has 125 active keys, six
locales named `en`, `es`, `de`, `ch`, `ru`, and `fr`, four tags, zero screens,
zero descriptions, and zero stored placeholder schemas. Only 104 service keys
overlap the app catalog.

The current exporter changes code identity:

- `buildExportContent` calls `toArbKey` for every ARB key
  (`packages/backend/convex/exports.ts:119-132`).
- Applied to Brickit, 1,424 of 1,434 keys are renamed.
- The transform creates 80 collision groups containing 295 input keys. Object
  assignment silently overwrites 215 keys, so only 1,219 survive.

The current importer loses executable metadata:

- ARB parsing admits placeholder objects, but import persists only their names
  (`packages/backend/convex/importValidation.ts:107-179` and
  `packages/backend/convex/imports.ts:128-164`).
- Flutter uses placeholder type and format metadata to determine generated
  method signatures and formatting behavior.
- The measured round-trip output fails `flutter gen-l10n`; the untouched files
  generate successfully.

The bulk path is not an integration path:

- `MAX_IMPORT_MESSAGES` is 50
  (`packages/backend/convex/importValidation.ts:5-9`).
- One 1,434-key locale therefore needs 29 requests; the six-file catalog needs
  174.
- Import still performs per-message reads and writes inside one mutation
  (`packages/backend/convex/imports.ts:116-206`).
- `WorkflowManager` is registered, and job rows have a `workflowId`, but no
  workflow uses it (`packages/backend/convex/workflows.ts` and
  `packages/backend/convex/schema.ts:271-305`).

The present quality model also conflates states that a release gate must keep
distinct. An empty value becomes `missing`, but export materializes absent
values as `""` (`packages/backend/convex/lib.ts:47-49` and
`packages/backend/convex/exports.ts:85-98`). Flutter can fall back for an absent
message; an explicit empty string can ship empty UI.

Brickit’s current files contain quality work that a useful service should
surface:

- Only one of 1,434 keys has a translator description.
- English declares placeholders on 67 keys.
- There are 380 target values exactly equal to English. Fourteen are empty in
  both source and target, leaving 366 non-empty source-copy candidates; some
  are legitimate product names and must support an explicit “accepted” finding.
- There are 48 empty target values, plus three empty English source values.
- Static source analysis found roughly 662 keys with no Dart reference and
  found that 701 of 772 referenced keys map to one screen or widget area. The
  first number is a review queue, not an automatic deletion list; the second is
  a strong opportunity to create translator context mechanically.

Finally, the checked-in Crowdin mapping points to `/lib/l10n/app_en.arb`, while
the actual catalog is under `packages/brickit_generated/lib/l10n/intl_*.arb`
(`packages/brickit/crowdin.yml`). No inspected CI path repairs that mismatch.
Codemagic does run the repository’s broader code-generation commands, so “zero
validation” would be too strong; what is absent is a dedicated localization
contract gate that checks semantic ARB parity, explicit generator success,
generated-interface drift, and a clean regenerated-file diff. There is
currently no trustworthy localization pipeline to preserve.

## Comparison of the three reports

| Report | Strongest contribution | Main weakness | Role in this synthesis |
| --- | --- | --- | --- |
| `temp/brickit-fit-report.html` | Best measured diagnosis: it exercises the round-trip behavior, runs the real Flutter generator, quantifies collisions, dead-key candidates, context recovery, and length expansion, and gives the most decisive sequence. | Its service round trip is a faithful simulation of the TypeScript behavior rather than a call through a deployed Blabla workflow. Some estimates are optimistic: a multi-locale loop alone is not a durable release contract, and “roughly a day” does not include snapshot semantics, storage, migration, or CI hardening. | Analytical spine and priority ordering. |
| `reports/brickit-translation-overlay` | Best product and operating model: it uses live catalog state, distinguishes Git release truth from service workflow truth, introduces immutable Git-addressed snapshots, and ends with a credible acceptance sequence. | It gives less prominence to the actual generator failure and data loss. Its P0 set is too wide: pagination, locale migration, catalog ingestion, and compiler-grade validation should not all block the first fidelity proof. | Target contract, domain language, phased trust model, and acceptance gates. |
| `temp/brickit-overlay-report.html` | Broadest inventory: the fit matrix, separate Blabla/Flutter work lists, security notes, open questions, and capability coverage are useful as a completeness check. | It is the least selective. More than thirty proposed changes obscure the few load-bearing ones, several implementation choices are premature, and its “Blabla is authoritative” wording is too coarse for a workflow in which Git still controls source changes and releases. | Supporting backlog and risk checklist, not roadmap. |

The best combined report therefore starts with the fit report’s failure proof,
uses the field report’s dual-truth operating model, keeps the overlay report’s
open questions, and replaces all three task inventories with acceptance-gated
vertical slices.

## The target domain model

Four terms should be used consistently:

**Source snapshot** — an immutable import of all localization inputs from one
repository commit: files, paths, locale identities, content hashes, parsed
message contracts, and code-context manifest.

**Working catalog** — the reviewed translation state based on a source snapshot.
It may advance through change sets, but it never silently changes the source
snapshot beneath them.

**Release bundle** — immutable generated files plus a manifest containing the
source snapshot, approved catalog revision, filenames, locale mapping, hashes,
readiness result, and generator evidence.

**Release truth** — the merged Flutter commit containing the bundle’s ARBs.
Blabla recognizes this commit on re-ingest; it does not invent a parallel
release lineage.

This vocabulary removes the apparent “which system is the source of truth?”
contradiction. Git owns code identity, source-copy changes, and shipped files.
Blabla owns the controlled work that turns a source snapshot into an approved
release bundle.

## The module to deepen

Today import, export, validation, UI mutations, agent operations, and jobs expose
too much of the workflow’s implementation to callers. The design target is one
deep **Localization Sync module** with a small external interface:

```ts
ingestSnapshot(input: SnapshotSubmission): Promise<SnapshotIngestionRun>
openRelease(input: ReleasePreparation): Promise<ReleaseRecord>
recordFallbackApproval(input: FallbackApprovalRequest): Promise<ReleaseRecord>
buildRelease(input: ReleaseBuildRequest): Promise<ReleaseBuildRun>
```

The interface includes invariants, not just TypeScript types:

- `ingestSnapshot` receives a complete repository commit and file manifest from
  a Repository Adapter. It is idempotent by project, repository, commit, and
  content hash; its durable run either atomically publishes a Source Snapshot or
  preserves diagnostics without partial catalog change.
- `openRelease` is a deliberate release-preparation action, not a dashboard
  refresh. It creates or reuses a Release Record for one Baseline Snapshot and
  catalog revision. Its internal Release Assessment is deterministic and pure.
- `recordFallbackApproval` accepts a finite selection of current missing
  findings from one Release Record. The module resolves and persists exact
  source fingerprints itself; callers cannot create a standing group rule or an
  arbitrary delivery exception.
- `buildRelease` is the final approval action in Brickit’s one-translator mode.
  It rechecks the current Release Record, refuses anything other than `Ready`
  or `Ready with Deviations`, and starts an idempotent Release Build Run rather
  than returning six ARB strings inline.

ARB and JSON already justify a real format seam. A Flutter ARB adapter must
preserve message identifiers and all unknown metadata while exposing known
placeholder and ICU contracts for validation. The HTTP API, web UI, agent API,
Repository Adapter, and future CLI should be adapters into the same module, not
separate workflow implementations. The Repository Adapter owns Git transport
and credentials: it submits raw files or storage handles to ingestion, then
downloads a completed Release Bundle and writes a branch or pull request. The
module never fetches Git or creates that pull request itself.

Raw uploaded files and release bundles belong in file storage. Normalized,
queryable facts—snapshots, file manifests, entries, findings, provenance, and
run progress—belong in indexed tables. Large files, result bundles, or
unbounded child lists should not live inline on one Convex document. Reading a
run, Release Record, or bundle artifact is an adapter query; it is not another
workflow command.

The interface is also the test surface. Existing parser and helper tests remain
useful below it, but adoption is decided by tests that cross the full module:
ingest a source snapshot, inspect findings, prepare an approved revision, build
a release, and verify the observable files and manifest.

## Security and operational contract

The existing project-scoped, hashed, revocable agent tokens are a sound base,
but source synchronization and release delivery need their own permissions.
Add separate `sync_source` and `release_export` capabilities, token expiry and
rotation ownership, environment binding, and audit events for snapshot creation
and bundle download. A pull-request bot’s repository credential must remain
separate from its Blabla export credential.

Every mutating automation request needs an idempotency key and expected base
snapshot or revision. A request must not be replayable against another project,
environment, or stale branch. Every bundle download must be traceable to the
Release Record, release-build requester, manifest, and checksums that produced
it.

The current owner/editor/viewer model does not enforce separation between
translation editing, review, apply, release approval, and token administration.
Whether Brickit needs two-person release control is a product decision, but the
module interface must not make that separation impossible.

Jobs need observable progress, bounded retries, cancellation, durable
diagnostics, and alerts for queue age, partial failure, generator
incompatibility, and readiness failures. “Completed” means the manifest and
every locale artifact are durable and verified. Automation errors should retain
protocol meaning—especially HTTP 429 and retry information—rather than turning
every non-authentication failure into a generic 400. Wildcard browser CORS must
be revisited before any browser-held integration credential is introduced.

Rollback is Git-first: revert the bundle pull request or re-export a previous
immutable release revision, then re-ingest the resulting merged commit.

## Delivery plan

### Gate 0 — Freeze the compatibility contract

Create a checked-in synthetic golden corpus containing snake_case and numeric
collision cases, typed and formatted placeholders, plurals and selects,
non-breaking spaces, `@@locale`, unknown metadata, empty and missing values, and
locale-specific message shapes. Add a private cross-repository Brickit corpus
test unless policy explicitly allows the proprietary six-file catalog to be
vendored into Blabla. Add two test layers:

1. A fast semantic round-trip test invokes the real TypeScript codec over the
   golden corpus and asserts exact message identity, value equality, locale
   identity, descriptions, complete placeholder metadata, unknown metadata
   preservation, and explicit missing-value behavior.
2. A private Flutter integration job writes the produced Brickit bundle, runs
   the pinned `flutter gen-l10n`, and compares generated public getters and
   method signatures. A no-op round trip must produce no semantic or
   generated-interface diff.

The first test should fail on the current code before any fix lands. This is the
single highest-leverage starting point because it converts the reports’
diagnosis into a permanent compatibility boundary.

Exit gate: the tests reproduce the current key loss and generator failure with
actionable diagnostics.

### Gate 1 — Make one catalog lossless

Implement the Flutter ARB adapter behind the Localization Sync module:

- Preserve keys verbatim; reject unsupported identifiers instead of normalizing
  them.
- Preserve `@@locale`, descriptions, complete placeholder objects, and unknown
  metadata.
- Parse ICU with a real MessageFormat parser. Validate syntax and argument
  contracts separately from locale-specific plural policy.
- Separate absent, intentionally empty, source fallback, stale, unreviewed, and
  accepted-source-copy states in release findings.
- Serialize deterministically without pretending whitespace and key order are
  semantic identity.

Do not migrate live Brickit data yet.

Exit gate: all six fixture ARBs make a no-op round trip, `gen_l10n` succeeds,
all 1,434 public identifiers survive, and generated signatures do not drift.

### Gate 2 — Ingest an immutable full snapshot

Add source snapshots, file manifests, provenance, and per-file processing
results. Upload complete files once, store them in file storage, and process
bounded batches through a durable workflow. Publishing the snapshot is atomic:
callers either see a complete six-locale snapshot or a failed job with
per-entry diagnostics.

Ingest must produce a reviewable reconciliation plan:

- new source keys,
- changed source values or contracts,
- unchanged keys,
- absent keys proposed for archive,
- locale and metadata mismatches,
- context-manifest changes.

On an accepted baseline snapshot, automatically soft-archive a source key
absent from the source contract and a bound target locale whose file is absent.
Retain their history, make each action prominent in a durable reconciliation
report, and offer a recovery path; previews never archive the accepted catalog.
Branch snapshots remain separate from the project’s accepted baseline until
explicitly promoted.

Add a least-privilege `sync_source` token scope. The browser UI and repository
client use the same operation. Snapshot creation carries an idempotency key and
expected parent snapshot.

Exit gate: a clean project ingests the Brickit commit in one operator action,
records 1,434 active source keys and six locale files, and retries safely
without duplicate history.

### Gate 3 — Deliver a release back to Git

Make the settled project release policy a first-class result. Assess the whole
active, bound target-locale set on the Baseline Snapshot, not an ad-hoc export
selection. Invalid ICU or a target that breaks the source-declared metadata and
generated public interface is non-waivable and blocks delivery.

The ordinary Brickit mode is self-confirming: a valid human-saved or explicitly
accepted target value is complete immediately. An unchanged source carries that
work across releases; a changed source wording makes only its target value stale
until the translator confirms or updates it. A human-saved source-identical
value and a confirmed intentional blank are complete localized output, recorded
as evidence but able to produce a `Ready` release. A future separate-review
mode may make unreviewed values non-exportable without changing this default.

Keep absent target values distinct from `""`. A missing message uses Source
Fallback and is never exportable by default. A source-bound Batch Decision may
approve an exact finite selection of missing findings and source fingerprints;
only then is the release `Ready with Deviations`. Visual grouping may make that
selection easy, but it must not become a standing locale- or feature-wide rule.
Persist every assessment, its findings, decisions, output, and evidence as a
durable Release Record; show the latest one before release approval and retain
relevant unresolved facts beside their strings.

Build one release bundle containing all six ARBs and a manifest with:

- repository and source commit,
- source snapshot and approved catalog revision,
- locale-to-filename mapping,
- content hashes,
- readiness policy and result,
- generator/toolchain version.

Start this work as an idempotent Release Build Run. The Repository Adapter waits
or polls for its completed artifact, then writes the bundle atomically to Git;
it must not treat request acceptance as a ready bundle.

Add a small Brickit-side client command that writes the bundle atomically. In CI
it uses an expiring, environment-bound export-only credential, runs
`flutter gen-l10n`, verifies generated code policy, and then runs the
repository’s normal analysis and tests. The first delivery can be a
developer-run command that opens a reviewable pull request; automatic PR
creation is a later adapter, not a prerequisite for the contract.

Exit gate: approving one translation change in Blabla creates a Flutter pull
request whose diff contains only the intended ARB and generated-code changes,
and the merged commit re-ingests as the same release state.

### Gate 4 — Make it better than hand-edited JSON

Once the bridge is trusted, ingest a code-context manifest generated in the
Flutter repository:

- static Dart call sites,
- feature and screen attribution,
- ambiguous or dynamic references,
- unreferenced-key candidates,
- optional character or component-role hints.

Use it to generate translator context and findings. Start with the high-confidence
91% of live keys that map to one area. Let agents propose descriptions through
the existing review system. Dead keys remain candidates until a human confirms
that dynamic and cross-repository use has been ruled out.

Add accepted findings for legitimate source copies and intentional locale
differences. Then add terminology and style guidance. Screenshot capture should
follow only after the key-to-screen relationship is real; translation memory
and AI suggestions should follow only after approved history is sufficiently
large to evaluate them.

Exit gate: the service reduces real translation and review work—measured by
context coverage, findings resolved before QA, and review throughput—without
weakening the release contract.

### Gate 5 — Cut over without losing history

Treat the current 125-key Brickit project as data to reconcile, not as the
baseline to mutate in place. Import the source snapshot into a clean or widened
model, map the 104 shared keys, preserve relevant review history, resolve the 21
service-only keys explicitly, and migrate the existing `ch` Locale in place to
`zh`. Preserve its identity, values, review history, and status; reject `ch`
afterward. Bind `zh` to `intl_zh.arb`, require `@@locale: "zh"`, and keep
Flutter's `zh-CN` selection as adapter configuration rather than a second
catalog.

Run at least one shadow release: Blabla produces a bundle, but the team compares
it with the hand-maintained release and does not yet make it authoritative.
After the no-op and one-change acceptance sequences pass, remove or repair the
obsolete Crowdin configuration and freeze direct target-ARB edits outside the
sync command.

Exit gate: three consecutive production-intended bundles complete through the
new workflow with no unintended identity, metadata, generated-interface, or
locale drift, and token rotation plus rollback to the last merged ARBs have
been exercised.

## The first implementation slice

The first slice is not “build bulk import” or “add screenshots.” It is:

> Given Brickit’s six current ARBs, the real Blabla codec can ingest and export
> them without changing message identity or executable localization semantics,
> and Flutter 3.44.6 generates the same public localization interface.

That slice touches the true seam, produces a binary pass/fail result, and
de-risks every later workflow decision. Until it passes, service output must not
touch a Brickit release branch.

## Remaining decisions

The implementation route is not fully specified until the following decisions
are made:

1. Whether unknown ARB metadata is stored as raw per-entry JSON, a lossless AST,
   or a raw-file overlay plus normalized known fields.
2. The first repository adapter’s user experience: local command, CI check,
   pull-request bot, or a staged combination.
3. How much static context inference is safe to apply automatically and what
   remains a finding for human confirmation.
4. The live-data migration and rollback contract.

These are decision questions, not implementation tickets. They are charted in
the canonical GitHub
[Wayfinder map](https://github.com/serge-the-hedge/flutte/issues/4).

## Deliberately not in the first destination

Server-driven locale maps, localized image production, store-listing copy,
translation memory, AI suggestion ranking, an MCP server, and a general visual
in-context editor are all plausible later surfaces. None should delay lossless
ARB fidelity, immutable snapshot sync, or a release bundle that passes Flutter.

The service becomes useful when an approved change reliably becomes exactly one
reviewable Git diff. Everything clever comes after that.
