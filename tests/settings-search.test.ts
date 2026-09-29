import { test, expect } from "vitest"
import { matchesSettingsSearch, scoreSettingsSearch, searchSnippet, settingsSearchText } from "@/lib/settings-search"

test("settings search matches every whitespace-separated term", () => {
  expect(matchesSettingsSearch("主题", "常规 外观主题")).toBe(true)
  expect(matchesSettingsSearch("  AI  model ", "AI default Model")).toBe(true)
  expect(matchesSettingsSearch("AI missing", "AI model")).toBe(false)
  expect(matchesSettingsSearch("  ", "主题")).toBe(false)
})

test("localized i18n messages flatten into search text", () => {
  expect(settingsSearchText({ title: "供应商", child: { backup: "API Key" }, other: null })).toBe("供应商 API Key ")
  expect(settingsSearchText(undefined)).toBe("")
})

test("search scores menu titles above descriptions and returns snippets only for fallback hits", () => {
  const titleHit = scoreSettingsSearch("端口", {
    title: "局域网访问",
    category: "设置",
    details: "监听端口 访问密码",
  })
  expect(titleHit?.score).toBe(1)
  expect(titleHit?.snippet ?? "").toMatch(/监听端口/)

  const titleAndCategory = scoreSettingsSearch("局域网", {
    title: "局域网访问",
    category: "设置",
    details: "端口",
  })
  expect(titleAndCategory?.score).toBe(100)
  expect(titleAndCategory?.snippet).toBe("")

  expect(scoreSettingsSearch("缺失", { title: "常规", category: "设置", details: "主题" })).toBe(null)
  expect(searchSnippet("常规 外观主题 语言", "语言")).toBe("常规 外观主题 语言")
})
