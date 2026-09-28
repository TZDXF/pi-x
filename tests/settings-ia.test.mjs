import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("settings menus use the grouped information architecture", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const general = read("../src/components/settings/GeneralSettings.vue")
  const workspace = read("../src/components/settings/WorkspaceSettings.vue")
  const page = read("../src/components/SettingsPage.vue")

  assert.match(router, /"workspace",/)
  assert.match(tabs, /SETTINGS_GROUP_DEFS/)
  assert.match(tabs, /id: "workspace",[\s\S]*?\.\/WorkspaceSettings\.vue/)
  assert.match(tabs, /"modelConversation",[\s\S]*?tabIds: \["models", "model-config", "retry"\]/)
  assert.match(tabs, /"extensions",[\s\S]*?tabIds: \["packages", "agent-config", "skills"\]/)
  assert.doesNotMatch(general, /OpenWithSettings/)
  assert.doesNotMatch(general, /ProjectlessSettings/)
  assert.match(workspace, /OpenWithSettings/)
  assert.match(workspace, /ProjectlessSettings/)
  assert.match(page, /v-for="group in visibleGroups"/)
  assert.match(page, /<ScrollArea class="settings-menu/)
  assert.match(page, /NAV_WIDTH_STORAGE_KEY = "pix\.settings-nav-width"/)
  assert.match(page, /startNavResize/)
  assert.match(page, /resizeNavWithKeyboard/)
  assert.match(page, /17rem/)
})
