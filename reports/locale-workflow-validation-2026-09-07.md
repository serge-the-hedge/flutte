# Language introduction workflow validation

This implements the blockers recorded in the
[earlier readiness review](locale-adding-review-2026-09-07.md). The supported user
workflow is in [Adding a language](../docs/adding-languages.md).

## Behavior checked

- Configured language names, catalog paths and runtime mappings replace the
  Portuguese-only preparation and delivery path. Prepared artifacts retain their
  configuration when project settings change.
- Independent review authorization remains mandatory for agent-authored work.
  Exact delivery observations preserve the original reviewer and Intentional
  Blank reason; preview snapshots cannot transfer approval.
- Binding an observed language publishes its projection atomically without
  inventing another Snapshot. Concurrent bindings and ingestion reject stale
  binding evidence instead of losing a language.
- Historical completion receipts survive subsequent edits. Matching artifacts
  use both target bytes and the reviewed Source Contract.
- Task history is paginated and language selectors remain searchable. Unusually
  large Strings windows split into smaller reactive requests.

## Capacity decision

The bound-language limit increases from six to ten, including Source. Planned
introductions have a separate limit of 128. This is capacity for a handful of
additions to the current six-language catalog, subject to the combined key, row
and byte limits; it does not establish support for dozens of full-size catalogs.

Twelve copies of the real 1,434-message corpus fit the initial projection:
12,441,619 bytes of projected content and 14,603,596 bytes of stored projection
rows. However, complete archival required 14,341,856 bytes and restoration
14,255,629 bytes of content, exceeding the 12 MiB lifecycle envelope. Raising
that envelope further would leave insufficient space for stored metadata and
other reads within [Convex's 16 MiB transaction limit](https://docs.convex.dev/production/state/limits). Ten is the selected bound.

The capacity test uses the production archival and restoration helpers and
checks stored documents separately from public results. The extended proof
runs the complete introduction, review, archive, restore, Source change and
release lifecycle with Convex transaction-limit enforcement enabled:

```sh
bun run --cwd packages/backend test:locale-capacity
```

## Repository checks

The full backend suite passed 417 tests, with the extended capacity proof
excluded from routine execution. Web tests passed 134 tests. Type checks,
repository lint and the production web build passed. Independent agent review
found and fixed declaration validation, concurrent binding, historical receipt
and artifact matching issues.

## Flutter adapter

The CLI suite passes 57 tests, static analysis, formatting and executable
compilation. Real Flutter 3.47.2 delivery passed for Italian (`it-IT`), Japanese
(`ja`) and Serbian (`sr-Latn-RS`) in disposable copies of the application
checkout. Each produced the expected four files and a clean local review
commit. The original application checkout was not modified.

The adapter remains specific to Brickit's repository layout and introduces
language-level catalog codes. Runtime mappings may include a script and region;
separate script or regional content variants require further format support.
An incompatible Flutter SDK is rejected when regeneration changes unrelated
output.
