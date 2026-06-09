# Emacs Parity Plan

Goal: every implemented GNU Emacs-named command should match GNU Emacs name-by-name for the behavior Jemacs claims to implement. Non-GNU compatibility helpers may remain, but they should be documented as Jemacs extensions or renamed away from misleading GNU names.

Current branch for this work: `main`.

## Recently Completed On This Branch

- Prefix and boundary parity for core motion/edit commands:
  - `forward-char`, `backward-char`
  - `next-line`, `previous-line`
  - `move-end-of-line`
  - `beginning-of-buffer`, `end-of-buffer` inactive/active mark side effects with numeric prefixes
  - `forward-word`, `backward-word`
  - `newline`
  - `self-insert-command`
  - `goto-line`
  - `kill-line` plain end-of-buffer error behavior versus explicit numeric-prefix no-op
  - `set-mark-command` double-universal prefix and repeat-pop local/global mark behavior
  - `yank` numeric/zero/negative prefix kill-ring selection
  - `yank-pop` numeric/negative prefix rotation and stale-yank guard
  - `quoted-insert` repeat prefixes, quoted control-key insertion, and numeric character-code input via `read-quoted-char-radix`
- Buffer/window/tab prefix parity:
  - `next-buffer`, `previous-buffer`
  - `other-window`
  - `previous-window-any-frame`; non-GNU `other-window-backward` renamed to `jemacs-other-window-backward`
  - `recenter-top-bottom`
  - `scroll-other-window`, `scroll-other-window-down`
  - `quit-window`
  - `list-buffers`
  - `tab-bar-new-tab`, `tab-bar-close-tab`, tab switching commands
- Editing parity already covered by tests for:
  - `delete-char`, `delete-backward-char`
  - `open-line`
  - `transpose-chars`, `transpose-lines`, `transpose-words`
  - `mark-whole-buffer`, `mark-paragraph`
  - kill/copy/yank basics and active-region deletion
- Non-GNU convenience aliases renamed under `jemacs-*`:
  - `redo` -> `jemacs-redo`
  - `python-beginning-of-defun` / `python-end-of-defun` -> `jemacs-python-beginning-of-defun` / `jemacs-python-end-of-defun`
  - `dired-unmark-all` -> `jemacs-dired-unmark-all`
  - `bookmark-list` -> `jemacs-bookmark-list`
  - `lsp-find-references` -> `jemacs-lsp-find-references`
  - `clear-mark` -> `jemacs-clear-mark`; GNU `deactivate-mark` added
  - `toggle-transient-mark-mode` -> `jemacs-toggle-transient-mark-mode`; GNU `transient-mark-mode` added
  - `dired-toggle-mark` -> `jemacs-dired-toggle-mark`
  - `buffer-list-select` -> GNU `Buffer-menu-select`
  - `toggle-window-dedicated` -> `jemacs-toggle-window-dedicated`
  - `copy-region-to-clipboard-mac` -> `jemacs-copy-region-to-clipboard-mac`
  - `bookmark-import-from-emacs` -> `jemacs-bookmark-import-from-emacs`
  - `clear-whitespace-and-newline-and-indent` -> `jemacs-clear-whitespace-and-newline-and-indent`
  - `find-definition` -> `jemacs-find-definition`
  - `revert-function` -> `jemacs-revert-function`
  - `revert-definition` -> `jemacs-revert-definition`
  - `revert-all-definitions` -> `jemacs-revert-all-definitions`
  - `org-next-heading` / `org-previous-heading` -> `org-next-visible-heading` / `org-previous-visible-heading`

## Missing Or Incomplete Parity Work

### 1. Audit Every Implemented Command Name

- Generate the complete list of `editor.command(...)` registrations from `lisp/`, `plugins/`, `src/modes/`, and user-loaded package surfaces.
- For each command, classify it as:
  - GNU Emacs command with expected parity.
  - Third-party package command, such as Magit/Markdown/Org-style commands, with upstream package parity expectations.
  - Jemacs-only extension that should be clearly documented or renamed.
