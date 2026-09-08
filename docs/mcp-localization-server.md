# Deferred localization MCP adapter

Status: **not implemented; deferred**. Terminal-equipped coding agents use the
[portable agent kit](../agent-kit/README.md) and supported
[HTTP API](agent-api.md). No MCP server is needed for this workflow.

Revisit MCP for a concrete client that benefits from native tools or cannot run
the HTTP helper. Design a small evaluated workflow interface; a tool per HTTP
endpoint is not an accepted requirement. Reuse the existing API's bounds,
provenance, rate limits, and scope checks.

A future reviewer connection must belong to a separate agent with its own
credential and preserve [exact-revision review authorization](agent-review.md).
Translation tools submit candidates; they cannot grant themselves review access.
Release construction remains in the authenticated human UI, and Git delivery
remains with the local Repository Adapter.
