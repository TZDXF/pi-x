import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("archived sessions live in a settings tab and the sidebar entry is gone", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const app = read("../src/App.vue")
  const sidebar = read("../src/components/WorkspaceSidebar.vue")

  assert.match(router, /"archives",/)
  // 旧链接仍可达，但会落到设置里的归档标签。
  assert.match(router, /segments\[0\] === "archives"[\s\S]*?tab: "archives"/)
  assert.doesNotMatch(router, /name: "archives"/)
  assert.match(tabs, /id: "archives"[\s\S]*?import\("@\/components\/ArchivedSessionsPage\.vue"\)/)
  assert.match(tabs, /"general",[\s\S]*?tabIds: \["general", "shortcuts", "notifications", "remote", "archives", "about"\]/)
  assert.match(app, /registerShortcutHandler\("app\.archives", \(\) => navigate\("\/settings\/archives"\)\)/)
  assert.doesNotMatch(sidebar, /emit\('archives'\)/)
  assert.doesNotMatch(sidebar, /archives: \[\]/)
})

test("the archived session panel keeps search, restore and delete", () => {
  const page = read("../src/components/ArchivedSessionsPage.vue")

  assert.match(page, /<Search :size="14"/)
  assert.match(page, /restore\(s\)/)
  assert.match(page, /async function remove\(s: SessionMeta\)/)
  // 面板由设置页提供滚动容器与标题，这里不再自带 ScrollArea 与页头。
  assert.doesNotMatch(page, /ScrollArea/)
  assert.doesNotMatch(page, /<h1/)
})

test("archived session list, restore and delete work through remote dispatch", () => {
  const remote = read("../src-tauri/src/remote.rs")

  assert.match(remote, /"session_list_archived" =>/)
  assert.match(remote, /"session_update" =>/)
  assert.match(remote, /"session_delete" =>/)
})

test("archiving hides the row immediately without disabling the rest of the sidebar", () => {
  const sidebar = read("../src/components/WorkspaceSidebar.vue")

  // 点击归档立即隐藏该行（乐观更新），失败时清掉标记撤回。
  assert.match(sidebar, /async function archive\(s: SessionMeta\)/)
  assert.match(sidebar, /archiving\.value\[s\.file\] = true/)
  assert.match(sidebar, /finally \{\s*delete archiving\.value\[s\.file\]/)
  assert.match(sidebar, /!archiving\.value\[s\.file\] &&/)
  // 归档不再占用共享的 saving 标志，因此不会连带禁用整个列表。
  const archive = sidebar.slice(sidebar.indexOf("async function archive("))
  assert.doesNotMatch(archive.slice(0, archive.indexOf("\n}")), /saving\.value/)
})
