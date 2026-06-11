/** Describes the raw prefix shape before collapsing to a single numeric value. */
export type RawPrefixShape =
  /** No prefix was given. */
  | { kind: "none" }
  /** Plain `C-u` (or repeated `C-u`), no digits typed. `value` = 4, 16, 64, … */
  | { kind: "plain-cu"; value: number }
  /** Bare `M--` with no digits. */
  | { kind: "bare-negative" }
  /** Explicit numeric value from digits (`C-u N`, `M-- N`, `C-u 0`, bare digit prefix). */
  | { kind: "explicit"; value: number }

/** GNU Emacs-style numeric prefix argument state (C-u, M--, digit keys). */
export class PrefixArgumentState {
  private value: number | null = null
  private negative = false
  private digitString: string | null = null

  /** First `C-u` → 4; repeat `C-u` → multiply by 4. */
  universalArgument(): number {
    if (this.digitString != null) {
      const base = parseInt(this.digitString, 10) || 1
      this.digitString = null
      this.value = base * 4
    } else if (this.value == null) {
      this.value = 4
    } else {
      this.value *= 4
    }
    return this.value
  }

  /** `M--` toggles sign of the pending prefix. */
  toggleNegative(): void {
    this.negative = !this.negative
  }

  /** Digit key after `C-u` (e.g. `C-u 5`). */
  addDigit(digit: number): number {
    const d = Math.max(0, Math.min(9, digit))
    this.digitString = this.digitString == null ? String(d) : `${this.digitString}${d}`
    this.value = null
    return parseInt(this.digitString, 10)
  }

  /** True when `C-u` / `M--` / digits are pending and not yet consumed by a command. */
  isActive(): boolean {
    return this.value != null || this.digitString != null || this.negative
  }

  /** After `C-u`, bare digit keys build the argument instead of self-inserting. */
  acceptsDigitKey(): boolean {
    return this.isActive()
  }

  isNegative(): boolean {
    return this.negative
  }

  peek(): number | null {
    if (this.digitString != null) {
      const n = parseInt(this.digitString, 10)
      return this.negative ? -n : n
    }
    if (this.value != null) return this.negative ? -this.value : this.value
    if (this.negative) return -1
    return null
  }

  /** Compute the raw prefix shape from the current state (without clearing). */
  rawShape(): RawPrefixShape {
    if (this.digitString != null) {
      const n = parseInt(this.digitString, 10)
      return { kind: "explicit", value: this.negative ? -n : n }
    }
    if (this.value != null) return { kind: "plain-cu", value: this.peek()! }
    if (this.negative) return { kind: "bare-negative" }
    return { kind: "none" }
  }

  /** Consume prefix, returning both the raw shape and the computed numeric value. */
  consumeRaw(): { raw: RawPrefixShape; value: number | null } {
    const raw = this.rawShape()
    const value = this.peek()
    this.clear()
    return { raw, value }
  }

  /** Legacy: consume and return only the numeric value. */
  consume(): number | null {
    const n = this.peek()
    this.clear()
    return n
  }

  clear(): void {
    this.value = null
    this.negative = false
    this.digitString = null
  }

  describe(): string {
    const n = this.peek()
    if (n == null) return "nil"
    return String(n)
  }
}

export function digitFromKey(name: string): number | null {
  if (/^[0-9]$/.test(name)) return Number(name)
  return null
}
