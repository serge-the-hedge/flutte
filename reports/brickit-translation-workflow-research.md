# Brickit translation workflow: research synthesis

_Inspected 30 July 2026. Service working tree: `730526b53c39` on
`docs/brickit-integration`; Flutter working tree: `4c6b65419745` on `main`.
The critical backend files have not changed since the service snapshot named by
the visual report. Existing unrelated working-tree changes were left alone._

This is historical research, not a description of the current implementation.
Use the [catalog lifecycle](../docs/catalog-message-lifecycle.md) and
[implementation-status table](../docs/spec/localization-control-plane.md) for
current behavior. Backend evidence links below are pinned to the inspected
service commit. Referenced Flutter checkouts, overlay sources, and temporary
HTML reports were local research artifacts and are not included in this repo;
their filenames remain as provenance, without broken download links.

## Finding at inspection

Blabla already has the right safety nucleus for translation work: project-scoped
tokens, human-reviewed agent proposals, optimistic conflict detection, per-value
history, and automatic staleness after a source edit. It is not yet safe to put
between Brickit's ARB files and a Flutter release.

The immediate failure is concrete, not aspirational. Brickit has 1,434 message
keys in each of six ARBs. Blabla accepts only 50 messages per import, rewrites
ARB identifiers on export, collapses 215 Brickit keys through name collisions,
drops executable placeholder metadata, ignores `@@locale` on import, and emits
missing values as empty strings. The measured fit report also ran the transformed
files through Brickit's Flutter 3.44.6 generator; generation failed while the
untouched files generated cleanly
(`temp/brickit-fit-report.html`:140-156).

The best operating model is:

> Git remains the only build and release source. Blabla becomes the control
> plane for translation and review, always against an immutable, Git-addressed
> snapshot. A dedicated automation job exports a complete, pinned bundle into a
> pull request. App builds validate checked-in ARBs offline; they never pull
> “latest translations” from a mutable service state.

This takes the strongest architectural decision and acceptance sequence from the
interactive field report, the empirical conformance evidence from the fit
report, and the broader migration and quality backlog from the overlay report.

## What existed at inspection

### Flutter release contract

Brickit uses Flutter's local `gen_l10n` flow. The package config names
`intl_en.arb` as the template and generates `app_localizations.dart`
(`brickit_generated/l10n.yaml`:1-4).
The six catalogs are `en`, `de`, `es`, `fr`, `ru`, and `zh`; the generated
delegate declares those language locales
(`app_localizations.dart`:99-107),
while the app selects region-qualified locales such as `en-US` and `zh-CN`
(`locale_const.dart`:3-18).
Both application roots use the generated delegates
(`main.dart`:188-192,
`main.dart`:209-217).

Direct inspection gives the following baseline:

- 1,434 message identifiers in every locale, or 8,604 locale values.
- 1,434 `@key` metadata records in every locale.
- Only one English description.
- 67 English keys with placeholders, containing 86 placeholder definitions, 82
  with an explicit type.
- File sizes from 152,458 to 187,986 bytes, all below Blabla's 256 KiB request
  ceiling. The message-count ceiling, not the byte ceiling, blocks import.

Key identity is generated API identity. The current output contains distinct
snake_case members such as `collection_title`, `collection_title_1`, and
`collection_title_2`
(`app_localizations.dart`:917-935).
Changing an ARB identifier is therefore a source-breaking Dart API change.

The checked-in Crowdin mapping points to `/lib/l10n/app_en.arb` and
`app_%two_letters_code%.arb`, not the actual package path or `intl_*.arb`
filenames
(`packages/brickit/crowdin.yml`:1-3).
This proves the checked-in mapping is stale; it does **not** prove that no
undocumented Crowdin workflow exists. That remains an owner question.

Codemagic runs project code generation during test and build workflows
(`codemagic.yaml`:30-43,
`codemagic.yaml`:189-200),
and the generated package has `flutter.generate: true`
(`brickit_generated/pubspec.yaml`:45-47).
The reports' phrase “zero validation” is therefore too strong. What is absent is
a dedicated localization contract gate: semantic ARB parity, explicit generator
execution, generated-API diffing, and a clean working-tree assertion.

