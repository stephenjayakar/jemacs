/**
 * Reading and writing `.dir-locals.el`.
 *
 * The file is an alist `((MODE . ((VAR . VALUE) ...)) ...)`, so `customize-dirlocals`
 * needs just enough of a reader to get those pairs back out and enough of a
 * printer to put them back. This is a reader for that shape specifically, not a
 * general Lisp reader: it handles lists, dotted pairs, strings, numbers,
 * symbols, `t`/`nil`, and quoting.
 */

export type DirlocalsSetting = [string, unknown]
export type DirlocalsSpec = { mode: string; settings: DirlocalsSetting[] }

/** A cons cell read from the file. Lists are arrays; dotted pairs keep `cdr`. */
type Sexp = { car: Sexp | null; cdr: Sexp | null } | Sexp[] | string | number | boolean | null | { sym: string }

function isSymbol(value: unknown): value is { sym: string } {
  return typeof value === "object" && value !== null && "sym" in value
}

function isCons(value: unknown): value is { car: Sexp | null; cdr: Sexp | null } {
  return typeof value === "object" && value !== null && "car" in value
}

class Reader {
  private i = 0
  constructor(private readonly text: string) {}

  /** Skip whitespace and `;` comments. */
  private skip(): void {
    for (;;) {
      while (this.i < this.text.length && /\s/.test(this.text[this.i]!)) this.i++
      if (this.text[this.i] === ";") {
        while (this.i < this.text.length && this.text[this.i] !== "\n") this.i++
        continue
      }
      return
    }
  }

  atEnd(): boolean {
    this.skip()
    return this.i >= this.text.length
  }

  read(): Sexp {
    this.skip()
    const ch = this.text[this.i]
    if (ch === undefined) throw new Error("Unexpected end of dir-locals file")
    if (ch === "'" || ch === "`") { this.i++; return this.read() }
    if (ch === "(") return this.readList()
    if (ch === ")") throw new Error("Unbalanced ) in dir-locals file")
    if (ch === "\"") return this.readString()
    return this.readAtom()
  }

  private readList(): Sexp {
    this.i++ // (
    const items: Sexp[] = []
    let tail: Sexp | null = null
    for (;;) {
      this.skip()
      const ch = this.text[this.i]
      if (ch === undefined) throw new Error("Unterminated list in dir-locals file")
      if (ch === ")") { this.i++; break }
      // A dot followed by a delimiter is the dotted-pair marker.
      if (ch === "." && /[\s()]/.test(this.text[this.i + 1] ?? " ")) {
        this.i++
        tail = this.read()
        this.skip()
        if (this.text[this.i] === ")") this.i++
        break
      }
      items.push(this.read())
    }
    if (tail === null) return items
    // `(a . b)` — one element plus a tail — is a cons cell.
    if (items.length === 1) return { car: items[0]!, cdr: tail }
    // `(a b . c)` degenerates to a list whose last cons has that tail; the
    // shapes dir-locals uses never need more than the simple case.
    return { car: items[0]!, cdr: tail }
  }

  private readString(): string {
    this.i++ // opening quote
    let out = ""
    while (this.i < this.text.length) {
      const ch = this.text[this.i]!
      if (ch === "\\") { out += this.text[this.i + 1] ?? ""; this.i += 2; continue }
      if (ch === "\"") { this.i++; return out }
      out += ch
      this.i++
    }
    throw new Error("Unterminated string in dir-locals file")
  }

  private readAtom(): Sexp {
    const start = this.i
    while (this.i < this.text.length && !/[\s()]/.test(this.text[this.i]!)) this.i++
    const token = this.text.slice(start, this.i)
    if (token === "nil") return null
    if (token === "t") return true
    if (/^[-+]?\d+$/.test(token)) return Number.parseInt(token, 10)
    if (/^[-+]?\d*\.\d+$/.test(token)) return Number.parseFloat(token)
    return { sym: token }
  }
}

/** Lisp value -> the plain JS value a Custom widget edits. */
function toValue(sexp: Sexp): unknown {
  if (sexp === null) return null
  if (isSymbol(sexp)) return sexp.sym
  if (Array.isArray(sexp)) return sexp.map(toValue)
  if (isCons(sexp)) return [toValue(sexp.car), toValue(sexp.cdr)]
  return sexp
}

/** Parse `.dir-locals.el` into the specs `customize-dirlocals` renders. */
export function parseDirLocals(text: string): DirlocalsSpec[] {
  let top: Sexp
  try {
    const reader = new Reader(text)
    if (reader.atEnd()) return []
    top = reader.read()
  } catch {
    return []
  }
  if (!Array.isArray(top)) return []
  const specs: DirlocalsSpec[] = []
  for (const entry of top) {
    if (!isCons(entry)) continue
    const mode = entry.car === null ? "nil" : isSymbol(entry.car) ? entry.car.sym : String(toValue(entry.car))
    const body = entry.cdr
    const settings: DirlocalsSetting[] = []
    // `(MODE . ((VAR . VALUE) ...))` — the cdr is the list of settings.
    const pairs = Array.isArray(body) ? body : body === null ? [] : [body]
    for (const pair of pairs) {
      if (!isCons(pair)) continue
      const name = isSymbol(pair.car) ? pair.car.sym : String(toValue(pair.car))
      settings.push([name, toValue(pair.cdr)])
    }
    specs.push({ mode, settings })
  }
  return specs
}

/** Print a JS value back as the Lisp datum `.dir-locals.el` expects. */
function printValue(value: unknown): string {
  if (value === null || value === undefined) return "nil"
  if (value === true) return "t"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") {
    // A bare symbol stays a symbol; anything else is a string literal.
    return /^[A-Za-z][A-Za-z0-9-]*$/.test(value) && !/^\d/.test(value)
      ? value
      : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `(${value.map(printValue).join(" ")})`
  return JSON.stringify(String(value))
}

/** Render specs back to `.dir-locals.el` source. */
export function formatDirLocals(specs: DirlocalsSpec[]): string {
  const entries = specs.map(spec => {
    const settings = spec.settings
      .filter(([name]) => name)
      .map(([name, value]) => `(${name} . ${printValue(value)})`)
      .join("\n   ")
    return `(${spec.mode} . (${settings}))`
  })
  return `(${entries.join("\n ")})\n`
}
