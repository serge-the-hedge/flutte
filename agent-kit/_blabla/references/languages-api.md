# Language management

Use these endpoints for an explicit language setup or editing assignment.
Reads need `read`; writes need `languages-write`. A translator can hold both
`propose` and `languages-write`. Reviewer credentials remain separate and cannot
include language writes. Existing tokens have immutable scopes: create a new
scoped token and replace the intended local profile when adding this capability.
The existing terminal helper supports all methods below; no CLI upgrade is needed.

### `GET /languages`

Returns `projectType`, `canWrite`, `languages`, and `introductionTargets`.
Each language has `id`, `code`, `label`, `isSource`, `canEditCode`, and
`canEditLabel`. Introduction targets contain `id`, `localeCode`, `label`,
`catalogPath`, `runtimeLocale`, and `updatedAt`. Save the returned IDs and
previous values for edits; re-read after conflicts.

### `POST /languages`

In a **Basic** project, add and enable a target language:

```json
{"code":"pt-BR","label":"Portuguese (Brazil)"}
```

Returns `{kind: "language", localeId, membershipRevision}`. Re-adding a removed
language restores its ID, translations and history. A supplied nonblank label
replaces its old name; omission keeps it. Adding an already enabled language
with the same metadata is harmless; use PATCH to change its name. Source
languages are edited by ID, never added as another target.

In a **Repository** project, configure a language for future proposals:

```json
{
  "code":"it",
  "label":"Italian",
  "catalogPath":"packages/brickit_generated/lib/l10n/intl_it.arb",
  "runtimeLocale":"it-IT"
}
```

Returns `{kind: "introductionTarget", targetId, updatedAt}`. Read the project's
Source catalog path first: the Flutter adapter requires the same directory and
a language-only catalog code. To update an existing target, include its
`expectedUpdatedAt` from GET. Existing proposals keep their pinned configuration.
Configuration does not activate or bind a repository language. Continue with
[the new-language task workflow](translation-api.md#new-locale-translation-task)
when translation is part of the assignment.

### `PATCH /languages/:id`

Use an active language ID from GET and all four fields. Restore removed
languages with POST before editing them:

```json
{
  "code":"pt-BR",
  "label":"Portuguese (Brazil)",
  "expectedCode":"pt",
  "expectedLabel":"Portuguese"
}
```

Basic codes and names can change, including the Source label/code. The same ID,
translations, history and task scope remain; live task reads use the current
code. This relabels existing content—it does not translate that content into a
different language. Repository languages permit name edits with the existing
code unchanged; code/binding corrections use the repository setup workflow.
Success returns JSON `null`.

Validation rejects malformed codes/names, collisions (including retained or
archived identities), and unsafe repository code changes. Invalid or insufficient tokens
return 401, missing languages 404, and conflicting previous values 409. Re-read
metadata and reassess rather than overwriting a concurrent edit. These endpoints
never remove languages or grant translation review or Git delivery authority.
