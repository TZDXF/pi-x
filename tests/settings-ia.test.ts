import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("settings menus use the grouped information architecture", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const general = read("../src/components/settings/GeneralSettings.vue")
  const workspace = read("../src/components/settings/WorkspaceSettings.vue")
  const page = read("../src/components/SettingsPage.vue")

  expect(router).not.toMatch(/"workspace",/)
  expect(router).not.toMatch(/"retry",/)
  expect(tabs).toMatch(/SETTINGS_GROUP_DEFS/)
  expect(tabs).not.toMatch(/id: "workspace",/)
  expect(tabs).not.toMatch(/id: "retry",/)
  expect(tabs).toMatch(
    /"general",[\s\S]*?tabIds: \["general", "shortcuts", "notifications", "remote", "archives", "about"\]/,
  )
  expect(tabs).toMatch(
    /"capabilities",[\s\S]*?tabIds: \["models", "model-config", "packages", "agent-config", "skills"\]/,
  )
  expect(general).toMatch(/<WorkspaceSettings \/>/)
  expect(general).toMatch(/<RetrySettings v-if="isDesktop" \/>/)
  expect(workspace).toMatch(/OpenWithSettings/)
  expect(workspace).toMatch(/ProjectlessSettings/)
  expect(page).toMatch(/v-for="group in visibleGroups"/)
  expect(page).toMatch(/<ScrollArea class="settings-menu/)
  expect(page).toMatch(/NAV_WIDTH_STORAGE_KEY = "pix\.settings-nav-width"/)
  expect(page).toMatch(/ResizablePanelGroup/)
  expect(page).toMatch(/resizeNavWithKeyboard/)
  expect(page).toMatch(/272px \/ `w-68`/)
})
