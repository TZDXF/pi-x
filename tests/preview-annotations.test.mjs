import { test, expect } from "vitest"
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
  expect(lines[0]).toBe("网页标注 · 结算页")
  expect(lines[1]).toBe("http://localhost:5173/checkout")
  expect(lines[3]).toMatch(/^1\. 元素 `button\.btn:nth-of-type\(2\)` "提交订单"$/)
  expect(lines[4]).toMatch(/^   评论: 移动端溢出$/)
  expect(lines[6]).toMatch(/^2\. 区域 \(100, 200\) 300×121$/)
  // 区域没有评论时不再输出评论行。
  expect(lines.length).toBe(7)
})

test("annotations can be filtered back to their page ignoring hash", () => {
  const all = [pin, area]
  expect(annotationsForPage(all, "http://localhost:5173/checkout").length).toBe(2)
  expect(annotationsForPage(all, "http://localhost:5173/checkout#done").length).toBe(2)
  expect(annotationsForPage(all, "http://localhost:5173/other").length).toBe(0)
  expect(annotationsForPage(all, "http://localhost:5173/checkout?x=1").length).toBe(0)
})

test("sameUrl compares origin, path and search but not hash", () => {
  expect(sameUrl("http://a.dev/x", "http://a.dev/x")).toBe(true)
  expect(sameUrl("http://a.dev/x?q=1", "http://a.dev/x?q=1")).toBe(true)
  expect(sameUrl("http://a.dev/x#top", "http://a.dev/x")).toBe(true)
  expect(sameUrl("http://a.dev/x", "http://b.dev/x")).toBe(false)
  expect(sameUrl("http://a.dev/x?q=1", "http://a.dev/x?q=2")).toBe(false)
  expect(sameUrl("not a url", "http://a.dev")).toBe(false)
})

test("annotation ids are unique", () => {
  expect(nextAnnotationId()).not.toBe(nextAnnotationId())
})
