/** Shared helpers for extracting plain text from pi message content.
 *  Used by both the session store (streaming/output assembly) and the
 *  timeline builder (raw history summarization) so the acceptance rules
 *  can never drift apart. */

/** Plain text of a content field: a string, or the concatenation of its
 *  text blocks. Non-text blocks (thinking / toolCall / image) contribute nothing. */
export function contentText(content: unknown): string {
  if (typeof content === "string")
    return content
  if (Array.isArray(content))
    return content
      .map((c: any) => (c && c.type === "text" ? c.text : ""))
      .join("")
  return ""
}
