export type BisectParseResult =
  | { kind: "culprit"; sha: string; line: string }
  | { kind: "progress"; line: string }

const SHA = "[0-9a-f]{7,40}"

export function parseBisectOutput(output: string): BisectParseResult | null {
  const lines = output.split("\n").map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    const culprit = new RegExp(`^(${SHA}) is the first bad commit$`).exec(line)
    if (culprit) return { kind: "culprit", sha: culprit[1]!, line }
  }
  for (const line of lines) {
    if (/^Bisecting: \d+ revisions? left to test after this/.test(line)) {
      return { kind: "progress", line }
    }
  }
  return null
}
