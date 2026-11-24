/**
 * 错误信息的展示文本归一（TZD-145）：provider 偶尔把整段 HTML 错误页当作错误信息返回，
 * 直接按纯文本渲染会在对话里出现一大片标签与样式源码。这里在展示前做两件事：
 *
 * 1. **只保留文字**：丢弃 `<script>` / `<style>` / 注释等不可读内容，结构标签换成换行，
 *    解码 `&amp;` / `&#39;` 等实体（单趟解码，`&amp;lt;` 只还原成 `&lt;`）。
 * 2. **限制长度**：错误页动辄上万字符，展示文本截到 `ERROR_TEXT_MAX_LENGTH`，尽量在
 *    空白边界断开并补 `…`。
 *
 * 只处理**像 HTML 的**错误文本（判据见 `looksLikeHtml`）：普通错误**逐字节原样返回**，
 * 既不被剥标签、也不被截断 —— 例如 `Type 'Foo' is not assignable to type '<T>'`、
 * `unexpected token <body> at position 12`、`rendering <span>Foo</span> failed` 都原样展示。
 * 限长只作用于从 HTML 提取出的文字。
 *
 * 与 `formatRetryError`（provider JSON payload 拆包）组合：先拆包再归一，因为 provider
 * 既可能直接返回 HTML 页面，也可能把 HTML 塞进 `{"error":{"message":"<html>…"}}`。
 * 本模块保持零依赖、纯字符串处理，可在 node 环境直接单测（不依赖 DOM）。
 */

/** 展示文本上限：足够容纳正常 provider 错误，又不会让错误页淹没整屏对话。 */
export const ERROR_TEXT_MAX_LENGTH = 500

/** 常见具名实体（HTML 错误页里出现的编码噪音基本集中在这一组）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
}

/** 结构标签：替换为换行，避免相邻文本块粘成一行。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "ul",
])

/** 任何标签（带不带属性都吃掉）；标签名用于判断是否结构标签。 */
const TAG_RE = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi

/** HTML 注释、doctype/声明与不可读块（源码不是错误信息的一部分）。 */
const COMMENT_RE = /<!--[\s\S]*?-->/g
const DECLARATION_RE = /<![^>]*>/g
const RAW_TEXT_BLOCK_RE = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const HEAD_RE = /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi

/** 参与"像 HTML"计数的结构标签名（不含 `<T>` 这类泛型/占位符）。 */
const STRUCTURAL_NAMES = new Set([
  "html",
  "head",
  "body",
  "title",
  "div",
  "p",
  "span",
  "table",
  "tr",
  "td",
  "th",
  "tbody",
  "thead",
  "tfoot",
  "caption",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "pre",
  "style",
  "script",
  "template",
  "noscript",
  "meta",
  "link",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "form",
  "center",
  "font",
  "blockquote",
  "dt",
  "dd",
  "dl",
  "img",
  "a",
])

/** 片段判定门槛：结构标签出现次数下限（一对元素 = 2 次出现）。 */
const HTML_FRAGMENT_MIN_TAGS = 2

function decodeNumericEntity(body: string, match: string): string {
  const hex = /x/i.test(body[1] ?? "")
  const digits = hex ? body.slice(2) : body.slice(1)
  const code = Number.parseInt(digits, hex ? 16 : 10)
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
  try {
    return String.fromCodePoint(code)
  } catch {
    return match
  }
}

/** 解码 HTML 实体；未收录的具名实体与非法码点保持原样（宁可留字，不吞字符）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body.startsWith("#")) return decodeNumericEntity(body, match)
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * 是否像 HTML 文档/片段。
 *
 * 判据要**宁可漏判、不可误判**：判成 HTML 就会剥标签，而普通报错里的
 * `unexpected token <body> at position 12`、`rendering <span>Foo</span> failed`
 * 需要原样展示。因此：
 * - 整页信号：`<!doctype html>`；成对的 `<html>…</html>` 或 `<body>…</body>`；
 *   `<html` 另有 `head`/`body` 的名字；成对 `script`/`style`/`template`/`noscript`
 *   **且**至少还有一个别的结构标签（单独一句 `<script>…</script>` 仍是普通文本）；
 * - 片段：整段以 `<` 开头、以 `>` 结尾（是标记而不是"报错里引用了标签"），且至少有一
 *   对开/闭标签。判据看整段的形状而不是标签个数，所以 `rendering <span>Foo</span> failed`、
 *   `<body> is not allowed here` 这类普通报错里的标签引用不会被剥掉；而
 *   `<div>…</div>`、`<pre>…</pre>` 这样的片段仍会提取文字。
 */
