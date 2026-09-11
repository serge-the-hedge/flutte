# Blabla Repository Adapter

The shortest local workflow is:

```sh
# once per project and role; paste the token at the hidden prompt
blabla login --profile brickit-workspace --server https://<your-dev-deployment>.convex.site
export BLABLA_PROFILE=brickit-workspace

# whenever the Brickit checkout changes
cd /path/to/brickit-flutter
git fetch origin develop
git switch develop
git pull --ff-only origin develop
blabla sync
```

`sync` reads the bound ARB files and tracked sibling catalogs from the checkout, uploads each catalog separately,
then finalizes one durable Source Snapshot. Progress and diagnostics go to stderr;
stdout reports the result, new/changed/removed keys, and changed translation values
when the server provides those counts. Long server requests show elapsed waiting
time, not an estimated percentage. Repeated snapshots are identified as already
synced; previews explicitly leave the accepted catalog unchanged. Each file is
limited to 8 MiB; there is no combined upload byte limit. Uploaded files remain
private staging evidence until finalization succeeds. Incomplete uploads expire
after 24 hours, and cleanup preserves files owned by a published Snapshot. It exits with status `0` only when ingestion
succeeds; a failed run returns `1` with its diagnostics. It is read-only locally: it never edits the
checkout, fetches or pushes Git, or opens a pull request. The web Sync page can
create a single workspace connection with the `snapshot-submission` permission
and the agent permissions together, then gives you the one-time `login`
command. If setup is incomplete, `sync` prints the exact missing binding or
project configuration instead of requiring a project id or a hand-built HTTP
request.

Unbound files are listed by repository path and declared locale. Open **Sync →
Discovered catalog files** in Blabla (also available in **Settings → Languages**)
to review the prefilled language and add it to Strings without another sync.
Discovery never activates a language automatically.

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

When a ready new-Locale task belongs to that same Baseline, deliver both jobs
through the same transaction:

```sh
blabla deliver --release <release-record-id> --locale-proposal <proposal-id>
```

The server applies the Release Delta to the checkout's current catalog tree.
That delta may contain pending Source Proposals and reviewed target values.
Target drift is replaced with the reviewed value; if checkout Source moved away
from the Baseline before delivery, the whole conflicting key is skipped and
reported. The CLI runs Flutter generation in a disposable worktree and creates
a local `blabla/release-...` review branch containing the delivery commit and,
when needed, a separate preceding generated-output refresh commit.
For combined delivery it validates that both immutable artifacts share the
same repository, Baseline/Source Snapshot, and integration branch; applies the
reviewed Release Delta; and adds the complete configured Catalog Document. Flutter generation
runs first to assess the existing generated output and again over the combined candidate.
Blabla supplies the catalog bytes and provenance; the adapter owns only local
Git and Flutter toolchain I/O.

Delivery uses the same per-file upload protocol as sync and downloads each result
separately. See [Repository Adapter transport](../docs/repository-adapter.md) for
session retries, cleanup, and version 2 release manifests.

It never receives Git credentials, pushes, or opens a pull request.

## Install

Released macOS arm64 and Linux x64 binaries are attached to every Blabla GitHub
Release. Install the latest one with:

```sh
curl -fsSL https://raw.githubusercontent.com/serge-the-hedge/flutte/main/cli/install.sh | sh
```

Run the same command to update. Check the installed release with `blabla --version`.
The executable is independent of your checkout: pulling Git changes does not
update it. Installed binaries need no Dart SDK and updates preserve your login.

From a checkout, install a particular release with
`BLABLA_VERSION=v0.2.0 sh cli/install.sh`. Set `BLABLA_INSTALL_DIR` to choose a
destination (the default is `~/.local/bin`). When piping the installer, put
these environment variables on the `sh` command. The script supports only the
two published platforms and never installs a Dart package globally.

## Configure and run

