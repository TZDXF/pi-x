/** Parse a base64 data URL into the RPC image shape; null when not an image payload. */
export function dataUrlToImage(d: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

/** Whether an attachment URL renders as an image (inline data or a remote image file). */
export function isImageUrl(url?: string): boolean {
  return !!url && (url.startsWith("data:image/") || /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(url))
}

/**
 * Whether an attachment renders as an image. Covers blob: object URLs, which
 * carry no type in the URL itself, by also checking media type and file extension.
 */
export function isImageAttachment(file: { url?: string; mediaType?: string; filename?: string }): boolean {
  return (
    isImageUrl(file.url) ||
    !!file.mediaType?.toLowerCase().startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(file.filename ?? "")
  )
}
