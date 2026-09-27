/**
 * 文件预览的类型判断：按扩展名（小写）判断，与后端的二进制嗅探互补。
 * 除 ./paths 外保持零依赖，便于 node:test 直接加载。
 */
import { baseName } from "./paths"

/** 可作为图片预览的扩展名；svg 是文本，由预览面板单独按图片渲染并可切源码 */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "ico", "bmp", "avif"])

/** 以 Markdown 渲染的扩展名 */
export const MD_EXTS = new Set(["md", "markdown"])

/** 取路径（/ 或 \ 分隔）最后一段的扩展名，小写；点文件（.gitignore）与无扩展名返回空 */
export function extOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

export const isImageExt = (path: string) => IMAGE_EXTS.has(extOf(path))

export const isMarkdownExt = (path: string) => MD_EXTS.has(extOf(path))
