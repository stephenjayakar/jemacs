/**
 * Built-in canvas demos, reachable with `M-x canvas-demo`.
 *
 * Each demo is literal drawing-language source rather than generated shapes: opening one
 * gives an editable, self-documenting example, which is the point of a text-backed
 * drawing format.
 */

export type CanvasDemo = {
  name: string
  description: string
  /** Whether the drawing uses `{t}` and is worth animating with C-c C-a. */
  animated: boolean
  source: string
}

const SINE = `# Animated sine wave. Press C-c C-a to start/stop animation.
aspect 2.4
face comment
line 0.05 0.5 0.95 0.5
line 0.05 0.12 0.05 0.88

face keyword
plot 0.05 0.12 0.9 0.76 {sin(t)} {sin(t+0.4)} {sin(t+0.8)} {sin(t+1.2)} {sin(t+1.6)} {sin(t+2)} {sin(t+2.4)} {sin(t+2.8)} {sin(t+3.2)} {sin(t+3.6)} {sin(t+4)} {sin(t+4.4)} {sin(t+4.8)} {sin(t+5.2)} {sin(t+5.6)} {sin(t+6)} {sin(t+6.4)} {sin(t+6.8)}

face string
plot 0.05 0.12 0.9 0.76 {cos(t)} {cos(t+0.4)} {cos(t+0.8)} {cos(t+1.2)} {cos(t+1.6)} {cos(t+2)} {cos(t+2.4)} {cos(t+2.8)} {cos(t+3.2)} {cos(t+3.6)} {cos(t+4)} {cos(t+4.4)} {cos(t+4.8)} {cos(t+5.2)} {cos(t+5.6)} {cos(t+6)} {cos(t+6.4)} {cos(t+6.8)}

face default
text 0.05 0.07 sin (yellow) and cos (green), phase-shifted by t = {t}
`

const ORBITS = `# Planets on circular orbits. C-c C-a to run.
aspect 1.6
face comment
circle 0.5 0.5 0.12
circle 0.5 0.5 0.22
circle 0.5 0.5 0.34

# The sun.
face warning
circle 0.5 0.5 0.03

# Each planet is a small circle placed by polar coordinates.
face keyword
circle {0.5+0.075*cos(t*2)} {0.5+0.12*sin(t*2)} 0.018

face string
circle {0.5+0.1375*cos(t*1.3)} {0.5+0.22*sin(t*1.3)} 0.022

face error
circle {0.5+0.2125*cos(t*0.8)} {0.5+0.34*sin(t*0.8)} 0.016

face default
text 0.03 0.06 Three bodies, angular velocity 2.0 / 1.3 / 0.8
`

const BARS = `# Static bar chart -- the shape of a build profile.
aspect 2.2
face comment
line 0.08 0.85 0.96 0.85

face keyword
bars 0.08 0.15 0.88 0.7 34 52 88 41 63 97 72 55 29 81 46 68

face default
text 0.08 0.1 Compile time per target (bars auto-scale to the largest value)
text 0.08 0.94 //base  //net  //storage  //rpc  //util  //server  //client
`

const BOUNCE = `# A ball bouncing in a box, using abs() to fold the motion.
aspect 2
face comment
rect 0.05 0.05 0.9 0.9 stroke

face error
circle {0.1+0.8*abs(sin(t*0.7))} {0.12+0.76*abs(sin(t*1.1))} 0.04

face default
text 0.07 0.03 abs(sin) gives a cheap triangle-ish bounce
`

const GRID = `# A perspective-ish grid: pure geometry, no animation.
aspect 2
face comment
line 0.0 0.75 1.0 0.75
poly 0.5 0.3 0.0 1.0
poly 0.5 0.3 0.16 1.0
poly 0.5 0.3 0.33 1.0
poly 0.5 0.3 0.5 1.0
poly 0.5 0.3 0.66 1.0
poly 0.5 0.3 0.83 1.0
poly 0.5 0.3 1.0 1.0
line 0.0 0.8 1.0 0.8
line 0.0 0.86 1.0 0.86
line 0.0 0.93 1.0 0.93
line 0.0 1.0 1.0 1.0

face keyword
circle 0.5 0.3 0.06

face default
text 0.03 0.12 Vanishing point at (0.5, 0.3)
`

export const DEMOS: CanvasDemo[] = [
  { name: "sine", description: "Animated sine/cosine plot", animated: true, source: SINE },
  { name: "orbits", description: "Three planets on circular orbits", animated: true, source: ORBITS },
  { name: "bounce", description: "A ball bouncing in a box", animated: true, source: BOUNCE },
  { name: "bars", description: "Bar chart of per-target build times", animated: false, source: BARS },
  { name: "grid", description: "Perspective grid geometry", animated: false, source: GRID },
]

/** Human-readable index for `M-x canvas-demos`. */
export function demoIndexText(): string {
  const rows = DEMOS.map(demo => {
    const marker = demo.animated ? " (animated)" : ""
    return `  ${demo.name.padEnd(8)} ${demo.description}${marker}`
  })
  return [
    "Canvas demos",
    "============",
    "",
    "Open one with  M-x canvas-demo  and pick a name.",
    "Animated demos start with C-c C-a.",
    "",
    ...rows,
    "",
    "Drawing language (one command per line):",
    "  aspect <ratio>            canvas width / height",
    "  face   <face-name>        colour for following shapes",
    "  rect   x y w h [stroke]   filled unless 'stroke'",
    "  line   x1 y1 x2 y2",
    "  poly   x1 y1 x2 y2 ...    open polyline",
    "  circle cx cy r",
    "  text   x y caption",
    "  plot   x y w h v1 v2 ...  auto-scaled line chart",
    "  bars   x y w h v1 v2 ...  auto-scaled bar chart",
    "",
    "Coordinates are 0..1 fractions of the canvas box.",
    "{...} interpolates arithmetic over the animation clock t,",
    "e.g. {0.5+0.2*sin(t)}; sin, cos, abs and sqrt are available.",
    "",
    "The canvas renders in the Electron GUI (jemacs --gui).",
    "In the terminal the buffer stays plain, editable text.",
  ].join("\n")
}
