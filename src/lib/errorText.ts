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
const DECLARATION_RE = /<![^>]*>|<\?[^>]*\?>/g
const RAW_TEXT_BLOCK_RE = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const HEAD_RE = /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi

/**
 * 参与"像 HTML"判据的结构标签名（不含 `<T>` 这类泛型/占位符）。
 * 导出是为了让测试能对**每一个**标签逐一验证同类绕过（普通报错里成对引用它们
 * 都不应被剥标签），而不是只钉住 QA 举的那一个样例。
 */
export const STRUCTURAL_TAG_NAMES = [
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
] as const

const STRUCTURAL_NAMES = new Set<string>(STRUCTURAL_TAG_NAMES)

/**
 * 只有源码、没有可读文字的标签：单独的 `<script>…</script>` / `<style>…</style>` 是代码
 * 片段而不是错误页，提取后会是空串（调用方还会落到"未知错误"），因此不算 HTML。
 */
const RAW_TEXT_NAMES = new Set(["script", "style", "template", "noscript"])

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
 * 判据必须**宁可漏判、不可误判**：判成 HTML 就会剥标签，而普通报错里的标签引用
 * （`unexpected token <body> at position 12`、`rendering <body>Foo</body> failed`）
 * 承载关键诊断信息，必须原样展示。因此不再有"命中某一个标签就整段算 HTML"的特例，
 * 所有结构标签一视同仁：
 *
 * 1. **整页**：`<!doctype html>`。
 * 2. **片段**：文字**以标记开头**（去掉前导注释/声明/BOM 后首个 token 是开标签）——
 *    这是"整段就是标记"与"一句报错里引用了标签"的分界，对**所有**结构标签一律生效；
 *    再要求存在闭合标签，且结构标签出现 ≥ 2 次（一对元素 = 2 次）。
 *    出现 `html` 元素且另有 `head`/`body` 名字或 `</html>` 也算整页。
 * 3. **纯源码块**：只有 `script`/`style`/`template`/`noscript`（没有别的结构标签）时不算
 *    HTML —— 提取后为空，展示原文更有信息量。
 *
 * 依据是**整段文本的形状**而不是标签计数，所以 `<body>Foo</body>` 出现在句子中间时
 * 任何标签都不会触发剥离；`<div>…</div>`、`<pre>…</pre>`、`<body><h1>…</h1></body>`
 * 这类真正以标记开头的片段仍照常提取。
 */
export function looksLikeHtml(text: string): boolean {
  if (typeof text !== "string" || !text.includes("<")) return false
  const value = text.trim()
  // `<!doctype html>` 只出现在真正的 HTML 文档里，是最强的整页信号。
  if (/<!\s*doctype\s+html/i.test(value)) return true
  // 其余所有分支都要求**整段以标记开头**：前导注释/声明/BOM 之后首个 token 是开标签。
  // 这是"整段就是标记"与"一句报错里引用了标签"的唯一分界，对所有结构标签一视同仁，
  // 因此不存在"某个标签（如成对 body）能被普通报错绕过"的特例。
  if (!/^<[a-z][a-z0-9-]*/i.test(stripLeadingMarkupNoise(value))) return false
  const names = htmlTagNames(value)
  // `html` 元素（配合 `head`/`body` 名字或 `</html>`）说明是文档外壳，不是片段里的一对标签。
  if (names.has("html") && (names.has("head") || names.has("body") || /<\/html\s*>/i.test(value))) return true
  if (!/<\/[a-z][a-z0-9-]*\s*>/i.test(value)) return false
  // 纯 script/style 块不是错误页（提取后没有可读文字）。
  if (names.size > 0 && [...names].every(name => RAW_TEXT_NAMES.has(name))) return false
  return structuralTagCount(value) >= HTML_FRAGMENT_MIN_TAGS
}

/** 去掉开头的注释、`<!doctype …>`/`<![CDATA[…]]>`/`<?xml …?>` 声明与空白。 */
function stripLeadingMarkupNoise(text: string): string {
  let value = text.replace(/\uFEFF/g, "").trimStart()
  for (;;) {
    const before = value
    value = value
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<![^>]*>/, "")
      .replace(/^<\?[^>]*\?>/, "")
      .trimStart()
    if (value === before) return value
  }
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

/** 去掉注释、声明（`<!doctype>` / `<?xml?>`）与 script/style/template/noscript（含未闭合尾巴）。 */
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
