import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const source = readFileSync(new URL("../src/lib/settings-search.ts", import.meta.url), "utf8")
const { matchesSettingsSearch, scoreSettingsSearch, searchSnippet, settingsSearchText } = loadTsSource(source)

test("settings search matches every whitespace-separated term", () => {
  assert.equal(matchesSettingsSearch("主题", "常规 外观主题"), true)
  assert.equal(matchesSettingsSearch("  AI  model ", "AI default Model"), true)
  assert.equal(matchesSettingsSearch("AI missing", "AI model"), false)
  assert.equal(matchesSettingsSearch("  ", "主题"), false)
})

test("localized i18n messages flatten into search text", () => {
  assert.equal(settingsSearchText({ title: "供应商", child: { backup: "API Key" }, other: null }), "供应商 API Key ")
  assert.equal(settingsSearchText(undefined), "")
})

test("search scores menu titles above descriptions and returns snippets only for fallback hits", () => {
  const titleHit = scoreSettingsSearch("端口", {
    title: "局域网访问",
    category: "设置",
    details: "监听端口 访问密码",
  })
  assert.equal(titleHit?.score, 1)
  assert.match(titleHit?.snippet ?? "", /监听端口/)

  const titleAndCategory = scoreSettingsSearch("局域网", {
    title: "局域网访问",
    category: "设置",
    details: "端口",
  })
  assert.equal(titleAndCategory?.score, 100)
  assert.equal(titleAndCategory?.snippet, "")

  assert.equal(scoreSettingsSearch("缺失", { title: "常规", category: "设置", details: "主题" }), null)
  assert.equal(searchSnippet("常规 外观主题 语言", "语言"), "常规 外观主题 语言")
})
