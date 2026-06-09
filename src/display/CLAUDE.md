# src/display/

Pure render: `Editor` → `LogicalModel` → `DisplayModel`. Hosts (`src/ui/`) consume `DisplayModel` (char-grid hosts) or `LogicalModel` (hosts that own their own layout); they never read `Editor` directly.

| file | what |
|---|---|
| `protocol.ts` | `DisplayModel`, `WindowDisplayNode`, `UiHost` — the contract a char-grid host implements |
| `logical.ts` | `LogicalModel`, `LogicalPane`, `buildLogicalModel(editor)` — viewport-independent: text, spans, point/mark, modeline, theme. No row wrapping. |
| `char-grid-layout.ts` | `layoutCharGrid(logical, viewport)` — wrap/gutter/cursor/row-slice onto a fixed cell grid |
| `build-display-model.ts` | `buildDisplayModel(editor, {viewport})` — shim: editor side-effects (viewport persist, body-geometry hook, startLine write-back) + `buildLogicalModel` → `layoutCharGrid` |
| `buffer-view.ts` | `styledRegion` — text + spans → `ThemedText`; handles cursor insertion, line numbers, region |
| `themed-text.ts`, `theme.ts` | `ThemedText{chunks}`, face → fg/bg/bold |
| `viewport.ts`, `click-to-point.ts` | scroll math, cell→point |

`buildLogicalModel` and `layoutCharGrid` must be pure (no `editor` mutation). All editor mutation lives in the `buildDisplayModel` shim. Test at layer 2 via `test/harness/display.ts`.
