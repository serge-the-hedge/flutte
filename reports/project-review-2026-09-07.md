# Project review — 7 September 2026

Scope: the complete current tree at `6ec235a`, initially clean. This is a code and documentation audit, not a branch-diff review. Findings are separated into implementation/standards and specification consistency. P1 means fix before relying on the affected workflow; P2 means concrete correctness or contract debt; P3 means lower-impact maintenance debt.

At the audited revision, the project was not ready for a clean bill of health. The current Catalog Workspace and Release machinery has substantial validation and focused integration coverage, but membership handling has security/correctness defects, the CLI has reproducible failures, and partially retired workflows leave contradictory instructions and callable dead ends. A targeted cleanup is justified; a wholesale rewrite is not.

## Resolution

The accompanying cleanup resolves C1–C8 and D1–D5. Invitations require verified
email; membership writes share the last-owner guard and reject nonexistent
accounts. CLI delivery checks the captured checkout, credentials are private
before writing, failed sync exits unsuccessfully, FVM paths are absolute, and
version interpretation is shared. Editor drafts retain their original concurrency
basis across virtualization and loading; focused React interaction tests cover
that lifecycle.

Legacy catalog writes and lossy exports are removed; their HTTP addresses return
an explicit migration response. Historical job and Change Set reads, database
tables, and component mounts remain to preserve deployed evidence. The production
prototype is removed. Documentation now distinguishes shipped behavior from
planned work, and lint warnings fail the quality gate. Token hashing uses the
shared Web Crypto implementation with the existing stored format.

The findings below describe **the audited revision**, with evidence pinned to that
commit. They are retained as the rationale for the cleanup, not as outstanding
bugs. Agent reviewer authorization is a separate feature and changes the default
human-review contract only when a human explicitly permits it.

## Standards and implementation

### C1 · P1 · An unverified email account can claim a project invitation

