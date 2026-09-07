# Independent agent review

Human review is the default. A Reviewer Agent may accept or reject another
agent's exact Candidate Value revision only when a human has authorized agent
review. Translation and review remain separate assignments.

## Enablement

There are two alternatives:

- A project owner enables **Agent review** in project settings. This permits
  independent reviewer credentials to review candidates throughout that project.
- An editor delegates one exact candidate revision to a named reviewer in the
  review workbench. This works while the project setting is off and does not
  authorize future revisions or other candidates.

Owners create a dedicated **Reviewer** API token in project settings with
`read`, `search`, and `review` scopes. Its `review` scope cannot be combined with
translation, snapshot-submission, or delivery scopes. Assign it to a separate agent; keep the translator's credential
with the translator. The server rejects self-review using authenticated token
identities. Credential separation is enforceable; the server cannot inspect
which process or model operates a credential. Giving both credentials to the
same agent violates this workflow.

Disable the project setting to stop future reviews authorized by that setting.
Revoke a per-revision delegation to stop that delegation; it does not override
an enabled project setting. Revoke the reviewer token to stop all of its future
access. These decisions belong to the project: changing the granting human's
role does not revoke them; use the explicit controls above. Completed reviews retain their historical authority and continue to
count as evidence after permission is withdrawn.

## Review contract

The human supplies the reviewer with the exact candidate revision's review URL.
The [Agent API](agent-api.md) returns bounded Source, current target, and candidate
context, together with an opaque review token. The reviewer must inspect that
context and submit its decision with the token it received. The same credential
can search the Catalog Workspace and read related message context to assess
terminology and established wording. Search access does not extend review
authorization to other candidates. Applicable Dictionary terms and voice guides
are included once in review context and bound into its review token; their text
indexes refer to the single Source value. Immutable guidance citations remain
readable after later edits or removal. For new-Locale consistency, use
`POST /proposal-examples/search` with the authorized revision as its review scope
to read reviewed draft examples without accessing the translating credential.
Existing reviewer credentials created without
`search` need a replacement token to use search; token scopes are immutable.
Once reviewed, the same URL returns a recorded result instead of editable
context. This recovers a
lost response even after a later revision or finalization, while current access
is still checked.

Agent acceptance applies the exact candidate bytes, including an existing
Intentional Blank reason. It cannot edit the candidate, keep it against a newer
Source Contract, finalize a Locale Proposal, build a Release Bundle, or deliver
to Git. Corrections require a new translation revision and a new review.

The server checks the candidate revision, Source and target basis, latest review,
reviewer identity, and current permission again in the write transaction. A
changed catalog value, staged new-Locale value, Source, candidate, guidance, or authority
invalidates the read token. The reviewer must read and assess the new context;
it must not blindly retry an earlier verdict against new facts.

## Evidence

Every agent review records the actual reviewer token identity and the authorizing
human decision: the project policy revision or the exact per-candidate grant.
Acceptance carries this provenance into the applied value and its confirmation
or blank decision. It never labels the agent as the granting human.

Authorized exact acceptance can complete a target Locale's First Review and
produce a Translator Confirmation. Reviewed new-Locale values can finalize and
carry forward through the existing human workflow. Ordinary agent submissions,
rejections, and ordinary-import batches do not acquire these powers.

This permission is separate from the reserved **Translation Review Mode**,
which would require a second review after a human saves a value. Agent review
does not introduce that additional approval stage.
