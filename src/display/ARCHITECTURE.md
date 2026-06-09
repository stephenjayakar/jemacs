# Display architecture

## The three layers

```
Editor ──► LogicalModel ──► (host-specific layout) ──► pixels/cells
            logical.ts       char-grid-layout.ts   →  opentui-host.ts
                             web-layout.ts         →  dom-frame.ts
                             (canvas-layout.ts)    →  (canvas host)
```

**Layer 1 — `Editor`.** Kernel state: buffers, point/mark, window tree, modes,
font-lock. Knows nothing about rows, columns, or pixels.

**Layer 2 — `LogicalModel`** (`logical.ts:69`). Viewport-independent snapshot:
each leaf becomes a `LogicalPane` with raw `text`, `displayText` (post
display-filter), buffer-absolute `spans`, `point`/`mark`, the window tree
shape, and the `theme`. `buildLogicalModel` (`logical.ts:89`) is pure — it
reads `editor` and never wraps a line or counts a column. This is the
hand-off type: every host consumes exactly this.

**Layer 3 — host layout.** One function per host family, each
`LogicalModel → whatever that host paints`:

- **char-grid** — `layoutCharGrid` (`char-grid-layout.ts:21`). Splits row/col
  budgets across the tree (`:46`), hard-wraps display text at `wrapCols` via
  `wrapBodyRows` (`display-wrap.ts:72`), inserts the █ cursor glyph, slices to
  the visible region. Output is `DisplayModel` (`protocol.ts:48`). OpenTUI
  consumes it verbatim (`opentui-host.ts:96`); Electron consumes it through
  `serializeDisplayModel`.
- **web/DOM** — `webLayout` (`web-layout.ts:19`). No wrapping at all: ships
  the whole themed buffer as `body`, ships `cursor:{row,colOffset}` instead
  of a glyph (`:67`), and lets the browser do line-breaking with
  `white-space: pre-wrap` and a positioned caret (`dom-frame.ts:58`).
- **canvas / 3D** — not built yet; see below.

`buildDisplayModel` (`build-display-model.ts:24`) is now just a shim for
char-grid hosts: editor side-effects (geometry write-back, startLine sync) +
`buildLogicalModel` → `layoutCharGrid`. The web host bypasses it entirely
(`web/host.ts:114`).

## Why the old `buildDisplayModel` caused the markdown jank

Before the split, `buildDisplayModel` was the only path and it *always* ran
char-grid wrapping — `wrapBodyRows` at a monospace column count — before any
host saw the text. That's correct for a terminal. For a `perFaceFonts` host
it's wrong twice over:

1. Markdown faces carry `family`/`height`/`heightScale` (`theme-types.ts:9`).
   A `# heading` at 1.6× and a variable-pitch body paragraph have different
   glyph widths, but `wrapBodyRows` counts characters. So the wrap point was
   wrong and the host re-flowed it anyway → double-wrap, visible jitter on
   every keystroke.
2. The █ cursor glyph was baked into the body text. With proportional fonts
   the █ doesn't sit where the real caret would, and it shifts the rest of
   the line.

We patched around (1) with `computeLineVisualRows` (`visual-line-height.ts:50`
— estimate px-per-line from face heights and feed that back into the row
budget) but it was always an approximation fighting the host's real layout
engine. The fix is structural: stop wrapping in shared code. `LogicalModel`
carries enough that each host can wrap with its own metrics, and `webLayout`
ships a cursor coordinate instead of a glyph.

## Faces are the cross-host abstraction

A `TextSpan` names a **face** (`"keyword"`, `"markdown-header-1"`) — semantic,
not visual. `resolveFace(face, theme, buffer)` (`runtime/faces.ts`, called
from `theme.ts:35`) walks `defface` registry → theme → buffer-local remaps →
`FaceStyle{fg,bg,bold,italic,family,height,heightScale}`. That's still
host-neutral.

Each host then interprets `FaceStyle` against its own metrics:

| host | what it does with `FaceStyle` |
|---|---|
| OpenTUI | fg/bg/bold/italic → ANSI; `family`/`height` ignored (`capabilities.perFaceFonts: false`, `opentui-host.ts:40`) |
| DOM | every field → `span.style.*` (`dom-frame.ts:30`); browser measures |
| canvas | `family`+`height` → `ctx.font`; `ctx.measureText` for wrap |

So modes and themes stay host-agnostic — they emit faces. Only layer 3 knows
that `height: 180` means 18px in DOM, "ignore" in a terminal, and a `ctx.font`
string on canvas.

## Slotting in canvas / 3D

A canvas host is a third layer-3 function:

```ts
canvasLayout(logical: LogicalModel, ctx: CanvasRenderingContext2D): CanvasFrame
```

Walk `logical.windows`; for each `LogicalPane`, iterate spans → resolve face
→ set `ctx.font` from `family`/`height` → `ctx.measureText(chunk)` to find
the wrap point → emit `{x, y, text, style}` runs. Cursor is a rect at the
measured x of `point` within its line. 3D is the same with z/transform on
top. Nothing upstream of `LogicalModel` changes; `LogicalPane.spans` +
`theme` is the full input.

## Shadow-browser

Today's `WebHost` (`web/host.ts:40`) runs the `Editor` server-side and
pushes `SerializedDisplayModel` frames to a thin browser client. Shadow-browser
inverts that: the **browser runs a real `Editor`** (S, the shadow) and talks to
the authority (A) over a `ShadowLink` — exactly the same op protocol tramp
buffers already use (`shadow/link.ts:9`, `shadow/ops.ts:11`).

- `platform/runtime.ts` is the seam: in the browser, `spawnProcess`/
  `readFileText`/`writeFileText` aren't available, so `compile`, `magit`,
  `save-buffer` etc. route as `{kind:"command", name, args}` to A
  (`shadow/DESIGN.md:34`, `link.ts:62`). Same gate as a tramp `/ssh:` buffer
  with `buffer.link` set.
- Display is purely local: browser-S calls `buildLogicalModel` on its own
  editor and feeds `webLayout` (or `canvasLayout`). No display frames cross
  the wire — only `Splice`/`Point`/`Cmd`/`Ack` ops do.
- Transport is `ws-link.ts` (already exists for the laptop-shadow case);
  `trust:"full"` only on an SSH-auth'd channel, otherwise `"propose"`.

Net: one `Editor` codebase, one face system, N layout functions, and the
shadow protocol is what moves state — never rendered frames.