Evidence: [auth.ts:50](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/auth.ts#L50), [projects.ts:385](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/projects.ts#L385), and the immediate existing-account invitation path at [projects.ts:333](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/projects.ts#L333).

Email/password authentication explicitly does not require verification. Invitation acceptance looks up invitations using the account's email and grants the stored role without checking that the account controls the address. Normalization also discards the email-verification fact. Someone registering an invited address before its intended owner can claim the invitation, including an owner invitation. Inviting an already registered but unverified account has the same trust problem.

Verified with an isolated Convex integration test: an account with `emailVerified: false` accepted a pending invitation and subsequently read the project with role `owner`. This is an access-control defect, not a stylistic concern. Require proven control of the invited email before granting membership, through verified email or an invitation secret delivered to that mailbox; cover both invitation paths.

### C2 · P1 · Legacy Portuguese delivery can overwrite newly committed work

Evidence: [locale_proposal_adapter.dart:378](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/locale_proposal_adapter.dart#L378); compare the HEAD check at [release_delivery_adapter.dart:309](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/release_delivery_adapter.dart#L309).

The legacy adapter generates its candidate in a disposable worktree, then checks only that the original checkout's relevant files are clean before copying. A concurrent commit makes the checkout clean while changing the tree. Delivery then applies output prepared from the earlier tree to the newer commit.

Reproduced in a disposable repository: a runtime-locale registration change was committed during the first generator run; delivery succeeded, and its review commit removed that change. Capture and recheck HEAD before copying. Possible Duplicated Code: the two delivery implementations already enforce different Git safeguards. Share their checkout transaction boundary or retire the old delivery command.

### C3 · P1 · Credentials are written before restrictive permissions are applied

Evidence: [credentials.dart:75](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/credentials.dart#L75); the CLI README promises mode `0600` protection.

The temporary file receives the token, including a flush, before a separate `chmod 600` process runs. With umask `022` and traversable parent directories, another local user can read the file during that interval. Final-file permission checks do not cover this exposure. Create a private file or private temporary directory before writing secret bytes. This finding is based on the write order and permission conditions, not a claim that credentials were accessed on this machine.

### C4 · P2 · Alternative membership writes bypass the last-owner safeguard

Evidence: [projects.ts:109](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/projects.ts#L109), [projects.ts:299](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/projects.ts#L299), and [projects.ts:335](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/projects.ts#L335).

`updateMemberRole` protects the last owner, but `addMember` and `inviteMemberByEmail` both call an upsert that patches the role unconditionally. The sole owner can re-invite their own email as a viewer and leave the project with no owner able to restore permissions.

Two isolated integration tests reproduced the ownerless result, one through each public mutation. Put the invariant in the shared membership write function so every caller receives the same protection.

### C5 · P2 · Failed sync returns a successful process exit status

Evidence: [blabla.dart:259](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/bin/blabla.dart#L259).

The command discards `SnapshotSyncReceipt` and returns zero even when the server records a failed run. Reproduced with a temporary local HTTP server: the CLI printed a failed-run diagnostic, then `runCli` returned `0`. Scripts and chained commands will continue after rejected synchronization. Derive the exit code from the receipt's success state.

### C6 · P2 · Relative checkout paths break the local FVM SDK

Evidence: [flutter_toolchain.dart:74](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/flutter_toolchain.dart#L74).

With `--checkout .`, the resolver retains `./.fvm/flutter_sdk/bin/flutter` as the executable. Generation later runs from the disposable package directory, where that relative path does not identify the SDK. Reproduced `No such file or directory`. Normalize checkout and SDK locations to absolute paths before returning the resolved toolchain.

### C7 · P2 · Virtualized editor rows do not retain unsaved drafts

Evidence: component-local draft state at [strings-catalog-view.tsx:344](https://github.com/serge-the-hedge/flutte/blob/6ec235a/apps/web/src/components/localization/strings-catalog-view.tsx#L344), blur handling at line 607, and rendering only `virtualItems` at [line 1494](https://github.com/serge-the-hedge/flutte/blob/6ec235a/apps/web/src/components/localization/strings-catalog-view.tsx#L1494).

Dirty text lives inside each editor. Scrolling a row outside the virtual range unmounts that editor; returning recreates its state from the saved catalog value. The card cache holds server data, not draft state, and blur does not save. Filtering the row out has the same problem. Retain drafts above the virtualized rows, keyed by message and Locale with their concurrency basis, or explicitly keep dirty editors mounted.

This is a source-level finding. Browser verification was attempted, but the browser runtime reported no available browsers. Existing rendering tests use static markup and do not exercise scrolling/unmounting with dirty inputs.

### C8 · P3 · The three CLI gateways disagree about version warnings

Evidence: [snapshot_sync_adapter.dart:309](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/snapshot_sync_adapter.dart#L309), compared with [release_api_gateway.dart:178](https://github.com/serge-the-hedge/flutte/blob/6ec235a/cli/lib/release_api_gateway.dart#L178).

Sync warns whenever the minimum version differs from the local version, even if the minimum is older. The other gateways compare semantic versions. Possible Duplicated Code: share compatibility-header interpretation and version comparison. This is a maintenance judgment supported by an observable policy difference.

## Spec and documentation consistency

### D1 · P1 · Legacy proposals return review links with no human completion path

Evidence: [http.ts:1108](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/http.ts#L1108), [reviews route:19](https://github.com/serge-the-hedge/flutte/blob/6ec235a/apps/web/src/routes/projects.$projectId.reviews.tsx#L19), and [agent-api.md:166](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/agent-api.md#L166).

The documented requirement says, “Humans must approve and apply the review in the web app.” The legacy Change Set endpoint still accepts work, returns `200` and `status: open`, and supplies a review URL. That URL now renders only a legacy retirement notice; its detail child has no review component. The tags endpoint returns the same kind of dead link. Backend mutations still exist, but the documented human workflow does not.

Retire these writes with an explicit migration response or translate them into current Translation Tasks. Merely labeling them compatible does not make the workflow usable.

### D2 · P2 · Legacy ARB export is retired over HTTP but remains publicly callable in Convex

Evidence: [exports.ts:175](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/exports.ts#L175), its missing-value conversion at line 97 and identifier conversion at line 123, compared with HTTP retirement at [http.ts:1925](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/http.ts#L1925).

The locked specification requires “Message identifiers survive exactly” ([spec:146](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/spec/localization-control-plane.md#L146)). `startArbExport` still permits a viewer to generate the old corpus with renamed identifiers, missing values turned into empty strings, and no Release assessment. This is a second artifact-producing interface with different semantics. It is not the current CLI release route, so this is incomplete retirement rather than a demonstrated bypass inside Release Bundle delivery. Remove it or explicitly quarantine it as a non-delivery legacy artifact.

### D3 · P2 · The locked specification contradicts the current agent safety boundary

Evidence: [spec:1039](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/spec/localization-control-plane.md#L1039) versus [agent-api.md:4](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/agent-api.md#L4).

The specification says agent writes land “as an ordinary current value with no Confirmation.” The canonical guide says agents submit immutable candidates and only human review changes current values; the current task implementation follows the latter. Following the locked spec would reintroduce direct agent writes. Update the obsolete decision in the spec and point to the candidate/review boundary.

### D4 · P2 · Agent instructions still direct new work into the retired model

Evidence: [mcp-localization-server.md:18](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/mcp-localization-server.md#L18) and [agent-api.md:145](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/agent-api.md#L145).

The guide explicitly says new agents should use the preferred task workflow, yet its general translation rules still recommend legacy lookup/status filters, Change Sets, and `/strings/tags`. The MCP design maps its tools to legacy search, context, and Change Sets exclusively. An agent can follow the canonical guide's opening instructions and later be sent into the incompatible old corpus. Rewrite the general rules around workspace discovery and Translation Tasks; clearly mark legacy material and the MCP document's implementation status.

### D5 · P2 · First Review eligibility has conflicting normative definitions

Evidence: [spec:954](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/spec/localization-control-plane.md#L954), [catalog-message-lifecycle.md:70](https://github.com/serge-the-hedge/flutte/blob/6ec235a/docs/catalog-message-lifecycle.md#L70), and [ordinaryImportRuns.ts:115](https://github.com/serge-the-hedge/flutte/blob/6ec235a/packages/backend/convex/ordinaryImportRuns.ts#L115).

The spec says a later introduction is “never eligible” for `ordinary-v1`. The lifecycle excludes it “while First Review is pending”; the implementation checks pending review, not permanent introduction provenance. These are different policies, even though other eligibility conditions exclude many already reviewed values. Choose one rule and align the documents and predicate. This finding does not claim that pending First Review is currently bypassed.

## Cleanup opportunities, not additional correctness findings

- Retire the old writable corpus deliberately. `keys`, `values`, `imports`, `exports`, `changeSets`, and their Agent API functions remain a second set of domain operations. Preserve required historical reads and migrate required clients before deletion. The broken compatibility paths above show why this needs a defined endpoint, rather than indefinite coexistence.
- Remove or relocate completed experiments. The production route tree still includes the explicitly throwaway, 1,528-line proposal prototype and a public wrapper. Keeping it for comparison is currently documented, so this is an intentional tradeoff to reconsider, not an accidental exposure finding.
- Make documentation status explicit. Lead the README with what Blabla does, rather than its scaffold's technology list; provide one implementation-status map for the locked spec. Code Context and Dictionary are specified future work without corresponding current implementation, not proven regressions. Keep useful research, but date and scope historical QA records: `design-qa.md` uses machine-local `/tmp` evidence and calls bundle construction the next slice even though bundles now exist.
- Remove needless hand-maintained infrastructure after the correctness work. `apiTokens.ts` contains a full SHA-256 implementation while `lib.ts` already uses Web Crypto for SHA-256. A shared digest implementation would reduce maintenance surface; preserve the existing token hash format and validate parity during that change.
- Treat the lint result honestly. The check allows warnings, including explicit `any` in backend contexts despite the documented typing preference. Individual lint diagnostics are not duplicated as review findings; the remaining warning count belongs in cleanup acceptance criteria.

## Original audit verification and limits

- Installed dependencies successfully with `bun install --frozen-lockfile`; the initial check could not start because dependencies were absent.
- `bun run check` passed: lint completed with **43 warnings**, type checks passed through existing Turbo cache entries, **336 backend tests** and **110 web tests** passed, and the production web build passed. The largest snapshot suite took approximately 262 seconds.
- Local Bun was **1.4.2**, whereas the repository and CI pin **1.3.13**. This was local verification, not a fresh execution of the pinned CI environment.
- `dart analyze`, formatting (19 files, zero changes), and executable compilation passed. The temporary executable was removed. CLI tests: **40 passed, 1 skipped**. The skipped real-generator acceptance test requires a supplied Brickit checkout and Flutter; the separate real-repository delivery proof was not run.
- Three temporary Convex tests reproduced unverified invitation acceptance and both last-owner bypasses. Three disposable CLI reproductions demonstrated concurrent-commit overwrite, failed-sync exit status, and relative FVM resolution failure.
- Browser verification was unavailable; the virtualized-draft finding is based on source inspection. No claim is made about live deployment behavior or measured browser performance.

Temporary reproduction tests, local servers, scripts, and disposable repositories were removed after use. Those reproductions preceded the accompanying implementation fixes. No deployment was performed as part of the audit.

This review covers all major subsystems through source inspection, independent CLI and spec/documentation reviews, existing automated checks, and focused reproductions. It does not certify every execution path or promise zero remaining technical debt.

Implementation/standards: 8 findings; worst risks are invitation takeover and overwrite of concurrent committed work. Spec/documentation: 5 findings; worst is successfully accepted work stranded behind a retired review UI.
