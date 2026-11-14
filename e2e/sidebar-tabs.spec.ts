import { expect, test, type Page } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"

// Only heavy panel bodies are stubbed. The sidebar, ui/tabs, Reka focus handling,
// popover and VueDraggable are real; no backend or external service is contacted.
const panelTypes: Record<string, string> = {
  "/src/components/ReviewPanel.vue": "review",
  "/src/components/ProjectFiles.vue": "files",
  "/src/components/terminal/TerminalPanel.vue": "terminal",
  "/src/components/browser/BrowserPanel.vue": "browser",
}

/**
 * 轻量面板替身。
 *
 * terminal 替身**刻意复刻**真实 `TerminalPanel` 的关键行为：
 * `watch(() => props.visible, ..., { immediate: true })` —— 首次可见且没有 shell 时
 * 自动开一个（`embedded && !tabs.length → openTerminal()`）。没有这段，
 * `shellOpens === 0` 就不是有效反向证据：替身本来就不会自己开 shell。
 */
function panelSource(type: string) {
  return `<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
const props = defineProps(['visible', 'focus', 'project', 'changes', 'embedded'])
const emit = defineEmits(['send-to-chat'])
const fixture = window.sidebarFixture
const text = ref('')
const shell = ref(false)
onMounted(() => fixture.mounts.push('${type}'))
onUnmounted(() => fixture.unmounts.push('${type}'))
function openTerminal() { shell.value = true; fixture.shellOpens++; return Promise.resolve() }
if ('${type}' === 'terminal') {
  fixture.clearShell = () => { shell.value = false }
  // 与真实组件一致：首次可见（visible 为 true）即自开 shell。
  watch(() => props.visible, visible => {
    if (!visible) return
    nextTick(() => { if (!shell.value) void openTerminal() })
  }, { immediate: true })
}
defineExpose({ openTerminal, hasTerminals: () => shell.value })
</script>
<template><div data-panel="${type}" class="flex-1"><input aria-label="${type} state" v-model="text" />
<span data-visible>{{ visible }}</span><span data-focus>{{ focus }}</span>
<button v-if="'${type}' === 'browser'" @click="emit('send-to-chat', 'fixture annotation')">Insert annotation</button>
</div></template>`
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import RightSidebar from '/src/components/RightSidebar.vue'
import '/src/style.css'
import { defineComponent, h as vh, nextTick, ref as vref, onMounted, onUnmounted, watch } from 'vue'
import { useSidebarTabs } from '/src/composables/useSidebarTabs.ts'
const fixture = window.sidebarFixture = reactive({
  activeId: null, open: true,
  mounts: [], unmounts: [], shellOpens: 0, reorders: [], activations: [], closes: [], inserts: [], restarts: [],
  seeded: false, generation: 0
})
// 真实 composable + 模块级注册表：Tab 状态不放在组件里，卸载后仍存活（与生产一致）。
const store = {
  sidebarTabs: {},
  persistSidebarTabs(key, value) { if (value === null) delete this.sidebarTabs[key]; else this.sidebarTabs[key] = value },
}
const sessionFile = vref(null)
const project = 'C:/fixture'
const runtimeId = 'rt-e2e'
let apiRef = null
function seed() {
  const api = useSidebarTabs({ runtimeId, sessionFile, project: () => project, workspaceStore: store })
  if (!fixture.seeded) {
    api.add('review'); api.add('files'); api.add('review'); api.add('terminal'); api.add('browser')
    api.activeId.value = api.tabs.value[0].id
    fixture.seeded = true
  }
  apiRef = api
  return api
}
const Pane = defineComponent({
  setup() {
    const api = seed()
    onUnmounted(() => { fixture.unmounts.push('pane') })
    return () => vh(RightSidebar, {
      tabs: api.tabs.value, activeId: api.activeId.value, open: fixture.open,
      changes: [], project, focus: 'src/example.ts',
      'onUpdate:activeId': id => { fixture.activations.push(id); api.activeId.value = id },
      'onClose-tab': id => { fixture.closes.push(id); api.close(id) },
      'onAdd-tab': type => { api.add(type) },
      'onReorder-tabs': tabs => { fixture.reorders.push(tabs.map(tab => tab.id)); api.reorder(tabs) },
      'onSend-to-chat': text => fixture.inserts.push(text),
      'onRestart-terminal': id => { fixture.restarts.push(id); api.restartTerminal(id) }
    })
  }
})
let show = vref(true)
createApp({render:()=>vh('div',{style:'display:flex;height:650px;width:1400px'},[
  show.value ? vh(Pane, { key: fixture.generation }) : null
])}).use(createI18n({legacy:false,locale:'en',messages:{en:messages}})).mount('#app')
window.sidebarRemount = async () => { show.value = false; await nextTick(); fixture.generation++; show.value = true; await nextTick() }
window.sidebarTabsState = () => (apiRef ? apiRef.tabs.value.map(t => ({ id: t.id, type: t.type, stale: t.stale })) : [])
window.sidebarActivate = id => { if (apiRef) apiRef.activeId.value = id }
window.sidebarReorder = () => fixture.reorders.length
</script></body></html>`

interface SidebarFixture {
  seeded: boolean
  generation: number
  activeId: number | null
  open: boolean
  mounts: string[]
  unmounts: string[]
  shellOpens: number
  reorders: number[][]
  activations: number[]
  closes: number[]
  inserts: string[]
  restarts: number[]
  clearShell: () => void
}

declare global {
  interface Window {
    sidebarFixture: SidebarFixture
    sidebarRemount: () => Promise<void>
    sidebarTabsState: () => { id: number; type: string; stale?: boolean }[]
    sidebarActivate: (id: number) => void
    sidebarReorder: () => number
  }
}

let server: ViteDevServer
const url = "http://localhost:1473/__sidebar-tabs"

test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.config.ts",
    server: { port: 1473, strictPort: true },
    plugins: [
      {
        name: "sidebar-tabs-fixture",
        enforce: "pre",
        load(id) {
          const normalized = id.replace(/\\/g, "/")
          const entry = Object.entries(panelTypes).find(([suffix]) => normalized.endsWith(suffix))
          if (entry) return panelSource(entry[1])
        },
        configureServer(vite) {
          vite.middlewares.use("/__sidebar-tabs", async (_request, response, next) => {
            try {
              response.setHeader("Content-Type", "text/html")
              response.end(await vite.transformIndexHtml("/__sidebar-tabs", html))
            } catch (error) {
              next(error)
            }
          })
        },
      },
    ],
  })
  await server.listen()
})

test.afterAll(async () => {
  await server?.close()
})

test.beforeEach(async ({ page }) => {
  // Desktop detection only. The terminal panel is a deterministic lifecycle stub.
  await page.addInitScript(() => {
    Object.assign(window, { isTauri: !location.search.includes("remote") })
  })
  await page.goto(url)
  await expect(page.getByRole("tab")).toHaveCount(5)
})

async function active(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true })
  await expect(tab).toHaveAttribute("aria-selected", "true")
  const panelId = await tab.getAttribute("aria-controls")
  expect(panelId).toBeTruthy()
  const panel = page.locator(`[id="${panelId}"]`)
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute("role", "tabpanel")
  await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!)
  return panel
}

test("arrow/Home/End navigation activates linked panels and roves only through tabs", async ({ page }) => {
  await expect(page.getByRole("tablist", { name: "Right panel" })).toHaveCount(1)
  const review = page.getByRole("tab", { name: "Review 1", exact: true })
  await page.getByRole("separator").focus()
  await page.keyboard.press("Tab")
  await expect(review).toBeFocused()
  await review.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "Project files", exact: true })).toBeFocused()
  await active(page, "Project files")
  await page.keyboard.press("End")
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toBeFocused()
  await active(page, "Browser")
  await page.keyboard.press("ArrowRight")
  await expect(review).toBeFocused()
  await active(page, "Review 1")
  await page.keyboard.press("ArrowLeft")
  await active(page, "Browser")
  await page.keyboard.press("Home")
  await expect(review).toBeFocused()
  await active(page, "Review 1")
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1)
  // All five panels exist, but only the active one belongs to the accessible tree.
  await expect(page.locator('[role="tabpanel"]')).toHaveCount(5)
  await expect(page.getByRole("tabpanel")).toHaveCount(1)
})

test("close buttons are separate controls reachable by Tab, Enter and Space", async ({ page }) => {
  const review = page.getByRole("tab", { name: "Review 1", exact: true })
  await review.focus()
  await page.keyboard.press("Tab")
  const closeReview = page.getByRole("button", { name: "Close tab: Review 1", exact: true })
  await expect(closeReview).toBeFocused()
  await expect(closeReview).toHaveCSS("opacity", "1")
  await expect(page.locator('[role="tab"] button')).toHaveCount(0)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab")).toHaveCount(4)
  await active(page, "Project files")
  await expect(page.getByRole("tab", { name: "Project files", exact: true })).toBeFocused()
  // Closing an inactive terminal must neither activate it nor open a shell.
  const closeTerminal = page.getByRole("button", { name: "Close tab: Terminal", exact: true })
  await closeTerminal.focus()
  await closeTerminal.press("Space")
  await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toHaveCount(0)
  await active(page, "Project files")
  const state = await page.evaluate(() => ({
    closes: window.sidebarFixture.closes,
    shellOpens: window.sidebarFixture.shellOpens,
    activations: window.sidebarFixture.activations,
  }))
  expect(state.closes).toEqual([1, 4])
  expect(state.shellOpens).toBe(0)
  expect(state.activations).not.toContain(4)
})

test("duplicate-type panels retain independent state and stay mounted while hidden", async ({ page }) => {
  let panel = await active(page, "Review 1")
  await panel.getByRole("textbox").fill("first review draft")
  await page.getByRole("tab", { name: "Review 2", exact: true }).click()
  panel = await active(page, "Review 2")
  await panel.getByRole("textbox").fill("second review draft")
  await page.getByRole("tab", { name: "Project files", exact: true }).click()
  await page.getByRole("tab", { name: "Review 1", exact: true }).click()
  await expect((await active(page, "Review 1")).getByRole("textbox")).toHaveValue("first review draft")
  await page.getByRole("tab", { name: "Review 2", exact: true }).click()
  await expect((await active(page, "Review 2")).getByRole("textbox")).toHaveValue("second review draft")
  expect(await page.evaluate(() => window.sidebarFixture.mounts)).toEqual([
    "review",
    "files",
    "review",
    "terminal",
    "browser",
  ])
  expect(await page.evaluate(() => window.sidebarFixture.unmounts)).toEqual([])
  await expect(page.locator('[data-panel="review"] [data-focus]').first()).toHaveText("")
  await expect(panel.locator("[data-focus]")).toHaveText("src/example.ts")
})

// 注：替身现在复刻真实 `TerminalPanel` 的"首次可见即自开 shell"（`watch(visible, immediate)`），
// 因此本用例的历史期望（首次激活 shellOpens===0）按真实行为改写：首次激活就会开一个。
test("an empty terminal opens a shell on first show and on every reactivation", async ({ page }) => {
  const terminal = page.getByRole("tab", { name: "Terminal", exact: true })
  await terminal.click()
  await active(page, "Terminal")
  // 真实组件在首次可见时就自开 shell。
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(1)
  await terminal.click()
  expect(await page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(1)
  // 再点一次但 shell 已不在了 → 重新开（RightSidebar 的 reactivateTab 语义）。
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await terminal.click()
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(2)
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await terminal.press("Enter")
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(3)
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await terminal.press("Space")
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(4)
  await page.getByRole("tab", { name: "Review 1", exact: true }).click()
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await page.keyboard.press("End")
  await page.keyboard.press("ArrowLeft")
  await active(page, "Terminal")
  // 从隐藏回到可见（且没有 shell）也会自开一个。
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(5)
  await page.evaluate(() => {
    window.sidebarFixture.open = false
  })
  await expect((await active(page, "Terminal")).locator("[data-visible]")).toHaveText("false")
})

// TZD-95：走真实生命周期 —— 卸载后重挂载，terminal 必须自动转 stale，只渲染占位。
// 这条必须 E2E：单测无法证明"面板没被挂载"这一渲染层事实，而"不挂面板且 shellOpens 不增加"
// 正是恢复逻辑最容易静默退化的地方（TerminalPanel 首次可见即自开 shell）。
test("unmount then remount marks terminal stale and never mounts a terminal panel", async ({ page }) => {
  const terminalTab = page.getByRole("tab", { name: "Terminal", exact: true })
  await terminalTab.click()
  await active(page, "Terminal")
  // 卸载前：真实的 TerminalPanel 已挂载（这是"活着的 shell"），并且替身已经自开了一个。
  expect(await page.evaluate(() => window.sidebarFixture.mounts)).toContain("terminal")
  const shellOpensBeforeUnmount = await page.evaluate(() => window.sidebarFixture.shellOpens)
  expect(shellOpensBeforeUnmount).toBe(1)

  await page.evaluate(() => window.sidebarFixture.mounts = [])
  await page.evaluate(() => window.sidebarTabsState())
  await page.evaluate(() => window.sidebarRemount())
  await page.evaluate(() => window.sidebarRemount())

  // 重挂载后：terminal 在注册表里已被标 stale（不是靠夹具预填）。
  const terminalEntry = await page.evaluate(() =>
    window.sidebarTabsState().find(tab => tab.type === "terminal")
  )
  expect(terminalEntry?.stale).toBe(true)

  // 占位可见，且**没有**再挂 TerminalPanel、没有新开 shell。
  const placeholder = page.locator("[data-terminal-stale]").first()
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText("The terminal process exited with the previous run")
  expect(await page.evaluate(() => window.sidebarFixture.mounts)).not.toContain("terminal")
  // 基准是卸载前的 1，不在 0：重挂载不得让这个计数增长。
  expect(await page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(shellOpensBeforeUnmount)

  // 只有显式点"重新打开终端"才挂载面板 —— 并且**真的会自开一个 shell**
  // （替身复刻了真实组件的"首次可见自开 shell"，所以这里 shellOpens 必须增长，
  //  否则说明替身没模拟到位、上面的 0 也就不是有效反向证据）。
  await placeholder.getByRole("button", { name: "Reopen terminal" }).click()
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.mounts)).toContain("terminal")
  // 显式重开必须**真的**多开一个 shell —— 这才证明"替身会自开 shell"，
  // 也就证明重挂载后的"没增长"是有效反向证据。
  await expect
    .poll(() => page.evaluate(() => window.sidebarFixture.shellOpens))
    .toBe(shellOpensBeforeUnmount + 1)
})

test("real dragging emits reordered IDs and keyboard navigation follows the new DOM order", async ({ page }) => {
  const source = await page.getByRole("tab", { name: "Review 1", exact: true }).boundingBox()
  const target = await page.getByRole("tab", { name: "Review 2", exact: true }).boundingBox()
  if (!source || !target) throw new Error("Missing drag targets")
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width - 2, target.y + target.height / 2, { steps: 20 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.reorders.length)).toBeGreaterThan(0)
  // 顺序来自真实注册表（`useSidebarTabs`），不是夹具里的副本数组。
  const ids = await page.evaluate(() => window.sidebarTabsState().map(tab => tab.id))
  expect(ids).not.toEqual([1, 2, 3, 4, 5])
  expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  const selected = page.locator('[role="tab"][aria-selected="true"]')
  await selected.focus()
  await page.keyboard.press("Home")
  const activeId = () =>
    page.evaluate(() => window.sidebarFixture.activations[window.sidebarFixture.activations.length - 1])
  expect(await activeId()).toBe(ids[0])
  await page.keyboard.press("ArrowRight")
  expect(await activeId()).toBe(ids[1])
  await page.keyboard.press("End")
  expect(await activeId()).toBe(ids[ids.length - 1])
  expect(await page.evaluate(() => window.sidebarFixture.unmounts)).toEqual([])
})

test("adding and closing duplicate tabs and the empty state reuse existing labels", async ({ page }) => {
  await page.getByRole("button", { name: "Add tab", exact: true }).click()
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await expect(page.getByRole("tab")).toHaveCount(6)
  await active(page, "Browser 2")
  await page.getByRole("button", { name: "Close tab: Browser 2", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toHaveCount(1)
  for (let remaining = 5; remaining > 0; remaining--) {
    await page.locator(".sidebar-tab-close").first().click()
    await expect(page.getByRole("tab")).toHaveCount(remaining - 1)
  }
  await expect(page.getByRole("button", { name: "Add tab", exact: true })).toBeFocused()
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(page.locator('[role="tabpanel"]')).toHaveCount(0)
  await page.getByRole("button", { name: "Review", exact: true }).click()
  await active(page, "Review")
})

test("remote browser tabs keep visibility and send-to-chat without desktop gating", async ({ page }) => {
  await page.goto(`${url}?remote`)
  await page.getByRole("tab", { name: "Browser", exact: true }).click()
  const panel = await active(page, "Browser")
  await expect(panel.locator("[data-visible]")).toHaveText("true")
  await panel.getByRole("button", { name: "Insert annotation" }).click()
  expect(await page.evaluate(() => window.sidebarFixture.inserts)).toEqual(["fixture annotation"])
  await page.evaluate(() => {
    window.sidebarFixture.open = false
  })
  await expect(panel.locator("[data-visible]")).toHaveText("false")
  // 关闭状态下侧栏自身隐藏（宽度收起），重新打开后才能继续操作工具栏。
  await page.evaluate(() => {
    window.sidebarFixture.open = true
  })
  await page.getByRole("button", { name: "Add tab", exact: true }).click()
  // Terminal no longer gates on desktop: the entry is offered to remote browsers too.
  await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveCount(1)
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await active(page, "Browser 2")
})
