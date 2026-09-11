---
name: blabla-translate
description: Author Basic project source strings, translate or correct Blabla task messages, or manage assigned languages. Submit translations as immutable candidates for human or independently authorized agent review.
---

# Author strings and propose translations

Work through Translation Tasks and report candidates as **proposed** until
recorded review establishes otherwise.

For an assignment to add or edit languages, follow [language management](../_blabla/references/languages-api.md)
with `languages-write`. Verify the resulting language metadata before creating
translation tasks; a language-only assignment ends after that verification.

For an assignment to author Basic source strings, use
[Create strings](../_blabla/references/collection-api.md#create-strings) with
`strings-write`. Record the returned stable key and source revision as the
creation acknowledgement. Source-only assignments end there; translate the new identities through the steps below only
when requested. Repository source authoring stays in its source checkout.

1. Read [transport](../_blabla/references/transport.md). Use the assigned
   translation credential and discover the project. It needs `read`, `search`,
   and `propose` for translation with example lookup. Keep reviewer credentials
   exclusively with a separate reviewer agent. Discovery’s `agentReview.enabled`
   states project-wide permission; when false, independent review needs explicit
   human delegation for the exact revisions. Plan that handoff without treating
   review permission as a restriction on translation scope.
2. Establish the requested keys and languages before choosing tasks. For “all
   existing languages,” use discovered `locales` excluding `sourceLocale`.
   For specified languages, verify each against discovery; new repository
   languages use `capabilities.newLocaleTargets`. An explicitly assigned task
   keeps its own scope. If a broad translation assignment omits languages, use
   all existing target languages and state that scope.
3. Resume matching tasks from the [task inbox](../_blabla/references/translation-api.md#get-translation-tasks)
   and create tasks for uncovered scope through
   [task creation](../_blabla/references/translation-api.md#post-translation-tasks).
   The inbox is token-visible work history, not the project’s language inventory.
   Existing repository and Basic targets need one task per language and at most
   32 keys; configured new repository languages use complete-catalog tasks.
   Track every requested key/language pair across tasks. The server owns the basis.
4. Read one [task page](../_blabla/references/translation-api.md#get-translation-tasksid),
   including Source, current target, applicable guidance, newest candidate, and
   review feedback. For wording questions follow
   [retrieval](../_blabla/references/retrieval.md); new languages can reuse
   authorized reviewed draft examples. Inspect the exact failed revision when
   correcting a rejection. Preserve already reviewed values unless the assignment
   explicitly calls for further edits.
5. Apply the [translation rules](../_blabla/references/translation-api.md#translation-rules)
   to every candidate. Use returned `format`: managed `plain` text treats braces literally; App
   messages preserve their executable contract. Preserve exact
   intentional formatting. Resolve contextual ambiguity from evidence or the
   human's assignment; absent guidance is not invented project policy.
6. Submit up to 16 decisions through
   [task candidates](../_blabla/references/translation-api.md#post-translation-tasksidcandidates).
   Intentional Blanks require a reason. Process the assigned scope page by page;
   a continuation means there is more work even after a short or empty page.
   On stale basis or changed feedback, read and reassess before resubmitting.
7. Report task identities and coverage per language: submitted, already reviewed
   and preserved, or blocked, with remaining cursor/work and unresolved questions.
   Completion requires accounting for every requested key/language pair.
   Hand review to a human or a separately assigned reviewer with its
   own authorized revision context. Submitting a candidate does not change the
   live Workspace, activate a language, or deliver it to Git.

For new-Locale continuation, finalization, and delivery constraints, consult
[Locale Proposal lifecycle](../_blabla/references/translation-api.md#new-locale-translation-task)
only when the task reaches that branch. Repository delivery remains the local
Repository Adapter's workflow.
