# Lower-level and compatibility API

### `POST /translation-proposals`

Creates or resumes an idempotent agent proposal. For existing Workspace
targets:

```json
{
  "clientProposalKey": "checkout-de-pass-1",
  "target": { "kind": "catalogWorkspace" }
}
```

Retries with the same token, key, and target return the same proposal. Reusing
the key for a different target returns `IDEMPOTENCY_KEY_REUSED`.

### `POST /translation-proposals/:id/candidate-revisions`

Body:

```json
{
  "items": [
    {
      "messageId": "checkout.payButton",
      "localeId": "k...",
      "value": "Jetzt bezahlen",
      "clientRevisionKey": "checkout-de-pass-1-r1",
      "expectedCandidateRevision": 0,
      "basis": {
        "projectionId": "k...",
        "snapshotId": "k...",
        "gitValueFingerprint": "sha256:...",
        "gitValueRevision": 0,
        "workspaceRevision": 0,
        "sourceFingerprint": "sha256:..."
      }
    }
  ]
}
```

Values are checked against the active Source Contract and exact basis. A stale
submission returns `STALE_BASIS` without writing evidence. Corrections append a
new immutable revision and name the current `expectedCandidateRevision`.

For a new Locale, first create or resume its configured Locale Proposal with
`POST /locale-proposals` and `{ "localeCode": "pt" }`. Then create the same generic
proposal with a Locale target:

```json
{
  "clientProposalKey": "pt-checkout-pass-1",
  "target": {
    "kind": "localeProposal",
    "localeProposalId": "k..."
  }
}
```

Its candidate basis carries the pinned `localeProposalId`, `snapshotId`, and
source fingerprint instead of a mutable target Locale id. The candidate is
reviewed in the same Proposals workbench; accepting it updates the staged
Locale Proposal with the actual reviewer and authorization, while rejecting it leaves no active
catalog change. This candidate/review contract is shared by every configured
introduction target.

### `GET /translation-proposals/:id`

Returns the proposal header for the token that created it.

### `GET /translation-proposals/:id/candidates`

Returns a bounded page of the proposal's current candidate revisions. Use
`limit` (maximum 16) and the returned `continueCursor` to continue.

<a id="post-export"></a>

### Retired catalog endpoints

`GET /strings/search`, `POST /context`, `POST /change-sets`,
`POST /strings/tags`, and `POST /export` return `410 Gone` with
`code: RETIRED_WORKFLOW`. Replace legacy search/context with the workspace
endpoints and proposed writes with Translation Tasks. There is no current
agent tag-authoring workflow.

`GET /change-sets/:id` is an authenticated historical read returning stored items,
`retired: true`, and a migration explanation. It cannot apply them; pending work
must be resubmitted through a current Translation Task.

### Locale Proposal endpoints

All proposal endpoints require both `read` and `propose`. Prefer Translation
Tasks for normal agent work: they resolve the Source basis and preserve candidate
review feedback. These lower-level endpoints expose the same prepared catalog.

The historical `/locale-proposals/pt` routes remain compatibility aliases.
Explicitly creating through that old route can establish the former default
Portuguese configuration (`pt`, `pt-BR`, sibling `intl_pt.arb`) if none exists.
Generic creation always requires an editor-configured target.

#### `POST /locale-proposals`

Body: `{ "localeCode": "it" }`. Creates or resumes that Locale's proposal pinned
to the current accepted Baseline Snapshot. It returns its id, progress, delivery status, and any current
validation diagnostics. It does not create an active Locale or bind a file.

#### `GET /locale-proposals?proposalId=...`

Returns the durable proposal review summary, including bounded diagnostics from
the last failed finalization attempt.

#### `GET /locale-proposals/template?proposalId=...&cursor=0&limit=16`

Returns up to 16 ordered source messages from immutable snapshot evidence. Each
message includes its id, source value, source fingerprint, opaque metadata JSON
when present, and whether a value has already been staged.

#### `POST /locale-proposals/values`

Body:

```json
{
  "proposalId": "k...",
  "items": [
    {
      "messageId": "welcome",
      "value": "Boas-vindas, {name}!",
      "sourceFingerprint": "sha256-of-the-returned-source-value"
    }
  ]
}
```

Each request accepts 1–16 values. Unknown ids, duplicate ids, ordinary blanks,
outdated source fingerprints, invalid ICU, and incompatible placeholders are
rejected. For an Intentional Blank, send `"value": ""` plus a concise
`intentionalBlankReason`.

#### `GET /locale-proposals/values?proposalId=...&cursor=0&limit=16`

Returns the submitted values for one bounded source-template page, including
their source fingerprints and any Intentional Blank reasons. Use it to resume
or review a draft without rebuilding an ARB document client-side.

#### `POST /locale-proposals/finalize`

Body:

```json
{ "proposalId": "k..." }
```

Derives the configured catalog from the pinned Source Snapshot and all staged values. A
complete successful result becomes `ready` only after every agent-authored
value has been reviewed by a human or authorized independent reviewer. A failed result exposes an actionable
diagnostic sample and persists it on the proposal.

#### `GET /locale-proposals/artifact?proposalId=...`

Returns the immutable, hash-checked version-1 artifact: derived catalog,
Source repository/commit/manifest, integration branch, and pinned
`locale.code`, `locale.label`, `locale.runtimeLocale`. `catalog.catalogPath` is
the repository-relative delivery path; `catalog.fileName` is its basename. Historical
Portuguese artifacts without `catalogPath` use the sibling-file convention.

Delivery reads require `X-Blabla-CLI-Protocol`. Incompatible/missing versions
return `426 CLI_UPGRADE_REQUIRED`; successful reads advertise minimum version
and protocol in `X-Blabla-Minimum-CLI-Version` / `X-Blabla-Minimum-CLI-Protocol`.
The legacy `/locale-proposals/pt` and `/locale-proposals/pt/artifact` reads retain
this floor. Use the [Repository Adapter](https://github.com/serge-the-hedge/flutte/blob/main/docs/repository-adapter.md)
for checkout requirements and artifact delivery.

## Existing-locale delivery

Build the reviewed Release Record in the human UI, then use the
[CLI delivery workflow](https://github.com/serge-the-hedge/flutte/blob/main/cli/README.md).
The separate [Repository Adapter API](https://github.com/serge-the-hedge/flutte/blob/main/docs/repository-adapter.md)
documents per-file transfer; the local CLI performs Git delivery.
