# Review API

<a id="independent-review-endpoints"></a>

### `GET /candidate-reviews/:revisionId`

Requires a separate reviewer credential and current human authorization under
[review policy](https://github.com/serge-the-hedge/flutte/blob/main/docs/agent-review.md).

`kind: "candidate"` returns Source, current target, candidate, blank reasons,
basis status, authorization, guidance, and an opaque `reviewToken`. Managed
context includes `collectionId` and `format: "plain"` for independent
[collection evidence](collection-api.md) retrieval.
`kind: "recordedReview"` instead returns `latestReview` (decision, reviewer,
authorization, timestamp, final fingerprint when available), without a token.
With current access, recorded results remain readable after supersession,
target removal, or finalization, allowing lost-response recovery.

### `POST /candidate-reviews/:revisionId`

Requires the same reviewer identity and current authorization:

```json
{ "reviewToken": "<from GET>", "decision": { "kind": "accept" } }
```

Rejection uses `{ "kind": "reject", "reason": "Explain the defect" }` and leaves
the live value unchanged. Acceptance applies exact bytes and any existing blank
reason; edited values cannot be supplied. Changes to Source, target, candidate,
prior review, guidance, or authority invalidate the token. The
[review skill](../../blabla-review/SKILL.md) owns reassessment and recovery steps.
