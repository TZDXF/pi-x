/**
 * 文件预览里 Markdown 图片的地址解析。
 *
 * 背景（TZD-132）：`vue-stream-markdown` 的 URL 硬校验在 `defaultOrigin` 为空时
 * 只放行 `/`、`./`、`../` 开头的相对地址，其余相对地址（如 `assets/a.png`）会
 * 直接退化成「链接被拦截」的错误占位；即便放行，webview 也只会按应用自身的源去
 * 请求，根本读不到项目目录里的文件。因此渲染层接管 `img`：相对地址按 md 文件所在
 * 目录解析成项目内路径，再经 `read_file_preview` 读成 data URL（CSP 只允许
 * `'self' data: blob:`，且远端 SSH 项目同样走这条命令）。
 */
import type { FilePreview } from "./projectFiles"
import { extOf, isImageExt } from "./fileKind"
import { normalizeSlashes } from "./paths"
import type { InjectionKey } from "vue"

/** 图片地址的解析结果：外部直链、项目内路径、或不可渲染（拦截/越界/无效）。 */
export type MarkdownImageSource =
  | { kind: "external"; url: string }
  | { kind: "project"; path: string }
  | { kind: "blocked" }

/** 文件预览向 Markdown `img` 组件提供的上下文。 */
export interface MarkdownImageContext {
  /**
   * 当前 Markdown 文件在项目内的路径（如 `docs/spec/a.md`），相对图片按它的目录解析。
   * 为空时无法解析相对地址，图片退化为不可渲染。
   */
  docPath: string
  /** 读取项目内的图片并返回可直接放进 `img src` 的地址；读不到时返回 null。 */
  load?: (path: string) => Promise<string | null>
}

export const markdownImageContextKey: InjectionKey<MarkdownImageContext> = Symbol("pix-markdown-image")

/** 只允许这些来源作为外部图片直链；`javascript:`、`file:` 等一律拦截。 */
function isAllowedExternal(src: string): boolean {
  return /^(?:https?:\/\/|\/\/|blob:|data:image\/)/i.test(src)
}

/** 协议相对地址（`//host/x.png`）按 https 处理，与浏览器默认行为一致。 */
function externalUrl(src: string): string {
  return src.startsWith("//") ? `https:${src}` : src
}

/** 解码百分号转义（解析层会把中文等字符编码），非法转义保持原样。 */
function decodePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

/** 带协议的地址（`https:`、`javascript:`、`C:` 不算）；`//` 协议相对也算外部。 */
function hasProtocol(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")
}

/**
 * 解析 Markdown 图片地址。
 *
 * - 带协议/协议相对/data URL → 外部直链（仅 http/https/blob/data:image），**原样保留**：
 *   外链里的 `%2F`、`%20` 属于远端资源名，解码会改变请求地址。
 * - 其他相对或根相对地址 → 项目内路径：先解码（解析层会把中文编码），再按 `docPath`
 *   的目录解析 `./`、`../`，以 `/` 开头则相对项目根；去掉 `?query`、`#anchor`，统一为正斜杠。
 * - 解析后越出项目根、指向绝对文件系统路径、带其他协议 → `blocked`。
 */
export function resolveMarkdownImageSource(src: string, docPath: string): MarkdownImageSource {
  const raw = (src ?? "").trim()
  if (!raw) return { kind: "blocked" }
  // 先按未解码的原串判定外链，避免 `%2F` 被解码成路径分隔符。
  if (hasProtocol(raw)) {
    return isAllowedExternal(raw) ? { kind: "external", url: externalUrl(raw) } : { kind: "blocked" }
  }
  const decoded = decodePath(raw)
  // 解码后才出现协议（如 `javascript%3A...`）或绝对路径的，同样不放行。
  if (hasProtocol(decoded) || /^[a-z]:[\\/]/i.test(decoded)) return { kind: "blocked" }
  // 去掉查询串与锚点后再按路径解析（`a.png?x=1`、`a.png#top` 都指向同一张图）。
  const pathOnly = decoded.split(/[?#]/)[0]
  if (!pathOnly) return { kind: "blocked" }
  const segments = pathOnly.startsWith("/") ? [] : normalizeSlashes(docPath).split("/").slice(0, -1)
  for (const part of normalizeSlashes(pathOnly).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!segments.length) return { kind: "blocked" }
      segments.pop()
      continue
    }
    // Windows 盘符、UNC 前缀等绝对路径不当作项目内文件。
    if (/^[a-z]:$/i.test(part)) return { kind: "blocked" }
    segments.push(part)
  }
  return segments.length ? { kind: "project", path: segments.join("/") } : { kind: "blocked" }
}

/**
 * 把 `read_file_preview` 的结果转成可直接放进 `img src` 的地址。
 * 图片走 base64 data URL；svg 由后端当文本返回，这里按文本重新编码。其他类型不可预览。
 */
export function previewImageUrl(preview: FilePreview | null | undefined, path = ""): string | null {
  if (!preview) return null
  if (preview.kind === "image") {
    if (!preview.data) return null
    return `data:${preview.mime ?? "application/octet-stream"};base64,${preview.data}`
  }
  if (preview.kind === "text" && preview.text && !preview.truncated && extOf(path) === "svg") {
    return `data:image/svg+xml;utf8,${encodeURIComponent(preview.text)}`
  }
  return null
}

/** 预览面板本身是否按图片渲染该路径（与 `previewImageUrl` 的判定保持一致）。 */
export function isPreviewableImagePath(path: string): boolean {
  return isImageExt(path) || extOf(path) === "svg"
}