### Blabla workflow and current blockers

The existing human and agent model is valuable:

- API tokens are project-scoped, hashed at rest, one-time visible, revocable,
  and limited to `read`, `search`, `propose`, and `export`
  ([`apiTokens.ts`:96-104](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/apiTokens.ts),
  [`apiTokens.ts`:118-151](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/apiTokens.ts)).
- The HTTP API authenticates a bearer token, checks its scope, rate-limits the
  call, and records last use
  ([`http.ts`:23-51](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/http.ts)).
- Agents create open reviews rather than applying values directly
  ([`docs/agent-api.md`:42-57](../docs/agent-api.md),
  [`docs/agent-api.md`:80-88](../docs/agent-api.md)).
- Values have versions and history; changing the source marks non-missing target
  values stale
  ([`values.ts`:73-117](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/values.ts),
  [`values.ts`:119-144](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/values.ts)).
- Applying a review rechecks `baseVersion` and reopens conflicts instead of
  silently overwriting
  ([`changeSets.ts`:619-678](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/changeSets.ts)).

The Flutter boundary is nevertheless unsafe:

1. **Import cannot accept the catalog.** The parser limits a request to 50
   messages and 256 KiB
   ([`importValidation.ts`:5-9](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/importValidation.ts),
   [`importValidation.ts`:35-47](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/importValidation.ts)).
   A locale therefore needs 29 chunks; six locales need 174 requests, against an
   import limiter of 10/minute with a burst of three
   ([`rateLimits.ts`:34-39](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/rateLimits.ts)). Imports
   still execute all per-message reads and writes synchronously inside one
   mutation
   ([`imports.ts`:116-164](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/imports.ts),
   [`imports.ts`:253-282](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/imports.ts)); the registered
   workflow manager is not used
   ([`workflows.ts`:1-5](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/workflows.ts)).

2. **Export destroys key identity.** `buildExportContent` applies `toArbKey`
   before writing both messages and metadata
   ([`exports.ts`:100-134](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/exports.ts)).
   The transform removes numeric segments and camel-cases separators
   ([`lib.ts`:51-62](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/lib.ts)). Running that exact
   function over `intl_en.arb` confirms 1,424 renames, 1,219 unique outputs, 80
   collision groups containing 295 input keys, and 215 silently lost keys. The
   largest collision folds 12 keys into one.

3. **ARB metadata is not lossless.** The parser accepts a raw placeholder object
   but the importer reduces it to `{name}` and only sets it when a key is first
   created
   ([`importValidation.ts`:107-179](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/importValidation.ts),
   [`imports.ts`:128-164](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/imports.ts)). Existing keys
   only receive new tags on re-import
   ([`imports.ts`:165-184](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/imports.ts)). The schema can
   represent `type` and `example`, but not Flutter attributes such as `format`
   or unknown future metadata
   ([`schema.ts`:19-23](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/schema.ts)).
   Export also writes the internal `{name, type?, example?}` object beneath a
   property already named for that placeholder, rather than reconstructing the
   imported ARB shape
   ([`exports.ts`:123-131](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/exports.ts)).
   All `@@*` document metadata, including `@@locale`, is skipped
   ([`importValidation.ts`:123-125](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/importValidation.ts)).

4. **Validation is heuristic.** A key is marked ICU merely when a source string
   contains both braces
   ([`imports.ts`:145-155](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/imports.ts)). There is no
   parser-backed syntax check, placeholder/signature compatibility check, or
   exact-SDK `gen_l10n` oracle before apply or export.

