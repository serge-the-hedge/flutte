---
name: blabla-dictionary
description: Fill or maintain a Blabla project's Dictionary under an explicit terminology assignment. Use for shared definitions, preferred Locale renderings, and untranslatable terms with dictionary-write access.
---

# Maintain the Dictionary

Dictionary writes change active shared guidance directly; they are not proposed
translations. Work within the human's terminology assignment using `read` and
`dictionary-write`. Translation or reviewer access alone does not grant this
permission.

1. Read [transport](../_blabla/references/transport.md) and discover the project's
   Dictionary capability. If access is missing, report the required scope; do not
   switch to another agent's credential.
2. Read the [Dictionary](../_blabla/references/api.md#get-dictionary), including
   its revision and complete entries. Use exact term lookup when adding a Locale
   rendering. Follow continuations to cover an assigned audit.
3. Use [retrieval](../_blabla/references/retrieval.md) where example lookup is
   authorized (`search` scope). Establish each term's meaning from the assignment
   and evidence. Frequency alone is not policy. Keep voice-guide editing with
   the human; the general guide and optional Locale add-ons remain live context.
4. [Save a bounded batch](../_blabla/references/api.md#post-dictionaryterms) with
   the read `expectedRevision`. An existing term is replaced in full: preserve
   its definition and other Locale renderings unless the assignment changes
   them. An untranslatable term has no Locale renderings. Remove a term only when
   removal is part of the assignment.
5. After a conflict or lost response, read again and compare the intended change
   against current entries. Preserve concurrent human/agent work before retrying.
   Report the changed terms, returned revision/citations, and unresolved choices.
