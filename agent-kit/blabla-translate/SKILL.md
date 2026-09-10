---
name: blabla-translate
description: Translate or correct Blabla task messages and prepare new languages. Add or edit languages under an explicit setup assignment, and submit immutable candidates for human or independently authorized agent review.
---

# Propose translations

Work through Translation Tasks and report candidates as **proposed** until
recorded review establishes otherwise.

For an assignment to add or edit languages, follow [language management](../_blabla/references/languages-api.md)
with `languages-write`. Verify the resulting language metadata before creating
translation tasks; a language-only assignment ends after that verification.

1. Read [transport](../_blabla/references/transport.md). Use the assigned
   translation credential and discover the project. It needs `read`, `search`,
   and `propose` for translation with example lookup. Keep reviewer credentials
   exclusively with a separate reviewer agent.
2. Resume the assigned task. If the assignment requires a new task, read
   [task creation](../_blabla/references/translation-api.md#post-translation-tasks): existing
   repository and Basic
   projects use project-scoped selected message ids; a configured new Locale uses the complete
   catalog scope. The server owns the task's basis.
3. Read one [task page](../_blabla/references/translation-api.md#get-translation-tasksid),
   including Source, current target, applicable guidance, newest candidate, and
   review feedback. For wording questions follow
   [retrieval](../_blabla/references/retrieval.md); new languages can reuse
   authorized reviewed draft examples. Inspect the exact failed revision when
   correcting a rejection. Preserve already reviewed values unless the assignment
   explicitly calls for further edits.
4. Apply the [translation rules](../_blabla/references/translation-api.md#translation-rules)
   to every candidate. Use returned `format`: managed `plain` text treats braces literally; App
   messages preserve their executable contract. Preserve exact
   intentional formatting. Resolve contextual ambiguity from evidence or the
   human's assignment; absent guidance is not invented project policy.
5. Submit up to 16 decisions through
   [task candidates](../_blabla/references/translation-api.md#post-translation-tasksidcandidates).
   Intentional Blanks require a reason. Process the assigned scope page by page;
   a continuation means there is more work even after a short or empty page.
   On stale basis or changed feedback, read and reassess before resubmitting.
6. Report the task identity, submitted scope, remaining cursor/work, and unresolved
   questions, including intentionally preserved casing, spacing, or punctuation.
   Hand review to a human or a separately assigned reviewer with its
   own authorized revision context. Submitting a candidate does not change the
   live Workspace, activate a language, or deliver it to Git.

For new-Locale continuation, finalization, and delivery constraints, consult
[Locale Proposal lifecycle](../_blabla/references/translation-api.md#new-locale-translation-task)
only when the task reaches that branch. Repository delivery remains the local
Repository Adapter's workflow.
