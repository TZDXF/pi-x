import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface SplitTestWindow {
  __splitEvents: string[]
  __splitTree: () => unknown
  __splitReset: (primary: string, secondary: string) => void
}

const html = `<!doctype html><html><body><div id="app" style="height: 100vh"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import SplitChatLayout from '/src/components/SplitChatLayout.vue'
import { splitView, enterSplit, closePane, leafByRuntime } from '/src/stores/splitView.ts'
import '/src/style.css'

const events = []
const activeLeafId = ref(null)
const runtimeTitle = id => '会话 ' + id

const app = createApp({
  setup() {
    const wire = () => {
      activeLeafId.value = leafByRuntime('primary') ? 'primary-leaf' : null
    }
    window.__splitEvents = events
    window.__splitTree = () => JSON.parse(JSON.stringify(splitView.tree))
    window.__splitReset = (primary, secondary) => {
      enterSplit(primary, secondary, 'horizontal')
      wire()
    }
    enterSplit('primary', 'secondary', 'horizontal')
    wire()
    return () =>
      h(SplitChatLayout, {
        tree: splitView.tree,
        activeLeafId: activeLeafId.value,
        onActivate: id => events.push('activate:' + id),
        onClose: id => {
          events.push('close:' + id)
          const leaf = leafByRuntime(id)
          if (leaf) closePane(leaf.id)
        },
      }, {
        paneTitle: ({ runtimeId }) => runtimeTitle(runtimeId),
        pane: ({ runtimeId, active }) =>
          h('div', { 'data-pane': runtimeId, 'data-active': String(active) }, 'pane ' + runtimeId),
      })
  },
})
app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } }))
app.mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "split-view", port: 1467, html })
})

test.afterAll(async () => {
  await harness?.close()
})


test("renders one pane per conversation with active highlighting", async ({ page }) => {
  await page.goto(harness.url)
  await expect(page.locator("[data-pane='primary']")).toBeVisible()
  await expect(page.locator("[data-pane='secondary']")).toBeVisible()
  await expect(page.locator("[data-pane='primary'][data-active='true']")).toHaveCount(0)
})

test("pointer down activates the pane under the cursor", async ({ page }) => {
  await page.goto(harness.url)
  await page.locator("[data-pane='secondary']").click()
  const events = await page.evaluate(() => (window as unknown as SplitTestWindow).__splitEvents)
  expect(events).toContain("activate:secondary")
})

test("closing a pane removes it from the tree", async ({ page }) => {
  await page.goto(harness.url)
  await page.locator("button[aria-label='关闭此窗格']").first().click()
  const tree = (await page.evaluate(() => (window as unknown as SplitTestWindow).__splitTree())) as
    | { kind: string; children?: Array<{ runtimeId?: string }>; runtimeId?: string }
    | null
  // 关闭后仅剩一个叶子：组折叠成单叶，叶上不再有 children。
  const remaining = tree?.kind === "group" ? tree.children?.map(child => child.runtimeId) : [tree?.runtimeId]
  expect(remaining).toEqual(["secondary"])
})