# Blabla Repository Adapter

The shortest local workflow is:

```sh
# once per machine
blabla login --server https://<your-dev-deployment>.convex.site --token ...

# whenever the Brickit checkout changes
cd /path/to/brickit-flutter
git fetch origin develop
git switch develop
git pull --ff-only origin develop
blabla sync
```

`sync` reads the bound ARB files from the checkout, submits one durable Source
Snapshot, and prints the receipt. It exits with status `0` only when ingestion
succeeds; a failed run returns `1` with its diagnostics. It is read-only locally: it never edits the
checkout, fetches or pushes Git, or opens a pull request. The web Sync page can
create a single workspace connection with the `snapshot-submission` permission
and the agent permissions together, then gives you the one-time `login`
command. If setup is incomplete, `sync` prints the exact missing binding or
project configuration instead of requiring a project id or a hand-built HTTP
request.

The current Brickit integration branch is `develop`. Sync refuses another
branch so the accepted Source Snapshot and later delivery stay on the same
team integration line. The Sync page shows the configured branch.

Keep the checkout current with the Brickit team's normal fast-forward pull
before syncing. If `develop` is not present locally, `git switch develop` will
create it from the fetched remote branch when Git can identify it unambiguously.

When running Blabla locally, use the value of `VITE_CONVEX_SITE_URL` from
`apps/web/.env` (or the active Convex dev deployment). The Vite URL
`http://localhost:3001` serves the browser and is not the Repository Adapter
API endpoint.

Run it again after a Brickit commit changes. Repeating the same commit and
catalog bytes is idempotent; a descendant commit can advance the accepted
baseline when the server has the corresponding lineage report. After syncing,
the web Strings workspace is the place to edit and review translations.

For existing Locales, select one or more keys in Strings and start a Translation
Task. An agent submits candidates to that frozen task, and a human accepts the
values in Translation Tasks. Prepare a Release Record, build its immutable
Release Bundle, then deliver it from the current Brickit integration branch:

```sh
blabla deliver --release <release-record-id>
```

When a ready Portuguese task belongs to that same Baseline, deliver both jobs
through the same transaction:

```sh
blabla deliver --release <release-record-id> --locale-proposal <proposal-id>
```

The server applies the Release Delta to the checkout's current catalog tree.
That delta may contain pending Source Proposals and reviewed target values.
Target drift is replaced with the reviewed value; if checkout Source moved away
from the Baseline before delivery, the whole conflicting key is skipped and
reported. The CLI runs Flutter generation in a disposable worktree and creates
one local `blabla/release-...` review commit.
For combined delivery it validates that both immutable artifacts share the
same repository, Baseline/Source Snapshot, and integration branch; applies the
reviewed Release Delta; and adds the complete `intl_pt.arb`. Flutter generation
runs first as a clean-tree drift check and again over the combined candidate.
Blabla supplies the catalog bytes and provenance; the adapter owns only local
Git and Flutter toolchain I/O.

It never receives Git credentials, pushes, or opens a pull request.

## Install

Released macOS arm64 and Linux x64 binaries are attached to every Blabla GitHub
Release. Install the latest one with:

```sh
curl -fsSL https://raw.githubusercontent.com/serge-the-hedge/flutte/main/cli/install.sh | sh
```

Set `BLABLA_VERSION=v0.1.0` before that command to install a particular release,
or `BLABLA_INSTALL_DIR` to choose a destination (the default is
`~/.local/bin`). The script supports only the two published platforms and
never installs a Dart package globally.

## Configure and run

The web project's **API tokens** page creates the workspace connection used by
both `sync` and translation agents. Copy its one-time setup command and run it
locally. This writes only
`~/.config/blabla/credentials.json` at mode `0600`. Secret bytes are written
inside a private temporary directory before the protected file atomically
replaces the previous credentials. It never writes to a Brickit checkout.

```sh
blabla login --server https://your-blabla.example --token ...
```

`BLABLA_API_URL` and `BLABLA_TOKEN` override the stored credentials, which is
useful for CI and one-off invocations. The token needs `read`, `search`, and
`propose` for translation work and `export` for Release Bundle delivery. The
default workspace connection includes all four plus snapshot submission.

From the same Brickit checkout, switch to the integration branch before
delivery. The current project target is `develop`; the adapter refuses a
different branch and uses `develop` as the pull-request base.

