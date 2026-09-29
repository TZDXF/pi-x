import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("archived sessions live in a settings tab and the sidebar entry is gone", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const app = read("../src/App.vue")
  const sidebar = read("../src/components/WorkspaceSidebar.vue")

  expect(router).toMatch(/"archives",/)
  // 旧链接仍可达，但会落到设置里的归档标签。
  expect(router).toMatch(/segments\[0\] === "archives"[\s\S]*?tab: "archives"/)
  expect(router).not.toMatch(/name: "archives"/)
  expect(tabs).toMatch(/id: "archives"[\s\S]*?import\("@\/components\/ArchivedSessionsPage\.vue"\)/)
  expect(tabs).toMatch(
    /"general",[\s\S]*?tabIds: \["general", "shortcuts", "notifications", "remote", "archives", "about"\]/,
  )
  expect(app).toMatch(/registerShortcutHandler\("app\.archives", \(\) => navigate\("\/settings\/archives"\)\)/)
  expect(sidebar).not.toMatch(/emit\('archives'\)/)
  expect(sidebar).not.toMatch(/archives: \[\]/)
})

test("the archived session panel keeps search, restore and delete", () => {
  const page = read("../src/components/ArchivedSessionsPage.vue")

  expect(page).toMatch(/<Search :size="14"/)
  expect(page).toMatch(/restore\(s\)/)
  expect(page).toMatch(/async function remove\(s: SessionMeta\)/)
  // 面板由设置页提供滚动容器与标题，这里不再自带 ScrollArea 与页头。
  expect(page).not.toMatch(/ScrollArea/)
  expect(page).not.toMatch(/<h1/)
})

test("archived session list, restore and delete work through remote dispatch", () => {
  const remote = read("../src-tauri/src/remote.rs")

  expect(remote).toMatch(/"session_list_archived" =>/)
  expect(remote).toMatch(/"session_update" =>/)
  expect(remote).toMatch(/"session_delete" =>/)
})

test("archiving hides the row immediately without disabling the rest of the sidebar", () => {
  const sidebar = read("../src/components/WorkspaceSidebar.vue")

  // 点击归档立即隐藏该行（乐观更新），失败时清掉标记撤回。
  expect(sidebar).toMatch(/async function archive\(s: SessionMeta\)/)
  expect(sidebar).toMatch(/archiving\.value\[s\.file\] = true/)
  expect(sidebar).toMatch(/finally \{\s*delete archiving\.value\[s\.file\]/)
  expect(sidebar).toMatch(/!archiving\.value\[s\.file\] &&/)
  // 归档不再占用共享的 saving 标志，因此不会连带禁用整个列表。
  const archive = sidebar.slice(sidebar.indexOf("async function archive("))
  expect(archive.slice(0, archive.indexOf("\n}"))).not.toMatch(/saving\.value/)
})
