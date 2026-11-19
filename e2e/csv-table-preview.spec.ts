import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-137：CSV 表格预览的结构性契约。
 *
 * 断言的是「大文件仍然可用」的成因，不是墙上时钟：DOM 行数、可见列数、
 * 在途请求数、滚动容器能否真正横滚、刷新后页码是否保持。行数/列数全部由
 * 内存合成，不访问任何外部服务。
 */
const VIRTUAL_ROWS = 300_000
const PAGED_ROWS = 1_500_000
/** 宽表：200 列，用于验证 128 列渲染上限。 */
const WIDE_COLUMNS = 200
/** 每页人为延迟（毫秒），让「快速跳多个区段」确实产生并发的在途请求。 */
const PAGE_DELAY = 550

function harnessHtml(rows: number, mode: "text" | "backend", columns = 4) {
  return `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import CsvTablePreview from '/src/components/CsvTablePreview.vue'
import '/src/style.css'
const rows = ${rows}
const columns = ${columns}
const header = []
for (let c = 0; c < columns; c++) header.push('c' + c)
const lines = [header.join(',')]
for (let i = 0; i < rows; i++) {
  const cells = []
  for (let c = 0; c < columns; c++) cells.push(c === 0 ? String(i) : 'v' + i + '_' + c)
  lines.push(cells.join(','))
}
const props = ${JSON.stringify({ mode })}.mode === 'text'
  ? { project: 'C:/demo', path: 'big.csv', text: lines.join('\\n') }
  : { project: 'C:/demo', path: 'big.csv' }
const app = createApp({
  render: () => h('div', { style: 'display:flex;height:700px;width:1200px' }, [h(CsvTablePreview, props)]),
})
app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#app')
window.__ready = true
</script></body></html>`
}

/** 420px 宽的真实侧栏场景：预览组件被塞进只有 419px 的容器（overflow hidden）。 */
const narrowHtml = `<!doctype html><html><body>
<div id="host" style="width:419px;height:520px;display:flex;overflow:hidden"></div>
<script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import CsvTablePreview from '/src/components/CsvTablePreview.vue'
import '/src/style.css'
const text = ['A,B,C,D,E', '1,2,3,4,5', '6,7,8,9,10'].join('\\n')
const app = createApp({
  render: () => h('div', { style: 'display:flex;height:100%;width:100%;min-width:0' }, [
    h(CsvTablePreview, { project: 'C:/demo', path: 'narrow.csv', text }),
  ]),
})
app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#host')
window.__ready = true
</script></body></html>`

/** 后端模式 + 可外部触发的 `revision` 递增，用于验证磁盘刷新保留页码。 */
const refreshHtml = (rows: number) => `<!doctype html><html><body><div id="app"></div><script type="module">
const rows = ${rows}
import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import CsvTablePreview from '/src/components/CsvTablePreview.vue'
import '/src/style.css'
const revision = ref(0)
window.__bumpRevision = () => { revision.value += 1 }
const app = createApp({
  render: () => h('div', { style: 'display:flex;height:700px;width:1200px' }, [
    h(CsvTablePreview, { project: 'C:/demo', path: 'big.csv', revision: revision.value }),
    // rows 仅供 README 说明：后端分页由 mock 提供数据。

  ]),
})
app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#app')
window.__ready = true
</script></body></html>`

interface FakeOptions {
  total: number
  columns?: number
  delayMs?: number
  /** 每页最多回多少行（模拟后端按字节预算裁剪）。 */
  rowsPerPage?: number
}

/**
 * Fake `read_csv_page`: synthetic rows, per-call accounting (count, concurrency,
 * offset) and an optional artificial delay so overlapping requests are visible.
 */
async function mockBackendPages(page: Page, options: FakeOptions) {
  await page.addInitScript((config: FakeOptions) => {
    const target = window as any
    target.isTauri = true
    target.__csvCalls = [] as { offset: number; limit: number }[]
    target.__csvMaxConcurrent = 0
    target.__csvActive = 0
    const columns = config.columns ?? 4
    const header = Array.from({ length: columns }, (_, index) => `c${index}`)
    const pageOf = (offset: number, limit: number) => {
      const rows: string[][] = []
      const total = config.total
      for (let row = offset; row < Math.min(offset + limit, total); row++) {
        rows.push(Array.from({ length: columns }, (_, index) => (index === 0 ? String(row) : `v${row}_${index}`)))
      }
      return {
        offset,
        rows,
        header,
        more: offset + rows.length < total,
        totalRows: offset === 0 ? total : null,
        columnCount: columns,
        truncatedColumns: false,
        truncatedCells: false,
        budgetTruncated: rows.length < Math.min(limit, total - offset),
        delimiter: ",",
        fileBytes: 20 * 1024 * 1024,
      }
    }
    Reflect.set(target, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args: { offset?: number; limit?: number }) => {
        if (command !== "read_csv_page") throw Error("unexpected command " + command)
        const offset = args.offset ?? 0
        const limit = Math.min(args.limit ?? 500, config.rowsPerPage ?? Number.MAX_SAFE_INTEGER)
        target.__csvCalls.push({ offset, limit })
        target.__csvActive += 1
        target.__csvMaxConcurrent = Math.max(target.__csvMaxConcurrent, target.__csvActive)
        if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs))
        target.__csvActive -= 1
        return pageOf(offset, limit)
      },
    })
  }, options)
}