- For every GNU-named command, compare:
  - Interactive prefix semantics.
  - Programmatic return value.
  - Point/mark side effects.
  - Error/boundary behavior.
  - Buffer/window selection behavior.
  - Prompt defaults and history names.
  - Keybindings where Jemacs advertises GNU defaults.

### 2. Core Motion And Editing Gaps

- `move-beginning-of-line`
  - Verify all prefix cases against GNU Emacs, including before/after-buffer clamping and field/minibuffer prompt boundaries.
- `beginning-of-buffer`, `end-of-buffer`
  - Fractional prefix behavior and active/inactive mark side effects are covered.
  - Remaining audit: exact messages, mark ring interaction, narrowing, and field boundaries.
- `set-mark-command`
  - Double-universal prefix behavior and `set-mark-command-repeat-pop` local/global repeat behavior are covered.
  - Remaining audit: transient-mark-mode-off temporary activation, exact command-loop state, messages, and full mark/global-mark ring edge cases.
- `exchange-point-and-mark`
  - Covered for basic prefix behavior, but still needs mark ring and transient-mark-mode audit.
- `kill-line`
  - Covered for several prefix cases, blank-tail newline behavior, consecutive kill append, and plain end-of-buffer error behavior.
  - Remaining audit: read-only buffers, invisible text, field boundaries, and exact kill-ring append semantics across all kill commands.
- `kill-word`, `backward-kill-word`
  - Unicode-aware behavior exists, but exact syntax-table and subword interactions are incomplete.
- `yank`, `yank-pop`
  - `yank` now honors numeric, zero, and negative prefix kill-ring selection.
  - `yank-pop` now honors numeric and negative prefix rotation and no longer replaces stale yank ranges after unrelated commands.
  - Remaining audit: plain `C-u C-y` behavior blocked by raw-prefix representation, full `yank-from-kill-ring` prompt behavior after non-yank commands, rotation messages, and text property/yank-handler behavior.
- Rectangle commands
  - Implemented commands need complete audit for prefix args, register behavior, padding, tabs, and error cases.
- Region case commands such as `downcase-region`
  - Need full point/mark preservation and read-only/error parity audit.
- `quoted-insert`
  - Repeat prefixes, quoted control-key insertion, and octal/decimal/hex `read-quoted-char-radix` character-code input are covered.
  - Remaining audit: overwrite modes, minibuffer behavior beyond basic insertion, invalid-code errors, and Unicode input parity.

### 3. Search And Replace Gaps

- `isearch-forward`, `isearch-backward`
  - Literal search exists, but GNU isearch has extensive state behavior still missing: repeat search, direction toggles, failed search recovery, lazy highlight, word/symbol search variants, and full keymap behavior.
- `query-replace`, `replace-string`
  - Need exact prompt flow, region restriction, word-boundary options, case-fold/case-replace behavior, undo grouping, and replacement commands.
- Regexp isearch plugin
  - Needs direct comparison to GNU `isearch-forward-regexp` / `isearch-backward-regexp`.

### 4. File And Buffer Command Gaps

- `find-file`, `find-file-read-only`, `find-alternate-file`
  - Existing behavior is useful but not complete: wildcards, symlinks/truename behavior, remote paths, backup/autosave interactions, file-local variables, hooks, and exact prompt defaults need audit.
- `save-buffer`, `write-file`, `save-some-buffers`, `save-buffers-kill-terminal`
  - Need complete GNU confirmation, hooks, backup, autosave, modified flag, and return/message behavior.
- `kill-buffer`
  - Existing modified-buffer prompting exists; needs complete GNU handling for process buffers, unsaved buffers, buffer query functions, hooks, and fallback display behavior.
- `revert-buffer`
  - Needs exact `noconfirm`, auto-revert, file/directory buffer, and dirty-buffer behavior.
