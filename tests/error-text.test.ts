import { test, expect } from "vitest"
import {
  ERROR_TEXT_MAX_LENGTH,
  decodeHtmlEntities,
  htmlToPlainText,
  limitDisplayText,
  looksLikeHtml,
  normalizeErrorText,
  normalizeProviderError,
} from "@/lib/errorText"

/**
 * TZD-145：错误信息是 HTML 时提取文字并限制长度。
 *
 * 钉住三件事：
 * 1. 判据（`looksLikeHtml`）只认真正像 HTML 的错误页，含尖括号的普通报错不被剥标签；
 * 2. 提取（`htmlToPlainText`）丢掉 script/style/注释，保留可读文字，标题优先，
 *    provider 的 HTML 是文字与实体的来源，不是样式源码；
 * 3. 长度（`limitDisplayText`）默认截到 `ERROR_TEXT_MAX_LENGTH` 并以 `…` 结尾。
 */

const escapePage = (body: string) =>
  `<!DOCTYPE html><html><head><title>502 Bad Gateway</title><style>body{font-family:Arial}</style></head>` +
  `<body><h1>502 Bad Gateway</h1>${body}<script>window.__DATA__={}</script></body></html>`

test("html detection accepts error pages but not angle brackets in plain errors", () => {
  expect(looksLikeHtml(escapePage("<p>upstream</p>"))).toBeTruthy()
  expect(looksLikeHtml("<html><head><title>Oops</title></head><body><div>x</div></body></html>")).toBeTruthy()
  // 片段：整段是标记且有开/闭标签（没有 doctype / html 外壳的真片段）。
  expect(looksLikeHtml("<div><h1>down</h1><p>detail</p></div>")).toBeTruthy()
  expect(looksLikeHtml("<table><tr><td>x</td></tr></table>")).toBeTruthy()
  expect(looksLikeHtml("<pre>fatal: no space left on device</pre>")).toBeTruthy()
  // 普通报错：类型/泛型里的尖括号、单个标签片段都不算 HTML。
  expect(looksLikeHtml("Type 'Foo' is not assignable to type '<T>'")).toBe(false)
  expect(looksLikeHtml("unexpected token <div> at position 12")).toBe(false)
  expect(looksLikeHtml("503 boom")).toBe(false)
})

/**
 * 回归（QA）：普通报错的标签承载关键诊断信息，不能被当成 HTML 剥掉。
 * 两处原先的误判原因：
 * - `<html|head|body>` 开标签一出现就判整页 —— 现在还要求闭合或另有 html 相关标签；
 * - 同一元素的 `<span>` + `</span>` 被计成两个结构标签 —— 现在只计**不同**标签名。
 */
test("plain errors carrying a tag are never stripped", () => {
  const cases = [
    "unexpected token <body> at position 12",
    "unexpected token <head> at position 7",
    "rendering <span>Foo</span> failed",
    "rendering <div>Foo</div> failed",
    "cannot parse <script>const a = 1</script> snippet",
    "<body> is not allowed here",
    "unexpected close tag </div>",
    "Type 'Foo' is not assignable to type '<T>'",
  ]
  for (const text of cases) {
    expect(looksLikeHtml(text)).toBe(false)
    expect(normalizeErrorText(text)).toBe(text)
  }
})

test("entities decode once, numeric forms included, unknown names kept", () => {
  expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &#39;q&#x27; &nbsp;")).toBe("a & b <c> 'q'  ")
  // 单趟解码：双重转义只还原一层，避免把用户文本变成标签。
  expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;")
  expect(decodeHtmlEntities("&unknown; stays")).toBe("&unknown; stays")
})

test("an HTML error page reduces to readable text with its title first", () => {
  const text = htmlToPlainText(escapePage("<p>The upstream server is overloaded.</p><p>Try again later.</p>"))
  expect(text).toBe("502 Bad Gateway\nThe upstream server is overloaded.\nTry again later.")
  // 样式与脚本源码一律不进展示文本。
  expect(text).not.toMatch(/font-family|__DATA__|<|>/)
})

test("title already opening the body is not repeated", () => {
  const text = htmlToPlainText("<html><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>")
  expect(text).toBe("Not Found")
})

test("unclosed raw-text blocks from a truncated page are dropped", () => {
  const text = htmlToPlainText("<html><body><p>fatal</p><script>var a = 1; var b =")
  expect(text).toBe("fatal")
})

test("display length caps long text at a word boundary", () => {
  expect(limitDisplayText("short")).toBe("short")
  const long = "word ".repeat(200).trim()
  const capped = limitDisplayText(`prefix ${long}`, 40)
  expect(capped.length).toBeLessThanOrEqual(41)
  expect(capped.endsWith("…")).toBeTruthy()
  expect(capped.startsWith("prefix word")).toBeTruthy()
  // 超长无空白 token 硬截，而不是只剩空白前的一小段。
  const token = "a".repeat(1000)
  expect(limitDisplayText(token, 30)).toBe(`${"a".repeat(30)}…`)
  // 默认上限就是 ERROR_TEXT_MAX_LENGTH。
  expect(limitDisplayText(token)).toBe(`${"a".repeat(ERROR_TEXT_MAX_LENGTH)}…`)
})

test("plain provider errors pass through unchanged", () => {
  expect(normalizeErrorText("503 boom")).toBe("503 boom")
  expect(normalizeErrorText("")).toBe("")
  expect(normalizeErrorText("  connection refused  ")).toBe("connection refused")
})

test("normalizing an HTML error yields capped plain text", () => {
  const page = escapePage(`<p>${"detail ".repeat(300)}</p>`)
  const text = normalizeErrorText(page)
  expect(text.startsWith("502 Bad Gateway")).toBeTruthy()
  expect(text.length).toBeLessThanOrEqual(ERROR_TEXT_MAX_LENGTH + 1)
  expect(text.endsWith("…")).toBeTruthy()
  expect(text).not.toMatch(/<[a-z]/i)
})

/**
 * 回归（QA）：普通（非 HTML）provider 正文不截断。
 * 之前 `normalizeProviderError` 对两种分支都调 `limitDisplayText`，600 字符的正常
 * 诊断被截成 `500 · aaa…a…`，末尾信息丢失 —— 与"HTML 提取后限长、普通错误透传"的
 * 验收口径相反。
 */
test("plain provider errors keep their full text, only HTML is capped", () => {
  const detail = "a".repeat(600)
  expect(normalizeProviderError(detail, "500")).toBe(`500 · ${detail}`)
  expect(normalizeProviderError(detail)).toBe(detail)
  // 带空白的长诊断同样完整。
  const sentence = "context window exceeded ".repeat(60).trim()
  expect(normalizeProviderError(sentence, "400")).toBe(`400 · ${sentence}`)
  // HTML 分支仍然限长，并保留状态码前缀。
  const page = escapePage(`<p>${"detail ".repeat(300)}</p>`)
  const capped = normalizeProviderError(page, "500")
  expect(capped.startsWith("500 · 502 Bad Gateway")).toBeTruthy()
  expect(capped.endsWith("…")).toBeTruthy()
  expect(capped.length).toBeLessThanOrEqual(ERROR_TEXT_MAX_LENGTH + 1)
})
