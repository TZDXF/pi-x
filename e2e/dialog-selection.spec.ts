import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { Dialog, DialogContent, DialogScrollContent, DialogTitle } from '/src/components/ui/dialog'
import { Select, SelectContent, SelectTrigger, SelectValue, SelectItem } from '/src/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from '/src/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '/src/components/ui/popover'
import '/src/style.css'
const open = ref(true)
const contentTag = ref('section')
const Content = new URLSearchParams(location.search).has('scroll') ? DialogScrollContent : DialogContent
window.escapeEvents = 0
const app = createApp({
  setup() {
    return () => h(Dialog, { open: open.value, 'onUpdate:open': (value) => { open.value = value } }, {
      default: () => h(Content, {
        'aria-describedby': undefined,
        as: contentTag.value,
        onEscapeKeyDown: () => { window.escapeEvents++ },
      }, () => [
        h(DialogTitle, () => 'Selection dialog'),
        h(Select, {}, () => [
          h(SelectTrigger, { 'data-testid': 'select-trigger' }, () => h(SelectValue, { placeholder: 'Choose' })),
          h(SelectContent, {}, () => [h(SelectItem, { value: 'alpha' }, () => 'Alpha'), h(SelectItem, { value: 'beta' }, () => 'Beta')]),
        ]),
        h(DropdownMenu, {}, () => [
          h(DropdownMenuTrigger, { 'data-testid': 'menu-trigger' }, () => 'Menu'),
          h(DropdownMenuContent, {}, () => h(DropdownMenuItem, {}, () => 'Menu item')),
        ]),
        h(Popover, {}, () => [
          h(PopoverTrigger, { 'data-testid': 'popover-trigger' }, () => 'Popover'),
          h(PopoverContent, {}, () => h('button', {}, 'Popover item')),
        ]),
        h('button', { id: 'change-content-tag', onClick: () => { contentTag.value = 'article' } }, 'Change content tag'),
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

// These regressions need browser hit-testing: a modal popup sets the dialog's
// pointer-events to none, redirecting even an inside click to the overlay.
for (const popup of [
  { trigger: "select-trigger", slot: "select-content" },
  { trigger: "menu-trigger", slot: "dropdown-menu-content" },
  { trigger: "popover-trigger", slot: "popover-content" },
]) {
  for (const target of ["inside", "overlay"] as const) {
    test(`${popup.trigger}: an ${target} click dismisses only the popup`, async ({ page }) => {
      await page.goto(harness!.url)
      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await page.getByTestId(popup.trigger).click()
      const content = page.locator(`[data-slot="${popup.slot}"]`)
      await expect(content).toBeVisible()
      // Reka installs its document pointerdown listener on the next timer turn
      // so the opening pointerdown cannot immediately dismiss the popup.
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

      if (target === "inside") {
        // Use coordinates, not locator.click(): modal children intentionally
        // make the paragraph pointer-transparent while the popup is open.
        const box = await page.locator("#selectable").boundingBox()
        expect(box).toBeTruthy()
        await page.mouse.click(box!.x + 20, box!.y + 10)
      } else {
        await page.mouse.click(2, 2)
      }

      await expect(content).toHaveCount(0)
      await expect(dialog).toBeVisible()
      // Once the popup has gone, an ordinary overlay click must still close.
      await page.mouse.click(2, 2)
      await expect(dialog).toHaveCount(0)
    })
  }
}

for (const variant of ["regular", "scroll"]) {
  test(`${variant} content forwards reactive props and escape events`, async ({ page }) => {
    await page.goto(harness!.url + (variant === "scroll" ? "?scroll=1" : ""))
    await expect(page.locator('section[role="dialog"]')).toBeVisible()
    await page.locator("#change-content-tag").click()
    await expect(page.locator('article[role="dialog"]')).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { escapeEvents: number }).escapeEvents)).toBe(1)
  })
}
