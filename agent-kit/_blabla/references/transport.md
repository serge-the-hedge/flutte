# Use the HTTP helper

Requirements: Node.js 22 or newer and a complete installed Blabla skill bundle.
Resolve the helper path relative to this reference file:
`../scripts/blabla-agent.mjs`. Its `--help` output is the command-line reference.

For credentials, profile selection, scopes, or reviewer isolation, read
[Human Setup](api.md#human-setup). The host supplies the assigned profile through
`BLABLA_PROFILE` or you pass `--profile NAME` to each invocation. Direct environment
credentials are also supported as described there.

## Requests

The helper prefixes endpoint paths with `/api/agent/v1`:

```text
node <helper-path> request GET /projects/current
node <helper-path> request GET /workspace/search --query query.json
node <helper-path> request POST /workspace/context --body context.json
```

Write JSON files with the host's file-writing tools, preserving exact Unicode,
quotes, newlines, and ICU braces. Request files contain API parameters only.
For example, `query.json` for established German target wording could contain:

```json
{ "q": "bauen", "localeCode": "de", "searchIn": "target", "quality": "confirmed", "view": "compact", "limit": 8 }
```

Successful requests print the original API JSON to stdout. Failures print a
structured `error` to stderr and exit nonzero. Treat `status` and `code` as
machine-readable facts. `retryAfterMs`, when available, tells you the earliest
rate-limit retry; respect the assignment's time budget before waiting. Transport
failures may have an unknown write outcome: inspect current task/review/Dictionary
state before deciding whether a retry is appropriate. The helper does not retry
writes automatically or print raw server error text that might contain secrets.

For exact endpoint contracts, read only the relevant [API section](api.md#endpoints).
This helper adds no scopes, review authority, or CLI delivery compatibility.

## Bounded scans

`scan` supports the paginated read endpoints listed by `--help`. For example:

```text
node <helper-path> scan GET /workspace/search --query query.json
node <helper-path> scan POST /proposal-examples/search --body examples.json
```

The output contains `pages` (unaltered API page objects), `nextCursor`, `complete`,
and `stopReason`. Inspect `complete`, not just the cursor:

- `complete: true` means an accepted API page ended with a null continuation.
- A page/byte budget stop preserves completed pages and the next request's
  cursor. Put that cursor into the same query/body JSON to resume.
- If the first page exceeded the byte budget, no page was accepted; a null
  continuation with `complete: false` means retry the original request with a
  larger budget or smaller API `limit`.
- An error after earlier pages retains their evidence and continuation, adds an
  `error`, and exits nonzero. A stale-basis error requires restarting the search
  against fresh facts rather than combining incompatible generations.

Empty pages with a continuation are scanned normally. Repeated or missing
cursors are protocol errors. GET `/translation-tasks` is a bounded inbox without
a continuation: use `request` for it, and `scan` only for a particular task's
paginated contents. The helper enforces request, byte, and timeout bounds; do not
raise them merely to download an entire catalog for a small wording question.
