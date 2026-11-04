import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import KanbanBoard from '/src/components/kanban/KanbanBoard.vue'
import { kanbanColumnOrderKey } from '/src/lib/kanban'
import zhCN from '/src/i18n/locales/zh-CN'
import '/src/style.css'
const columnOrder = ref(JSON.parse(localStorage.getItem('kanban-test-order') || '{}'))
const selectedProject = ref('')
const cards = Array.from({length:40}, (_,i) => ({
  id:'task-'+i,project:'root',projectName:'Project',status:'todo',updatedAt:Date.now()-300000,
  title:('任务 '+i+' 的完整标题 ').repeat(15),preview:Array(12).fill('这是卡片内容，第'+i+'项。').join(String.fromCharCode(10)),
}))
cards.push({...cards[0], id:'running', status:'running'})
createApp({
  render: () => h('div', {style:'display:flex;width:940px;height:640px'}, [h(KanbanBoard, {
    cards,projects:[{value:'root',label:'Project'}],selectedProject:selectedProject.value,
    columnOrder:columnOrder.value,
    'onUpdate:selectedProject':value => {selectedProject.value=value},
    onReorder:(column,ids) => {
      columnOrder.value={...columnOrder.value,[kanbanColumnOrderKey(selectedProject.value,column)]:ids}
      localStorage.setItem('kanban-test-order',JSON.stringify(columnOrder.value))
    },
  })]),
}).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':zhCN}})).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "kanban", port: 1531, html })
})
test.afterAll(async () => harness?.close())

test("horizontal wheel scrolls over cards and column whitespace while vertical wheel stays in its column", async ({
  page,
}) => {
  await page.goto(harness.url)
  const board = page.getByRole("region", { name: "任务看板", exact: true })
  const scroller = board.locator(".overflow-x-auto")
  const column = board.locator('[data-kanban-column="todo"] .overflow-y-auto')
  const card = column.locator("[data-kanban-card]").first()
  await card.hover()
  await page.mouse.wheel(200, 0)
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(100)
  await scroller.evaluate(el => {
    el.scrollLeft = 0
  })
  const rect = (await column.boundingBox())!
  await page.mouse.move(rect.x + 2, rect.y + 60)
  await page.mouse.wheel(180, 0)
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(100)
  await scroller.evaluate(el => {
    el.scrollLeft = 0
  })
  await card.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => column.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  expect(await scroller.evaluate(el => el.scrollLeft)).toBe(0)
})

test("native dragging reorders only within a column and survives reloading", async ({ page }) => {
  await page.goto(harness.url)
  const column = page.locator('[data-kanban-column="todo"]')
  const cards = column.locator("[data-kanban-card]")
  await expect(cards).toHaveCount(40)
  await cards.nth(1).dragTo(cards.nth(0), { targetPosition: { x: 60, y: 4 } })
  await expect(cards.first()).toHaveAttribute("data-kanban-card", "task-1")
  await cards.first().dragTo(page.locator('[data-kanban-card="running"]'))
  await expect(cards).toHaveCount(40)
  await expect(cards.first()).toHaveAttribute("data-kanban-card", "task-1")
  await page.reload()
  await expect(cards.first()).toHaveAttribute("data-kanban-card", "task-1")
})

test("titles stay on one line, previews on two, and project/time share the bottom row", async ({ page }) => {
  await page.goto(harness.url)
  const card = page.locator("[data-kanban-card]").first()
  await expect(card).toBeVisible()
  const title = card.locator(":scope > span").first()
  await expect(title).toHaveCSS("white-space", "nowrap")
  await expect(title).toHaveCSS("text-overflow", "ellipsis")
  const heights = await card.locator(".line-clamp-2").evaluateAll(elements =>
    elements.map(el => ({
      height: el.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
    })),
  )
  expect(heights).toHaveLength(1)
  for (const measure of heights) expect(measure.height).toBeLessThanOrEqual(measure.lineHeight * 2 + 1)
  const projectBox = (await card.locator('span[title="root"]').boundingBox())!
  const timeBox = (await card.locator("time").boundingBox())!
  expect(projectBox.x + projectBox.width).toBeLessThan(timeBox.x)
  expect(Math.abs(projectBox.y + projectBox.height / 2 - timeBox.y - timeBox.height / 2)).toBeLessThanOrEqual(1)
  await expect(card.locator("time")).toHaveText("5分钟前")
  await expect(card.locator("time")).toHaveAttribute("title", /更新时间:.*\d{4}/)
  await expect(card.locator("time")).toHaveAttribute("datetime", /T/)
})