Follow [Human Setup](../agent-kit/_blabla/references/api.md#human-setup) for
profiles, direct environment credentials, automation, logout, and reviewer
isolation. Use `--profile NAME` on each command or set `BLABLA_PROFILE` for the
session. The token needs `snapshot-submission` for sync and `export` for delivery.

From the same Brickit checkout, switch to the integration branch before
delivery. The current project target is `develop`; the adapter refuses a
different branch and uses `develop` as the pull-request base.

For a combined job, run:

```sh
blabla deliver --release <release-record-id> --locale-proposal <proposal-id> --checkout /path/to/brickit-flutter
```

Omit `--locale-proposal` for existing-Locale work only. To deliver a new Locale
on its own, run `blabla deliver-locale --proposal <proposal-id>`. The old
`deliver-portuguese` name remains a deprecated alias. Each delivery accepts one
new Locale; repeat the same flow for the next language after merging and syncing
the preceding delivery.

A project editor configures the catalog code, label, path, and explicit Runtime
Locale Mapping before a task starts. This Brickit adapter supports language-only
catalog codes in `packages/brickit_generated/lib/l10n/` and runtime mappings such
as `it-IT`, `ja`, or `sr-Latn-RS`. Script mappings use Flutter's
[`Locale.fromSubtags`](https://api.flutter.dev/flutter/dart-ui/Locale/Locale.fromSubtags.html).
A content variant requiring a separate regional/script ARB is not supported by
this adapter yet. Runtime registration recognizes literal Locale declarations
and Brickit's named `supportedLocales` and `supportedLanguageCodes` lists; it
does not depend on a particular existing language or its position. Unfamiliar
registration expressions and duplicate runtime mappings stop delivery.

For local CLI development, use Dart **3.13.3**, matching the pinned CI and
release toolchain. Download that exact version and your platform from the
[official SDK archive](https://dart.dev/get-dart/archive), verify the archive's
SHA-256 checksum, and extract it to a versioned directory. Keep this standalone
SDK separate from Flutter's bundled Dart. For example, with the SDK extracted
under `~/.local/share/blabla/dart-3.13.3/`, select it for the current shell:

```sh
export PATH="$HOME/.local/share/blabla/dart-3.13.3/dart-sdk/bin:$PATH"
dart --version
```

Then run from `cli/`:

```sh
dart pub get --enforce-lockfile
BLABLA_PROFILE=brickit-workspace \
dart run bin/blabla.dart deliver \
  --release <release-record-id> \
  --locale-proposal <proposal-id> \
  --checkout /path/to/brickit-flutter
```

Direct credentials are also supported; see [Human Setup](../agent-kit/_blabla/references/api.md#human-setup). Flutter is
resolved in this order: `--flutter-sdk`, the checkout's `.fvm/flutter_sdk`, its
`.fvmrc` through installed FVM, `FLUTTER_ROOT`, then `flutter` on `PATH`. A configured
but unavailable repository SDK stops with an `fvm install` instruction instead of
silently using a different SDK. An exact `.fvmrc` version must match the selected
repository SDK; a stale SDK link gets an `fvm use <version>` repair command.
The SDK executable is fixed before entering the disposable worktree.

A clean preflight proves compatibility. If existing generated output needs a
refresh, delivery handles it automatically when all of these hold:

- The SDK comes from repository configuration or an explicit `--flutter-sdk`.
- Its known version satisfies the root `pubspec.yaml` Flutter constraint, if declared.
- Only existing `app_localizations_<locale>.dart` files change; the shared
  `app_localizations.dart`, catalogs, file set, and permissions remain unchanged.
- A second generation run produces identical output.

Delivery verifies the full candidate before writing, then creates a separate
`chore(l10n): refresh generated localization` commit before the delivery commit.
Review both commits on the same branch. A failed candidate does not leave a
refresh commit in your checkout. Unrelated staged work remains outside both
commits for existing-Locale delivery.

If refresh cannot be automated, the command lists the actual changed files,
explains the blocker, and saves a diff under the checkout's Git directory at
`blabla/diagnostics/generation-*/baseline.diff`. The printed path remains available
after temporary-worktree cleanup. Follow the specific SDK or application-change
guidance, then retry your original command; do not blindly regenerate and commit
with an unexplained SDK mismatch.

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
Combined delivery requires a clean checkout; standalone new-Locale delivery
requires clean localization paths and an empty index. New-Locale output
is limited to its ARB, runtime locale registration, and expected generated Dart
files; Release Delta output is verified against its delivery manifest. A complete
new-Locale artifact requires the checkout Source Catalog to match its pinned
commit, including when combined with a Release Bundle. Sync and continue the
proposal if Source has moved.

The final output prints `git push` and `gh pr create` commands for the developer
to choose to run. The Adapter never runs either command itself.

## Verify and build

```sh
dart format --output=none --set-exit-if-changed .
dart analyze
dart test
dart compile exe bin/blabla.dart -o dist/blabla
```

To use that local build, run `install -m 755 dist/blabla "$HOME/.local/bin/blabla"`.
For normal updates, prefer the published release so everyone gets the same build.

## Publish a CLI release

1. Update `pubspec.yaml` and the default version in `lib/cli_version.dart` together.
2. Run the verification commands above and merge the change after Quality passes
   on macOS arm64 and Linux x64.
3. Publish a GitHub Release with a new `vX.Y.Z` tag targeting the verified commit
   on `main`. Include the CLI changes since the previous release in its notes.
4. Wait for **Release CLI** to succeed and attach both platform binaries. It builds
   the tagged source using Dart 3.13.3 and stamps the tag version into the executable.
5. Run the installer and verify `blabla --version`. Reusing a tag or replacing a
   published release is unnecessary; fixes get a new version.

`test/brickit_flutter_integration_test.dart` is the real-generator acceptance
test for Italian, Japanese, and a Serbian script/region runtime mapping. It
clones the supplied checkout into a temporary directory, so it never
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