const renderedRows = (page: Page) => page.locator("[data-csv-row]")
const csvColumnHeaders = (page: Page) => page.locator("[data-csv-header]")

test.describe("csv table preview", () => {
  let virtualHarness!: VueHarness
  let pagedHarness!: VueHarness
  let backendHarness!: VueHarness
  let narrowHarness!: VueHarness
  let wideHarness!: VueHarness
  let refreshHarness!: VueHarness

  test.beforeAll(async () => {
    virtualHarness = await startVueHarness({ name: "csv-text", port: 1464, html: harnessHtml(VIRTUAL_ROWS, "text") })
    pagedHarness = await startVueHarness({ name: "csv-paged", port: 1465, html: harnessHtml(PAGED_ROWS, "text") })
    backendHarness = await startVueHarness({
      name: "csv-backend",
      port: 1466,
      html: harnessHtml(VIRTUAL_ROWS, "backend"),
    })
    narrowHarness = await startVueHarness({ name: "csv-narrow", port: 1467, html: narrowHtml })
    wideHarness = await startVueHarness({
      name: "csv-wide",
      port: 1468,
      html: harnessHtml(200, "text", WIDE_COLUMNS),
    })
    refreshHarness = await startVueHarness({ name: "csv-refresh", port: 1469, html: refreshHtml(PAGED_ROWS) })
  })

  test.afterAll(async () => {
    await virtualHarness.close()
    await pagedHarness.close()
    await backendHarness.close()
    await narrowHarness.close()
    await wideHarness.close()
    await refreshHarness.close()
  })

  test("a 300k-row file renders a viewport-sized row set and follows scrolling", async ({ page }: { page: Page }) => {
    await page.goto(virtualHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()
    // 视口 700px / 行高 26px ≈ 27 行 + 上下各 8 行 overscan：与 30 万行无关。
    expect(await renderedRows(page).count()).toBeLessThan(80)
    await expect(page.locator("[data-csv-rows]")).toContainText(String(VIRTUAL_ROWS))
    await expect(page.locator("[data-csv-pager]")).toHaveCount(0)
    await expect(csvColumnHeaders(page)).toHaveCount(4)
    await expect(csvColumnHeaders(page).last()).toHaveText("c3")

    const scroller = page.locator("[data-csv-scroll]")
    // 供给虚拟滚动的总高度必须覆盖全部行（CSSOM 会把大数序列化成 7.8e+06px）。
    const bodyHeight = await page
      .locator("[data-csv-body]")
      .evaluate(el => Number.parseFloat(getComputedStyle(el).height))
    expect(bodyHeight).toBeCloseTo(VIRTUAL_ROWS * 26, -2)

    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight / 2
      element.dispatchEvent(new Event("scroll"))
    })
    const firstRow = Number(await renderedRows(page).first().getAttribute("data-csv-row"))
    expect(firstRow).toBeGreaterThan(VIRTUAL_ROWS / 2 - 20)
    expect(firstRow).toBeLessThan(VIRTUAL_ROWS / 2 + 20)
    expect(await renderedRows(page).count()).toBeLessThan(80)

    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(renderedRows(page).last()).toHaveAttribute("data-csv-row", String(VIRTUAL_ROWS))
  })

  test("a file above the virtual-scroll ceiling switches to bounded screen navigation", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.goto(pagedHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    // 150 万行 × 26px 越过浏览器元素高度上限（~33.5M px），虚拟滚动不可达尾部。
    await expect(page.locator("[data-csv-pager]")).toBeVisible()
    expect(await renderedRows(page).count()).toBeLessThan(80)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await expect(page.locator("[data-csv-rows]")).toContainText(String(PAGED_ROWS))

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 2")
    expect(await renderedRows(page).count()).toBeLessThan(80)

    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  test("project files come back in slices, and only around the visible window", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: VIRTUAL_ROWS })
    await page.goto(backendHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()
    await expect(page.locator("[data-csv-rows]")).toContainText(String(VIRTUAL_ROWS))
    expect(await renderedRows(page).count()).toBeLessThan(80)

    const scroller = page.locator("[data-csv-scroll]")
    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(renderedRows(page).last()).toHaveAttribute("data-csv-row", String(VIRTUAL_ROWS))

    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number; limit: number }[])
    const maxConcurrent = await page.evaluate(() => (window as any).__csvMaxConcurrent as number)
    expect(calls.length).toBeLessThanOrEqual(4)
    expect(Math.max(...calls.map(call => call.limit))).toBe(500)
    expect(Math.max(...calls.map(call => call.offset))).toBeLessThan(VIRTUAL_ROWS)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  // 回归（验收 P1）：420px 侧栏里三列就该看全，且能真正横滚到第五列。
  test("a narrow sidebar keeps the table inside its width but scrolls horizontally", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.goto(narrowHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    const scroller = page.locator("[data-csv-scroll]")
    await expect(renderedRows(page).first()).toBeVisible()

    const metrics = await scroller.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
    }))
    // 容器不能比侧栏更宽（否则父级 overflow-hidden 会把它裁掉，滚动条永远在 0）。
    expect(metrics.clientWidth).toBeLessThanOrEqual(420)
    // 但内容要比容器宽，横滚才有意义。
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)

    const scrolled = await scroller.evaluate(element => {
      element.scrollLeft = element.scrollWidth
      return element.scrollLeft
    })
    expect(scrolled).toBeGreaterThan(0)
    // 滚到最右后，最后一列（E）必须进入可视区域。
    const lastHeader = csvColumnHeaders(page).last()
    await expect(lastHeader).toHaveText("E")
    const headerBox = await lastHeader.boundingBox()
    const scrollerBox = await scroller.boundingBox()
    expect(headerBox!.x).toBeGreaterThan(scrollerBox!.x + 20)
    expect(headerBox!.x + headerBox!.width).toBeGreaterThan(scrollerBox!.x + scrollerBox!.width - 20)
  })

  // 回归（验收 P1）：200 列的文件只渲染 128 列（表头与行同样受约束）。
  test("only 128 columns are rendered for a 200-column file", async ({ page }: { page: Page }) => {
    await page.goto(wideHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()
    await expect(csvColumnHeaders(page)).toHaveCount(128)

    const cellsInFirstRow = await renderedRows(page).first().locator("> div").count()
    // 行号单元格 + 128 个数据单元格。
    expect(cellsInFirstRow).toBe(129)

    const domNodes = await page.locator("[data-csv-body] div").count()
    expect(domNodes).toBeLessThan(80 * 130)
    await expect(page.locator("[data-csv-preview]")).toContainText("More than 128 columns")
  })

  // 回归（验收 P1）：快速跳过 6 个不同区段时，在途请求也不超过 2 个。
  test("rapid jumps across distant segments never exceed two in-flight requests", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: VIRTUAL_ROWS + 2, delayMs: PAGE_DELAY })
    await page.goto(backendHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()

    const scroller = page.locator("[data-csv-scroll]")
    for (const fraction of [0.2, 0.4, 0.6, 0.8, 0.95, 0.3]) {
      await scroller.evaluate((element, ratio) => {
        element.scrollTop = element.scrollHeight * ratio
        element.dispatchEvent(new Event("scroll"))
      }, fraction)
      // 短于页面延迟：队列里应只剩最新窗口的缺口，旧区段不再各发一个请求。
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(PAGE_DELAY * 3)

    const maxConcurrent = await page.evaluate(() => (window as any).__csvMaxConcurrent as number)
    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(calls.length).toBeLessThanOrEqual(12)

    // 最终窗口仍能正常显示：不做「丢请求就留空洞」的取舍。
    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight * 0.3
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(renderedRows(page).first()).toBeVisible()
    expect(await renderedRows(page).count()).toBeLessThan(80)
  })

  // 回归（验收 P2）：磁盘刷新保留页码与滚动位置，不回到第一屏。
  test("a disk refresh keeps the paged position instead of jumping back to row 1", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, delayMs: 20 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 1")

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 2")

    // 模拟磁盘变更：revision 递增。
    await page.evaluate(() => (window as any).__bumpRevision())
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 2")

    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    // 刷新请求必须落在第 2 屏（offset 500），而不是回到 0。
    expect(calls.some(call => call.offset === 500)).toBe(true)
    expect(calls.filter(call => call.offset === 0)).toHaveLength(1)
  })
})