export function looksLikeHtml(text: string): boolean {
  if (typeof text !== "string" || !text.includes("<")) return false
  if (/<!\s*doctype\s+html/i.test(text)) return true
  const names = htmlTagNames(text)
  if (names.has("html") && (names.has("head") || names.has("body") || /<\/html\s*>/i.test(text))) return true
  // 带闭合 body 的片段（没有 doctype / html 外壳的错误页）。
  if (/<body\b[^>]*>[\s\S]*?<\/body\s*>/i.test(text)) return true
  const rawPair = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/i.exec(text)
  if (rawPair) {
    const others = [...names].filter(name => name !== rawPair[1]!.toLowerCase())
    if (others.length > 0) return true
  }
  // 片段：整段就是标记（首尾都是标签），不是"一句报错里引用了一个标签"。
  if (!text.trimStart().startsWith("<") || !text.trimEnd().endsWith(">")) return false
  if (!/<\/[a-z][a-z0-9-]*\s*>/i.test(text)) return false
  return structuralTagCount(text) >= HTML_FRAGMENT_MIN_TAGS
}

/** 文中出现过的结构标签名（小写、去重；未知标签名不参与计数）。 */
function htmlTagNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(TAG_RE)) {
    const name = match[1]?.toLowerCase()
    if (name && STRUCTURAL_NAMES.has(name)) names.add(name)
  }
  return names
}

/** 结构标签出现次数（开/闭标签各计一次，同 `htmlTagNames` 的名字集合）。 */
function structuralTagCount(text: string): number {
  let count = 0
  for (const match of text.matchAll(TAG_RE)) {
    const name = match[1]?.toLowerCase()
    if (name && STRUCTURAL_NAMES.has(name)) count++
  }
  return count
}

/** 去掉注释与 script/style/template/noscript（含未闭合的尾巴）。 */
function stripUnreadableBlocks(html: string): string {
  let out = html.replace(COMMENT_RE, " ").replace(DECLARATION_RE, " ").replace(RAW_TEXT_BLOCK_RE, " ")
  // 被截断的错误页可能没有闭合标签：从残余的开标签起全是源码，丢弃到结尾。
  return out.replace(/<(?:script|style|template|noscript)\b[\s\S]*$/i, " ")
}

/** 标签转文本：结构标签给换行，行内标签直接去掉。 */
function stripTags(html: string): string {
  return html.replace(TAG_RE, (_tag, name: string) => (BLOCK_TAGS.has(name.toLowerCase()) ? "\n" : ""))
}

/** 折叠行内空白、丢掉空行；保留换行以便错误分段。 */
function collapseLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

/** 错误页常把真正的原因写在 `<title>`，正文只是模板外壳。 */
function htmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return match ? collapseLines(decodeHtmlEntities(stripTags(match[1]))) : ""
}

/** 从 HTML 提取展示用文字：标题 + 正文（标题已是正文开头时不重复）。 */
export function htmlToPlainText(html: string): string {
  const title = htmlTitle(html)
  const body = collapseLines(decodeHtmlEntities(stripTags(stripUnreadableBlocks(html.replace(HEAD_RE, " ")))))
  if (!title) return body
  if (!body) return title
  if (body.toLowerCase().startsWith(title.toLowerCase())) return body
  return `${title}\n${body}`
}

/** 截断展示文本，尽量在空白边界断开并补 `…`。 */
export function limitDisplayText(text: string, maxLength: number = ERROR_TEXT_MAX_LENGTH): string {
  const value = text.trim()
  if (!maxLength || value.length <= maxLength) return value
  const slice = value.slice(0, maxLength)
  const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "))
  // 边界太靠前说明是一个超长 token（URL/堆栈），硬截比只剩开头几个字更有信息量。
  const cut = boundary >= maxLength / 2 ? slice.slice(0, boundary) : slice
  return `${cut.trimEnd()}…`
}

/**
 * 错误信息归一：像 HTML 的错误页 → 纯文字并截断；普通错误文本原样返回。
 * `formatRetryError` 在拆出 provider JSON payload 后统一走这里。
 */
export function normalizeErrorText(text: string, maxLength: number = ERROR_TEXT_MAX_LENGTH): string {
  const raw = text.trim()
  if (!raw) return ""
  if (!looksLikeHtml(raw)) return raw
  return limitDisplayText(htmlToPlainText(raw), maxLength)
}

/**
 * provider 错误正文 + HTTP 状态码的展示文本。
 *
 * 只有**像 HTML 的错误页**才提取文字并限长（`500 · 提取后的正文`）；普通错误正文
 * 保持原行为：原样拼上状态码，**不截断**（否则 provider 的正常长诊断会在末尾丢字）。
 */
export function normalizeProviderError(
  text: string,
  status?: string,
  maxLength: number = ERROR_TEXT_MAX_LENGTH,
): string {
  const raw = text.trim()
  if (!raw) return ""
  const prefix = status ? `${status} · ` : ""
  if (!looksLikeHtml(raw)) return `${prefix}${raw}`
  return limitDisplayText(`${prefix}${htmlToPlainText(raw)}`, maxLength)
}
