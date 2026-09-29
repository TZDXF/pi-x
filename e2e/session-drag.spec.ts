import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

// Use the actual sidebar and native mouse drag: synthetic DataTransfer events
// cannot catch writes attempted after the browser's dragstart writable phase.
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, computed } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import WorkspaceSidebar from '/src/components/WorkspaceSidebar.vue'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import { useSessionDrop } from '/src/composables/useSessionDrop.ts'
import { splitView, splitAtEdge } from '/src/stores/splitView.ts'
import '/src/style.css'
const app = createApp({ setup() {
  const workspace = useWorkspaceStore()
  const task = new URLSearchParams(location.search).has('task')
  const path = task ? 'C:/tasks' : 'C:/demo'
  workspace.projects = task ? [] : [path]
  workspace.projectless = task ? path : ''
  workspace.histories[path] = [{ file: '/sessions/other.jsonl', id: 'other', title: 'Drag me', mtime: 1 }]
  workspace.refresh = async () => {}
  workspace.rememberWorkspace = async () => {}
  const text = ref('hello')
  const bridge = ref({ get textInput() { return text.value }, setTextInput(value) { text.value = value } })
  const drop = useSessionDrop({ sessionFile: '/sessions/current.jsonl' }, bridge,
    computed(() => workspace.histories[path]), (payload, zone) => splitAtEdge('current', zone, payload.file))
  return () => h('div', { style: 'display:flex;height:100vh' }, [
    h(WorkspaceSidebar, { project: path, ready: true, busy: false }),
    h('main', { 'data-testid': 'target', style: 'flex:1;position:relative',
      onDragoverCapture: drop.onSessionDragOver, onDragleave: drop.onSessionDragLeave, onDropCapture: drop.onSessionDrop }, [
      h('output', { 'data-testid': 'zone' }, drop.splitZone.value || ''),
      h('output', { 'data-testid': 'tree' }, JSON.stringify(splitView.tree)),
      h('textarea', { 'data-testid': 'composer', value: text.value }),
    ]),
  ])
} })
app.use(createPinia()).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } }))
app.mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "session-drag", port: 1468, html })
})
test.afterAll(async () => {
  await harness?.close()
})

for (const task of [false, true]) {
  for (const zone of ["left", "right", "top", "bottom", "center"] as const) {
    test(`${task ? "task" : "project"} session native drag to ${zone}`, async ({ page }) => {
      await page.goto(harness.url + (task ? "?task" : ""))
      const source = page.locator('.session-row[data-file="/sessions/other.jsonl"]')
      await expect(source).toBeVisible()
      const target = page.getByTestId("target")
      const rect = await target.boundingBox()
      if (!rect) throw new Error("Missing drop target")
      await source.dragTo(target, {
        targetPosition: {
          x: rect.width * (zone === "left" ? 0.05 : zone === "right" ? 0.95 : 0.5),
          y: rect.height * (zone === "top" ? 0.05 : zone === "bottom" ? 0.95 : 0.5),
        },
      })
      if (zone === "center") {
        await expect(page.getByTestId("composer")).toHaveValue('hello @session("/sessions/other.jsonl") ')
        await expect(page.getByTestId("tree")).toHaveText("null")
      } else {
        await expect(page.getByTestId("tree")).not.toHaveText("null")
        const tree = JSON.parse((await page.getByTestId("tree").textContent())!)
        expect(tree.direction).toBe(zone === "left" || zone === "right" ? "horizontal" : "vertical")
        const ids = tree.children.map((leaf: { runtimeId: string }) => leaf.runtimeId)
        expect(ids).toEqual(
          zone === "left" || zone === "top"
            ? ["/sessions/other.jsonl", "current"]
            : ["current", "/sessions/other.jsonl"],
        )
        await expect(page.getByTestId("composer")).toHaveValue("hello")
      }
      await expect(page.getByTestId("zone")).toBeEmpty()
      await expect(source).toHaveCount(1)
    })
  }
}
