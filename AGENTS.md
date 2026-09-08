## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default Matt Pocock triage label vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

### Product contracts

For localization changes, read `docs/catalog-message-lifecycle.md` and the
implementation-status table in `docs/spec/localization-control-plane.md`. For
agent integrations, use `docs/agent-api.md`; legacy catalog writes are retired.
For consumer-agent workflow changes, edit `agent-kit/` and run
`bun run test:agent-kit`; its shared HTTP reference owns endpoint documentation.

For translation review, read `docs/agent-review.md`. Agent review requires a
project setting or explicit per-revision human delegation and a separate reviewer
agent. Never give a translating agent the reviewer credential for its own work.