For a combined job, run:

```sh
blabla deliver --release <release-record-id> --locale-proposal <proposal-id> --checkout /path/to/brickit-flutter
```

Omit `--locale-proposal` for existing-Locale work only. The old
`deliver-portuguese --proposal ...` command remains as a deprecated
compatibility path for an already-prepared Portuguese-only job.

For local CLI development, run the same command through Dart from `cli/`:

```sh
dart pub get
BLABLA_API_URL=https://your-blabla.example \
BLABLA_TOKEN=... \
dart run bin/blabla.dart deliver \
  --release <release-record-id> \
  --locale-proposal <proposal-id> \
  --checkout /path/to/brickit-flutter
```

`--server` and `--token` are available for an explicit invocation. Flutter is
resolved in this order: `--flutter-sdk`, `FLUTTER_ROOT`, the checkout's
`.fvm/flutter_sdk`, its `.fvmrc` through an installed `fvm`, then `flutter` on
`PATH`. The root `pubspec.yaml` Flutter constraint is printed as informational
context, never a version gate: preflight generation is the compatibility check.
Local SDK paths are resolved absolutely, so `--checkout .` also works when
generation moves into the disposable worktree.

All three HTTP gateways use the same compatibility headers: an unsupported
protocol blocks the request; a newer minimum CLI version prints one advisory
warning per gateway. Equal or older minimum versions do not warn.

Before writing to the checkout, delivery validates artifact provenance, the
integration branch, and relevant localization paths. Preflight and candidate
`flutter gen-l10n` runs use a disposable Git worktree pinned to the captured
checkout commit. After revalidating the server artifacts, both delivery paths
recheck local changes, branch, and HEAD before creating a local review branch.
A checkout that advances during preparation must be retried.

Existing-Locale delivery preserves unrelated staged work outside its commit.
Combined delivery requires a clean checkout; the Portuguese-only compatibility
command requires clean localization paths and an empty index. Portuguese output
is limited to its ARB, runtime locale registration, and expected generated Dart
files; Release Delta output is verified against its delivery manifest.

The final output prints `git push` and `gh pr create` commands for the developer
to choose to run. The Adapter never runs either command itself.

## Verify and build

```sh
dart format --output=none --set-exit-if-changed .
dart analyze
dart test
dart compile exe bin/blabla.dart -o dist/blabla
```

`test/brickit_flutter_integration_test.dart` is the real-generator acceptance
test. It clones the supplied checkout into a temporary directory, so it never
writes the named checkout:

```sh
BRICKIT_CHECKOUT=/path/to/brickit-flutter \
dart test test/brickit_flutter_integration_test.dart
```

## Prove the complete Portuguese loop

The repository also carries one real-corpus delivery-pipeline proof from a
Source Snapshot through the public Agent API and this command into a temporary
Brickit branch. It first verifies that the supplied checkout's `origin` is
Brickit. The proof never uses a deployed Blabla project, changes the named
checkout, uses GitHub credentials or remote Git, or leaves the disposable
branch behind. Run it from the repository root:

```sh
BRICKIT_CHECKOUT=/path/to/brickit-flutter \
bun run --cwd packages/backend test:repository-proof --reporter=verbose
```

The proof ingests the real English ARB as accepted Source Snapshot evidence,
pages and stages all of its messages through the Agent API, finalizes the
derived `intl_pt.arb`, and runs `deliver-portuguese` against a disposable clone.
It asserts the exact four-file review commit, the `pt-BR` Runtime Locale
Mapping, Flutter generation, a clean branch, and a Git guard that rejects any
remote Git transport command. It observes the review-ready branch before the
test removes its temporary checkout.

Its staged values intentionally echo the source values. That is a safe,
contract-valid fixture for proving the delivery pipeline, provenance, and
complete Catalog Document construction; it is not a claim that automated code
can assess Portuguese translation quality. A real agent supplies reviewed
Portuguese values by following the bounded proposal steps in [the Agent API guide](../docs/agent-api.md#portuguese-locale-proposal), then a developer runs the normal command above.

Failures name their boundary: `Agent API rejected …` means the Snapshot,
proposal, value, or artifact was refused; adapter errors identify checkout or
artifact drift; and Flutter failures print the resolved SDK path and version.
