import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import SplitChatLayout from '/src/components/SplitChatLayout.vue'
import ChatView from '/src/components/ChatView.vue'
import WindowTitleBar from '/src/components/WindowTitleBar.vue'
import { sessionFor, activateSession, activeRuntimeId } from '/src/stores/conversations.ts'
import { splitView, enterSplit, closePane, leafByRuntime, insertAdjacent } from '/src/stores/splitView.ts'
import '/src/style.css'
const layout = new URLSearchParams(location.search).get('layout') || 'horizontal'
const app = createApp({ setup() {
  const rightOpen = ref(false)
  for (const id of ['primary', 'secondary', 'third']) {
    const session = sessionFor(id)
    session.cwd = 'C:/demo'
    session.sessionFile = id + '.jsonl'
    session.entries = Array.from({length: 30}, (_, i) => ({ kind: 'user', id: i + 1,
      text: id + ' message ' + i + '\\n' + 'A long conversation to scroll. '.repeat(12), images: [] }))
  }
  activateSession('primary')
  enterSplit('primary', 'secondary', layout === 'vertical' ? 'vertical' : 'horizontal')
  if (layout === 'nested') insertAdjacent(leafByRuntime('secondary').id, 'bottom', 'third')
  return () => h('div', {class: 'flex h-screen overflow-hidden', style: 'padding-top:36px'}, [
    h(WindowTitleBar, {showRightSidebar: true, rightSidebarOpen: rightOpen.value,
      onToggleRightSidebar: () => rightOpen.value = !rightOpen.value}),
    h('aside', {'data-testid': 'left-sidebar', style: 'width:160px;flex-shrink:0'}, 'Workspace sidebar'),
    h('main', {id: 'workspace-main', class: 'flex flex-1 min-h-0 min-w-0 relative overflow-hidden'}, [
      h('div', {class: 'flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden'}, [
        h(SplitChatLayout, {tree: splitView.tree, activeLeafId: leafByRuntime(activeRuntimeId.value)?.id,
          onActivate: activateSession}, {
          pane: ({runtimeId}) => h(ChatView, {key: runtimeId, sessionId: runtimeId, project: 'C:/demo',
            splitPane: splitView.tree.kind === 'group', sidebarTarget: '#workspace-main', rightSidebarOpen: rightOpen.value,
            'onUpdate:rightSidebarOpen': value => rightOpen.value = value,
            onClosePane: () => { closePane(leafByRuntime(runtimeId).id); activateSession('secondary') },
            ensureStarted: async () => false, connecting: false, connected: false}),
        }),
      ]),
    ]),
  ])
} })
app.use(createPinia()).use(createI18n({legacy: false, locale: 'en', messages: {en: messages}})).mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "split-view", port: 1467, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 1600, height: 1100 } })

for (const layout of ["horizontal", "vertical", "nested"]) {
  test(`${layout} panes retain scrollable history and visible composers`, async ({ page }) => {
    await page.goto(`${harness.url}?layout=${layout}`)
    const panes = page.locator("[data-pane-runtime-id]")
    await expect(panes).toHaveCount(layout === "nested" ? 3 : 2)
    for (const pane of await panes.all()) {
      await expect(pane).toHaveCSS("border-radius", "0px")
      await expect(pane.locator("header")).toHaveCount(1)
      await expect(pane.locator(".composer-rich-editor")).toBeInViewport()
      const bounds = await pane.evaluate(element => {
        const paneRect = element.getBoundingClientRect()
        const composer = element.querySelector(".composer-dock")!.getBoundingClientRect()
        const log = element.querySelector<HTMLElement>('[role="log"]')!
        return {
          bottom: composer.bottom,
          paneBottom: paneRect.bottom,
          height: log.clientHeight,
          scrollHeight: log.scrollHeight,
        }
      })
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.paneBottom + 1)
      expect(bounds.height).toBeGreaterThan(50)
      expect(bounds.scrollHeight).toBeGreaterThan(bounds.height)
      const log = pane.locator('[role="log"]')
      await log.hover()
      await page.mouse.wheel(0, -10000)
      await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeLessThan(100)
      await page.mouse.wheel(0, 350)
      await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
    }
  })
}

test("titlebar toggles a single workspace sidebar outside all split panes", async ({ page }) => {
  await page.goto(harness.url)
  const toggle = page.getByTestId("window-titlebar").getByRole("button", { name: "Toggle right panel" })
  await expect(toggle).toHaveCount(1)
  await expect(page.getByTestId("window-titlebar").getByRole("button", { name: "Toggle right panel" })).toBeVisible()
  await toggle.click()
  await expect(page.locator("#workspace-main > .changes-sidebar:visible")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Toggle right panel" })).toHaveCount(1)
  await expect(page.locator("[data-pane-runtime-id] .changes-sidebar")).toHaveCount(0)
  await expect(page.locator("[data-pane-runtime-id] [data-testid='left-sidebar']")).toHaveCount(0)
  const sidebar = page.locator(".changes-sidebar:visible")
  const sidebarRect = await sidebar.boundingBox()
  for (const pane of await page.locator("[data-pane-runtime-id]").all()) {
    const rect = await pane.boundingBox()
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(sidebarRect!.x + 1)
  }
  await page.locator('[data-runtime-id="secondary"] .workspace-header').click()
  await expect(page.locator('[data-runtime-id="secondary"]')).toHaveClass(/border-primary/)
  await expect(page.locator("#workspace-main > .changes-sidebar:visible")).toHaveCount(1)
  await toggle.click()
  await expect(page.locator(".changes-sidebar:visible")).toHaveCount(0)
})

for (const layout of ["horizontal", "vertical", "nested"]) {
  test(`${layout} closing to one pane removes split controls and borders`, async ({ page }) => {
    await page.goto(`${harness.url}?layout=${layout}`)
    const close = page.getByRole("button", { name: "Close pane" })
    await expect(close).toHaveCount(layout === "nested" ? 3 : 2)
    if (layout === "nested") {
      await page.locator('[data-runtime-id="third"]').getByRole("button", { name: "Close pane" }).click()
      await expect(close).toHaveCount(2)
    }
    await page.locator('[data-runtime-id="primary"]').getByRole("button", { name: "Close pane" }).click()
    await expect(page.locator("[data-pane-runtime-id]")).toHaveCount(1)
    await expect(close).toHaveCount(0)
    const remaining = page.locator('[data-runtime-id="secondary"]')
    await expect(remaining).toHaveCSS("border-width", "0px")
    await expect(remaining).toHaveCSS("border-radius", "0px")
    await expect(remaining.locator(".composer-rich-editor")).toBeInViewport()
  })
}
