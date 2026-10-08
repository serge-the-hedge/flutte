# Translation and independent review workflow

Use `../scripts/blabla-workflow.mjs` relative to this reference for task work and
review. It uses the same credentials as [transport](transport.md). Node.js 22+
is sufficient; do not build a batch poster, polling loop, or replacement validator.
Use the HTTP helper for discovery, retrieval, task creation and finalization;
the endpoint references remain authoritative.

## Establish the run

The coordinator assigns one absolute installed bundle root to the run and every
worker. Check it against the chosen reviewed checkout using the
[installer](https://github.com/serge-the-hedge/flutte/blob/main/agent-kit/README.md#install-into-the-consumers-workspace)
with `--check`, and retain the reported fingerprint with the brief. Keep that
bundle for resumed states; adopt an update at an idle boundary with its new
root/fingerprint recorded.

Discover the project with the assigned profile. Record requested keys and locales,
matching task IDs, and one private state directory per task. Use discovered locale
identities verbatim. New repository locales need their catalog path and real runtime
locale configured before bulk work; never invent a language code to represent a
script. Verify app/device selection separately from artifact readiness.

For a broad assignment, inspect a small representative slice before parallel work:
recurring terms, ICU, intentional blanks, rich whitespace, fragments, and limits.
Record `brief-v1.json` with the scope, task IDs, retrieved guidance revisions,
evidence references, provisional wording choices, and unresolved questions. Keep
human/project requirements distinct from translator preferences. Small assignments
can keep this in their task notes. Resolve ambiguity with call sites or related
messages where available; a key name alone does not establish UI placement.
For repeated caller or fragment research, select [shared local evidence](evidence.md)
against the current saved task or reviewer context. Keep its Source/file hash
results and limitations with the round's briefing.

For constrained UI groups, follow [review a UI group](#review-a-ui-group) before
expanding the affected pilot. Include the group even in a small assignment.

Translate and review the pilot before expanding. Preserve each brief version;
include its path in worker assignments. If policy changes, create a new version
listing the affected message IDs, stop overlapping work on those messages, and
reassign their translation/review. Persist Dictionary or Voice Guide changes only
when that maintenance is authorized. A local brief does not override server
guidance or grant review authority.

### Review a UI group

Read co-displayed titles, subtitles, buttons, and composed fragments together.
Record their exact keys and Source, the action/object the group must communicate,
and available screenshot or caller evidence. Include known width, line-count,
explicit line-break, and optional-subtitle constraints. Distinguish measured or
observed behavior from assumptions; a character count alone cannot prove fit.

Evaluate the complete localized group in the pilot, including likely longer
languages. Shorten wording while retaining the action and its object somewhere
visible: a generic “Filter” button only works when nearby text establishes what
is filtered. An authorized blank subtitle or redistributed meaning must leave
the group understandable and preserve executable contracts. Record that choice
and the blank reason for the independent reviewer.

If layout evidence is unavailable, record that limitation and preserve clear
meaning. Ask a targeted question when the missing context changes the wording;
unaffected groups can continue. Share the same evidence with the reviewer, who
still fetches current authoritative Source and candidate contexts independently.

## Translate one durable page

```text
node <workflow> task read TASK_ID --state <task-state> --profile <translator>
node <workflow> task submit TASK_ID --state <task-state> --profile <translator> --body candidates.json
```

`read` returns at most 16 targets with current source, guidance, candidate and
feedback. Translate the returned `work`. Write exact candidate bytes to JSON:

```json
{"items":[{"messageId":"welcome","candidate":{"kind":"value","value":"Bienvenue"}},{"messageId":"hidden_suffix","candidate":{"kind":"intentionalBlank","reason":"This locale needs no suffix."}}]}
```

Submit at most 16 items; use fewer for long or complex messages. Server submission
validates the actual ICU/placeholder and character-limit contract. Preserve exact
whitespace unless evidence justifies changing it. Script/terminology heuristics are
review clues, not deterministic contract failures; shared Chinese characters are
not inherently wrong-script text.

After submission, when `reviewHandoff` is non-null, pass that file and brief version to a
separate reviewer agent. The file carries exact revision IDs. Continue `task read`
until `submittedScopeComplete`. Empty pages can have a continuation. A cursor
advances only after its page has candidates; draft files do not advance progress.
Use `task read ... --restart` to revisit feedback from the start. A rejected
terminal task requires an assigned correction task; do not rewrite accepted work.

### Inspect a known page

To revisit a known correction, reuse a cursor previously returned by this task:

```text
node <workflow> task inspect TASK_ID --cursor CURSOR --state <task-state> --profile <translator>
node <workflow> task submit TASK_ID --state <task-state> --profile <translator> --body candidates.json
```

`--cursor` is a nonnegative safe integer position. Use an observed server cursor;
do not calculate it from an assumed page size because pages can stop on bytes.
Inspection reads one fresh page of at most 16 targets with current Source,
guidance, candidates and feedback. The cursor locates evidence; it does not
establish that the page was assessed or reviewed. Read and reassess that evidence
before submitting corrections through the ordinary submit command.

Inspection selects the saved page for submission and preserves the ordinary scan
checkpoint and separate `task status` observations. Its output (and subsequent
submit output) includes `inspectionCursor`, `inspectedPageComplete` and
`scanCheckpoint`. `inspectedPageComplete` means this page has no missing or
rejected candidates; even a final inspected page cannot establish whole-task
coverage. `submittedScopeComplete` reports the saved ordinary scan. Resume
`task read` at that checkpoint, and rescan `task status --restart` for fresh review
coverage after corrections.

Unknown writes block inspection: recover the identical saved submission on its
original page first. Before fetching, inspection clears the old page selection.
If fetching fails or the worker stops, successfully read or inspect again before
submitting. Changed Source or guidance still requires fresh assessment. Inspection uses the assigned
translator credential and state; independent review and exact revision handoffs
follow the same rules as ordinary submission.

One translator owns a task/state at a time. Parallelize independent tasks/locales;
start with one translator and one reviewer, then at most two of each if useful.
Keep each review round at 16 revisions or fewer, with one owner per revision.
Pacing is shared across local workflow workers using the same API credential.
Do not evade rate limits with extra tokens. Workers on different machines require
host-level coordination; the local scheduler does not claim distributed ownership.

## Reuse reviewed authorship

When assigned to reuse exact reviewed text, select an accessible source task and
an open destination task with the intended Locale and current Source. Create or
resume the destination through the ordinary task API first. Review does not
transfer between tasks or Locale identities; the new candidates need independent
assessment under the destination’s guidance.

```text
node <workflow> task reuse DESTINATION_TASK_ID --source SOURCE_TASK_ID --state <reuse-state> --profile <translator>
```

Use a separate state directory for this task pair. Each invocation consumes up to
four source pages (`--max-pages` 1–32); repeat the same command until `complete:true`.
The runner saves the request key before writing, exact page receipts, skip results,
and `reuse-handoff-CURSOR.json` files containing the new revision IDs. Resume the
same state after an interrupted or unknown write: the server returns its durable
receipt. Keep skip results for reconciliation; `complete` means source scanning
finished, not every destination candidate exists or has been reviewed. Resolve
changed/incompatible/occupied scope with ordinary task reads and the assignment.
A new explicitly assigned reuse pass uses a new state directory.

Give each nonempty handoff to the separate reviewer. Then use ordinary `task read`
and `task status` state for destination work and coverage. See the
[reuse endpoint contract](translation-api.md#post-translation-tasksdestinationidreuse)
for eligibility, drift checks, blanks, provenance and result meanings.

## Independently review and record

The host launches a separate reviewer with its dedicated profile. The translator
must not load that credential or act as a fallback reviewer. If the host cannot
isolate a reviewer, complete translation and return exact revision handoffs for
human or independent review. Project policy or per-revision human delegation is
required; setup is not something a translating agent can grant itself.

```text
node <workflow> review read --state <review-state> --profile <reviewer> --body <handoff-file>
node <workflow> review submit --state <review-state> --profile <reviewer> --body <filled-decision-template>
```

`read` independently fetches each revision's authoritative context and saves
context files plus a template. Read every context file, including source, target,
candidate, blank reason, basis, guidance and permission. Retrieve examples with
the reviewer's own access. Fill every verdict explicitly:

```json
{"items":[{"revisionId":"EXACT_REVISION","reviewToken":"TOKEN_FROM_ASSESSED_CONTEXT","decision":{"kind":"reject","reason":"The action changes from saving to deleting."}}]}
```

Acceptance is `{"kind":"accept"}` and accepts exact bytes. An accepted blank
records `intentionalBlank`; it is not missing translation. Never join verdicts
by message ID alone or transfer a verdict to a replacement revision. Missing
verdicts remain undecided. The reviewer owns the assessment, posting and receipts;
a coordinator may aggregate recorded receipts without becoming the reviewer.

For many rounds, use a [campaign queue](campaign.md) with an immutable manifest
and disjoint reviewer ownership. Assign the queue once; its reviewer selects each
next bounded round and follows the same read, assessment and submit steps above.
Use the generated campaign report for progress instead of maintaining separate
counts. Server coverage and finalization remain separate completion steps.

`submit` checks that each verdict names a context this reviewer read, rechecks its
token, and retrieves the server's recorded result. Changed facts require a new
read and new assessment; the command never refreshes a token and replays a verdict.
Its output separates `recorded` and `blocked` revisions. Partial completion exits
nonzero; successful revisions remain recoverable from their receipts.
`read` also saves receipts for already recorded reviews, including after a lost
local receipt, without posting a decision. Existing receipts remain byte-identical;
contradictory observations return `CONFLICTING_RECEIPT` and preserve the original
evidence for explicit reconciliation.
`complete` covers the submitted verdicts; whole-task completion always requires
the server coverage scan below, including revisions omitted from a decision file.

## Recovery and completion

| Signal | Action |
| --- | --- |
| Interrupted worker / output exhaustion | Resume the same state and assigned scope; inspect saved files before regenerating work. Dead local owners are recovered. |
| Local lock `BUSY` | Resume the same command and state after contention subsides. The runner bounds retries for lock handoffs. |
| Invalid worker lock | Preserve the lock and state files; report the filesystem code or invalid-JSON diagnostic for investigation. |
| Unknown candidate write | Repeat `task submit` with `<task-state>/submission.json` as the body. It reads the server before resubmitting identical candidates. |
| Unknown review write | Repeat the exact saved decisions. The runner reads recorded results before writing. |
| `429` | The runner shares pacing, honors retry timing, and bounds retries. If still blocked, resume later with the same state. |
| `REASSESS`, `STALE_BASIS` | Read fresh evidence and assess again. Never replay a stale verdict. |
| Validation error | Correct the named candidate against the actual contract. |
| Provider `content_filter` | Record that actual provider failure and retain completed work; do not relabel it as context exhaustion or loop on smaller batches. |
| Permission failure | Preserve the handoff and report the missing authority. |

Observe review coverage from the server:

```text
node <workflow> task status TASK_ID --state <task-state> --profile <translator> --restart
node <workflow> task status TASK_ID --state <task-state> --profile <translator>
```

Each invocation scans up to four pages and checkpoints. Repeat without `--restart`
until `complete:true`. Counts distinguish accepted values, intentional blanks,
rejected, pending review and missing candidates. `allLatestReviewed` requires every
target to have an accepted latest revision. Results carry observation times; a
multi-page scan is not an atomic release-readiness assertion. Rescan after changes.

Account for every requested key/locale pair across tasks. Report proposed,
recorded-reviewed, finalized, delivered and activated states precisely. For new
locales, finalize through the [proposal lifecycle](translation-api.md#new-locale-translation-task):
the server validates the complete artifact again. The Repository Adapter verifies
delivered bytes and runtime integration. A ready artifact alone does not mean
devices select the locale or that a release has shipped.
