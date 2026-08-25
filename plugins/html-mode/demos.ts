/**
 * Built-in HTML demos for `M-x html-demo`.
 *
 * Each one exercises a different part of the translation -- typography, lists, tables,
 * progress bars, inline emphasis -- so they double as a visual regression check on the
 * HTML-to-surface compiler.
 */

export type HtmlDemo = {
  name: string
  description: string
  source: string
}

const ARTICLE = `<!doctype html>
<html>
<head><title>Ignored</title><style>body { color: red }</style></head>
<body>
  <h1>The Rendering Pipeline</h1>
  <p>
    Jemacs compiles HTML into the kernel's <code>WebNodeModel</code> vocabulary
    rather than injecting markup, so a document can never reach the DOM directly.
    Emphasis survives: <strong>bold</strong>, <em>italic</em>, and
    <a href="https://example.com/spec">links carry their href as a tooltip</a>.
  </p>
  <h2>Why translate instead of embed?</h2>
  <blockquote>
    <p>A surface that cannot express arbitrary markup cannot be used to smuggle it.</p>
  </blockquote>
  <h3>Consequences</h3>
  <ul>
    <li>Colours come from your theme, not the page.</li>
    <li>The same document renders as text in the terminal.</li>
    <li>Unknown elements degrade to their text content.</li>
  </ul>
  <hr>
  <p>Entities decode too: &amp; &lt; &gt; &copy; &mdash; &hellip;</p>
</body>
</html>`

const DASHBOARD = `<h1>Build Dashboard</h1>
<h2>Targets</h2>
<table>
  <tr><th>Target</th><th>Status</th><th>Time</th></tr>
  <tr><td>//base:util</td><td>passed</td><td>12s</td></tr>
  <tr><td>//net:client</td><td>passed</td><td>41s</td></tr>
  <tr><td>//storage:index</td><td>FAILED</td><td>88s</td></tr>
  <tr><td>//rpc:server</td><td>passed</td><td>33s</td></tr>
</table>
<h2>Coverage</h2>
<p>Line coverage</p>
<progress value="78" max="100" title="78% lines"></progress>
<p>Branch coverage</p>
<progress value="54" max="100" title="54% branches"></progress>
<p>Doc coverage</p>
<progress value="91" max="100" title="91% documented"></progress>
<h2>Actions</h2>
<button>Rerun failed</button>
<button>Open in review tool</button>
<h2>Notes</h2>
<ol>
  <li>Progress elements become <code>bar</code> nodes.</li>
  <li>Buttons become <code>badge</code> nodes.</li>
  <li>Tables are laid out as aligned rows.</li>
</ol>`

const KITCHEN_SINK = `<h1>h1 heading</h1>
<h2>h2 heading</h2>
<h3>h3 heading</h3>
<h4>h4 heading</h4>
<p>Plain paragraph text with <b>bold</b>, <i>italic</i>, <u>underline</u>,
   <code>inline code</code>, <kbd>C-x C-c</kbd>, <mark>highlight</mark> and
   <del>struck out</del> runs.</p>
<h3>Nested lists</h3>
<ul>
  <li>First level
    <ul><li>Second level</li><li>Also second</li></ul>
  </li>
  <li>Back to first</li>
</ul>
<h3>Preformatted</h3>
<pre>function id(x) {
  return x
}</pre>
<h3>Form controls</h3>
<input placeholder="Search query">
<input type="checkbox" name="recursive">
<h3>Images</h3>
<img src="diagram.png" alt="Architecture diagram">
<h3>Malformed markup is tolerated</h3>
<p>Unclosed bold: <b>still renders
<p>Stray less-than: a < b</p>`

export const HTML_DEMOS: HtmlDemo[] = [
  { name: "article", description: "Prose, headings, quotes and links", source: ARTICLE },
  { name: "dashboard", description: "Tables, progress bars and buttons", source: DASHBOARD },
  { name: "kitchen-sink", description: "Every supported element, including malformed input", source: KITCHEN_SINK },
]

export function htmlDemoIndexText(): string {
  return [
    "HTML demos",
    "==========",
    "",
    "Open one with  M-x html-demo  and pick a name.",
    "C-c C-r toggles between the rendered document and its source.",
    "",
    ...HTML_DEMOS.map(demo => "  " + demo.name.padEnd(14) + " " + demo.description),
    "",
    "How rendering works:",
    "  HTML is parsed and compiled into the kernel's surface vocabulary",
    "  (row / column / text / bar / badge). Plugins cannot emit raw DOM,",
    "  so a document is translated, never embedded.",
    "",
    "Element mapping:",
    "  h1..h6          themed heading text",
    "  p, div, span    text rows (inline runs stay on one line)",
    "  ul, ol, li      bulleted / numbered rows with indent",
    "  blockquote      indented block",
    "  pre             preformatted lines, line breaks preserved",
    "  table           aligned rows with a header rule",
    "  progress/meter  bar node",
    "  button/summary  badge node",
    "  img             badge showing the alt text",
    "  a               link-faced text, href kept as a tooltip",
    "  script/style    dropped",
    "",
    "M-x html-render-to-text shows the plain-text projection,",
    "which is exactly what the terminal displays.",
  ].join("\n")
}
