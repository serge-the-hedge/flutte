# Planned localization MCP adapter

Status: **not implemented**. The supported agent transport is the HTTP
[Agent Translation Guide](agent-api.md). A future MCP adapter should call those
endpoints and preserve their bounds, provenance, and authorized-review boundary.

| Proposed tool | HTTP endpoint under `/api/agent/v1` | Scope |
| --- | --- | --- |
| `localization_project` | `GET /projects/current` | `read` |
| `localization_search` | `GET /workspace/search` | `search` |
| `localization_work` | `GET /workspace/work` | `search` |
| `localization_context` | `POST /workspace/context` | `read` |
| `localization_proposal_examples` | `POST /proposal-examples/search` | `read`, `search` |
| `localization_guidance` | `POST /guidance/context` | `read` |
| `localization_guidance_revision` | `GET /guidance/revisions/:id` | `read` |
| `localization_create_task` | `POST /translation-tasks` | `propose` |
| `localization_list_tasks` | `GET /translation-tasks` | `read` |
| `localization_read_task` | `GET /translation-tasks/:id` | `read` |
| `localization_propose_candidates` | `POST /translation-tasks/:id/candidates` | `propose` |

Pass opaque cursors and task identities through unchanged. Return candidates as
proposed until authorized review succeeds. Translation tools cannot accept or
apply them; a future reviewer tool must use a separate reviewer credential and
the exact-revision API in [Agent Review](agent-review.md).
Mirror HTTP validation and rate-limit responses rather than inventing a second
policy. Read the HTTP guide for each endpoint's complete scope checks.

Release construction stays in the authenticated human UI, and Git delivery stays
with the local Repository Adapter. Legacy search, context, Change Set, tag, and
export addresses return `410 Gone` and are not MCP tool targets.