5. **Missing and large-catalog behavior are unsafe.** Export maps an absent value
   to `""`
   ([`exports.ts`:85-98](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/exports.ts)). Agent search
   takes at most 50 keys before applying screen, tag, and status filters, so a
   requested filter can silently miss later matches
   ([`agentApi.ts`:177-192](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/agentApi.ts),
   [`agentApi.ts`:220-247](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/agentApi.ts)). The web
   editor has the inverse scaling problem: it collects every key and then queries
   values for every key
   ([`keys.ts`:117-174](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/keys.ts),
   [`projects.$projectId.strings.tsx`:529-542](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/apps/web/src/routes/projects.$projectId.strings.tsx)).

6. **The modeled workflow is only partly implemented.** The schema lists
   `key_create`, locale, and archive item kinds
   ([`schema.ts`:240-269](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/schema.ts)), but validation
   rejects every kind other than `translation_value` and tag-only
   `key_metadata`
   ([`changeSetValidation.ts`:80-129](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/changeSetValidation.ts)).
   Change sets are capped at 50 items
   ([`changeSetValidation.ts`:5-6](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/changeSetValidation.ts),
   [`changeSetValidation.ts`:132-138](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/changeSetValidation.ts)).

## Comparison of the three reports

| Artifact | Best contribution | Weaknesses and corrections | What to retain |
|---|---|---|---|
| `reports/brickit-translation-overlay` | Best product narrative and operating model. It correctly keeps Git as release truth, introduces Git-addressed snapshots, complete bundles, staged trust, and a six-step end-to-end acceptance sequence (`app/page.tsx`:927-951, `app/page.tsx`:956-1015). It also separates later dynamic content and localized assets from the first ARB milestone (`app/page.tsx`:790-804). | Its live-deployment counts are not reproducible from the artifact, its architecture omits detailed permissions/idempotency/rollback, and its tests only assert that selected prose renders—not that any metric or source claim is true (`tests/rendered-html.test.mjs`:33-52). The README is still a generic Vinext starter guide, so the deliverable is not self-explanatory or maintainable (`README.md`:1-28). | Use this as the narrative spine and decision record. |
| `temp/brickit-fit-report.html` | Strongest empirical evidence. It reports an actual Flutter 3.44.6 generation failure, quantifies the key collision, measures translator-context scarcity, and identifies call-site analysis as a service differentiator rather than just another TMS feature (`brickit-fit-report.html`:140-202). Its “conformance test first” sequencing is the best engineering starting point. | Its reproducer is described but not checked in; `build_report.py` hard-codes measured values rather than recomputing them. “Crowdin is dead,” “46% dead keys,” and the one-day estimate for four fixes are overconfident. Unreferenced keys are candidates until runtime, generated, server-driven, and cross-repo uses are excluded. A direct `blabla pull` inside an app build would also weaken reproducibility unless pinned to an approved bundle revision. | Keep the measured corpus, actual generator oracle, collision analysis, source-location inventory, and test-first order. |
| `temp/brickit-overlay-report.html` | Broadest inventory. It clearly separates work required in Blabla from work required in Brickit, covers missing/stale policies, reconcile semantics, async jobs, source sync, deterministic exports, and credential hygiene (`brickit-overlay-report.html`:215-258). Its round-trip table is an effective contract checklist (`brickit-overlay-report.html`:181-197). | It becomes a 33-item backlog without a sharp dependency cut. It calls RBAC a clean fit even though current `editor` authority combines editing, review, and apply. It also says ARB byte sizes are unverified even though the files are present and measurable (`brickit-overlay-report.html`:277-285); all six are below 256 KiB. “67 vs. 63–67 placeholder keys” needs a definition: every locale contains 67 placeholder metadata blocks; the drift is in message usage/signatures. | Keep its service/app split, missing-value policy, archive reconciliation, locale contract, and open product questions. |

The combined report should avoid presenting static call-site absence as deletion
proof, absence of CI text as proof that a third-party process does not exist, or
raw key parity as translation quality. It should distinguish measured facts,
source-code deductions, live-deployment observations, and owner decisions.

## Target workflow and architecture

### Workflow

1. **Feature PR changes the source contract.** A developer adds or edits the
   English ARB message, description, placeholder schema, and product code. A
   local/CI validator checks key syntax, `@@locale`, metadata shape, exact
   placeholder signature, and `flutter gen-l10n`.
