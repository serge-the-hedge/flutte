# Agent reference, skills, and MCP: assessment

Reviewed 2026-09-08 against `71910eb` (main after Strings PR #109).
Status: **recommendation, not an accepted implementation contract**. No skill,
MCP server, credential, or production setting was installed or changed.

## Recommendation

Make a small portable skill set the primary workflow entry point. Keep the
HTTP Agent API and backend as the source of callable behavior and authority.
Offer MCP as an optional adapter when the intended agent clients benefit from
native tools. Skills and MCP solve different problems and can share one release.

For terminal-equipped agents, start with skills, targeted references, and a
small deterministic HTTP helper. Compare that with a narrow MCP prototype
before committing to an always-running remote service. If browser/chat clients
without a terminal are a near-term requirement, bring MCP forward: skills alone
do not give those clients executable access to Blabla.

The user's target-client preference remains open. The first sequence assumes
terminal-equipped coding agents are the immediate audience, based on the
existing repository workflow; it does not assume chat-only clients are supported.

## What the primary sources support

Matt Pocock's current skills repository favors small, composable workflows. His
writing guidance gives each rule one authoritative home, keeps frequently needed
instructions inline, and links conditional detail. His skill-mechanics reference
also warns that each independently discoverable skill adds persistent metadata
cost. These support distinct jobs plus shared references, rather than splitting
by endpoint. They are useful design precedents, not proof that any composition
is perfect for our agents. Sources pin the observed commit:
[README](https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/README.md),
[writing for agents](https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/productivity/writing-for-agents/SKILL.md),
[skill mechanics](https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/productivity/writing-for-agents/SKILL-MECHANICS.md).

The [Agent Skills specification](https://agentskills.io/specification) describes
progressive loading of metadata, workflow instructions, and supporting files.
Anthropic's [tool-design guidance, September 2025](https://www.anthropic.com/engineering/writing-tools-for-agents)
recommends useful workflow operations, compact meaningful responses, and
measurement of task outcomes alongside calls, tokens, latency, and errors.
This supports improving discovery and retrieval ergonomics before exposing the
entire HTTP surface as tools.

Anthropic's [code-execution-with-MCP article, November 2025](https://www.anthropic.com/engineering/code-execution-with-mcp)
describes processing intermediate results in code to reduce model context use.
That requires a suitable runtime; MCP alone does not provide it. Current
[programmatic-tool-calling documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
excludes tools supplied by the MCP connector. Do not assume those two mechanisms
compose automatically. Similarly, [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
is a client/platform capability, not a universal property of MCP servers.

On this research date, MCP's latest specification resolves to
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
Its [tool-list rules](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
allow authorization-dependent discovery, but not a connection's tool list
changing as a side effect of an `enter_mode` request. Its
[authorization contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
requires a deliberate resource/audience and access design. Skill instructions,
tool visibility, and annotations cannot replace these checks.

Skills-over-MCP is a real initiative to track. The official extension repository
has [specification text](https://github.com/modelcontextprotocol/ext-skills/blob/f1f8605b72274e8ab667b72194103fe8096e9552/specification/stable/skills.mdx)
for listing/retrieving skills and resource-backed files, with host-controlled
activation and integrity checks. Despite the `stable` directory name, its
[README](https://github.com/modelcontextprotocol/ext-skills/blob/f1f8605b72274e8ab667b72194103fe8096e9552/README.md)
still calls the work experimental. Neither that text nor core MCP support proves
support in a selected client. Keep portable files as the source and evaluate
this optional distribution adapter once client support and maturity are clear.

These sources were checked on 2026-09-08. The recommendations below are our
application-specific conclusions, not requirements imposed by those authors.

## What is already here

| Evidence in this repo | Implication |
| --- | --- |
| [Agent API guide](../docs/agent-api.md), 873 lines | Setup, translation, independent review, Dictionary authoring, endpoint reference, compatibility, and delivery compete in one entry point. Agents need a route to the relevant subset. |
| [Planned MCP adapter](../docs/mcp-localization-server.md) | Explicitly unimplemented; its 14 proposed tools closely mirror HTTP endpoints. It is a starting inventory, not a validated agent interface. |
| [Retrieval implementation](../packages/backend/convex/agentRetrieval.ts) | Literal/exact search, compact results, bounded continuations, current-value evidence, and context with guidance already exist. An MCP wrapper does not improve retrieval relevance by itself. |
| [Project discovery](../packages/backend/convex/agentApi.ts) | Already advertises scopes, retrieval capabilities, and limits. Clients should inspect these instead of embedding changing project assumptions in skills. |
| [Translation Tasks](../packages/backend/convex/agentTranslationProposals.ts) | Existing/new-Locale tasks already hide internal concurrency machinery and return guidance plus candidate/review feedback. Preserve this useful interface. |
| [Independent review contract](../docs/agent-review.md) | Separate credentials and project policy or exact-revision delegation are enforced. A skill can explain the assignment, but cannot establish authority. |
| [Dictionary authoring](../packages/backend/convex/agentDictionary.ts) | Active term writes already have explicit scope, concurrency checks, and provenance. They need their own workflow, not implicit promotion of common wording. |
| [CLI proposal gateway](../cli/lib/agent_api_gateway.dart) | The CLI handles repository delivery; it is not currently a general translation/search command interface. Avoid assuming that interface already exists. |

Code Context is still explicitly unavailable. Neither skills nor MCP supplies
missing call sites, placement, or verified sibling relationships. That remains
separate backend/product work, as the [implementation table](../docs/spec/localization-control-plane.md)
records.

## Proposed skills

Start with four task-oriented skills, independent of the number of Locales:

| Skill | When it should activate | Result and stopping point |
| --- | --- | --- |
| `blabla-context` | Find existing wording, examples, terms, or voice guidance | Bounded evidence with citations, currency/provenance, and an honest statement of gaps; no writes |
| `blabla-translate` | Translate or correct assigned messages, or prepare a configured language | Immutable candidates submitted to a task; clearly reported as proposed |
| `blabla-review` | Independently assess specifically authorized candidate revisions | Exact accept/reject decisions recorded under a separate reviewer identity; no candidate editing or translation credential |
| `blabla-dictionary` | Deliberately fill or maintain the project Dictionary | Scoped active term changes with revision checks; preserves other Locale renderings |

Each entry should contain a precise activation description, required inputs,
short workflow, critical failure behavior, and a clear output contract. Put full
request shapes and less frequent recovery cases in directly linked references.
Do not copy the 873-line guide into four skills or create one skill per endpoint
or Locale. The project Voice Guide, optional Locale add-ons, and Dictionary stay
live API data; shipping them inside skills would create stale copies.

Translation and review use the same retrieval recipe, but review retrieves its
own authoritative context. Share that recipe as a targeted reference/helper;
do not require every workflow to load every other skill. Keep essential rules
such as credential separation visible in the relevant skill itself.

Keep backend development instructions in the repository's existing agent docs.
Consumer skills must also work in the application's checkout or another agent
workspace; installing them only in Blabla's own `.agents/skills` directory would
miss the agents actually translating the app. Publish one portable bundle and
add client-specific packaging only where needed. Preserve useful public doc
links during the reference split.

## How this improves search efficiency

The shared retrieval recipe should direct agents to:

1. Read project capabilities and the assigned task/review context first. These
   already include applicable guidance, so do not fetch the same guide separately
   for every message.
2. Start example discovery with the intended Locale, an explicit field, compact
   results, and confirmed quality. Use exact key lookup when a key is known.
3. For a new Locale, search authorized reviewed proposal examples as well as
   relevant Workspace evidence. Label reviewed draft evidence honestly.
4. Fetch full exact context only for selected keys. Compact previews and observed
   frequency do not establish terminology policy or authorize a review.
5. Follow opaque continuations through empty pages when completeness matters.
   Distinguish finding enough examples from exhaustively auditing a term.
6. Re-read and reassess after stale evidence; respect server retry timing. Never
   blindly replay a review verdict or overwrite concurrent Dictionary changes.

A small helper can handle JSON, scoped credentials, bounded paging, and error
normalization so agents do not repeatedly improvise shell requests. Give scans
explicit request/item/byte limits and return continuation when those limits are
reached. Do not turn every lookup into an unbounded full-catalog download.

If traces show agents repeatedly combining task context and a few example
queries, add one bounded context composition operation behind the shared backend
interface so HTTP and MCP both benefit. Do not move a second retrieval engine,
review policy, or automatic LLM translation loop into the MCP server.

## MCP shape worth evaluating

Prefer a small set of clear workflow operations over an exhaustive endpoint
mirror. A provisional translator set is project discovery, example search,
exact context, work discovery, task listing, task creation, task reading, and
candidate submission. Example search may use an explicit discriminated scope
for Workspace, owned task, or authorized review; those scopes must retain their
existing server checks and distinct evidence labels.

A reviewer connection exposes shared reads plus review-context and review-decision
operations. Dictionary operations appear only for the appropriate credential.
Tool visibility improves ergonomics; every request still needs backend
validation. Do not offer an `enter_reviewer_mode` switch or let an agent choose
which stored token a tool uses. Translator and reviewer connections belong to
separate agent sessions, not merely two named connections available to one agent.

The exact tool count and names are prototype decisions. Each tool should have
structured input/output, useful descriptions, realistic bounds, and correct
read/write annotations. Preserve exact values, provenance, opaque cursors,
review tokens, error codes, and retry timing. A short prose summary must not
replace the structured facts needed for correct review or recovery.

Use the supported HTTP API for the first MCP adapter. This preserves the current
scope checks, rate limits, and business rules. Share deterministic client code
with skill helpers where there is actual reuse. Keep translation/review and
repository delivery separate: no Git credentials or release construction in the
translation MCP server.

| Delivery option | Benefit | Added cost / when to choose |
| --- | --- | --- |
| Skills + HTTP helper | Smallest change; good for agents with files and a terminal | Requires a runtime and a way to supply a scoped credential; not sufficient for chat-only clients |
| Local stdio MCP + skills | Native tool schemas/discovery in supporting desktop/coding clients; can use current project tokens | Local package/process configuration and another protocol to test; choose if measured usability improves |
| Remote MCP + skills | Access from clients that support remote connectors without local execution | Deployment and client-compatible authentication, lifecycle, and operational support; choose for a concrete remote-client need |

For stdio, configure credentials outside tool arguments and serve one credential
role per process. A remote implementation needs its own deliberate MCP
authentication design; existing Blabla bearer tokens are not proof of portable
OAuth connector compatibility. Do not build a generic token-passthrough proxy.

MCP tools perform operations; resources can expose reference material and exact
immutable guidance revisions. Prompts may offer optional user-invoked starting
points, but should not duplicate all skill instructions. Client support varies;
core workflows must not depend on a client automatically loading resources,
prompts, tool search, or skill extensions.

## Verification before expanding

Compare the current guide, skills plus helper, and the narrow MCP prototype on
the same small local fixture and a few actual agent tasks:

- Find established terminology, including internal Chinese substrings and
  conflicting confirmed/imported usage.
- Read shared voice guidance with and without a Locale add-on.
- Prepare a new-language batch using reviewed draft examples.
- Correct a rejected candidate using its exact feedback.
- Review an authorized revision with an independent credential; reject attempts
  to self-review, change roles, or reuse stale review context.
- Add a Dictionary rendering without dropping existing languages.
- Continue across an empty search page and stop at the requested scan budget.

Measure task success, instruction/schema tokens loaded, response bytes, model
round trips, HTTP requests, relevant evidence found, invalid calls, and recovery.
Count backend work as well as model calls: hiding ten requests inside one tool
is not automatically more efficient. Verify exact text and permission behavior
with deterministic checks; use human language judgment where correctness is
editorial. Do not assert a percentage saving before measuring it.

These are interface evaluations, not 50/100-Locale load tests. They can use local
fixtures without consuming hosted Convex storage or database quotas. Actual
model evaluation would still consume the chosen model provider's usage.

## Proposed sequence

1. Split workflow instructions from the stable HTTP reference; publish the four
   portable skills with targeted references and a minimal shared helper.
2. Run focused workflow evaluations and fix the observed retrieval/ergonomic
   gaps at the existing backend interface.
3. Add and compare the narrow local MCP adapter if target clients benefit; move
   remote MCP earlier only for a concrete chat/remote-client requirement.
4. Package the same skills and adapter together for convenient installation.
   Keep runtime compatibility and updates explicit; avoid duplicate installed
   copies or a second source of workflow rules.

This sequence is a proposal. The current callable interface remains HTTP, and
the existing product contracts are unchanged.
