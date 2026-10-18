# Critique for Obsidian

Margin comments written by jemacs' `critique-mode`, drawn in Obsidian the way jemacs draws them: a note in the right margin beside the highlighted text. It reads the same syntax and uses the same parser (`plugins/critique/parse.ts`).

| syntax | example | without this plugin |
|---|---|---|
| native (default) | `==highlighted text==%%comment%%` | highlight renders, comment hidden in reading view |
| point comment | `%%comment%%` | hidden in reading view |
| CriticMarkup | `{==text==}{>>comment<<}`, `{>>comment<<}` | needs a CriticMarkup plugin to render (this plugin hides it in Live Preview only) |

Comments are single-line. Obsidian's multi-line `%%` block comments are left alone.

## Features

- **Margin notes** in Live Preview, source mode and reading view. Live Preview hides the comment markup until the cursor enters it, like Obsidian's own formatting. Click a note's text to edit it, `√` to resolve it, `+` to add another comment under it. When the pane is too narrow for a margin, the text column moves in to make room. If that would squeeze it too much, the notes sit inline. Notes already open in reading view pick up the margin the next time they render.
- **Comments panel** (ribbon icon or "Critique: Open comments panel"): lists the active note's comments with the quoted text. Click a card to jump to it. Each card has Edit, Reply and Resolve buttons. Reply adds another comment right after this one; Resolve keeps the text and drops the comment.
- **Critique: Comment on selection**: wraps the selection, or adds a point comment at the cursor.
- **Critique: Go to next / previous comment**.
- A setting picks native or CriticMarkup syntax for new comments.

## Install

```bash
cd integrations/obsidian-critique
npm install
bun run build          # -> main.js
mkdir -p <vault>/.obsidian/plugins/critique
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/critique/
```

Then enable "Critique" under Settings → Community plugins.

## jemacs side

`M-x critique-mode` in a markdown buffer. It turns on by itself when you visit a file that already has comments.

| key | command |
|---|---|
| `C-c ;` | `critique-comment`: comment on region / edit comment at point / point comment. A blank comment on a region (or when editing) leaves just the `==highlight==` |
| `C-c ]` / `C-c [` | next / previous comment |
| `C-c /` | `critique-resolve-comment` |
| `C-c =` | `critique-reply-comment`: add another comment under the one at point |
| `C-c C-x ;` | `critique-toggle-inline-comments`: show or hide the raw markup |
| | `critique-list-comments`: jump with completion |

The margin notes are clickable too: click a note's text to edit it in the minibuffer, `√` to resolve it, `+` to add another comment under it. This works in the terminal (with mouse support) and in the GUI. Notes longer than `right-margin-note-max-lines` (3) end in `…`: click it to expand the note, `▴` to fold it again. The comment at point always shows in full.

Customize with `critique-syntax` (`"obsidian"` or `"critic"`), `critique-margin-width`, `critique-hide-inline-comments` and `critique-auto-enable`.
