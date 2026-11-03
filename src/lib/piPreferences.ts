/** Commands remain argv arrays; never split or execute them in the frontend. */
export function parseUpdateCommand(text: string): { ok: true; argv: string[] | null } | { ok: false } {
  if (!text.trim()) return { ok: true, argv: null }
  try {
    const argv: unknown = JSON.parse(text)
    if (
      Array.isArray(argv) &&
      argv.length &&
      argv.every(arg => typeof arg === "string" && !arg.includes("\0")) &&
      argv[0].trim()
    )
      return { ok: true, argv }
  } catch {
    // The draft stays editable until valid JSON is entered.
  }
  return { ok: false }
}
