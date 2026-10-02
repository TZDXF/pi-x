/** Shared character heuristic for projected context and MCP usage estimates. */
export const CHARS_PER_TOKEN = 4
export const ESTIMATED_IMAGE_CHARS = 4800

/** Text and image content as counted by pi's fallback token estimate. */
export function textAndImageChars(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") chars += block.text.length
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS
  }
  return chars
}
