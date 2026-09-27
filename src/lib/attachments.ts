/** Parse a base64 data URL into the RPC image shape; null when not an image payload. */
export function dataUrlToImage(d: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

/** Whether an attachment URL renders as an image (inline data or a remote image file). */
export function isImageUrl(url?: string): boolean {
  return (
    !!url &&
    (url.startsWith("data:image/") ||
      /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(url))
  )
}
