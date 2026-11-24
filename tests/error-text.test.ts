import { test, expect } from "vitest"
import {
  ERROR_TEXT_MAX_LENGTH,
  decodeHtmlEntities,
  htmlToPlainText,
  limitDisplayText,
  looksLikeHtml,
  normalizeErrorText,
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
  expect(looksLikeHtml("<div>boom</div><div>detail</div>")).toBeTruthy()
  // 普通报错：类型/泛型里的尖括号、单个标签片段都不算 HTML。
  expect(looksLikeHtml("Type 'Foo' is not assignable to type '<T>'")).toBe(false)
  expect(looksLikeHtml("unexpected token <div> at position 12")).toBe(false)
  expect(looksLikeHtml("503 boom")).toBe(false)
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
