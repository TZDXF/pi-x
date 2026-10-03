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

function panelSource(type: string) {
  return `<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
defineProps(['visible', 'focus', 'project', 'changes', 'checkpoints', 'embedded'])
const emit = defineEmits(['send-to-chat'])
const fixture = window.sidebarFixture
const text = ref('')
const shell = ref(false)
onMounted(() => fixture.mounts.push('${type}'))
onUnmounted(() => fixture.unmounts.push('${type}'))
function openTerminal() { shell.value = true; fixture.shellOpens++; return Promise.resolve() }
if ('${type}' === 'terminal') fixture.clearShell = () => { shell.value = false }
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
const fixture = window.sidebarFixture = reactive({
  tabs: [{id:1,type:'review'},{id:2,type:'files'},{id:3,type:'review'},{id:4,type:'terminal'},{id:5,type:'browser'}],
  activeId:1, open:true, mounts:[], unmounts:[], shellOpens:0, reorders:[], activations:[], closes:[], inserts:[]
})
let nextId = 6
createApp({render:()=>h('div',{style:'display:flex;height:650px;width:1400px'},[
  h(RightSidebar,{
    tabs:fixture.tabs, activeId:fixture.activeId, open:fixture.open,
    changes:[], project:'C:/fixture', focus:'src/example.ts', totals:{added:2,removed:1,unknown:false},
    'onUpdate:activeId':id=>{fixture.activations.push(id);fixture.activeId=id},
    'onClose-tab':id=>{
      fixture.closes.push(id)
      const index=fixture.tabs.findIndex(tab=>tab.id===id)
      fixture.tabs=fixture.tabs.filter(tab=>tab.id!==id)
      if(fixture.activeId===id) fixture.activeId=fixture.tabs[Math.min(index,fixture.tabs.length-1)]?.id??null
    },
    'onAdd-tab':type=>{const id=nextId++;fixture.tabs.push({id,type});fixture.activeId=id},
    'onReorder-tabs':tabs=>{fixture.reorders.push(tabs.map(tab=>tab.id));fixture.tabs=tabs},
    'onSend-to-chat':text=>fixture.inserts.push(text)
  })
])}).use(createI18n({legacy:false,locale:'en',messages:{en:messages}})).mount('#app')
</script></body></html>`

interface SidebarFixture {
  tabs: { id: number; type: string }[]
  activeId: number | null
  open: boolean
  mounts: string[]
  unmounts: string[]
  shellOpens: number
  reorders: number[][]
  activations: number[]
  closes: number[]
  inserts: string[]
  clearShell: () => void
}

declare global {
  interface Window {
    sidebarFixture: SidebarFixture
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

test("only reactivating an empty terminal opens a shell, including keyboard activation", async ({ page }) => {
  const terminal = page.getByRole("tab", { name: "Terminal", exact: true })
  await terminal.click()
  await active(page, "Terminal")
  expect(await page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(0)
  await terminal.click()
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(1)
  await terminal.click()
  expect(await page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(1)
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await terminal.press("Enter")
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(2)
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await terminal.press("Space")
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(3)
  await page.getByRole("tab", { name: "Review 1", exact: true }).click()
  await page.evaluate(() => window.sidebarFixture.clearShell())
  await page.keyboard.press("End")
  await page.keyboard.press("ArrowLeft")
  await active(page, "Terminal")
  expect(await page.evaluate(() => window.sidebarFixture.shellOpens)).toBe(3)
  await page.evaluate(() => {
    window.sidebarFixture.open = false
  })
  await expect((await active(page, "Terminal")).locator("[data-visible]")).toHaveText("false")
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
  const ids = await page.evaluate(() => window.sidebarFixture.tabs.map(tab => tab.id))
  expect(ids).not.toEqual([1, 2, 3, 4, 5])
  expect([...ids].sort()).toEqual([1, 2, 3, 4, 5])
  const selected = page.locator('[role="tab"][aria-selected="true"]')
  await selected.focus()
  await page.keyboard.press("Home")
  expect(await page.evaluate(() => window.sidebarFixture.activeId)).toBe(ids[0])
  await page.keyboard.press("ArrowRight")
  expect(await page.evaluate(() => window.sidebarFixture.activeId)).toBe(ids[1])
  await page.keyboard.press("End")
  expect(await page.evaluate(() => window.sidebarFixture.activeId)).toBe(ids[ids.length - 1])
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
  await active(page, "Review +2 -1")
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
  await page.getByRole("button", { name: "Add tab", exact: true }).click()
  // Terminal no longer gates on desktop: the entry is offered to remote browsers too.
  await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveCount(1)
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await active(page, "Browser 2")
})
