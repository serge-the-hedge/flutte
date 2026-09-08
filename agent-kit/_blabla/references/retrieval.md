# Retrieve useful evidence

Resolve the assigned project first. The `/workspace` routes use its project type;
for Basic projects follow the [plain-text contract](collection-api.md).
Consult another project only with that project’s authorized connection, retaining
project identity with evidence. Shared Dictionary access does not grant access
to another project’s strings.

Choose the smallest read that answers the question. Task pages, exact Workspace
context, and candidate-review context already include applicable guidance once;
avoid fetching the same guide for every message.

| Question | Read |
| --- | --- |
| What exactly does this known key say? | `POST /workspace/context` with selected `keys` and `locales` |
| Where have we used this wording? | `GET /workspace/search` with `localeCode`, `searchIn`, `view=compact`, usually `quality=confirmed` |
| Which wording is established in this new-language draft? | `POST /proposal-examples/search` scoped to the owned task or authorized review revision |
| What terms/voice apply to these supplied Source texts? | `POST /guidance/context`; needed only when existing context does not already provide it |
| Which values need work across the catalog? | `GET /workspace/work`, then create/read tasks for the assigned subset |
| What did this cited guidance revision say? | `GET /guidance/revisions/:revisionId` |

For request shapes and bounds, open the corresponding section in
[API reference](api.md#endpoints). For bounded scanning use the helper's `scan`
command described in [transport](transport.md).

Start with exact key lookup when the identifier is known. Otherwise choose the
field deliberately: Source wording, target wording, or key prefix. Search is
literal; internal Chinese substrings are supported, but stemming, typo repair,
and semantic ranking are not. A confirmed example is current, contract-valid,
and confirmed; inspect its actual provenance rather than treating confirmation
as editorial curation.

Use compact search hits to choose examples, then fetch full exact context for
values you will translate or review. Preserve evidence references and immutable
guidance citations. Dictionary entries are explicit shared terminology;
observed catalog usage may conflict with them. Missing guidance remains missing.
Code Context is unavailable until the project advertises otherwise: a suggestive
key name is not verified UI placement.

Workspace and new-Locale examples are separate evidence sets. Proposal searches
use `{ "kind": "task", "taskId": "…" }` for the translating task owner, or
`{ "kind": "review", "candidateRevisionId": "…" }` for its authorized reviewer.
Reviewed draft examples are not proof of release. Reviewers retrieve their own
evidence rather than relying only on examples selected by the translator.

For a few examples, stop once the evidence answers the question and report that
scope. For exhaustive occurrence audits use `quality=all` unless the assignment
limits the audit to confirmed values. Follow the [scan/resume contract](transport.md#bounded-scans)
through every page, preserving filters; changed filters or stale basis require a
fresh search. Report unfinished scope when the assignment's budget is exhausted.

For complete repairs, discover `/workspace/work` one Locale at a time and finish
that initial pass before accepting reviews. Queue matches require inspection,
not automatic overwrites; use the [translation skill](../../blabla-translate/SKILL.md)
for assigned candidates. After review, restart discovery with the same selected
reasons and require a complete zero-match pass before claiming they are fixed.
