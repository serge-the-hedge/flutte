# Projects and Dictionaries

A project owns one body of strings and a stable workflow. Choose its type when
creating it:

| Type | Source text | Reviewed output |
| --- | --- | --- |
| **Basic** | Author directly in Blabla | Copy text or download JSON |
| **Repository** | Repository Snapshots | Release Bundles delivered through the Repository Adapter |

Basic projects open in Strings. Repository projects also have Sync and Release.
Navigation follows the project type on every page; selecting a language never
changes the project’s workflow. To work on another body of copy, open another
project from **Projects**. Project types are not an in-place format conversion.

## Basic projects

Write source text and any translations in the new string’s inline rows, then
press **Save string** or **Cmd/Ctrl+Enter** to save them together. Empty target
fields remain untranslated. The editor clears and stays focused for the next string;
Enter inserts a line break. Failed saves keep the draft, and adding does not
change your search or page. Name and context are optional details.

Names accept spaces and Unicode, can repeat, and can be changed or cleared from
**Details**. Unnamed strings show their text without a placeholder name. Stable IDs are assigned
automatically and remain unchanged in links, tasks and exports. Existing keys
initially appear as names. Strings stay in creation order when renamed; search
finds names and source text. Large text pages automatically use smaller batches.

Add or remove project languages from **Languages**; each change applies immediately.
Removing a language retains its translations and history; adding it again restores them.
The source/target editor and Translation Tasks use the same review policy as
repository work. Braces and line breaks are literal plain text. Source edits are
direct and revision-checked; translations become stale when their source content
changes. Name/context-only edits preserve currency. Archiving keeps history and
reserves the ID.

All active target languages are selected initially. Reads hydrate language chunks
and split oversized requests. A focused value can be copied with its current
source/reviewed/stale/draft status visible. JSON output offers:

- **Reviewed**: every selected pair must be current and confirmed, including
  explicitly confirmed blanks.
- **Partial**: reviewed pairs only, with an omission report.
- **Draft**: working values, labelled as draft.

A download keeps values under stable IDs and includes a separate `names` map
for readable labels; renaming never changes the output identity. It is one
consistent read, not a claim of external publication. Context
accepts at most 50 keys, 20 languages and 128 pairs; downloads accept 128 keys,
1,000 languages and 1,024 pairs. Both enforce byte budgets. Larger selections
must be divided; nothing is silently truncated. Values are limited to 256 KiB,
context notes to 8 KiB, and retained language memberships to 1,000 per Basic project.
Creating a string accepts up to 128 initial translations within a 1 MiB payload.

## Shared Dictionaries

Use **Dictionaries** to create a terminology reference such as “Brickit”. Connect
it from each project’s **Translation guidance** settings. A project connects at
most one Dictionary, keeping conflicting terminology and precedence rules out
of the workflow. Voice guidance and its optional Locale add-ons remain local to
the project: store copy can sound different from in-app instructions.

Connected project members can read the Dictionary. Its owner and explicitly
assigned Dictionary editors can change terms. Connecting requires project-owner
and Dictionary-editor permission. A Dictionary editor can separately enable
agent writes for a connected project; the project token still needs the explicit
`dictionary-write` scope. Changing shared terms affects guidance in every
connected project. Review reads bind those revisions and require reassessment
after relevant guidance changes.

Dictionary renderings use canonical language codes independently of the language
sets in connected projects. Agent workflow and concurrency details live in the
[portable skills](../agent-kit/README.md).

## Existing collections and project terms

Existing repository projects keep their type and data. Owners can choose
**Make project** for old collections. The move copies current members and
language setup, retains text/candidate/review record identities and authorship,
and moves content in small resumable batches. Source/target writes are locked
until completion. Old links resolve to the new project; another collection’s
identical key remains independent.

The new project starts with human review and needs its own agent credentials.
Old credentials keep their original project scope; they do not gain access to the
new project. Existing tasks become project assignments that new project tokens
can continue, while their original author and candidate/review history remain intact.

Existing project terms can be promoted into a shared Dictionary with their
citation IDs intact. A collection move shares that Dictionary and copies current
voice guidance into independently editable project guidance. Empty projects do
not acquire unnecessary Dictionaries. If a move pauses, **Retry** resumes its
stored progress. No production migration or hosted fixture seeding is required
to merge this change; existing content moves only through the owner’s action.

The internal content-store IDs remain stable to preserve retained evidence;
collections are no longer a selectable product entity. Existing scoped HTTP
addresses remain compatibility routes. Concrete database connectors remain
outside the current implementation.