2. **Source sync creates a snapshot, not ambient mutation.** CI submits the six
   files plus repository, base commit, branch/ref, paths, Flutter SDK version,
   and content hashes. The service validates and returns an immutable snapshot
   id and a dry-run diff. Repeating the same request is idempotent.
3. **Translation work targets that snapshot.** Humans and agents translate
   target values in bounded change sets. Source-copy suggestions may be proposed
   in Blabla, but they return through the Flutter PR lane. They do not silently
   rewrite the source catalog.
4. **Approval creates a release revision.** Release readiness is evaluated with
   explicit per-project policies for missing, empty, stale, copied-source,
   invalid ICU, placeholder incompatibility, and intentional fallback.
5. **Automation opens a bundle PR.** A separate, least-privilege job downloads
   one manifest plus six content-addressed ARBs for a named snapshot/release
   revision and writes them atomically. It must not ask for “latest.”
6. **Flutter is the final oracle.** The PR checks semantic round-trip equality,
   generator success under the pinned SDK, generated public API compatibility,
   analysis/tests, and a clean regenerated-file diff. Merge makes the bundle a
   release input; re-sync records the merged commit without duplicating history.

### Data and module boundaries

The current `translationKeys` + `translationValues` model should not be widened
ad hoc until the ARB contract is explicit. The service needs deep boundaries:

- **ARB adapter:** parse, validate, preserve, and deterministically serialize
  message identifiers, values, all `@key` metadata, all `@@*` globals, and
  unknown extension fields. Semantic equality is required; byte equality is
  optional and should be a formatter policy.
- **Catalog model:** stable key identity, source definition, per-locale value,
  status, review history, and explicit locale-specific metadata overrides where
  the Flutter contract permits them.
- **Repository snapshot:** immutable Git provenance, file mapping, locale
  mapping, SDK/toolchain version, source hashes, parent snapshot, and sync
  diagnostics.
- **Release revision:** approved snapshot, policy result, bundle manifest,
  per-file checksum, author/reviewer, and immutable audit record.
- **Job boundary:** durable, resumable import/export/validation with bounded
  batches, progress, per-key diagnostics, cancellation, retry, and idempotency.
- **Context inventory:** Dart call sites, owning feature, screen/component,
  character or layout constraint, screenshot/Figma reference, and usage
  confidence. This is enrichment, not part of ARB fidelity.

Do not create a runtime mobile dependency on Convex. Do not bundle a Brickit
service token in the app. Dynamic server-localized content and localized image
assets should receive separate adapters after ARB release flow is reliable.

## Security and operational requirements missing from the drafts

The current token design is a good base, but production sync needs more:

- Add separate `sync_source` and `release_export` permissions rather than
  overloading agent scopes. Tokens need expiry, rotation ownership, environment
  binding, and an audit trail for snapshot creation and bundle download. Current
  token rows have revocation and last-use data but no expiry
  ([`schema.ts`:186-205](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/schema.ts)).
- Separate translator, source editor, reviewer, release approver, and token
  administrator capabilities if the team wants two-person release control.
  Today any editor can apply a change set
  ([`changeSets.ts`:619-630](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/changeSets.ts)); the
  owner/editor/viewer trio does not by itself enforce separation of duties.
- Keep CI tokens only in the CI secret store, never logs, artifacts, ARBs, or
  mobile config. The PR-writing bot should have repository permissions separate
  from the Blabla export token.
- Require idempotency keys and expected base snapshot/revision on every mutation.
  Reject stale-branch uploads and replay against a different project or
  environment.
- Record who exported what, from which approved revision, with checksums.
  Support revocation and rollback by reverting a Git PR or re-exporting a
  previous immutable revision.
- Decide whether the proprietary Brickit corpus may be committed as a service
  fixture. If not, keep a synthetic golden ARB corpus in Blabla and run the full
  Brickit corpus as a private cross-repository integration test.
