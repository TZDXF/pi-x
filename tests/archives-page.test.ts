import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("archived sessions live in a settings tab and the sidebar entry is gone", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  // 快捷键注册在 App 的 shortcuts composable 中。
  const shortcuts = read("../src/composables/useAppShortcuts.ts")
  const sidebar = read("../src/components/WorkspaceSidebar.vue")

  expect(router).toMatch(/"archives",/)
  // 旧链接仍可达，但会落到设置里的归档标签。
  expect(router).toMatch(/segments\[0\] === "archives"[\s\S]*?tab: "archives"/)
  expect(router).not.toMatch(/name: "archives"/)
  expect(tabs).toMatch(/id: "archives"[\s\S]*?import\("@\/components\/ArchivedSessionsPage\.vue"\)/)
  expect(tabs).toMatch(/"other",[\s\S]*?tabIds: \["model-config", "archives", "about"\]/)
  expect(shortcuts).toMatch(/registerShortcutHandler\("app\.archives", \(\) => navigate\("\/settings\/archives"\)\)/)
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

test("the archived session panel filters by project after the search box", () => {
  const page = read("../src/components/ArchivedSessionsPage.vue")

  expect(page).toMatch(/<Select v-model="filterProject">/)
  expect(page).toMatch(/<SelectItem value="all">/)
  expect(page).toMatch(/v-for="p in projects" :key="p\.cwd" :value="p\.cwd"/)
  // 过滤条件同时作用于分组列表与计数。
  expect(page).toMatch(/if \(fp !== "all" && s\.cwd !== fp\) continue/)
  expect(page).toMatch(/t\("sessionArchive\.count", \{ count: visibleCount \}\)/)
  // 被过滤的项目被删除后筛选条件自动回到“全部”。
  expect(page).toMatch(/filterProject\.value = "all"/)
})

test("bulk delete is exposed per project and for the whole page behind confirmation", () => {
  const page = read("../src/components/ArchivedSessionsPage.vue")

  // 每个项目名后的更多操作下拉。
  expect(page).toMatch(/<MoreHorizontal :size="15" \/>/)
  expect(page).toMatch(/@select="askRemoveAll\(group\.cwd\)"/)
  // 页面右上角的删除所有会话。
  expect(page).toMatch(/@click="askRemoveAll\(null\)"/)
  // 删除前必须经过确认对话框，并逐个调用 session_delete。
  expect(page).toMatch(/pendingClear\.value = \{ cwd, count: rows\.length \}/)
  expect(page).toMatch(/async function removeAll\(\)/)
  expect(page).toMatch(/await deleteSession\(s\.file\)/)
  expect(page).toMatch(/workspace\.removeSession\(s\.file\)/)
})

test("archived session list, restore and delete work through remote dispatch", () => {
  const remote = read("../src-tauri/src/remote/dispatch/session.rs")

  expect(remote).toMatch(/"session_list_archived" =>/)
  expect(remote).toMatch(/"session_update" =>/)
  expect(remote).toMatch(/"session_delete" =>/)
})

test("archiving hides the row immediately without disabling the rest of the sidebar", () => {
  const actions = read("../src/components/workspace/sidebar/useSidebarSessionActions.ts")
  const ordering = read("../src/components/workspace/sidebar/useSidebarSessionOrdering.ts")

  // 点击归档立即隐藏该行（乐观更新），失败时清掉标记撤回。
  expect(actions).toMatch(/async function archive\(session: SessionMeta\)/)
  expect(actions).toMatch(/archiving\.value\[session\.file\] = true/)
  expect(actions).toMatch(/finally \{\s*delete archiving\.value\[session\.file\]/)
  expect(ordering).toMatch(/!archiving\[session\.file\] &&/)
  // 归档不再占用共享的 saving 标志，因此不会连带禁用整个列表。
  const archive = actions.slice(actions.indexOf("async function archive("))
  expect(archive.slice(0, archive.indexOf("\n  }"))).not.toMatch(/saving\.value/)
})
