# Adding a language

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
language-level catalog codes of two or three letters. Runtime mappings can include a script and region. Separate
regional or script **content variants** need additional catalog-format support;
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

## Several languages and capacity

Prepare several configured languages in parallel. Deliver one new language per
command, merge and sync, then repeat. After each sync, continue and re-finalize
any remaining prepared tasks against the current Baseline before delivering
them. A ready existing-Locale release can include one new language pinned to
the release’s same Baseline Snapshot, using the Release screen’s optional
language selector or `deliver --release <id> --locale-proposal <proposal-id>`.

The current working envelope permits **10 bound Locales including Source**,
8,192 keys, 20,000 projected Locale values, and 12 MiB of projected content.
Every bound applies together; 10 Locales is not an unconditional size guarantee.
Snapshot submissions remain capped at 8 MiB and Navigation at 8 MiB. Setup
reports count and known row-capacity conflicts before submission; ingestion and
binding validate actual content before atomic publication.

The configuration list supports 128 planned introductions, independently of
active catalog capacity. This lets a project maintain a compact language plan;
it does not claim that dozens of full-size catalogs are already supported.
Larger catalogs need further bounded read and storage work before raising the
active envelope. Failed validation leaves the accepted Baseline intact.
