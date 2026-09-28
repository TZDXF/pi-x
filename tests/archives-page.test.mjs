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