- Add monitoring for job failure, partial progress, generator incompatibility,
  queue age, and release-policy failures. “Completed” must mean the manifest and
  every locale artifact are durable and verified.
- Return protocol-appropriate errors to automation—especially HTTP 429 with
  retry information for rate limits—and revisit wildcard CORS before supporting
  browser-held integration credentials. The current route wrapper maps every
  non-authentication failure to HTTP 400
  ([`http.ts`:54-63](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/http.ts)) and exposes permissive
  CORS headers ([`http.ts`:10-14](https://github.com/serge-the-hedge/flutte/blob/730526b53c39/packages/backend/convex/http.ts)).

## Recommended staged plan

### Phase 0 — Freeze the contract with failing tests

Add a small synthetic golden corpus to Blabla covering snake_case and numeric
collisions, typed/formatted placeholders, plurals/selects, non-breaking spaces,
`@@locale`, unknown metadata, empty/missing values, and locale-specific message
shapes. Add a private Brickit conformance test that imports all six current ARBs,
exports immediately, runs Flutter 3.44.6 `gen_l10n`, and compares generated API
signatures. Add an independent Brickit localization check now; it is useful even
if Blabla is never adopted.

Exit: the tests reproduce the current failure and establish a precise semantic
equality definition.

### Phase 1 — Make one-file round trips trustworthy

Stop key normalization; reject invalid identifiers instead of rewriting them.
Model and preserve complete ARB metadata and globals. Validate locale mapping,
ICU syntax, placeholder/signature compatibility, and project missing/stale
policy. Use Flutter's pinned generator as the final compatibility oracle rather
than attempting to reproduce all generator behavior with regexes.

Exit: each of Brickit's six ARBs survives import/export semantically and
generates the same public Dart API.

### Phase 2 — Build the snapshot and bundle lane

Implement durable full-catalog sync, idempotent Git-addressed snapshots,
pagination, archive reconciliation, and deterministic six-file bundles with
checksums. Add dedicated sync/release scopes and audit events. Finish
`key_create` and archive change-set semantics only as required by this lane.

Exit: a clean project ingests the full catalog in one operator action; rerunning
the same sync is a no-op; export produces one pinned manifest and complete
bundle.

### Phase 3 — Shadow migration

Bootstrap a clean staging Brickit project from the Git snapshot atomically
rather than replaying 174 UI imports. Diff the existing live Blabla Brickit data
against the snapshot: preserve divergent or service-only wording as reviewable
proposals instead of overwriting either side. Resolve `ch`/`zh` and
language/region mappings explicitly. Run the service in shadow mode for several
real feature PRs while direct ARB edits remain allowed.

Exit: repeated source syncs, translation reviews, exports, and re-syncs produce
only intended diffs with no lost history or unexplained staleness.

### Phase 4 — Controlled cutover

Have the automation job open ARB-only pull requests for approved release
revisions. Require localization and Flutter gates, then make Blabla the normal
lane for target translations. Keep an emergency, audited Git hotfix path and a
documented way to re-import the merged result; do not simply forbid all direct
edits without recovery semantics.

Exit: three consecutive production-intended bundles pass with zero unintended
key, metadata, generated-API, or locale drift, and token rotation plus rollback
have been exercised.

### Phase 5 — Add the reasons to prefer this service

Ingest call-site and ownership manifests, treat “unreferenced” as a review queue,
auto-suggest screens/tags, capture visual context and layout budgets, add
terminology/style rules, and only then build measured translation-memory or AI
suggestions. Keep server-driven localized content and localized image assets as
separate later workstreams.

## Adoption definition

Blabla is ready to accompany Brickit when a reviewer can trace:

`Flutter commit → immutable service snapshot → reviewed change set → approved release revision → checksumed six-ARB bundle → Flutter PR → merged commit`

and the reverse reconciliation produces the same state. The first success
metric is deliberately unglamorous: “approved here” becomes exactly one visible
Git diff, and that Git diff reproduces exactly the catalog the service says was
released.
