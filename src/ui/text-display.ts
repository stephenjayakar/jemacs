export function textWithCursor(text: string, point: number): string {
  const cursorPoint = Math.max(0, Math.min(point, text.length))
  const underCursor = text[cursorPoint]
  if (underCursor && underCursor !== "\n") {
    return text.slice(0, cursorPoint) + "█" + text.slice(cursorPoint + 1)
  }
  return text.slice(0, cursorPoint) + "█" + text.slice(cursorPoint)
}
