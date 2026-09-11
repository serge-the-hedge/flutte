# Agent HTTP reference

Request and response contracts for `/api/agent/v1`, authenticated with
`Authorization: Bearer <project_api_token>`. Use the
[skills](https://github.com/serge-the-hedge/flutte/tree/main/agent-kit) for agent
procedures and [transport](transport.md) for the terminal helper.

`429` responses include `Retry-After` in seconds and JSON `retryAfter` in
milliseconds. The header takes precedence. Translation, discovery, and review
need no CLI version headers. Artifact delivery has a separate [protocol floor](advanced-api.md#get-locale-proposalsartifactproposalid).

## Human Setup

Create a token in **Settings → Agent access** for the assigned project and role.
Copy its one-time-visible value, then save a named local profile with the
[CLI](https://github.com/serge-the-hedge/flutte/blob/main/cli/README.md#install) (v0.3.0 or newer):

```sh
blabla login --profile brickit-workspace --server https://example.convex.site
```

Paste the token at the hidden prompt. The server is the Convex HTTP API origin,
not the frontend or a review link. For automation, use `--token-stdin` and pipe
from the host's secret manager; keep secret values out of shell arguments,
history, prompts, and repository files.

Select the profile explicitly for every CLI or helper invocation. `sync` requires
`snapshot-submission`; delivery requires `export` (see [scopes](#scopes)). A
translation-only token cannot sync.

```sh
blabla sync --profile brickit-workspace
node <helper-path> request GET /projects/current --profile brickit-workspace
```

Alternatively, set `BLABLA_PROFILE` in that agent's environment. There is no
automatic default profile. Names contain 1–64 lowercase letters, digits, `_`, or
`-`, starting with a letter or digit. `blabla profiles` lists names only. Names select saved credentials; they
do not grant permissions. Use a separate name for each project and role. Verify
`GET /projects/current` identifies the intended project before starting work.

| Assignment | Scopes |
| --- | --- |
| Translation with example lookup | `read`, `search`, `propose` |
| Basic source authoring | `read`, `strings-write`; add `search`, `propose` for translations |
| Tag organization | `read`, `search`, `tags-write` |
| Language setup or editing | `read`, `languages-write`; add `propose` for translation tasks |
| Dictionary authoring | `read`, `dictionary-write`; add `search` for examples |
| Independent review | `read`, `search`, `review`, on a separate credential |

Dictionary editing also requires a Dictionary-editor grant for the connected
project. Review requires human
[authorization](https://github.com/serge-the-hedge/flutte/blob/main/docs/agent-review.md)
and a separate reviewer agent. Give the reviewer credential only to its authorized
session using the host's sandbox and credential controls. Profile names and file
permissions do **not** isolate agents running as the same OS user: that user can
read every profile. Environment scoping alone does not prevent access to shared
profile files. Keep reviewer profiles outside the translator's accessible filesystem.

Named profiles are supported on macOS and Linux only.
Profiles are version 1 JSON files (`version`, `server`, `token`) at
`~/.config/blabla/profiles/<name>.json`. On POSIX, the directory is private (`0700`)
and files are `0600`. They contain the token in plaintext. To remove a local profile:

```sh
blabla logout --profile brickit-workspace
```

Logout does not revoke the token; revoke it in **Settings → Agent access** to end
server access.

For direct environment setup, the canonical names are `BLABLA_API_URL` and
`BLABLA_TOKEN`. Both tools also accept the legacy pair
`BLABLA_AGENT_URL` and `BLABLA_AGENT_TOKEN`. When making requests, selecting a
profile rejects server or token overrides from flags or environment; clear those
overrides before using it. `login` accepts the
server and token inputs needed to create the selected profile.
An existing named profile is replaced only with `login --replace`.
Legacy CLI login without `--profile` still uses
`~/.config/blabla/credentials.json`; the helper does not implicitly load that file.
Loopback HTTP is allowed for local testing. Both tools reject redirects.

## Scopes

- `read`: project metadata, workspace context, and task/proposal reads.
- `search`: workspace search and work discovery.
- `propose`: Translation Task and candidate creation; it cannot apply values.
- `strings-write`: create source strings in Basic projects. It cannot edit existing
  source text, write repository keys, or save translations.
- `tags-write`: create project tags and add/remove current-message assignments.
- `languages-write`: add project languages or edit permitted language metadata.
  Repository additions configure future proposals; they do not bind files or deliver to Git.
- `dictionary-write`: create, replace, or remove active Dictionary entries with
  revision checks and agent attribution. It does not author Voice Guides or
  grant translation review or release powers.
- `review`: independent exact candidate acceptance or rejection, subject to human
  authorization. It cannot coexist with `propose`, `strings-write`, `languages-write`, `tags-write`, `dictionary-write`, `export`, or
  `snapshot-submission` on a token.
- `export`: immutable Release Bundle delivery through the local Repository
  Adapter; it does not grant a remote Git write.
- `snapshot-submission`: repository snapshot submission through the local adapter.

## Endpoints

Paginated reads return `nextCursor` unless stated otherwise. Null ends the scan;
short or empty pages may still have a continuation. Pass cursors unchanged with
the same filters. Endpoint-specific invalidation conditions are listed below.
See [scan/resume](transport.md#bounded-scans) for bounded terminal execution.

| Contract | Open when using |
| --- | --- |
| [Context](context-api.md) | Project discovery, search, guidance, or work queues |
| [Tags](tags-api.md) | Tag discovery, assignment, or filtered search |
| [Languages](languages-api.md) | Adding languages or editing their code/name |
| [Basic projects](collection-api.md) | Plain-text source creation, search/context or downloads |
| [Translation Tasks](translation-api.md) | Task creation, pages, and candidates |
| [Review](review-api.md) | Exact-revision review reads and decisions |
| [Dictionary](dictionary-api.md) | Term reads, replacements, or removals |
| [Lower-level/compatibility](advanced-api.md) | Explicit-basis proposals, artifacts, or legacy endpoints |
