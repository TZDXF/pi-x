import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("archived sessions use a workspace route outside settings", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const app = read("../src/App.vue")
  const sidebar = read("../src/components/WorkspaceSidebar.vue")
  const page = read("../src/components/ArchivedSessionsPage.vue")

  assert.match(router, /name: "archives"/)
  assert.match(router, /path: "\/archives"/)
  assert.doesNotMatch(router, /"archive",/)
  assert.doesNotMatch(tabs, /id: "archive",/)
  assert.match(app, /<ArchivedSessionsPage[^>]*v-if="route.name === 'archives'"/)
  assert.match(sidebar, /@click="emit\('archives'\)"/)
  assert.match(page, /<Search :size="14"/)
  assert.match(page, /restore\(s\)/)
  assert.match(page, /async function remove\(s: SessionMeta\)/)
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
