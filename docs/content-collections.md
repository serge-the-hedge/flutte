# Content collections

A project shares people, languages, Dictionary and voice guidance. Its collections
keep independently authored content separate while sharing Strings, Translation
Tasks and independent review.

| Collection | Source text | Reviewed output |
| --- | --- | --- |
| **App** | The existing repository Snapshot; source edits propose changes to Git | Existing Release Bundle and Repository Adapter delivery |
| **Managed**, such as App Store or Screenshot copy | Created and edited directly in Blabla | Copy or JSON download |

## Working with marketing copy

Choose **Write content here** when creating a project, or create a collection in
Strings. Name it, select its target languages, and add keys with source text and
optional context. The source language is the project's source Locale.

Use the same source/target editor, keyboard saves and Translation Tasks as for app
content. Managed text is plain text: braces, punctuation and line breaks are
literal. Saving source text changes it directly. Existing translations become
stale when they answer different source content; context-only changes preserve
currency. Archiving retains history and reserves the key.

**All languages** selects the active target languages of that collection. Adding
a marketing language does not add a file to App or change app release readiness.
A language can participate in several collections. Removing one membership keeps
its history and does not remove other memberships. Shared Locale identities with
managed history cannot be deleted or renamed through repository setup.

For examples, agents can search the selected collection and deliberately consult
App or another collection. Search results retain their collection and review
evidence. Project guidance applies across collections; Code Context remains
unavailable. See the [agent skills](../agent-kit/README.md).

A focused value has a **Copy text** action labelled as source, reviewed, stale or
draft. For JSON output, select keys and languages to copy/download. Reviewed output requires current
reviewed translations or reviewed Intentional Blanks. **Partial** output deliberately
omits unresolved values and includes an omission report; **Draft** output keeps
unresolved values and labels the result. Copy/download never claims publication
to a store. A download is one consistent read, not a second release workflow.

## Architecture and bounds

App is the stable `app` identity for the existing project repository. Existing
URLs, Snapshot identities, decisions and repository endpoints continue to address
it. Managed collections use durable IDs; their key namespace, memberships,
source revisions and target history are separate. No fake Snapshots, historical
record rewrite or data backfill is required. Only one repository integration per
project is currently supported; database connectors are not implemented.

Managed human edits and accepted agent candidates use the same compare-and-save
function. Its basis includes collection, source revision/fingerprint, target
revision and membership revision. The shared editor carries that basis unchanged.
Review still requires a human or a separately authorized Reviewer Agent;
translation credentials cannot author source text or approve their own work.

Reads and writes are indexed and bounded. A project supports 64 managed
collections; each managed collection retains up to 1,000 Locale memberships,
including inactive history. Membership is read separately for each collection. Values are limited to 256 KiB, context notes to 8 KiB. Browse
reads scan at most 16 keys; context reads accept 50 keys, 20 languages and 128
pairs, with a 1 MiB response bound. The UI hydrates language chunks and narrows
oversized requests. Downloads accept at most 128 keys, 1,000 languages and 1,024
pairs, still within 1 MiB; larger selections must be divided explicitly.

Source/value revisions grow with edits, while current targets occupy indexed
per-key/per-Locale records. Managed edits do not rebuild repository projections.
Local fixtures test isolation, stale work, review authorization and byte bounds;
these are not hosted load-test or quota guarantees.
