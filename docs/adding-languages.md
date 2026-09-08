# Adding a language

Basic projects add target languages directly in Strings; they need no catalog
file or repository delivery. See [Projects and Dictionaries](projects-and-dictionaries.md).
The repository workflow below applies to Repository Projects.


Use the same workflow for each language: configure it, prepare a Translation
Task, review the complete catalog, deliver it through Git, and bind the observed
file. Configuration and proposals do not activate a language.

## Configure and prepare

In **Settings → Languages**, save the catalog code, language name, repository
path, and explicit Runtime Locale Mapping. For example:

| Catalog code | Name | Catalog path | Runtime locale |
| --- | --- | --- | --- |
| `it` | Italian | `packages/brickit_generated/lib/l10n/intl_it.arb` | `it-IT` |
| `ja` | Japanese | `packages/brickit_generated/lib/l10n/intl_ja.arb` | `ja` |
| `sr` | Serbian | `packages/brickit_generated/lib/l10n/intl_sr.arb` | `sr-Latn-RS` |

The current adapter targets Brickit’s Flutter repository layout. New ARB files
must use the Source catalog’s directory. The Flutter adapter introduces
language-level catalog codes of two or three letters. Runtime mappings can
include a script and region. Separate regional or script **content variants** need additional catalog-format support;
do not encode one by changing the runtime mapping alone.

In **Translation tasks**, select the configured language and choose **Prepare
language**. The task pins its source evidence and delivery configuration. Later
settings edits affect future proposals; they cannot rewrite a prepared artifact.
Use the language filter and **Load more tasks** to find older work.

Add terminology and an optional Locale add-on in Translation guidance. The
general Voice Guide applies to every language. Agents discover configured
targets and use the same task workflow through the [Agent API](agent-api.md).

## Translate and review

Fill the complete catalog manually or give its task ID to a translating agent.
Agent candidates require human review or authorized independent agent review.
The translating agent must never hold the reviewer credential for its own work.
See [review authorization](agent-review.md).

Finalize only after every source message has a reviewed, contract-valid target.
An intentionally empty translation needs a reason. If the accepted Baseline
advances before delivery, use **Continue on current source** and finalize again.
This also applies when Source text is unchanged: compatible reviewed values
carry forward, and changed or added source values remain review work.

## Deliver and bind

The finalized task shows the command to run in the application checkout:

```sh
blabla deliver-locale --proposal <proposal-id>
```

The CLI verifies the artifact and pinned source, writes the configured ARB file,
registers the explicit runtime mapping, regenerates Flutter output, and creates
a local review branch. You push, review, and merge that branch under your Git
identity. Blabla holds no Git credentials.

After merging, check out the integration branch and run `blabla sync`. A later
accepted Baseline can record a **Locale Delivery Observation** only when the
catalog bytes and path match the artifact and its Source Contract still matches.
Preview snapshots and similar-looking translations do not transfer approval.

Return to the task and choose **Bind language**. This deliberate editor action
adds the observed file to the current Catalog Workspace, retaining its original
review provenance and Intentional Blank reasons. The **Binding Realization**
preserves Snapshot Identity and does not require another ingest. Binding the
target before its delivery commit arrives also preserves review evidence when
that commit is later accepted.

The language is then ordinary translation and release work in Strings. Adding
it does not reopen older messages' frozen First Review scope.

## Import a language already in Git

Sync discovers sibling ARB files even when no language is bound to them. Its
receipt names each unresolved file and the locale declared by `@@locale` (or
says the declaration is missing).

**Strings** links to unresolved discoveries. **Sync** and **Settings → Languages** show **Discovered catalog files** from the
current accepted snapshot. Each card shows the repository path, declared locale,
and message count. The form suggests the declared locale, or the existing language
configuration for that exact path when no locale is declared. Missing identity
requires an editor to choose it; filenames alone do not decide language identity.
Conflicting, source, and archived language bindings explain what needs resolving.

Choose **Add language** to bind and import that file immediately, without another
sync. A new language remains hidden during preparation and becomes active in
the same transaction as its catalog binding. Failed attempts reclaim the hidden
identity; abandoned attempts expire after 24 hours. Existing language identities
are preserved on failure. A snapshot change invalidates the open binding request. Files disappear from
discovery after binding; re-syncing the same commit no longer warns about them.
Adding a language is deliberate because it changes the active translation and
release scope. Ordinary Git imports remain unconfirmed; matching reviewed delivery
evidence keeps its existing review provenance. Merely finding a file never approves
its translations or activates its language.

## Several languages and capacity

Prepare several configured languages in parallel. Deliver one new language per
command, merge and sync, then repeat. After each sync, continue and re-finalize
any remaining prepared tasks against the current Baseline before delivering
them. A ready existing-Locale release can include one new language pinned to
the release’s same Baseline Snapshot, using the Release screen’s optional
language selector or `deliver --release <id> --locale-proposal <proposal-id>`.

The working catalog no longer has a 10- or 16-language ceiling. Ingestion
processes bounded groups of keys. Strings defaults to all active, bound languages
alongside Source. Use the language picker to select a subset or show Source only;
explicit selections are shareable in the URL. Search checks the key, Source, and
any selected language with literal substring matching. Cards load progressively
in bounded requests, with less key lookahead as more languages are selected.
Changing the selection retains the unsaved-edit navigation guard.

Resource guards still apply together: 8,192 active Source keys, 1,000,000 projected values,
1,000 Locale identities, and 8 MiB per uploaded catalog file. These are structural
guards, **not a tested capacity promise**. A processing group splits down to one
key when necessary; the incoming, previous, and archived evidence for that key
must fit its 6 MiB budget. Very large individual messages can therefore reach a
resource limit sooner than ordinary catalogs. Failed validation leaves the
accepted Baseline intact. The configuration list independently supports 128
planned introductions.

Use the current CLI for per-file uploads. The compatibility endpoint for older
clients still accepts at most 8 MiB for an entire snapshot request. Public catalog,
archive, restoration, and Git-change reads are paginated; continuations pin the
published projection and may contain another part of the same key.

More languages store more translations. During ingestion, this architecture also
stores a temporary indexed copy of incoming messages and derives reconciliation
twice: first to
calculate expected totals, then to stage and verify the complete result before
atomic publication. The temporary copy is removed before publication; failed attempts reclaim it
through bounded cleanup, and abandoned staging work expires after 24 hours. This costs extra transient
storage, reads, and compute in exchange for bounded processing and the existing
all-or-nothing publication checks. Immutable snapshots and retained generations
still contribute to ongoing storage usage.

Validation uses the local Convex test backend, including small multi-language
lifecycle fixtures and existing real-catalog examples. No 50- or 100-language
full-catalog load test or hosted fixture seeding is required for this change.
Measure those workloads separately before making latency or quota commitments.
