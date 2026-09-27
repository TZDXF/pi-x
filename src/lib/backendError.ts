/**
 * 后端/传输层用户可见错误的统一编码：`PIXERR:` 前缀 + JSON（code / fallback / params）。
 *
 * Rust 命令与 transport 层以编码字符串返回错误；展示前经 formatCodedError
 * 按当前语言翻译 `backendErrors.<code>`。fallback 保留中文原文，供未知编码、
 * 编码解析失败或旧版前端原样展示，保证任何路径下错误仍可读。
 * 本模块保持零依赖，便于 node:test 直接加载。
 */
export const CODED_ERROR_PREFIX = "PIXERR:"

export interface CodedError {
  code: string
  fallback: string
  params?: Record<string, string>
}

export function encodeCodedError(code: string, fallback: string, params?: Record<string, string>): string {
  return CODED_ERROR_PREFIX + JSON.stringify(params ? { code, fallback, params } : { code, fallback })
}

export function parseCodedError(text: string): CodedError | null {
  if (!text.startsWith(CODED_ERROR_PREFIX)) return null
  try {
    const parsed = JSON.parse(text.slice(CODED_ERROR_PREFIX.length)) as CodedError
    if (typeof parsed?.code === "string" && typeof parsed?.fallback === "string") return parsed
  } catch {
    /* 非编码错误，按普通文本处理 */
  }
  return null
}

export type TranslateFn = (key: string, params?: Record<string, string>) => string

/** 翻译编码错误；普通文本（含 pi 自身的英文输出）原样返回。 */
export function formatCodedError(t: TranslateFn, raw: unknown): string {
  if (raw == null) return ""
  const text = raw instanceof Error ? raw.message : String(raw)
  // 调用方常以 String(error) 传值，会带上 "Error: " 前缀，剥离后才能识别编码。
  const bare = text.startsWith("Error: ") ? text.slice("Error: ".length) : text
  const coded = parseCodedError(bare)
  if (!coded) return text
  const key = `backendErrors.${coded.code}`
  const translated = t(key, coded.params)
  // vue-i18n 对缺失 key 返回 key 本身，以此识别未收录的编码并回退 fallback。
  return translated === key ? coded.fallback : translated
}
