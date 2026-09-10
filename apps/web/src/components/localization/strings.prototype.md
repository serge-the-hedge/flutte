# Strings UI prototype — throwaway branch only

Question: how can long copy stay readable without losing the string list, and how should overlapping tags support whole-group export?

Run `bun run prototype:strings`; open http://localhost:3015/projects/prototype/strings?variant=A. Switch A/B/C using the bottom arrows or left/right keys outside editors. Toggle example groups to try strings shared by App Store and Google Play. “State” shows the active filters and selection. Edits are memory-only; downloads are marked prototype.

The original three layouts were rejected. Revised A keeps the list and short-value inline editing. Each value is clipped to three rendered lines; only overflowing values get a small expand icon and open a focused, single-value editor. This opening behavior is still a proposal. B/C remain available as rejected comparisons; the original A is preserved in git history. Overlapping tags remain confirmed.

The same components can be rendered on a signed-in Basic project's existing Strings route with `?variant=A|B|C` in development. The one-command fixture runner uses the same project shell and route shape without authentication or network reads. It uses checked-in examples unless the ignored `strings.prototype.local.json` is present. That local file holds a read-only Marketing snapshot, without credentials.

This branch is the design source. Rewrite the chosen behavior for production and leave the variant machinery here.
