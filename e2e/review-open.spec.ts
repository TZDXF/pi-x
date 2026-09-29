import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface TauriCall {
  command: string
  args: Record<string, unknown>
}

interface ReviewTestWindow {
  isTauri: boolean
  calls: TauriCall[]
  failOpen?: boolean
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  }
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import ReviewPanel from '/src/components/ReviewPanel.vue'
import OpenWithSettings from '/src/components/settings/OpenWithSettings.vue'
import '/src/style.css'
const lines = Array.from({length: 100}, (_, i) => [
  {kind:'remove', text:'old '+i+' '+ 'long '.repeat(60), oldLine:i+1},
  {kind:'add', text:'new '+i+' '+ 'long '.repeat(60), newLine:i+1},
]).flat()
createApp({render:()=>h('div',{},[
  h('div',{style:'padding:24px'},[h(OpenWithSettings)]),
  h('div',{style:'display:flex;height:650px;width:1100px'},[h(ReviewPanel,{project:'C:/demo project',changes:[{id:'1',path:'src/demo & 中文.ts',tool:'edit',lines,added:100,removed:100,unknownBefore:false}]})])
])}).use(createI18n({legacy:false,locale:'en',messages:{en:messages}})).mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "review-open", port: 1456, html })
})

test.afterAll(async () => {
  await harness?.close()
})

test("review split scrolling and default file opening", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.addInitScript(() => {
    const scopedWindow = window as unknown as ReviewTestWindow
    scopedWindow.isTauri = true
    scopedWindow.calls = []
    scopedWindow.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        scopedWindow.calls.push({ command, args })
        if (command === "detect_editors") return { vscode: true, cursor: true }
        if (command === "editor_icons") return {}
        if (command === "open_in_editor" && scopedWindow.failOpen) throw new Error("File does not exist")
      },
    }
  })

  await page.goto(harness.url)
  await page.getByRole("button", { name: "Split", exact: true }).click()
  const panes = page.locator('.review-split-pane [data-slot="scroll-area-viewport"]')
  await expect(panes.first()).toBeVisible()
  await expect(panes).toHaveCount(2)

  // reka-ui 缺陷回归:动态切换 orientation 后外层视口 overflow-y 不得卡在 hidden
  const outerViewport = page.locator(
    '.changes-file-view > [data-slot="scroll-area"] > [data-slot="scroll-area-viewport"]',
  )
  await expect(outerViewport).toHaveCount(1)
  expect(await outerViewport.evaluate(element => getComputedStyle(element).overflowY)).toBe("scroll")

  // 用真实鼠标滚轮验证:逐行 -> 并排切换后,垂直滚动必须立即生效
  // 切换瞬间异步组件/高亮落地会引发布局微调,允许滚轮重试几次,但最终必须生效
  let wheeled = false
  for (let attempt = 0; attempt < 5 && !wheeled; attempt += 1) {
    const box = await panes.last().boundingBox()
    if (!box) throw new Error("The right review pane has no bounding box")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(250)
    wheeled = await panes.last().evaluate(element => element.scrollTop > 0)
  }
  expect(wheeled, "wheel scrolling must work right after switching to split view").toBe(true)

  await panes.last().evaluate(element => {
    element.scrollTop = 600
    element.scrollLeft = 120
  })
  await page.waitForFunction(() => {
    const [left, right] = document.querySelectorAll('.review-split-pane [data-slot="scroll-area-viewport"]')
    return Boolean(left?.scrollTop && left.scrollTop > 500 && right && Math.abs(left.scrollTop - right.scrollTop) < 2)
  })

  for (const pane of [panes.first(), panes.last()]) {
    await pane.hover()
    await expect(pane.locator("..").locator('[data-slot="scroll-area-scrollbar"]').first()).toBeVisible()
    await expect(
      pane.locator("..").locator('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]'),
    ).toBeVisible()
    await expect(
      pane.locator("..").locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]'),
    ).toBeVisible()
  }
  expect(await panes.first().evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe("none")

  const select = page.getByRole("combobox", { name: "Default open method" })
  await select.click()
  await page.getByRole("option", { name: "Cursor", exact: true }).click()
  await page.getByRole("button", { name: "Open file with default application" }).click()
  const call = await page.evaluate(() => {
    const scopedWindow = window as unknown as ReviewTestWindow
    return scopedWindow.calls.find(candidate => candidate.command === "open_in_editor")
  })
  if (!call) throw new Error("open_in_editor was not invoked")
  expect(call.args.kind).toBe("cursor")
  expect(call.args.path).toBe("src/demo & 中文.ts")
  expect(call.args.project).toBe("C:/demo project")

  await page.reload()
  await expect(page.getByRole("combobox", { name: "Default open method" })).toContainText("Cursor")
  await page.evaluate(() => {
    const scopedWindow = window as unknown as ReviewTestWindow
    scopedWindow.failOpen = true
  })
  await page.getByRole("button", { name: "Open file with default application" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "File does not exist" })).toBeVisible()
  expect(errors, "the review page must not produce page errors").toEqual([])
})
