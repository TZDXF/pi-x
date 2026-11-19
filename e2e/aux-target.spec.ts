import { test, expect, type Locator, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/** 多 aux 目标选择的真实浏览器回归；底部越界是 TZD-129 复审的阻断问题。 */

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import SelectionMenu from '/src/components/chat/ConversationSelectionMenu.vue'
import ProjectFilePreview from '/src/components/ProjectFilePreview.vue'
import { openAux, auxInstancesFor, registerAuxAskRouter, registerAuxRuntimeBridge } from '/src/stores/auxChat.ts'
import { auxSelectionItems } from '/src/stores/auxSelections.ts'
import { askAuxSelection } from '/src/lib/auxAsk.ts'
import '/src/style.css'
const q = new URLSearchParams(location.search)
const parent = 'runtime:qa'
const count = Number(q.get('count') ?? 2)
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: messages } })
const pinia = createPinia()
setActivePinia(pinia)
registerAuxRuntimeBridge({kill: async () => {}})
let id = 0
const open = () => openAux(parent, { tabId: ++id, titlePrefix: 'QA Aux', spawn: async () => {} })
for (let i = 0; i < count; i++) await open()
let active = auxInstancesFor(parent)[0]
registerAuxAskRouter(parent, {active: () => active, open, reveal: tab => { active = tab }})
window.qa = () => ({ count: auxInstancesFor(parent).length, active: active?.title, buckets: auxInstancesFor(parent).map(tab => auxSelectionItems(tab.runtimeId)) })
createApp({setup() {
  const root = ref(null)
  const targets = computed(() => auxInstancesFor(parent))
  return () => q.has('file') ? h(ProjectFilePreview, {project:'qa', path:'notes.txt', auxParentRuntimeId:parent, readFile: async () => ({kind:'text', text:'File sample text for quoting', truncated:false})}) : [
    h('div', { ref: root, style: {position:'absolute', top: (q.has('bottom') ? 500 : q.has('top') ? 8 : 130)+'px', left:'60px'} },
      h('div', {'data-message-id': '42'}, h('p', {'data-selection-source':'assistant', id:'quote'}, 'Select exactly this text'))),
    h(SelectionMenu, {root:root.value, maxTextLength:8000, auxTargets:targets.value,
      onAuxAsk:(payload,target) => askAuxSelection({parentRuntimeId:parent, payload, target, t:i18n.global.t, toast:console.warn})})
  ]
}}).use(pinia).use(i18n).mount('#app')
</script></body></html>`

let harness: VueHarness
const askLabel = "Ask in auxiliary chat"
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "qa-aux-target", port: 18743, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 1000, height: 600 } })

async function select(page: Page, selector = "#quote") {
  await page.locator(selector).evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })
  await page.getByRole("button", { name: askLabel, exact: false }).click({ timeout: 5000 })
}
async function state(page: Page) {
  return page.evaluate(() => (window as any).qa())
}
async function expectActionable(locator: Locator) {
  const rect = await locator.evaluate(el => {
    const box = el.getBoundingClientRect()
    return {
      top: box.top,
      bottom: box.bottom,
      viewport: innerHeight,
      hit: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
    }
  })
  expect(rect.top).toBeGreaterThanOrEqual(0)
  expect(rect.bottom).toBeLessThanOrEqual(rect.viewport)
  expect(rect.hit).toBe(true)
}

test("existing precisely routes and activates, then explicit new does not reuse active", async ({ page }) => {
  await page.goto(harness.url)
  await select(page)
  expect((await state(page)).buckets).toEqual([[], []])
  await page.getByRole("menuitem", { name: "QA Aux 2" }).click()
  await expect
    .poll(() => state(page))
    .toMatchObject({
      count: 2,
      active: "QA Aux 2",
      buckets: [[], [{ text: "Select exactly this text", messageId: 42, source: "assistant" }]],
    })
  await select(page)
  await page.getByRole("menuitem", { name: "New auxiliary chat" }).click()
  await expect
    .poll(() => state(page))
    .toMatchObject({
      count: 3,
      active: "QA Aux 3",
      buckets: [[], [{ text: "Select exactly this text" }], [{ text: "Select exactly this text" }]],
    })
})

test("zero opens directly; one reuses without picker; five still allow new", async ({ page }) => {
  for (const count of [0, 1]) {
    await page.goto(harness.url + "?count=" + count)
    await select(page)
    await expect
      .poll(() => state(page))
      .toMatchObject({ count: 1, active: "QA Aux 1", buckets: [[{ text: "Select exactly this text" }]] })
    await expect(page.getByRole("menu")).toHaveCount(0)
  }

  // 辅助对话不设专属实例上限（TZD-127）：已有 5 个时新建项仍可点，且真的会再开一个。
  await page.goto(harness.url + "?count=5")
  await select(page)
  const newChat = page.getByRole("menuitem", { name: "New auxiliary chat" })
  await expect(newChat).toBeEnabled()
  await newChat.click()
  await expect.poll(async () => (await state(page)).count).toBe(6)
  await expect.poll(async () => (await state(page)).active).toBe("QA Aux 6")
})

test("actual file preview carries parent, path and line to exact target", async ({ page }) => {
  await page.goto(harness.url + "?file")
  await select(page, '[data-line="1"]')
  await page.getByRole("menuitem", { name: "QA Aux 2" }).click()
  await expect
    .poll(() => state(page))
    .toMatchObject({
      count: 2,
      active: "QA Aux 2",
      buckets: [[], [{ text: "File sample text for quoting", path: "notes.txt", lineRange: { start: 1, end: 1 } }]],
    })
})

test("bottom selection keeps last existing and new targets clickable", async ({ page }, testInfo) => {
  await page.goto(harness.url + "?bottom&count=3")
  await select(page)
  const newChat = page.getByRole("menuitem", { name: "New auxiliary chat" })
  const last = page.getByRole("menuitem", { name: "QA Aux 3" })
  await expectActionable(last)
  await expectActionable(newChat)
  await page.screenshot({ path: testInfo.outputPath("aux-target-bottom.png") })
  await newChat.click({ timeout: 2000 })
  await expect.poll(async () => (await state(page)).count).toBe(4)
})

test("top selection keeps every existing and new target inside the viewport", async ({ page }) => {
  await page.goto(harness.url + "?top&count=3")
  await select(page)
  const newChat = page.getByRole("menuitem", { name: "New auxiliary chat" })
  await expectActionable(page.getByRole("menuitem", { name: "QA Aux 3" }))
  await expectActionable(newChat)
  await newChat.click()
  await expect.poll(async () => (await state(page)).count).toBe(4)
})

for (const surface of ["chat", "file"] as const) {
  test(`short viewport (${surface}): internal wheel keeps the picker open and new chat clickable`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 180 })
    await page.goto(harness.url + "?top&count=4" + (surface === "file" ? "&file" : ""))
    await select(page, surface === "file" ? '[data-line="1"]' : "#quote")
    const menu = page.getByRole("menu", { name: "Choose auxiliary chat" })
    const newChat = menu.getByRole("menuitem", { name: "New auxiliary chat" })
    const geometry = await menu.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return { x: rect.x, y: rect.y, bottom: rect.bottom, height: el.clientHeight, scrollHeight: el.scrollHeight }
    })
    expect(geometry.y).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(180)
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height)

    await page.mouse.move(geometry.x + 90, geometry.y + 65)
    await page.mouse.wheel(0, 500)
    await expect.poll(() => menu.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await expect(menu).toBeVisible()
    expect((await state(page)).buckets).toEqual([[], [], [], []])
    await expectActionable(newChat)
    await newChat.click()
    await expect.poll(async () => (await state(page)).count).toBe(5)
  })
}

test("a real wheel outside the picker still closes it", async ({ page }) => {
  await page.goto(harness.url + "?top&count=3")
  await select(page)
  const menu = page.getByRole("menu", { name: "Choose auxiliary chat" })
  await expect(menu).toBeVisible()
  await page.evaluate(() => (document.body.style.height = "1000px"))
  await page.mouse.move(700, 100)
  await page.mouse.wheel(0, 200)
  await expect(menu).toHaveCount(0)
  expect((await state(page)).buckets).toEqual([[], [], []])
})
