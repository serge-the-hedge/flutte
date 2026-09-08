# Agent HTTP reference

Request and response contracts for `/api/agent/v1`, authenticated with
`Authorization: Bearer <project_api_token>`. Use the
[skills](https://github.com/serge-the-hedge/flutte/tree/main/agent-kit) for agent
procedures and [transport](transport.md) for the terminal helper.

`429` responses include `Retry-After` in seconds and JSON `retryAfter` in
milliseconds. The header takes precedence. Translation, discovery, and review
need no CLI version headers. Artifact delivery has a separate [protocol floor](advanced-api.md#get-locale-proposalsartifactproposalid).

## Human Setup

Create a project token in **Settings → API tokens**, copy its one-time-visible
value, and configure the assigned agent's [connection](transport.md).

| Assignment | Scopes |
| --- | --- |
| Translation with example lookup | `read`, `search`, `propose` |
| Dictionary authoring | `read`, `dictionary-write`; add `search` for examples |
| Independent review | `read`, `search`, `review`, on a separate credential |

Owners enable **Allow Dictionary editing** explicitly. A connected Dictionary
also needs a Dictionary-editor grant allowing agent writes from that project. Review requires human
[enablement](https://github.com/serge-the-hedge/flutte/blob/main/docs/agent-review.md).
Repository delivery uses the separate [CLI connection](https://github.com/serge-the-hedge/flutte/blob/main/cli/README.md).

## Scopes

- `read`: project metadata, workspace context, and task/proposal reads.
- `search`: workspace search and work discovery.
- `propose`: Translation Task and candidate creation; it cannot apply values.
- `dictionary-write`: create, replace, or remove active Dictionary entries with
  revision checks and agent attribution. It does not author Voice Guides or
  grant translation review or release powers.
- `review`: independent exact candidate acceptance or rejection, subject to human
  authorization. It cannot coexist with `propose`, `dictionary-write`, `export`, or
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
| [Basic projects](collection-api.md) | Plain-text workspace search/context or downloads |
| [Translation Tasks](translation-api.md) | Task creation, pages, and candidates |
| [Review](review-api.md) | Exact-revision review reads and decisions |
| [Dictionary](dictionary-api.md) | Term reads, replacements, or removals |
| [Lower-level/compatibility](advanced-api.md) | Explicit-basis proposals, artifacts, or legacy endpoints |
