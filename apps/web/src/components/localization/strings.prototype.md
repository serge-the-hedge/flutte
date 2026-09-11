# Strings UI prototype — throwaway branch only

Question: how should one advanced view combine string properties and locale editing, while the Strings list stays compact?

Run `bun run prototype:strings`; open http://localhost:3015/projects/prototype/strings?variant=A. Switch A/B/C using the bottom arrows or left/right keys outside editors. All original alternatives have been removed from the active prototype and remain in git history.

- A: compact dialog; Properties on the left of its toolbar, language selector on the right. Plain list with generous separation between strings.
- B: wide side panel with Properties and searchable locale navigation. Subtle cards separate strings in the list.
- C: larger view with collapsible properties above the locale editor. A left rule groups each string's values in the list.

Click a long value to open its locale; click the string name or properties icon to open properties. Short values still edit inline. Text and expand icon are one button. Previews show at most three lines and collapse blank paragraphs to single line breaks; original text remains intact in the editor. Drafts survive switching locales/properties; Save applies the whole advanced-view draft locally, Cancel discards it.

Overlapping tags remain confirmed. The optional example groups exercise App Store/Google Play overlap. State shows filters, selection and the open string/section. Edits are memory-only; downloads are marked prototype.

The same components render on a signed-in Basic project's existing Strings route with `?variant=A|B|C` in development. The fixture runner uses the same project shell and route shape without authentication or network reads. It uses checked-in examples unless the ignored `strings.prototype.local.json` is present. That local file holds a read-only Marketing snapshot, without credentials.

This branch is the design source. No new arrangement has been chosen yet. Rewrite the chosen behavior for production and leave the variant machinery here.