- `switch-to-buffer`, `switch-to-buffer-other-window`, `display-buffer`, `pop-to-buffer`
  - Need full display action and buffer selection semantics.
  - `display-buffer-other-window` has been renamed to `jemacs-display-buffer-other-window` because it is not a GNU function in current local Emacs.
- `list-buffers`
  - Prefix files-only behavior is covered; remaining GNU Buffer Menu columns, marks, sorting, and hidden-buffer behavior are incomplete.

### 5. Window And Tab Command Gaps

- `split-window`, `split-window-below`, `split-window-right`
  - Current window tree has no real size model, so SIZE prefix behavior and return values are incomplete.
- `delete-window`, `delete-other-windows`
  - Need GNU return values, dedicated/side/atomic window behavior, and error handling audit.
- `other-window`, `next-window-any-frame`, `previous-window-any-frame`
  - Basic prefix behavior exists, but frame/all-frames/minibuffer/window-parameter semantics are incomplete.
- `quit-window`
  - Prefix kill behavior is covered, but full bury/quit-restore behavior is incomplete.
- `scroll-up-command`, `scroll-down-command`
  - Existing tests cover page and numeric scrolling; still need full `scroll-error-top-bottom`, visual-line, window-start, and boundary behavior audit.
- `recenter-top-bottom`
  - Numeric behavior exists, but plain `C-u` cannot be distinguished from numeric `4` in the current prefix representation. This blocks exact GNU `C-u C-l` behavior until prefix raw-shape is represented.
- Tab bar commands
  - Prefix behavior for new/close/switch is improved, but full GNU tab objects, tab names, window configurations, tab history, and last-tab errors are incomplete.

### 6. Dired Gaps

- Existing Dired supports opening, marking, unmarking, copy/rename/delete basics.
- Missing/incomplete:
  - Exact mark characters and mark command semantics.
  - `dired-do-delete`, `dired-do-copy`, `dired-do-rename` prompts and confirmation flow.
  - Recursive directory operations.
  - Symlink, permission, owner/group/date formatting.
  - `dired-jump`, `dired-up-directory`, revert, and sorting behavior compared with GNU Dired.
  - Wdired parity for validation, abort, finish, and unchanged rows.

### 7. Help, Describe, Customize, And Eval Gaps

- `describe-key`, `describe-bindings`, `describe-function`, `describe-variable`
  - Need exact buffer names, formatting, links/buttons, keymap precedence, and help window behavior.
- `apropos-command`
  - Needs full matching and display semantics.
- `eval-region`, `eval-last-sexp`, `eval-expression`
  - JavaScript/TypeScript evaluator is intentionally not Elisp; document scope clearly and align command UI, errors, mark/point, and output buffers where GNU names are reused.
- Customize commands
  - Many command names exist; need full audit of prompt behavior, saved/unsaved/rogue listings, face/theme behavior, and custom-file persistence.

### 8. Registers And Bookmarks

- Registers:
  - Text, rectangle, point, number, and window-configuration support need full GNU return/message/error parity.
  - `insert-register`, `copy-to-register`, `append-to-register`, `prepend-to-register`, `number-to-register`, `increment-register`, `view-register`, `list-registers` need command-by-command audit.
- Bookmarks:
  - Basic set/jump/list/delete exists.
  - Need exact bookmark file format compatibility, annotations, handlers, relocation, bmenu behavior, and prompt/default semantics.

### 9. Project, Xref, Compile, Grep, Flymake, LSP

- Project commands:
  - Need compare with GNU `project.el` for roots, prompts, buffer selection, project switching, compile integration, and VC behavior.
- Xref commands:
  - Need exact `xref-find-references`, navigation, marker stack, and results buffer behavior.
- Compile/grep/next-error:
  - Need full compilation-mode buffer semantics, command history, process lifecycle, next-error ring behavior, and error regex coverage.
- Flymake/LSP:
  - Implementations are useful but not GNU/Flymake/LSP package complete. Audit command names and document unsupported behavior.

