import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const previewAnnotations = loadTsSource(
  readFileSync(new URL("../src/lib/previewAnnotations.ts", import.meta.url), "utf8"),
  { URL },
)
const { formatAnnotationsForChat, annotationsForPage, sameUrl, nextAnnotationId } = previewAnnotations

const labels = { page: "网页标注", element: "元素", area: "区域", comment: "评论" }

const pin = {
  id: "a1",
  kind: "pin",
  number: 1,
  pin: { selector: "button.btn:nth-of-type(2)", text: "提交订单", rect: { x: 312, y: 448, width: 96, height: 32 } },
  comment: "移动端溢出",
  url: "http://localhost:5173/checkout",
}
const area = {
  id: "a2",
  kind: "area",
  number: 2,
  area: { rect: { x: 100.4, y: 200, width: 300, height: 120.6 } },
  comment: "",
  url: "http://localhost:5173/checkout",
}

test("formats annotations as a structured chat block", () => {
  const text = formatAnnotationsForChat([pin, area], { url: "http://localhost:5173/checkout", title: "结算页" }, labels)
  const lines = text.split("\n")
  assert.equal(lines[0], "网页标注 · 结算页")
  assert.equal(lines[1], "http://localhost:5173/checkout")
  assert.match(lines[3], /^1\. 元素 `button\.btn:nth-of-type\(2\)` "提交订单"$/)
  assert.match(lines[4], /^   评论: 移动端溢出$/)
  assert.match(lines[6], /^2\. 区域 \(100, 200\) 300×121$/)
  // 区域没有评论时不再输出评论行。
  assert.equal(lines.length, 7)
})

test("annotations can be filtered back to their page ignoring hash", () => {
  const all = [pin, area]
  assert.equal(annotationsForPage(all, "http://localhost:5173/checkout").length, 2)
  assert.equal(annotationsForPage(all, "http://localhost:5173/checkout#done").length, 2)
  assert.equal(annotationsForPage(all, "http://localhost:5173/other").length, 0)
  assert.equal(annotationsForPage(all, "http://localhost:5173/checkout?x=1").length, 0)
})

test("sameUrl compares origin, path and search but not hash", () => {
  assert.equal(sameUrl("http://a.dev/x", "http://a.dev/x"), true)
  assert.equal(sameUrl("http://a.dev/x?q=1", "http://a.dev/x?q=1"), true)
  assert.equal(sameUrl("http://a.dev/x#top", "http://a.dev/x"), true)
  assert.equal(sameUrl("http://a.dev/x", "http://b.dev/x"), false)
  assert.equal(sameUrl("http://a.dev/x?q=1", "http://a.dev/x?q=2"), false)
  assert.equal(sameUrl("not a url", "http://a.dev"), false)
})

test("annotation ids are unique", () => {
  assert.notEqual(nextAnnotationId(), nextAnnotationId())
})
