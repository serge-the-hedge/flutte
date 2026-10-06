# Local review campaigns

Use `../scripts/blabla-campaign.mjs` when a separately assigned reviewer needs to
consume several exact handoffs, or a coordinator needs receipt-derived counts
across tasks and correction rounds. Inputs are read-only; `--details` writes only
the explicitly requested new report file. Node.js
22+ is sufficient. The [official workflow](workflow.md#independently-review-and-record)
owns credentials, independent assessment, review authorization and posting.

## Consume an assigned queue

The host assigns a separate reviewer one `owner` in an immutable manifest, its
manifest SHA-256, and its dedicated reviewer profile. Assignment of local work
does not grant review permission; the server checks that through the official
workflow. Keep translation and review agents and credentials separate.

```text
node <campaign> next --manifest campaign-v1.json --owner A --expect-manifest <assigned-sha256>
```

For each `ready` round:

1. Read the returned pinned brief and evidence references. Copy `round.reviewHandoff`
   to a private JSON body file. It names only pending current revisions, at most
   16; `round.handoff` preserves the original imported handoff for audit.
2. Run official `review read` with that body, the returned `round.reviewState`,
   and the reviewer's own profile. Read every authoritative context, retrieve
   examples independently, and fill explicit verdicts. The returned local brief
   supplements evidence; it cannot override live guidance or permission.
3. Run official `review submit` using the same state and the filled decision
   template. Recover partial or lost writes through that workflow. Missing
   verdicts remain pending.
4. Repeat `campaign next` with the same manifest hash after receipts are recorded.
   Stop on a blocked review, changed evidence, or exhausted assignment. This is
   a finite assigned work queue; waiting for external work requires a new host
   instruction, not a polling loop.

`busy` returns the original round and state without issuing new ownership. Let
the official runner handle live/dead worker locks. `blocked` returns diagnostics
and no round; preserve the files and resolve the named evidence problem.
`complete` means this owner has no unrecorded current revisions. It can coexist
with rejected values, missing candidates, or other owners' pending work.

## Manifest contract

Preserve each manifest version and the imported handoffs, briefs and context
supplements. Create a new version only after affected owners stop at an idle
boundary, including recovery of unfinished writes. Reuse their existing state
directories. Assign the new manifest hash explicitly before resuming; a reviewer
pinned to an older hash must not silently adopt changed scope or ownership.

Reserve affected owners before authoring a correction. An owner whose revisions,
task basis and assigned evidence remain unchanged can continue disjoint work on
the old pinned manifest during authoring. Request that owner's idle boundary when
the amendment is ready for adoption, rather than holding them through unrelated
retrieval and drafting. Recover unknown writes before switching any owner's
manifest, and record each explicit hash acknowledgment before dispatching work
under the new version.

```json
{
  "version": 1,
  "projectId": "PROJECT_ID",
  "scope": [{ "localeCode": "de", "messageIds": ["welcome"] }],
  "latest": [{ "localeCode": "de", "messageId": "welcome", "revisionId": "NEW_REVISION" }],
  "revisions": [
    { "revisionId": "OLD_REVISION", "taskId": "ORIGINAL_TASK", "localeCode": "de", "messageId": "welcome" },
    { "revisionId": "NEW_REVISION", "taskId": "CORRECTION_TASK", "localeCode": "de", "messageId": "welcome", "supersedes": "OLD_REVISION" }
  ],
  "reviewers": [{ "owner": "A", "tokenId": "REVIEWER_TOKEN_ID" }],
  "rounds": [
    {
      "id": "original-01", "owner": "A",
      "handoff": { "path": "original/handoff.json", "sha256": "<64 lowercase hex characters>" },
      "reviewState": "original/review-state",
      "brief": { "path": "brief-v1.md", "sha256": "<64 lowercase hex characters>" }
    },
    {
      "id": "correction-01", "owner": "A",
      "handoff": { "path": "correction/handoff.json", "sha256": "<64 lowercase hex characters>" },
      "reviewState": "correction/review-state",
      "brief": { "path": "brief-v2.md", "sha256": "<64 lowercase hex characters>" },
      "evidence": [{ "path": "context/welcome-v1.json", "sha256": "<64 lowercase hex characters>" }]
    }
  ]
}
```

Paths resolve relative to the manifest; absolute paths support read-only import
of an existing run. SHA-256 references pin raw file bytes. `evidence` is optional;
it can hold page-specific context or other assigned supplements. These are
references to available evidence, not a claim of complete application context.
The optional reviewer `tokenId` asserts an expected recorded reviewer identity;
it is metadata, not a credential or permission grant.

Each Locale scope lists its expected message IDs; different Locales may have
different scopes. `latest` must account for every pair exactly once. Use
`revisionId: null` for an explicitly missing candidate. Every non-null latest
revision must exist in `revisions`. A pair with multiple revisions needs an
explicit, unbranched `supersedes` chain ending at that latest revision. Corrections
may belong to different tasks; pair identity stays the same. File timestamps,
glob order and historical acceptance never select the latest revision.

Every revision belongs to exactly one round. An imported handoff contains
`{"revisions":[{"revisionId":"EXACT_REVISION"}]}` with 1–16 distinct IDs. Full
`taskId`, `localeCode`, and `messageId` fields are also supported and must match
the manifest. Each round owns a disjoint review state directory, including aliases
and nested paths. Every round names an assigned reviewer owner. The manifest
defines local assignment, not a distributed claim or a substitute for server
self-review enforcement.

## Receipt-derived reporting

```text
node <campaign> status --manifest campaign-v1.json
node <campaign> status --manifest campaign-v1.json --details report-v1.json
```

The report derives current counts and dated history from exact
`receipt-REVISION.json` observations in assigned review states. Saved verdicts,
summary totals and draft files never count as recorded review. State bindings
must identify the manifest project and reviewer role. Receipts must identify their
assigned exact revision, recorded decision, review ID, server timestamp and
matching reviewer authorization; acceptance also needs its final fingerprint.
Authorization evidence must include the authorizing human and timestamp, plus
either the positive policy revision or the grant ID and positive grant revision.
Incomplete, malformed, or mixed authorization variants cannot count as recorded
review. This validates historical provenance; current permission remains the
official workflow's responsibility.
Invalid or conflicting evidence produces diagnostics and blocks `next`.

The default report contains totals by Locale and owner and at most 16 examples
per findings, pending corrections, and diagnostics list; their separate counts
cover the full campaign. `--details` creates a new private report file with all
current rows, history and rounds. It refuses to overwrite an existing file and
keeps stdout compact. Detailed rows reference their round and receipt paths;
original receipt files retain full review provenance.

Counts distinguish accepted content, Intentional Blanks, rejection, pending review,
and missing candidates. Detailed `history` retains decisions and reasons for
superseded revisions. `openFindings` contains only rejected latest revisions.
`pendingCorrections` tracks replacements still awaiting recorded decisions.
`unresolvedFindingCount`
also includes a pending correction whose chain contains a recorded rejection;
supersession alone does not resolve that objection. Historical rejected revisions
distinguish `resolved-accepted`, `superseded-pending` and `superseded-rejected`.
Pending correction rounds take priority, in manifest order, then ordinary pending
rounds. A partial
round retains its state and original handoff while returning only undecided current
revisions. No local receipt removal or rewriting is needed to advance the queue.

`allLatestRecordedAcceptance` describes the manifest's recorded acceptance only.
`sourceCurrency: "notObserved"` and `releaseReady: null` keep the evidence boundary
explicit: historical receipts do not establish current Source/target currency,
current authorization, atomic whole-task coverage, or release readiness. Run the
official `task status` scan and the required target finalization/delivery workflow
separately. This distinction applies to both Basic and Repository projects.
