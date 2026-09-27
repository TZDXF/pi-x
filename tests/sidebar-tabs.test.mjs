import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('right sidebar hosts review, files and terminal as addable tabs', () => {
  const chat = read('../src/components/ChatView.vue')
  const sidebar = read('../src/components/RightSidebar.vue')
  const terminal = read('../src/components/terminal/TerminalPanel.vue')
  assert.match(chat, /<RightSidebar v-show="sidebarOpen" :open="sidebarOpen" :tabs="sidebarTabs" :active-id="activeTabId"/)
  assert.match(sidebar, /role="tablist"/)
  assert.match(sidebar, /v-for="tab in tabs"/)
  assert.match(sidebar, /@click="addTab\('review'\)"/)
  assert.match(sidebar, /@click="addTab\('files'\)"/)
  assert.match(sidebar, /@click="addTab\('terminal'\)"/)
  assert.match(sidebar, /v-else-if="tab.type === 'files'" v-show="tab.id === activeId"/)
  assert.match(sidebar, /v-else-if="tab.type === 'terminal' && isDesktop" v-show="tab.id === activeId"/)
  assert.match(sidebar, /:focus="tab.id === activeId \? focus : null"/)
  assert.match(terminal, /if \(!tabs\.value\.length && !props\.embedded\) emit\("close"\)/)
  assert.doesNotMatch(chat, /<TerminalPanel/)
})

test('terminal top tab opens a shell directly instead of lingering on the empty state', () => {
  const sidebar = read('../src/components/RightSidebar.vue')
  const terminal = read('../src/components/terminal/TerminalPanel.vue')
  // 经 + 菜单添加终端 tab 时面板挂载即 visible=true，watch 需 immediate 才能自动开 shell。
  assert.match(terminal, /if \(!visible\) return/)
  assert.match(terminal, /\{ immediate: true \}/)
  // 顶部 tab 点击统一走 clickTab；已激活且无 shell 的终端 tab 再点一次直接新建。
  assert.match(sidebar, /@click="clickTab\(tab\)"/)
  assert.match(sidebar, /function clickTab\(tab: SidebarTabItem\)/)
  assert.match(sidebar, /if \(wasActive && tab\.type === "terminal"\)/)
  assert.match(sidebar, /:ref="el => setTerminalPanel\(tab\.id, el\)"/)
})

test('browser tab works on desktop and remote with chat insert support', () => {
  const sidebar = read('../src/components/RightSidebar.vue')
  const chat = read('../src/components/ChatView.vue')
  const panel = read('../src/components/browser/BrowserPanel.vue')
  // 浏览器面板在远程(浏览器)模式下也可用,不得挂 isDesktop 门槛。
  assert.match(sidebar, /v-else-if="tab\.type === 'browser'" v-show="tab\.id === activeId"/)
  assert.match(sidebar, /@send-to-chat="\$emit\('send-to-chat', \$event\)"/)
  assert.match(chat, /@send-to-chat="insertIntoComposer"/)
  assert.match(chat, /function insertIntoComposer\(text: string\)/)
  // 渲染走 iframe + 代理,而不是 Electron 专有的 webview 标签。
  assert.doesNotMatch(panel, /<webview/)
  assert.match(panel, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"/)
  assert.match(panel, /previewProxyInfo\(\)/)
  // 标注结果可格式化为发给 AI 的文本。
  assert.match(panel, /insertIntoChat/)
  assert.match(read('../src/lib/previewAnnotations.ts'), /export function formatAnnotationsForChat/)
  // 代理仅由后端提供,远程 dispatch 必须放行 preview_proxy_info。
  assert.match(read('../src-tauri/src/remote.rs'), /"preview_proxy_info" =>/)
})

test('sidebar tab state lives in ChatView with per-type add, close and review focus', () => {
  const chat = read('../src/components/ChatView.vue')
  assert.match(chat, /const sidebarTabs = ref<SidebarTabItem\[\]>\(\[\]\)/)
  assert.match(chat, /function addSidebarTab\(type: SidebarTabType\)/)
  assert.match(chat, /function closeSidebarTab\(id: number\)/)
  assert.match(chat, /function openReviewAt\(path: string\)/)
  assert.match(chat, /else addSidebarTab\("review"\)/)
  assert.match(chat, /@add-tab="addSidebarTab"/)
  assert.match(chat, /@close-tab="closeSidebarTab"/)
})

test('project directory is available locally and remotely with containment checks', () => {
  const files = read('../src-tauri/src/fs_search.rs')
  assert.match(files, /relative\.components\(\)\.any/)
  assert.match(files, /!directory\.starts_with\(&root\)/)
  assert.match(files, /kind\.is_symlink\(\)/)
  assert.match(read('../src-tauri/src/lib.rs'), /commands::list_project_directory/)
  assert.match(read('../src-tauri/src/remote.rs'), /"list_project_directory" =>/)
})