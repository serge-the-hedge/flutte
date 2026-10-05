# Reuse local source and caller evidence

Use this helper when an assignment includes a versioned local evidence registry.
It selects recorded positive observations and explicit related-message groups,
then compares exact Source hashes and cited file bytes. Blabla's advertised Code
Context capability remains authoritative; this packet is supplementary evidence.

1. Read the assigned task page or exact candidate-review context through your
   normal workflow. Preserve the original read unchanged.
2. Select evidence using that read, the assigned registry, and the selected
   read-only checkout:

   ```text
   node <skills>/_blabla/scripts/blabla-evidence.mjs select --registry registry-v1.json --context page.json --checkout /path/to/app --project PROJECT_ID
   ```

   Add `--commit FULL_HASH` only when you have a recorded observation of that
   checkout's commit. This is caller-reported provenance; the helper does not
   inspect Git or establish which commit the checkout actually holds.
3. Inspect every selected fact's status, ordered members, file checks, provenance,
   and limitations. A group includes members outside the page: obtain their exact
   Sources through authorized context reads before treating the full group as
   matching. An omitted member's Source is `notSupplied`.
4. Preserve the output packet with its `registrySha256` and `contextSha256` in
   your assessment. A reviewer uses their independently fetched exact context
   and owns the assessment and verdict. The packet grants no review authority.

The helper reads local files and writes JSON to stdout. It makes no API requests,
reads no credentials, runs no Git commands, and changes no input or checkout file.
Keep registries and packets in private campaign storage outside the app checkout.
Publish a new registry version for changed observations; retain the prior file.

## Current Source input

`--context` accepts exactly one of these JSON shapes:

- Saved task `page.json`: `{ "page": { "targets": [...] }, "cursor": 0 }`.
- Direct task read: `{ "targets": [...] }`.
- Exact reviewer read: `{ "kind": "candidate", "messageId": "key", "source": { "value": "exact Source" } }`.
- A bounded extraction from current authoritative reads:
  `{ "messages": [{ "messageId": "key", "sourceValue": "exact Source" }] }`.

Task targets use `messageId` and `sourceValue`. Explicit `messages` and task
targets may instead supply `sourceSha256`, the lowercase SHA256 of exact UTF-8
Source bytes. Supply exactly one value or hash per message. This is not the
server's Source Contract fingerprint. Empty strings, LF, NBSP, and other valid
Unicode are preserved without trimming or normalization. Include every group
member through the extraction shape when a page is too small to contain them.
Extract Sources only; candidate text and previous verdicts cannot substitute.

Mixed supported shapes, duplicate IDs, and conflicting Sources are invalid.
The helper checks a top-level `projectId` if present; many server reads omit it,
so `--project` supplies the assignment's project binding. It does not authenticate
the local input or verify repository identity against Git. Reviewer tokens and
candidate values are neither copied nor used as local evidence.

## Immutable registry version 1

The registry has exactly these top-level fields:

```json
{
  "version": 1,
  "projectId": "PROJECT_ID",
  "provenance": {
    "repository": "github.com/owner/app",
    "commit": null,
    "dirtyFiles": []
  },
  "limitations": ["Only inspected positive evidence; bounded search was incomplete."],
  "facts": []
}
```

`commit` is the full lowercase 40- or 64-digit observed hash, or `null` when not
recorded. `dirtyFiles` is the recorded list of differing repository-relative
files, not a cleanliness check performed by this helper. Never reconstruct old
provenance from the checkout's later state.

Each fact has exactly the following fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique stable fact identifier |
| `kind` | `caller`, `verifiedAssembly`, or `semanticPairing` |
| `state` | `active` or `retracted` |
| `messages` | Ordered array of `{ "messageId": "key", "sourceSha256": "64 lowercase hex digits" }` |
| `files` | Array of `{ "path": "lib/file.dart", "sha256": "64 lowercase hex digits", "line": 42 }` |
| `statement` | Bounded description of the actually inspected observation or semantic pairing |
| `limitations` | Array of explicit qualifications, unknowns, or retraction reasons |

`caller` records inspected accesses, including related accesses in a record.
Its listed messages do not imply concatenation. `verifiedAssembly` records an
inspected assembly expression; list members in that expression's order and
describe any intervening literal/icon segments in `statement`. `semanticPairing`
supports joint grammatical or semantic assessment while current assembly and
injected spacing remain unverified. Groups need at least two distinct members;
callers and verified assemblies require cited files. The helper verifies bytes,
not the truth of a registry author's interpretation or line number.

Put unresolved runtime dispatch, layout width, rendering, and bounded search
misses in limitations. Positive observations survive incomplete research. This
helper has no completeness predicate and produces no unreferenced/unused-key
finding. Length ratios, neighboring keys, and co-displayed strings cannot become
assembly or UI-fit proof. Retract corrected observations in a new registry
version rather than silently replacing their meaning.

All facts in one registry share its observation provenance. A repeated message
or file across facts must retain the same hash. A registry with conflicting
hashes is invalid: use a separate immutable observation version. Cited paths use
relative POSIX spelling; traversal and symlinks escaping the selected checkout
are rejected. Internal symlinks compare the bytes of their contained targets.

## Packet interpretation and bounds

The packet retains each selected fact, full ordered groups, its limitations,
observed provenance, and both immutable input digests. Selection touches any fact
containing a requested message; it does not infer additional relationships.

| Fact status | Meaning |
| --- | --- |
| `matching` | All supplied member Source hashes and cited file hashes match, and the supplied commit matches the recorded commit |
| `stale` | A Source/file changed, a cited file is missing, or the reported commit differs |
| `unknown` | A member Source was not supplied, a cited file could not be read, or commit provenance cannot be compared |
| `retracted` | The registry withdrew this fact; individual comparisons remain visible for audit |

`matching` does not establish a clean checkout, current runtime behavior, a
verified semantic interpretation, rendered assembly, or UI fit. The recorded
dirty-file stamp remains visible. Source and file comparisons have their own
statuses; commit comparison is explicitly `callerReportedOnly`.
`unavailableMessages` means no selected active registry fact names that message;
stale/unknown facts remain in `facts` for inspection. Missing registry evidence
establishes no caller absence. Retracted facts remain historical observations.

The fixed envelope is 1 MiB per JSON input, 50 distinct requested messages,
64 KiB per Source, 256 facts, 16 messages and 8 citations per fact, 256 recorded
dirty paths, and 16 limitations per list. Statements/limitations are at most
4 KiB; IDs are at most 200 bytes. Selection reads at most 64 cited regular files,
4 MiB each and 16 MiB total; output is at most 512 KiB. Reads time out after five
seconds. Oversized or malformed requests fail with a JSON error on stderr and
nonzero exit; reduce the requested scope instead of treating failure as absence.
