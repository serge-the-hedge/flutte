# Project tags

Tags group current strings in Basic and Repository projects. A string can have
several tags. Tag changes preserve source revisions, translation confirmation,
and review evidence; they never edit repository files.

- `GET /tags` (`read`) returns `{items: [{id, name}], revision}`.
- `POST /tags` (`tags-write`) accepts `{name}` and returns the tag ID. Repeating an
  existing name, ignoring case, reuses its ID.
- `GET /workspace/tags` (`read`) accepts repeated `key` parameters (up to 128)
  and returns `[{messageId, tagIds}]`, including empty assignments. It works
  without target languages or translations.
- `PATCH /workspace/tags` (`tags-write`) accepts `{keys, addTagIds?, removeTagIds?}`.
  `keys` are stable message identities, not display names. Addition/removal is
  idempotent and preserves unrelated assignments. A batch is atomic.

A project supports 256 tags, a string 32 tags, and a write 32 distinct keys.
Names contain 1–80 characters. All tags and keys must belong to the credential's
project; archived strings cannot be edited. Reviewer credentials cannot carry
`tags-write`.

Use repeated `tagId` parameters with `GET /workspace/search` to match any selected
tag. With the terminal helper, put `"tagId": ["id1", "id2"]` in query JSON.
Search hits include `tagIds`. Filtered continuations bind the selected IDs and
metadata revision; restart a scan if assignments change. Empty pages may still
have a continuation cursor.

The retired `POST /strings/tags` endpoint remains retired.
