import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("right sidebar hosts review, files and terminal as addable tabs", () => {
  const chat = read("../src/components/ChatView.vue")
  const sidebar = read("../src/components/RightSidebar.vue")
  const terminal = read("../src/components/terminal/TerminalPanel.vue")
  expect(chat).toMatch(
    /<RightSidebar\s+v-show="sidebarOpen"\s+:open="sidebarOpen"\s+:tabs="sidebarTabs"\s+:active-id="activeTabId"/,
  )
  expect(sidebar).toMatch(/role="tablist"/)
  expect(sidebar).toMatch(/v-for="tab in tabs"/)
  expect(sidebar).toMatch(/@click="addTab\('review'\)"/)
  expect(sidebar).toMatch(/@click="addTab\('files'\)"/)
  expect(sidebar).toMatch(/@click="addTab\('terminal'\)"/)
  expect(sidebar).toMatch(/v-else-if="tab\.type === 'files'"\s+v-show="tab\.id === activeId"/)
  expect(sidebar).toMatch(/v-else-if="tab\.type === 'terminal' && isDesktop"\s+v-show="tab\.id === activeId"/)
  expect(sidebar).toMatch(/:focus="tab.id === activeId \? focus : null"/)
  expect(terminal).toMatch(/if \(!tabs\.value\.length && !props\.embedded\) emit\("close"\)/)
  expect(chat).not.toMatch(/<TerminalPanel/)
})

test("terminal top tab opens a shell directly instead of lingering on the empty state", () => {
  const sidebar = read("../src/components/RightSidebar.vue")
  const terminal = read("../src/components/terminal/TerminalPanel.vue")
  // 经 + 菜单添加终端 tab 时面板挂载即 visible=true，watch 需 immediate 才能自动开 shell。
  expect(terminal).toMatch(/if \(!visible\) return/)
  expect(terminal).toMatch(/\{ immediate: true \}/)
  // 顶部 tab 点击统一走 clickTab；已激活且无 shell 的终端 tab 再点一次直接新建。
  expect(sidebar).toMatch(/@click="clickTab\(tab\)"/)
  expect(sidebar).toMatch(/function clickTab\(tab: SidebarTabItem\)/)
  expect(sidebar).toMatch(/if \(wasActive && tab\.type === "terminal"\)/)
  expect(sidebar).toMatch(/:ref="el => setTerminalPanel\(tab\.id, el\)"/)
})

test("browser tab works on desktop and remote with chat insert support", () => {
  const sidebar = read("../src/components/RightSidebar.vue")
  const chat = read("../src/components/ChatView.vue")
  const panel = read("../src/components/browser/BrowserPanel.vue")
  // 浏览器面板在远程(浏览器)模式下也可用,不得挂 isDesktop 门槛。
  expect(sidebar).toMatch(/v-else-if="tab\.type === 'browser'"\s+v-show="tab\.id === activeId"/)
  expect(sidebar).toMatch(/@send-to-chat="\$emit\('send-to-chat', \$event\)"/)
  expect(chat).toMatch(/@send-to-chat="insertIntoComposer"/)
  expect(chat).toMatch(/function insertIntoComposer\(text: string\)/)
  // 渲染走 iframe + 代理,而不是 Electron 专有的 webview 标签。
  expect(panel).not.toMatch(/<webview/)
  expect(panel).toMatch(/:sandbox="sandboxAttr"/)
  expect(panel).toMatch(/previewProxyInfo\(\)/)
  // 标注结果可格式化为发给 AI 的文本。
  expect(panel).toMatch(/insertIntoChat/)
  expect(read("../src/lib/previewAnnotations.ts")).toMatch(/export function formatAnnotationsForChat/)
  // 代理仅由后端提供,远程 dispatch 必须放行 preview_proxy_info。
  expect(read("../src-tauri/src/remote.rs")).toMatch(/"preview_proxy_info" =>/)
})

test("sidebar tab state lives in ChatView with per-type add, close and review focus", () => {
  const chat = read("../src/components/ChatView.vue")
  expect(chat).toMatch(/const sidebarTabs = ref<SidebarTabItem\[\]>\(\[\]\)/)
  expect(chat).toMatch(/function addSidebarTab\(type: SidebarTabType\)/)
  expect(chat).toMatch(/function closeSidebarTab\(id: number\)/)
  expect(chat).toMatch(/function openReviewAt\(path: string\)/)
  expect(chat).toMatch(/else addSidebarTab\("review"\)/)
  expect(chat).toMatch(/@add-tab="addSidebarTab"/)
  expect(chat).toMatch(/@close-tab="closeSidebarTab"/)
})

test("project directory is available locally and remotely with containment checks", () => {
  const files = read("../src-tauri/src/fs_search.rs")
  expect(files).toMatch(/relative\s*\.\s*components\(\)\s*\.\s*any/)
  expect(files).toMatch(/!directory\.starts_with\(&root\)/)
  expect(files).toMatch(/kind\.is_symlink\(\)/)
  expect(read("../src-tauri/src/lib.rs")).toMatch(/commands::list_project_directory/)
  expect(read("../src-tauri/src/remote.rs")).toMatch(/"list_project_directory" =>/)
})
