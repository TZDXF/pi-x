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
window.__unmount = () => app.unmount()
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

/**
 * 真实 `ProjectFiles` 文件树：用于验证「切换 CSV 后分页历史按文件隔离」。
 * 文件页数据由 mock IPC 按文件名提供（a.csv 100/200/200…，b.csv 固定 200）。
 */
const projectFilesHtml = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ProjectFiles from '/src/components/ProjectFiles.vue'
import '/src/style.css'
createApp({ render: () => h('div', { style: 'display:flex;height:650px;width:1100px' }, [h(ProjectFiles, { project: 'C:/demo' })]) })
  .use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  .use(createPinia())
  .mount('#app')
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
const limitParam = Number(new URLSearchParams(location.search).get('historyLimit'))
const screenHistoryLimit = limitParam > 0 ? limitParam : 2048
const app = createApp({
  render: () => h('div', { style: 'display:flex;height:700px;width:1200px' }, [
    h(CsvTablePreview, { project: 'C:/demo', path: 'big.csv', revision: revision.value, screenHistoryLimit }),
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

/**
 * Wait until the preview has no request in flight **and** a frame has painted.
 * Paging state is only meaningful once the previous move settled; querying a
 * disabled/enabled button mid-flight measures a transient, not the state under
 * test. This is a synchronisation helper, not a relaxed timeout.
 */
async function settle(page: Page) {
  await expect(page.locator("[data-csv-preview]")).toHaveAttribute("data-csv-pending", "0")
  await page.evaluate(() => new Promise(requestAnimationFrame))
}

test.describe("csv table preview", () => {
  let virtualHarness!: VueHarness
  let pagedHarness!: VueHarness
  let backendHarness!: VueHarness
  let narrowHarness!: VueHarness
  let wideHarness!: VueHarness
  let refreshHarness!: VueHarness
  let projectFilesHarness!: VueHarness

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
    projectFilesHarness = await startVueHarness({ name: "csv-project-files", port: 1470, html: projectFilesHtml })
  })

  test.afterAll(async () => {
    await virtualHarness.close()
    await pagedHarness.close()
    await backendHarness.close()
    await narrowHarness.close()
    await wideHarness.close()
    await refreshHarness.close()
    await projectFilesHarness.close()
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

  // 复验 P2：前驱缓存被逐出后靠屏历史精确回退（不再用当前屏长猜）。
  test("paging back without a cached predecessor still lands on the exact screen", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 150, delayMs: 5 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    for (let step = 0; step < 8; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1201")

    // 8 屏 150 行远超缓存上限（3000 行），前几屏的 chunk 已被逐出。
    for (let step = 0; step < 8; step++) {
      await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
      await page.locator("[data-csv-page-prev]").click()
    }
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

  // 复验 P2（新）：卸载后旧请求结束不得再触发调度（旧实现只递增 generation，
  // 而 `finally` 里的无条件 pump() 仍会发请求）。
  test("a late request after unmount never schedules anything", async ({ page }: { page: Page }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      target.__release = null as null | (() => void)
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset?: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          target.__csvCalls.push(args.offset)
          if (args.offset === 0) {
            return Promise.resolve({
              offset: 0,
              rows: Array.from({ length: 500 }, (_, i) => [String(i), `v${i}`]),
              header: ["c0", "c1"],
              more: true,
              totalRows: 300_002,
              columnCount: 2,
              truncatedColumns: false,
              truncatedCells: false,
              budgetTruncated: false,
              delimiter: ",",
              fileBytes: 1,
            })
          }
          // 远处的请求挂住，直到测试手动放行。
          return new Promise(resolve => {
            target.__release = () =>
              resolve({
                offset: args.offset,
                rows: Array.from({ length: 500 }, (_, i) => [String(args.offset! + i), "v"]),
                header: ["c0", "c1"],
                more: true,
                totalRows: null,
                columnCount: 2,
                truncatedColumns: false,
                truncatedCells: false,
                budgetTruncated: false,
                delimiter: ",",
                fileBytes: 1,
              })
          })
        },
      })
    })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toBeVisible()

    const scroller = page.locator("[data-csv-scroll]")
    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight * 0.6
      element.dispatchEvent(new Event("scroll"))
    })
    await page.waitForFunction(() => (window as any).__release !== null)

    // 卸载组件（模拟关闭预览），再放行旧请求。
    await page.evaluate(() => {
      const target = window as any
      target.__unmount?.()
    })
    const callsBefore = await page.evaluate(() => (window as any).__csvCalls.length as number)
    await page.evaluate(() => (window as any).__release())
    await page.waitForTimeout(300)
    const callsAfter = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(callsAfter, "unmounted preview must not schedule new requests").toBe(callsBefore)
  })

  // 复验 P2（新）：切片长度可变（100/200 交替）时，驱逐后回退必须精确，
  // 不能因为「当前屏长」推断前驱而错位（旧实现 1001 → 801，预期 901）。
  test("back-paging with variable slice lengths never skips rows", async ({ page }: { page: Page }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      const total = 1_500_000
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset: number; limit: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          target.__csvCalls.push(args.offset)
          // 起点是 300 的倍数时只回 100 行，其余回 200 行。
          const length = args.offset % 300 === 0 ? 100 : 200
          const rows: string[][] = []
          for (let row = args.offset; row < Math.min(args.offset + length, total); row++) {
            rows.push([String(row), `v${row}`])
          }
          return Promise.resolve({
            offset: args.offset,
            rows,
            header: ["c0", "c1"],
            more: args.offset + rows.length < total,
            totalRows: args.offset === 0 ? total : null,
            columnCount: 2,
            truncatedColumns: false,
            truncatedCells: false,
            budgetTruncated: false,
            delimiter: ",",
            fileBytes: 1,
          })
        },
      })
    })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 记录每一屏的首行号，前进若干屏后再逐屏回退，必须原路返回。
    const starts: number[] = [1]
    for (let step = 0; step < 20; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
      const first = Number(await renderedRows(page).first().getAttribute("data-csv-row"))
      starts.push(first)
      if (first >= 901) break
    }
    expect(starts).toContain(901)

    const back: number[] = []
    for (let step = starts.length - 1; step > 0; step--) {
      await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
      await page.locator("[data-csv-page-prev]").click()
      back.push(Number(await renderedRows(page).first().getAttribute("data-csv-row")))
    }
    // 回退序列必须与前进序列（去掉最后一屏）完全一致，不能错位。
    expect(back).toEqual(starts.slice(0, -1).reverse())
  })

  // 复验 P2（新）：切换文件后分页历史必须按文件隔离——旧文件的屏起点不能成为
  // 新文件的「上一屏」（真实 ProjectFiles 文件树里复现：a.csv 的 100 被用给 b.csv）。
  test("pagination history does not leak between files", async ({ page }: { page: Page }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvFiles = {
        // a.csv 的切片是 100/200/…，b.csv 固定 200。
        "a.csv": { lengths: [100, 200, 200], total: 1_500_002 },
        "b.csv": { lengths: [200], total: 1_500_002 },
      }
      target.__csvCalls = []
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { path?: string; offset?: number; limit?: number }) => {
          if (command === "list_project_directory") {
            return args.path
              ? []
              : [
                  { name: "a.csv", path: "a.csv", is_dir: false },
                  { name: "b.csv", path: "b.csv", is_dir: false },
                ]
          }
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          const file = target.__csvFiles[args.path as string]
          const offset = args.offset ?? 0
          const index = offset === 0 ? 0 : target.__csvCalls.filter((call: any) => call.path === args.path).length
          const length = file.lengths[index] ?? file.lengths[file.lengths.length - 1]
          target.__csvCalls.push({ path: args.path, offset })
          const rows: string[][] = []
          for (let row = offset; row < Math.min(offset + length, file.total); row++) {
            rows.push([String(row), `${args.path}-${row}`])
          }
          return Promise.resolve({
            offset,
            rows,
            header: ["c0", "c1"],
            more: offset + rows.length < file.total,
            totalRows: offset === 0 ? file.total : null,
            columnCount: 2,
            truncatedColumns: false,
            truncatedCells: false,
            budgetTruncated: false,
            delimiter: ",",
            fileBytes: 1,
          })
        },
      })
    })
    await page.goto(projectFilesHarness.url)
    await page.getByRole("button", { name: "a.csv" }).click()
    await expect(page.locator("[data-csv-preview]")).toBeVisible()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // a.csv：0 → 100 → 300。
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "301")

    // 切到 b.csv（固定 200/屏）：0 → 200，再回退必须回到 b.csv 的 0。
    await page.getByRole("button", { name: "b.csv" }).click()
    const preview = page.locator("[data-csv-preview]")
    await expect(preview).toBeVisible()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "201")
    await page.locator("[data-csv-page-prev]").click()
    // 旧实现会落到 a.csv 遗留的 101 —— 内容仍是 b.csv，但位置错了。
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  // 复验 P2（新）：首页 chunk 被逐出后，仍要能一步退回 offset 0。
  test("the first screen stays reachable after its rows were evicted", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 100, delayMs: 5 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    for (let step = 0; step < 12; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    for (let step = 0; step < 11; step++) {
      await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
      await page.locator("[data-csv-page-prev]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")
    await expect(page.locator("[data-csv-page-prev]")).toBeEnabled()
    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  // 复验 P2（新）：历史被裁到不含前驱、且缓存里也没有紧邻前驱 chunk 时，
  // 回退必须**禁用**，而不是用当前屏长猜一个错误 offset。
  test("back-paging refuses instead of guessing once the history is gone", async ({ page }: { page: Page }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 100, delayMs: 5 })
    // historyLimit=3：只保留最近 3 个屏起点，前进 10 屏后最早的那些已被裁掉。
    await page.goto(`${refreshHarness.url}?historyLimit=3`)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    for (let step = 0; step < 10; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    // 逐屏回退，直到历史里已经没有更早的起点且缓存也没有紧邻前驱。
    let guard = 0
    while (guard++ < 10) {
      await settle(page)
      const enabled = await page.locator("[data-csv-page-prev]").isEnabled()
      if (!enabled) break
      const before = await renderedRows(page).first().getAttribute("data-csv-row")
      await page.locator("[data-csv-page-prev]").click()
      await expect(renderedRows(page).first()).not.toHaveAttribute("data-csv-row", String(before))
      const after = await renderedRows(page).first().getAttribute("data-csv-row")
      // 每次回退都必须严格前进（行号变小），绝不能停在同一个位置。
      expect(Number(after), `back from ${before} must move to an earlier row`).toBeLessThan(Number(before))
    }
    await settle(page)
    // 无精确目标时按钮禁用：不是「点了落到猜测 offset」。
    await expect(page.locator("[data-csv-page-prev]")).toBeDisabled()

    // 且再点也不会产生新的分页请求（不会偷偷跳到猜测的 offset）。
    const callsBefore = await page.evaluate(() => (window as any).__csvCalls.length as number)
    await page.locator("[data-csv-page-prev]").click({ force: true })
    await page.waitForTimeout(200)
    const callsAfter = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(callsAfter, "a disabled back button must not page to a guessed offset").toBe(callsBefore)
  })

  // 复验 P2（第八轮·反例 1）：同一文件 revision 刷新后短页边界改变，旧代
  // 屏起点不得覆盖新代实际前驱（旧实现 0 → 200 回退落到 stale 100）。
  test("a same-file refresh rebuilds the paging history instead of reusing stale starts", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      // 第一代：100/200 交替；revision 之后改成每屏 200。
      target.__csvGen = 1
      target.__csvBump = () => {
        target.__csvGen = 2
      }
      const total = 1_500_000
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset: number; limit: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          const offset = args.offset
          const length = target.__csvGen === 1 ? (offset % 300 === 0 ? 100 : 200) : 200
          target.__csvCalls.push({ offset, length })
          const rows: string[][] = []
          for (let row = offset; row < Math.min(offset + length, total); row++) {
            rows.push([String(row), `v${row}`])
          }
          return Promise.resolve({
            offset,
            rows,
            header: ["c0", "c1"],
            more: offset + rows.length < total,
            totalRows: offset === 0 ? total : null,
            columnCount: 2,
            truncatedColumns: false,
            truncatedCells: false,
            budgetTruncated: false,
            delimiter: ",",
            fileBytes: 1,
          })
        },
      })
    })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 第一代走出 0 → 100 → 300 → 100 → 0 的路径。
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "301")
    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")
    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 文件刷新（宽度变化 → 每屏 200），新一代首页仍是 0。
    await page.evaluate(() => {
      const target = window as any
      target.__csvBump()
      target.__bumpRevision()
    })
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "201")
    await page.locator("[data-csv-page-prev]").click()
    // 必须回到刚离开的新代首页 0；旧实现的 stale 100 不算数。
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  // 复验 P2（第八轮·反例 2）：缓存里末尾恰好相接的**预取片段**不是屏起点。
  // 真实形状：`2400 + 200` 与 `2592 + 8` 都止于 2600。刷新后缓存里只剩首页、
  // 当前屏与 `2592 + 8` 这段预取；回退只能落到验证过的屏起点，不能落到 2592。
  test("a prefetched chunk that merely ends at the screen start is not a predecessor", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      const total = 1_500_000
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset: number; limit: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          const offset = args.offset
          // 整屏 200 行；视口预取（未与 200 对齐）只回 8 行 —— 这正是
          // 「2400+200」和「2592+8」同终点止于 2600 的真实页形状。
          const length = offset % 200 === 0 ? 200 : 8
          target.__csvCalls.push({ offset, length })
          const rows: string[][] = []
          for (let row = offset; row < Math.min(offset + length, total); row++) {
            rows.push([String(row), `v${row}`])
          }
          return Promise.resolve({
            offset,
            rows,
            header: ["c0", "c1"],
            more: offset + rows.length < total,
            totalRows: offset === 0 ? total : null,
            columnCount: 2,
            truncatedColumns: false,
            truncatedCells: false,
            budgetTruncated: false,
            delimiter: ",",
            fileBytes: 1,
          })
        },
      })
    })
    await page.goto(`${refreshHarness.url}?historyLimit=1`)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 走到 2600（13 屏 × 200）。
    for (let step = 0; step < 13; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "2601")

    // 触发刷新：缓存清空后重新取回首页与当前屏；视口在 2592 处开缺口，
    // 预取请求返回 8 行，止于 2600 —— 与真实前驱 2400+200 同终点。
    await page.evaluate(() => (window as any).__bumpRevision())
    await page.waitForTimeout(400)
    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number; length: number }[])
    expect(
      calls.some(call => call.offset === 2592 && call.length === 8),
      `expected an 8-row prefetch ending at 2600, got ${JSON.stringify(calls.slice(-6))}`,
    ).toBe(true)

    // historyLimit=1 只留下当前屏（2600），首页与预取片段都不是**验证过的屏起点**：
    // 回退必须禁用，且点击不产生新请求（绝不落到 2592）。
    await expect(page.locator("[data-csv-page-prev]")).toBeDisabled()
    const callsBefore = calls.length
    await page.locator("[data-csv-page-prev]").click({ force: true })
    await page.waitForTimeout(200)
    const callsAfter = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(callsAfter, "a cached 2592+8 chunk must not be used as a predecessor").toBe(callsBefore)
  })

  // 复验 P2（第九轮·反例 1）：刷新后恢复在非首页（1500），首页 0 只是「见过的
  // 起点」，不能当作 1500 的已验证前驱——无确认相邻时应禁用回退（旧实现跳 0）。
  test("a refresh restored on a non-home screen never treats offset 0 as its predecessor", async ({
    page,
  }: {
    page: Page
  }) => {
    await mockBackendPages(page, { total: PAGED_ROWS, rowsPerPage: 500, delayMs: 10 })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    for (let step = 0; step < 3; step++) {
      await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
      await page.locator("[data-csv-page-next]").click()
    }
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1501")

    // 同文件刷新（每屏仍 500 行）：位置保留在 1500，但新代尚未确认任何相邻关系。
    await page.evaluate(() => (window as any).__bumpRevision())
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1501")

    // 重取 1500 后屏长已知；但「上一屏」没有确认边：必须禁用且点击无新请求，
    // 绝不能落到首页 0。
    await expect(page.locator("[data-csv-page-prev]")).toBeDisabled()
    const callsBefore = await page.evaluate(() => (window as any).__csvCalls.length as number)
    await page.locator("[data-csv-page-prev]").click({ force: true })
    await page.waitForTimeout(200)
    const callsAfter = await page.evaluate(() => (window as any).__csvCalls.length as number)
    expect(callsAfter, "back-paging must not jump to the home screen after a refresh").toBe(callsBefore)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1501")

    // 确认后仍可正常前进：1500 + 500 = 2000。
    await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "2001")
  })

  // 复验 P2（第九轮·反例 2）：刷新后当前屏从精确 offset 重取前，不得用旧代页长
  // 计算「下一屏」（旧实现 100 → 300，按新代 80 行应为 180，或禁用）。
  test("forward paging after a refresh waits for the new generation's slice length", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      target.__csvGen = 1
      target.__csvBump = () => {
        target.__csvGen = 2
      }
      const total = 1_500_000
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset: number; limit: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          const offset = args.offset
          // 第 1 代：首屏 100 行，其余 200；第 2 代：每请求最多 80 行。
          const length = target.__csvGen === 1 ? (offset === 0 ? 100 : 200) : 80
          target.__csvCalls.push({ offset, length, gen: target.__csvGen })
          const rows: string[][] = []
          for (let row = offset; row < Math.min(offset + length, total); row++) {
            rows.push([String(row), `v${row}`])
          }
          return Promise.resolve({
            offset,
            rows,
            header: ["c0", "c1"],
            more: offset + rows.length < total,
            totalRows: offset === 0 ? total : null,
            columnCount: 2,
            truncatedColumns: false,
            truncatedCells: false,
            budgetTruncated: false,
            delimiter: ",",
            fileBytes: 1,
          })
        },
      })
    })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 第 1 代：0（100 行）→ 100（200 行）。
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")

    // 刷新成 80 行/页，位置保留在 100。
    await page.evaluate(() => {
      const target = window as any
      target.__csvBump()
      target.__bumpRevision()
    })
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")

    // 必须从 100 精确重取，并测到新代 80 行，然后「下一屏」才能到 180。
    await page.waitForFunction(() => {
      const calls = (window as any).__csvCalls as { offset: number; gen: number }[]
      return calls.some(call => call.gen === 2 && call.offset === 100)
    })
    await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "181")

    const calls = await page.evaluate(() => (window as any).__csvCalls as { offset: number; gen: number }[])
    expect(calls.some(call => call.gen === 2 && call.offset === 100)).toBe(true)
  })

  // 复验 P2（第十轮·原始时序）：连续两次刷新时，最新代的精确 offset=100 测长
  // 请求不能被「旧代同 offset 在途」或「首页行已覆盖第 100 行」吞掉。
  test("consecutive refreshes keep the newest generation's exact measure request", async ({ page }: { page: Page }) => {
    await page.addInitScript(() => {
      const target = window as any
      target.isTauri = true
      target.__csvCalls = []
      target.__csvGen = 1
      const total = 1_500_000
      // 第一代首页 100 行；之后每次刷新切换页长 160/80 并换代号。
      target.__pageLen = 100
      target.__bump = (len: number) => {
        target.__csvGen += 1
        target.__pageLen = len
      }
      // 可以挂起「非首页」的请求，测试手动放行。
      target.__hold = false
      target.__held = [] as { offset: number; gen: number; release: () => void }[]
      Reflect.set(target, "__TAURI_INTERNALS__", {
        invoke: (command: string, args: { offset: number; limit: number }) => {
          if (command !== "read_csv_page") return Promise.reject(new Error("unexpected " + command))
          const gen = target.__csvGen as number
          const offset = args.offset
          const length = offset === 0 ? (gen === 1 ? 100 : target.__pageLen) : target.__pageLen
          target.__csvCalls.push({ offset, length, gen })
          const build = () => {
            const rows: string[][] = []
            for (let row = offset; row < Math.min(offset + length, total); row++) {
              rows.push([String(row), `g${gen}-${row}`])
            }
            return {
              offset,
              rows,
              header: ["c0", "c1"],
              more: offset + rows.length < total,
              totalRows: offset === 0 ? total : null,
              columnCount: 2,
              truncatedColumns: false,
              truncatedCells: false,
              budgetTruncated: false,
              delimiter: ",",
              fileBytes: 1,
            }
          }
          if (target.__hold && offset !== 0) {
            return new Promise(resolve => {
              target.__held.push({ offset, gen, release: () => resolve(build()) })
            })
          }
          return Promise.resolve(build())
        },
      })
    })
    await page.goto(refreshHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")

    // 第一代：0（100 行）→ 100。
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")

    // 第一次刷新（页长 160）：挂起新代的 offset=100。
    await page.evaluate(() => {
      const target = window as any
      target.__hold = true
      target.__bump(160)
      target.__bumpRevision()
    })
    await page.waitForFunction(() => {
      const held = (window as any).__held as { offset: number; gen: number }[]
      return held.some(entry => entry.offset === 100 && entry.gen === 2)
    })

    // 第二次刷新（页长 80）：最新代（3）必须**自己**精确请求 100，而不是被
    // 「旧的 100 在途」或「首页行覆盖第 100 行」吞掉。
    await page.evaluate(() => {
      const target = window as any
      target.__bump(80)
      target.__bumpRevision()
    })
    // 旧代同 offset 仍在途时，最新代的**测长意图**必须保留（不是被吞掉）：
    // 在途名额仍为 2、精确请求尚未发出，但一旦旧请求结束就必须按精确起点重发。
    await page.waitForFunction(() => (window as any).__csvCalls.some((c: any) => c.gen === 3 && c.offset === 0))
    const beforeRelease = await page.evaluate(() => (window as any).__csvCalls as { offset: number; gen: number }[])
    expect(beforeRelease.some(call => call.gen === 3 && call.offset === 100)).toBe(false)

    // 释放旧代的 160 长请求（其结果会被丢弃）；名额一释放，最新代立刻按精确
    // 起点 100 重发测长请求，而不是靠「首页行已覆盖第 100 行」蒙过去。
    await page.evaluate(() => {
      const target = window as any
      target.__hold = false
      for (const entry of target.__held) entry.release()
      target.__held = []
    })
    await page.waitForFunction(() => {
      const calls = (window as any).__csvCalls as { offset: number; gen: number }[]
      return calls.some(call => call.gen === 3 && call.offset === 100)
    })
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "101")

    // 新代页长 80：下一屏到 180（不是 260 或 300）。
    await expect(page.locator("[data-csv-page-next]")).toBeEnabled()
    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "181")
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
