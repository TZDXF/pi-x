/** Parse a base64 data URL into the RPC image shape; null when not an image payload. */
export function dataUrlToImage(d: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

/** 提交形状的附件（`onSubmit` 收到的那些字段；带原始 `File` 时优先用原件）。 */
export interface SubmittedAttachment {
  url?: string
  mediaType?: string
  filename?: string
  file?: File
}

/**
 * 失败态的提交回退成草稿里的附件（`completion.startFailed` 承诺“输入与附件都不丢”）。
 *
 * 优先用调用方给的**原始 `File`**：`PromptInput.submitForm` 会把 `file` 字段带到 `onSubmit`，
 * 那份是用户选的同一份对象，重挂载后直接 `addFiles` 就能重新生成 blob URL。没有原件时按
 * 已解码的 base64 重建 —— 否则“只发了一张图”的失败会让图静静消失（aux 无 session 文件）。
 */
export function draftFilesFromSubmit(
  files: readonly SubmittedAttachment[],
  images: readonly { data: string; mimeType: string }[],
): File[] {
  const originals = files.map(file => file.file).filter((file): file is File => !!file)
  if (originals.length) return originals
  return images.map(imageFileFrom).filter((file): file is File => !!file)
}

/** 把 RPC 形状的 base64 图片重建为 `File`（文件名只用于预览与类型判定）。 */
export function imageFileFrom(image: { data: string; mimeType: string }): File | null {
  try {
    const binary = atob(image.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    const extension = (image.mimeType.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png"
    return new File([bytes], `image.${extension}`, { type: image.mimeType })
  } catch {
    return null
  }
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
