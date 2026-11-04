import type { BoardDraftAttachment } from "@/lib/workspaceState"

/** Persist original bytes, never a preview URL that expires with its editor. */
export async function serializeBoardAttachments(
  attachments: readonly { url?: string; filename?: string; mediaType?: string; file?: File }[],
): Promise<BoardDraftAttachment[]> {
  return Promise.all(
    attachments.map(async attachment => {
      let url = attachment.url ?? ""
      if (attachment.file) {
        const bytes = new Uint8Array(await attachment.file.arrayBuffer())
        let binary = ""
        for (let offset = 0; offset < bytes.length; offset += 32768)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
        url = `data:${attachment.file.type || "application/octet-stream"};base64,${btoa(binary)}`
      }
      if (!url.startsWith("data:")) throw new Error("Attachment bytes are unavailable")
      return {
        url,
        filename: attachment.filename ?? attachment.file?.name,
        mediaType: attachment.mediaType || attachment.file?.type || "application/octet-stream",
      }
    }),
  )
}

export function boardDraftFiles(attachments: readonly BoardDraftAttachment[] = []): File[] {
  return attachments.flatMap(attachment => {
    const match = /^data:([^;]*);base64,([\s\S]*)$/.exec(attachment.url)
    if (!match) return []
    try {
      const bytes = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0))
      return [new File([bytes], attachment.filename || "attachment", { type: attachment.mediaType || match[1] })]
    } catch {
      return []
    }
  })
}
