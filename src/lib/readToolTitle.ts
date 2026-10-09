/** File preview for read tools, tolerating still-streaming JSON arguments. */
export function readToolTitle(argsText: string): string {
  let args: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(argsText)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    // Keep the path preview visible until the argument object finishes streaming.
  }

  const direct = args?.path ?? args?.file_path ?? args?.filePath
  let path = typeof direct === "string" ? direct : ""
  if (typeof direct !== "string") {
    const match = argsText.match(/"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)/)
    path = match ? match[1]!.replace(/\\\\/g, "\\").replace(/\\"/g, '"') : ""
  }
  if (!path) return ""

  const offset = args?.offset
  // `offset` is the API parameter name, not a localized UI label.
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 ? `${path} · offset=${offset}` : path
}
