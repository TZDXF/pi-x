import { expect, test } from "vitest"
import { createMarkmendParser } from "vue-stream-markdown"
import { isDeliberateAutoLink, markdownParserOptions } from "@/lib/markdownAutoLink"

const parse = (markdown: string) =>
  createMarkmendParser({ parserOptions: markdownParserOptions }).parse(markdown, "static")

/** 渲染树里所有带 href 的节点，用来断言“哪些文本真的成了链接”。 */
function hrefs(nodes: unknown[]): string[] {
  const out: string[] = []
  const walk = (node: unknown) => {
    if (typeof node === "string" || !Array.isArray(node)) return
    const [tag, attrs, ...children] = node as [string, Record<string, unknown>?, ...unknown[]]
    if (tag === "a" && typeof attrs?.href === "string") out.push(attrs.href)
    children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

test("file names that look like TLD domains stay plain text", async () => {
  const markdown = "改 src/session.py，重启 config.sh，再看 main.rs 与 session.py:42。"
  const { document } = await parse(markdown)

  expect(hrefs(document.nodes)).toEqual([])
  expect(JSON.stringify(document.nodes)).toContain(markdown)
})

test("bold and wrapped file names are not linkified either", async () => {
  const { document } = await parse("**session.py** 与 *config.sh* 与 nightly.py")
  expect(hrefs(document.nodes)).toEqual([])
  expect(document.nodes).toEqual([
    ["p", {}, ["strong", {}, "session.py"], " 与 ", ["em", {}, "config.sh"], " 与 nightly.py"],
  ])
})

test("real links keep working", async () => {
  const { document } = await parse(
    "https://example.com/a www.example.com/path github.com/TZDXF/pi-x example.com/x me@example.com <https://example.com> [docs](https://example.com/docs)",
  )

  expect(hrefs(document.nodes)).toEqual([
    "https://example.com/a",
    "http://www.example.com/path",
    "http://github.com/TZDXF/pi-x",
    "http://example.com/x",
    "mailto:me@example.com",
    "https://example.com",
    "https://example.com/docs",
  ])
})

test("bare hosts that are indistinguishable from file:line stay plain text", async () => {
  const { document } = await parse("裸域名 example.com 与 example.com:8080 保持纯文本")
  expect(hrefs(document.nodes)).toEqual([])
})

test("table cells, list items and blockquotes are covered", async () => {
  const { document } = await parse(
    "| 文件 | 说明 |\n| --- | --- |\n| session.py | 会话读写 |\n\n- config.sh\n\n> main.rs",
  )

  expect(hrefs(document.nodes)).toEqual([])
  expect(JSON.stringify(document.nodes)).toContain("session.py")
  expect(JSON.stringify(document.nodes)).toContain("config.sh")
  expect(JSON.stringify(document.nodes)).toContain("main.rs")
})

test("streaming parses apply the same guard", async () => {
  const parser = createMarkmendParser({ parserOptions: markdownParserOptions })
  await parser.parse("改 ", "streaming")
  await parser.parse("改 session.py 后重启", "streaming")
  const { document } = await parser.parse("改 session.py 后重启 https://example.com/x", "streaming")

  expect(hrefs(document.nodes)).toEqual(["https://example.com/x"])
})

test("the deliberate-link predicate states the intended rule", () => {
  for (const text of [
    "https://example.com/a",
    "http://example.com",
    "www.example.com",
    "example.com/x",
    "me@example.com",
  ]) {
    expect(isDeliberateAutoLink(text)).toBe(true)
  }
  for (const text of [
    "session.py",
    "config.sh",
    "main.rs",
    "README.md",
    "example.com",
    "example.com:8080",
    "session.py:42",
  ]) {
    expect(isDeliberateAutoLink(text)).toBe(false)
  }
})
