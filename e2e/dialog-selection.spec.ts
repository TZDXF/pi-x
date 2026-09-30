import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { Dialog, DialogContent, DialogTitle } from '/src/components/ui/dialog'
import '/src/style.css'
const open = ref(true)
const app = createApp({
  setup() {
    return () => h(Dialog, { open: open.value, 'onUpdate:open': (value) => { open.value = value } }, {
      default: () => h(DialogContent, { 'aria-describedby': undefined }, () => [
        h(DialogTitle, () => 'Selection dialog'),
        h('p', { id: 'selectable', style: 'width:320px;user-select:text;' }, 'Select this long dialog text'),
      ]),
    })
  },
})
app.mount('#app')
</script></body></html>`

let harness: VueHarness | null = null

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "dialog-selection", port: 1502, html })
})

test.afterAll(async () => {
  await harness?.close()
})

test("a selection drag ending outside does not dismiss the dialog", async ({ page }) => {
  await page.goto(harness!.url)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const box = await page.locator("#selectable").boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + 20, box!.y + 10)
  await page.mouse.down()
  await page.mouse.move(box!.x - 80, box!.y - 80, { steps: 8 })
  await page.mouse.up()

  await expect(dialog).toBeVisible()
})

test("an outside pointer event during a selection drag does not dismiss the dialog", async ({ page }) => {
  await page.goto(harness!.url)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const box = await page.locator("#selectable").boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + 20, box!.y + 10)
  await page.mouse.down()
  await page.mouse.move(box!.x + 40, box!.y + 10, { steps: 2 })
  await page.locator("body").dispatchEvent("pointerdown", {
    bubbles: true,
    button: 0,
    clientX: 2,
    clientY: 2,
    pointerId: 1,
  })
  await page.mouse.up()

  await expect(dialog).toBeVisible()
})

test("a fresh click outside still dismisses the dialog", async ({ page }) => {
  await page.goto(harness!.url)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  await page.mouse.click(2, 2)
  await expect(dialog).toHaveCount(0)
})
