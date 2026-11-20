import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-137：CSV 表格预览的结构性契约。
 *
 * 断言的是「大文件仍然可用」的成因，不是墙上时钟：DOM 行数、可见列数、
 * 在途请求数、滚动容器能否真正横滚、刷新后页码是否保持、失败是否重试。
 * 行数/列数全部由内存合成，不访问任何外部服务。
 *
 * 每个用例都对应一次复验的复现步骤；旧实现会在这些断言上失败。
 */
const VIRTUAL_ROWS = 300_000
const PAGED_ROWS = 1_500_000
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

/** 后端模式 + 可外部触发的 `revision` 递增（模拟磁盘变更）。 */
const refreshHtml = `<!doctype html><html><body><div id="app"></div><script type="module">
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
  /** 把 mock 的总行数改成这个值（模拟文件被改小）。 */
  currentTotal?: () => number
  /** 一律返回错误（模拟永久失败，例如超 256 MiB）。 */
  alwaysFail?: boolean
}

/**
 * Fake `read_csv_page`: synthetic rows, per-call accounting (count, concurrency,
 * offset) and an optional artificial delay so overlapping requests are visible.
 */
async function mockBackendPages(page: Page, options: FakeOptions) {
  await page.addInitScript((config: FakeOptions) => {
    const target = window as any
    target.isTauri = true
    target.__csvCalls = [] as { offset: number; limit: number; total: number }[]
    target.__csvMaxConcurrent = 0
    target.__csvActive = 0
    target.__csvTotal = config.total
    target.__csvShrinkTo = (rows: number) => {
      target.__csvTotal = rows
    }
    target.__csvColumns = config.columns ?? 4
    target.__csvSetColumns = (cols: number) => {
      target.__csvColumns = cols
    }
    const header = () => Array.from({ length: target.__csvColumns as number }, (_, index) => `c${index}`)
    const pageOf = (offset: number, limit: number) => {
      const rows: string[][] = []
      const total = target.__csvTotal as number
      const width = target.__csvColumns as number
      for (let row = offset; row < Math.min(offset + limit, total); row++) {
        rows.push(Array.from({ length: width }, (_, index) => (index === 0 ? String(row) : `v${row}_${index}`)))
      }
      return {
        offset,
        rows,
        header: header(),
        more: offset + rows.length < total,
        totalRows: offset === 0 ? total : null,
        columnCount: width,
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
        target.__csvCalls.push({ offset, limit, total: target.__csvTotal })
        target.__csvActive += 1
        target.__csvMaxConcurrent = Math.max(target.__csvMaxConcurrent, target.__csvActive)
        if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs))
        target.__csvActive -= 1
        if (config.alwaysFail) throw Error('PIXERR:{"code":"csvFileTooLarge","fallback":"file too large"}')
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
    wideHarness = await startVueHarness({ name: "csv-wide", port: 1468, html: harnessHtml(200, "text", WIDE_COLUMNS) })
    refreshHarness = await startVueHarness({ name: "csv-refresh", port: 1469, html: refreshHtml })
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
    expect(await renderedRows(page).count()).toBeLessThan(80)
    await expect(page.locator("[data-csv-rows]")).toContainText(String(VIRTUAL_ROWS))
    await expect(page.locator("[data-csv-pager]")).toHaveCount(0)
    await expect(csvColumnHeaders(page)).toHaveCount(4)
    await expect(csvColumnHeaders(page).last()).toHaveText("c3")

    const scroller = page.locator("[data-csv-scroll]")
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
    expect(metrics.clientWidth).toBeLessThanOrEqual(420)
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)

    const scrolled = await scroller.evaluate(element => {
      element.scrollLeft = element.scrollWidth
      return element.scrollLeft
    })
    expect(scrolled).toBeGreaterThan(0)
    const lastHeader = csvColumnHeaders(page).last()
    await expect(lastHeader).toHaveText("E")
    const headerBox = await lastHeader.boundingBox()
    const scrollerBox = await scroller.boundingBox()
    expect(headerBox!.x).toBeGreaterThan(scrollerBox!.x + 20)
    expect(headerBox!.x + headerBox!.width).toBeGreaterThan(scrollerBox!.x + scrollerBox!.width - 20)
  })

  test("only 128 columns are rendered for a 200-column file", async ({ page }: { page: Page }) => {
    await page.goto(wideHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()
    await expect(csvColumnHeaders(page)).toHaveCount(128)
    const cellsInFirstRow = await renderedRows(page).first().locator("> div").count()
    expect(cellsInFirstRow).toBe(129)
    await expect(page.locator("[data-csv-preview]")).toContainText("More than 128 columns")
  })

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
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(PAGE_DELAY * 3)

    const maxConcurrent = await page.evaluate(() => (window as any).__csvMaxConcurrent as number)
    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(calls.length).toBeLessThanOrEqual(12)

    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight * 0.3
      element.dispatchEvent(new Event("scroll"))
    })
    await expect(renderedRows(page).first()).toBeVisible()
    expect(await renderedRows(page).count()).toBeLessThan(80)
  })

  // 复验 P1（新）：已有 2 个请求在途时刷新，峰值仍是 2（旧实现清空计数后变 3，
  // 且把同一 offset 又请求了一次）。
  test("a refresh while two requests are in flight keeps the peak at two", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: VIRTUAL_ROWS, delayMs: PAGE_DELAY })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()

    const scroller = page.locator("[data-csv-scroll]")
    // 快速滚动到远处，让两个请求都还在途。
    for (const fraction of [0.3, 0.9]) {
      await scroller.evaluate((element, ratio) => {
        element.scrollTop = element.scrollHeight * ratio
        element.dispatchEvent(new Event("scroll"))
      }, fraction)
    }
    await page.waitForTimeout(120)
    const inflightBefore = await page.evaluate(() => (window as any).__csvActive as number)
    expect(inflightBefore).toBeGreaterThan(0)

    await page.evaluate(() => (window as any).__bumpRevision())
    await page.waitForTimeout(PAGE_DELAY * 3)

    const maxConcurrent = await page.evaluate(() => (window as any).__csvMaxConcurrent as number)
    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    // 同一 offset 不被重复请求（旧实现在刷新后重复了 39984）。
    const offsets = calls.map(call => call.offset)
    const duplicates = offsets.filter((offset, index) => offsets.indexOf(offset) !== index)
    expect(duplicates.length, `duplicate offsets: ${duplicates}`).toBeLessThanOrEqual(1)
  })

  // 复验 P2（新）：150 万行翻到第 2 屏后刷新，页码与元数据都保留。
  test("a disk refresh keeps the paged position instead of jumping back to row 1", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, delayMs: 20 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 1")

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 2")

    await page.evaluate(() => (window as any).__bumpRevision())
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText("Screen 2")

    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    expect(calls.some(call => call.offset === 500)).toBe(true)
  })

  // 复验 P1（新）：文件被改小（150 万 → 20 行）后刷新，页码回到有效屏、
  // 摘要与总行数一起更新，而不是旧页空白 + 摘要仍是旧值。
  test("a refresh after the file shrank clamps the screen and refreshes the summary", async ({
    page,
  }: {
    page: Page
  }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, delayMs: 20 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 翻到很后面的一屏，再把文件缩成 20 行并触发刷新。
    for (let step = 0; step < 3; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1501")

    await page.evaluate(() => {
      const target = window as any
      target.__csvShrinkTo(20)
      target.__bumpRevision()
    })

    await expect(page.locator("[data-csv-rows]")).toContainText("20 rows")
    // 旧页码（1501）已越界：回到第 1 行；行数降到 20 后重新落回虚拟滚动，
    // 翻屏器随之消失（这正是「文件被改小」后的正确形态）。
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await expect(page.locator("[data-csv-pager]")).toHaveCount(0)
    await expect(page.locator("[data-csv-body]")).toHaveAttribute("style", /height: 520px/)
  })

  // 复验 P1（新）：永久失败（例如超 256 MiB）不再自动循环重试，只保留一次显式重试。
  test("a permanent read error stops retrying and offers one explicit retry", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: VIRTUAL_ROWS, alwaysFail: true, delayMs: 40 })
    await page.goto(backendHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(page.locator("[data-csv-preview] [role=alert]")).toBeVisible()

    // 不操作也不应继续请求（旧实现会记录 10 次完成 + 第 11 次在途）。
    await page.waitForTimeout(900)
    const calls = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(calls, `calls without user action: ${calls}`).toBeLessThanOrEqual(1)
    await expect(page.locator("[data-csv-retry]")).toBeVisible()

    // 显式重试才会再请求一次，然后再次停下。
    await page.locator("[data-csv-retry]").click()
    await page.waitForTimeout(700)
    const afterRetry = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(afterRetry).toBeGreaterThan(1)
    expect(afterRetry).toBeLessThanOrEqual(4)
  })

  // 复验 P2（新）：后端按字节预算只回 150 行时，翻屏步长按**实际行数**计算，
  // 前进/后退都不会跳行（旧实现固定 ±500，出现 1 → 601 → 101）。
  test("short slices page forward and back by the real row count", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: 1_500_000, rowsPerPage: 150, delayMs: 10 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "151")

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "301")

    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "151")

    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  // 复验 P1（新）：旧代请求结束时必须唤醒新代队列。场景：两个请求在途 → 刷新
  // （回到顶部）→ 旧请求才结束。旧实现只在同代 finally 里 pump()，名额释放后
  // 画面一直空白，必须手工滚动才恢复。
  test("finishing stale requests still wakes the refreshed queue", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: VIRTUAL_ROWS, delayMs: PAGE_DELAY })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()

    const scroller = page.locator("[data-csv-scroll]")
    // 跳到远处，让两个请求都挂住。
    for (const fraction of [0.25, 0.65]) {
      await scroller.evaluate((element, ratio) => {
        element.scrollTop = element.scrollHeight * ratio
        element.dispatchEvent(new Event("scroll"))
      }, fraction)
    }
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => (window as any).__csvActive as number)).toBeGreaterThan(0)

    // 回到顶部并刷新：新代排队的 0 号缺口必须被旧请求结束后的那次唤醒带走。
    await scroller.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await page.evaluate(() => (window as any).__bumpRevision())

    // 不手动滚动：等旧请求全部结束 + 新代补齐。
    await page.waitForTimeout(PAGE_DELAY * 4)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    expect(await renderedRows(page).count()).toBeGreaterThan(0)
    const maxConcurrent = await page.evaluate(() => (window as any).__csvMaxConcurrent as number)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  // 复验 P2（新）：每次只回 10 行时，首屏「下一屏」可用前不应已经打满 50 个请求。
  test("a tiny slice size does not prefetch the whole 500-row screen", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 10, delayMs: 5 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await page.waitForTimeout(400)

    const calls = await page.evaluate(() => (window as any).__csvCalls.length as number)
    // 只取视口（~27 行 + overscan）所需的几个 10 行片段，而不是整屏 500 行。
    expect(calls, `prefetched ${calls} slices before paging`).toBeLessThanOrEqual(10)

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "11")
  })

  // 复验 P2（新）：前驱被逐出后按**实际屏长**回退，不跳行。
  test("paging back without a cached predecessor uses the real screen length", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 150, delayMs: 5 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    for (let step = 0; step < 8; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1201")

    // 8 屏 150 行已超过缓存上限（3000 行），第 1 屏与第 2 屏都应被逐出。
    for (let step = 0; step < 8; step++) {
      await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
      await page.locator("[data-csv-page-prev]").click()
    }
    // 回退步长必须是 150，而不是固定 500：8 次回退 = 1201 → 1，不出现 701 之类的错位。
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  // 复验 P2（新）：文件从 8 列缩到 1 列后刷新，不能残留 8 个表头。
  test("a refresh after the file got narrower drops the stale columns", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: 5000, columns: 8, delayMs: 20 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(csvColumnHeaders(page)).toHaveCount(8)

    await page.evaluate(() => {
      const target = window as any
      target.__csvSetColumns(1)
      target.__bumpRevision()
    })

    await expect(csvColumnHeaders(page)).toHaveCount(1)
    await expect(page.locator("[data-csv-preview]")).toContainText("1 columns")
    const firstRowCells = await renderedRows(page).first().locator("> div").count()
    // 行号单元格 + 剩下的一列（Playwright 的 expect 只接受一个参数）。
    expect(firstRowCells, "row-number cell + the single remaining column").toBe(2)
  })

  // 复验 P2（新）：连续翻 9 屏后回头取第 1 屏，必须重新请求（缓存有行数上限），
  // 而不是「九屏全部常驻、永不重取」。
  test("the row cache evicts instead of holding every visited screen", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, delayMs: 10 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    const callsBefore = await page.evaluate(() => (window as any).__csvCalls.length as number)
    for (let step = 0; step < 9; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "4501")
    const callsAfterForward = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(callsAfterForward).toBeGreaterThan(callsBefore)

    // 回到第 1 屏：第 1 屏应已被逐出，需要重新请求。
    for (let step = 0; step < 9; step++) {
      await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
      await page.locator("[data-csv-page-prev]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    const offsets = await page.evaluate(() => (window as any).__csvCalls as { offset: number }[])
    const zeroCalls = offsets.filter(call => call.offset === 0).length
    // 首次 1 次 + 之后至少一次重取；上限由缓存行数决定，不随「访问过几屏」增长。
    expect(zeroCalls).toBeGreaterThanOrEqual(2)
    expect(zeroCalls).toBeLessThanOrEqual(6)
  })
})
