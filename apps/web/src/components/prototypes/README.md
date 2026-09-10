# Strings provenance and history — throwaway UI study

Question: how should a translator filter current strings by their first accepted
snapshot, and inspect one language's previous values without crowding Strings?

Run from the repository root:

```sh
bun run prototype:strings
```

Open http://127.0.0.1:3017/prototype-strings.html?variant=A.
Use the floating arrows (or left/right keys outside inputs) to compare:

- **A — Picker + inline history:** smallest permanent footprint; expanded history moves later rows down.
- **B — Snapshot rail + history panel:** keeps history alongside the current value; uses more horizontal space.
- **C — Snapshot strip + comparison:** visible dates and a focused earlier/current comparison; history temporarily covers the list.

The same variants mount on the authenticated repository Strings route with
`?variant=A`, `B`, or `C` in development. The standalone entry mirrors its shell
with illustrative data so review needs no login, API calls, or hosted fixtures.
Search, languages, snapshot multi-selection, history, proposal visibility, and
version copying work in memory. Translation editing and focus tabs are scenery.
The prototype state disclosure shows selection and visible keys.

Snapshot choices use sync dates, newest first. Strings keep catalog order and
show current values; this is not a historical snapshot browser. Initial catalog
keys are separate from later introductions. Proposals do not become applied
history until approved; intentionally blank and never-translated values differ.

Implementation needs an explicit original snapshot identity (timestamps cannot
be joined reliably), paginated snapshot choices, and immutable repo value
revisions. Current storage cannot reconstruct every past manual edit; a real
history must identify unavailable older values. Basic target revisions and agent
revisions already retain text. Fixture descriptions and histories are illustrative.

No variant has been selected. Keep this branch out of main; implement the chosen
design with production contracts after feedback.
