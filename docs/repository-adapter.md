# Repository Adapter transport

The CLI owns Git and Flutter operations. Blabla owns snapshot validation,
reviewed release values, and publication. All routes below use
`/api/repository-adapter/v1`, a bearer project token, and the CLI compatibility
headers described in [the CLI guide](../cli/README.md).

## File uploads

Both `blabla sync` and `blabla deliver` upload one ARB file per request. The shared
session protocol retains the `/snapshot-uploads` path:

1. `POST /snapshot-uploads`: send `repository`, `commit`, and `expectedFiles`.
   Sync may include its normal `lineage` object. Release delivery additionally
   sends `kind: "release"` and `releaseRecordId`. The response provides
   `sessionId` and `maxFileBytes`.
2. `POST /snapshot-uploads/file`: send `sessionId`, `catalogPath`, `content`, and
   `contentHash` (hex SHA-256 of the exact UTF-8 content). Release sessions also
   send `kind: "release"`. Repeating the same path and hash succeeds; replacing
   that path with different content requires a new session.
3. `POST /snapshot-uploads/finalize`: send `sessionId`, and `kind: "release"` for
   delivery. All declared files must have arrived. Snapshot finalization returns
   the normal ingestion receipt. Release finalization returns `releaseRecord`,
   `catalogPaths`, `applied`, and `skipped`.
4. For releases, `POST /snapshot-uploads/download` with `sessionId` and
   `catalogPath` returns one resulting catalog's `content`. The CLI downloads all
   outputs before changing its disposable worktree.

Sync requires `snapshot-submission`; release upload and download require only
`export`. A session belongs to the exact project and token that created it.
Finalization is exclusive for 35 minutes, exceeding Convex's 30-minute action
runtime; a completed session returns its original receipt on retry.

Each input and delivered catalog is limited to 8 MiB. There is no combined
catalog upload byte limit. The operational manifest limit is 1,000 files.
Sessions expire after 24 hours. Cleanup removes unowned input files and temporary
release outputs in batches, preserving input blobs referenced by an immutable
Snapshot or Release Delivery Capture. A successful snapshot adopts its upload
blobs directly; it does not create a second permanent copy.

Older clients may still use `POST /snapshots` and
`POST /releases/:id/delivery-tree`. Those compatibility requests retain their
8 MiB combined request limit; legacy delivery also limits its expanded response
to 8 MiB and directs larger deliveries to the current CLI. New clients use the
session protocol.

## Release artifacts

New Release Bundles use a version 2 manifest with the existing `releaseRecord`
and `catalogs` metadata, `changeKeyCount`, and file-scoped `chunks`. Each chunk
reference has `catalogPath`, `storageId`, `contentHash`, `byteLength`, and
`changeKeyCount`. The referenced JSON array contains the existing release-change
records, restricted to one catalog. Baseline Source values repeat in each affected
catalog’s chunks; this modest storage overhead lets delivery fetch only that
catalog’s changes. The manifest itself is limited to 1 MiB of metadata, checked
as references are added. Source chunks include every changed key so
conflict reporting remains complete.

Construction reads one key per transaction and flushes a bounded buffer into
chunks. Delivery verifies chunk size and hash, then applies only the current
catalog's chunks against the same original Source catalog. A changed or missing
Source skips the key across languages. Version 1 artifacts remain readable.

Chunk references are registered before publication. Ready builds own their
chunks; failed or abandoned builds clean them up in batches. Version 2 delivery
captures retain a manifest and original input-file references instead of one
combined catalog JSON blob. Generated outputs are temporary download artifacts,
not an additional permanent catalog history.

### Discovered catalog files in sync receipts

The snapshot receipt includes `syncUrl` (a direct web link when configured) and
`run.unboundLocaleFiles`, a bounded list of
`{ catalogPath, declaredLocaleCode, messageCount }` records. Missing declarations
or counts are `null`. `unboundLocaleFileCount` counts this unresolved list; active
bindings are excluded even when the snapshot was originally ingested unbound.
The immutable snapshot evidence is retained. Older clients can ignore the additive
field; newer clients accept older receipts without it. CLI protocol remains 1.

The web discovery list uses the current accepted Baseline, independently of the
latest run (which may fail or create a Preview). It suggests explicit declared
locale identity or an exact configured catalog path and requires editor binding.