### 10. Major/Minor Mode Package Gaps

- Python/C/JSON/Java modes:
  - Font-lock exists, but indentation, syntax tables, comments, imenu, defun movement, and local keymaps need full parity audits.
- Org/Markdown:
  - Implemented commands should be compared to upstream package command names and behavior, especially movement, promotion/demotion, TODO cycling, link following, and insertion commands.
- Magit:
  - Many command names exist; they need explicit Magit parity classification. Some may be intentionally simplified and should be documented as such.
- Terminal/shell commands:
  - `term`, `shell`, `term-char-mode`, `term-line-mode` and jterm commands need exact naming and behavior classification versus GNU term/shell.
- Minor modes:
  - `global-auto-revert-mode`, `eldoc-mode`, `which-key-mode`, `subword-mode`, `smerge-mode`, `show-paren-mode`, `completion-preview-mode`, etc. need prefix semantics, lighter behavior, hooks, buffer-local/global behavior, and command names audited.

### 11. Prefix Argument Architecture

- Current `CommandContext.prefixArgument` preserves only the numeric value.
- Missing raw prefix shape:
  - Plain `C-u`
  - Repeated `C-u`
  - `M--`
  - Digit prefixes
  - Explicit zero
- This blocks exact parity for commands whose behavior depends on raw prefix form, not just numeric value.
- Add a richer prefix object while preserving existing `prefixArgument` for simple commands.

### 12. Return Values And Error Model

- Many commands currently return `undefined` even where GNU returns:
  - Moved buffer/window object.
  - `t`/`nil`.
  - Killed buffer.
  - Register/bookmark data.
- Many command errors are currently echo messages rather than thrown/user-error equivalents.
- Need a command-by-command return/error audit and a consistent representation of GNU `user-error` versus hard errors.

### 13. Keybinding Audit

- Verify GNU default bindings in `src/config/default-bindings.ts` and `lisp/*`.
- Decide whether non-GNU convenience bindings belong in default config, Stephen config, or packages:
  - `C-c` custom bindings.
  - Project/package-specific bindings.
  - Compatibility aliases that GNU does not define.
- Ensure user config overrides remain in `jemacs-stephen-config`, not upstream defaults.

### 14. Verification Work Still Needed

- Build a script that:
  - Extracts all Jemacs command names.
  - Uses local GNU Emacs to report whether each name is `fboundp`.
  - Captures GNU docstrings and interactive specs.
  - Produces a parity matrix with status and test coverage.
- Add per-command probe tests for behavior that is easy to compare against local GNU Emacs.
- Keep using focused regression tests for each fixed command.
- Keep a broad regression suite for touched subsystems.

## Known Current Verification Issues

- `npx bun test` focused and broad parity suites used during this work pass.
- `git diff --check` passes after recent parity commits.
- `npx bun run check` currently fails in unrelated existing TypeScript areas:
  - LSP protocol generated/export type mismatches.
  - `plugins/lsp-watchman` stream async iterator typing.
  - `plugins/term-v2` xterm option typing.
  - Shadow stdout/null and Buffer ArrayBufferView typing.
  - `src/ui/opentui-host.ts` OpenTUI `KeyHandler`/`TextareaOptions` typings.
  - Older test typing issues.
  - `../jemacs-packages/projectile` import path/type resolution.

These typecheck failures should be fixed separately so future parity work can use `bun run check` as a hard gate again.

## Working Rules For Remaining Parity Work

- Make changes on `emacs-parity-goal` or another named branch, never directly on `main`.
- For each command:
  - Read current Jemacs implementation.
  - Check GNU Emacs docstring with local `emacs --batch`.
  - Probe ambiguous edge cases in local GNU Emacs.
  - Patch the smallest subsystem that owns the behavior.
  - Add focused tests covering the probed behavior.
  - Run focused tests, a relevant broader regression set, and `git diff --check`.
  - Commit and push before moving to the next command.
- Leave unrelated untracked files, such as `.agents/`, untouched.
