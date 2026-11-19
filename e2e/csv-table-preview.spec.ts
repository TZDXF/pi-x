import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-137：CSV 表格预览的大文件契约。
 *
 * 这里固定的是**结构性上界**（DOM 行数、分页请求数、每页行数），不是墙上时钟
 * 断言——它们才是「大文件仍然流畅」的成因，也比任何耗时阈值稳定。行数用内存
 * 合成数据，不访问任何外部服务。
 */
const VIRTUAL_ROWS = 300_000
const PAGED_ROWS = 1_500_000

function harnessHtml(rows: number, mode: "text" | "backend") {
  return `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import CsvTablePreview from '/src/components/CsvTablePreview.vue'
import '/src/style.css'
const rows = ${rows}
const lines = ['id,name,amount,note']
for (let i = 0; i < rows; i++) lines.push(i + ',name' + i + ',' + (i % 997) + '.' + (i % 13) + ',note row ' + i)
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

/** Fake `read_csv_page`: 500-row pages of a synthetic sheet, with call accounting. */
async function mockBackendPages(page: Page, rows: number) {
  await page.addInitScript((total: number) => {
    const target = window as any
    target.isTauri = true
    target.__csvCalls = []
    target.__csvActive = 0
    target.__csvMaxConcurrent = 0
    const pageOf = (offset: number, limit: number) => {
      const cells: string[][] = []
      for (let row = offset; row < Math.min(offset + limit, total); row++) {
        cells.push([String(row), `name${row}`, `${row % 997}.${row % 13}`])
      }
      return {
        offset,
        rows: cells,
        header: ["id", "name", "amount"],
        more: offset + limit < total,
        totalRows: offset === 0 ? total : null,
        columnCount: 3,
        truncatedColumns: false,
        truncatedCells: false,
        delimiter: ",",
        fileBytes: 20 * 1024 * 1024,
      }
    }
    Reflect.set(target, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args: { offset: number; limit: number }) => {
        if (command !== "read_csv_page") throw Error("unexpected command " + command)
        target.__csvCalls.push({ offset: args.offset, limit: args.limit })
        target.__csvActive += 1
        target.__csvMaxConcurrent = Math.max(target.__csvMaxConcurrent, target.__csvActive)
        await new Promise(resolve => setTimeout(resolve, 10))
        target.__csvActive -= 1
        return pageOf(args.offset, args.limit)
      },
    })
  }, rows)
}

const renderedRows = (page: Page) => page.locator("[data-csv-row]")

test.describe("csv table preview", () => {
  let virtualHarness!: VueHarness
  let pagedHarness!: VueHarness
  let backendHarness!: VueHarness

  test.beforeAll(async () => {
    virtualHarness = await startVueHarness({
      name: "csv-text",
      port: 1464,
      html: harnessHtml(VIRTUAL_ROWS, "text"),
    })
    pagedHarness = await startVueHarness({
      name: "csv-paged",
      port: 1465,
      html: harnessHtml(PAGED_ROWS, "text"),
    })
    backendHarness = await startVueHarness({
      name: "csv-backend",
      port: 1466,
      html: harnessHtml(VIRTUAL_ROWS, "backend"),
    })
  })

  test.afterAll(async () => {
    await virtualHarness.close()
    await pagedHarness.close()
    await backendHarness.close()
  })

  test("a 300k-row file renders a viewport-sized row set and follows scrolling", async ({ page }: { page: Page }) => {
    await page.goto(virtualHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    const first = renderedRows(page).first()
    await expect(first).toBeVisible()
    // 视口 700px / 行高 26px ≈ 27 行 + 上下各 8 行 overscan：与 30 万行无关。
    expect(await renderedRows(page).count()).toBeLessThan(80)
    await expect(page.locator("[data-csv-rows]")).toContainText(String(VIRTUAL_ROWS))
    expect(await page.locator("[data-csv-pager]")).toHaveCount(0)
    // 表头来自首条记录，列数来自最宽行；摘要条同时给出总行数与分隔符。
    const headers = page.locator("[data-csv-header]")
    await expect(headers).toHaveCount(4)
    await expect(headers.first()).toHaveText("id")
    await expect(headers.last()).toHaveText("note")
    await expect(page.locator("[data-csv-preview]")).toContainText("Delimiter ,")

    const scroller = page.locator("[data-csv-scroll]")
    // 供给虚拟滚动的总高度必须覆盖全部行（CSSOM 会把大数序列化成 7.8e+06px），
    // 否则「滚到底」不再等于「最后一行」。
    const bodyHeight = await page
      .locator("[data-csv-body]")
      .evaluate(el => Number.parseFloat(getComputedStyle(el).height))
    expect(bodyHeight).toBeCloseTo(VIRTUAL_ROWS * 26, -2)

    await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight / 2
      element.dispatchEvent(new Event("scroll"))
    })
    // 滚到中段后窗口跟随滚动位置（首行略高于中点，因为上方还有 overscan）。
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

  test("a file above the virtual-scroll ceiling switches to bounded page navigation", async ({
    page,
  }: {
    page: Page
  }) => {
    await page.goto(pagedHarness.url)
    await page.waitForFunction(() => (window as any).__ready === true)
    // 150 万行 × 26px 越过浏览器元素高度上限（~33.5M px），虚拟滚动不可达尾部。
    await expect(page.locator("[data-csv-pager]")).toBeVisible()
    // 翻页模式也不是「一页 = 500 个 DOM 行」：当前页同样按视口虚拟化。
    expect(await renderedRows(page).count()).toBeLessThan(80)
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
    await expect(page.locator("[data-csv-rows]")).toContainText(String(PAGED_ROWS))

    await page.locator("[data-csv-page-next]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "501")
    await expect(page.locator("[data-csv-page-label]")).toHaveText(/Page 2 of \d+/)
    expect(await renderedRows(page).count()).toBeLessThan(80)

    await page.locator("[data-csv-page-prev]").click()
    await expect(renderedRows(page).first()).toHaveAttribute("data-csv-row", "1")
  })

  test("project files come back one page at a time and only around the visible window", async ({
    page,
  }: {
    page: Page
  }) => {
    await mockBackendPages(page, VIRTUAL_ROWS)
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
    // 首屏 + 尾部窗口：两次请求足矣，且从不请求整份文件。
    expect(calls.length).toBeLessThanOrEqual(3)
    expect(Math.max(...calls.map(call => call.limit))).toBe(500)
    expect(Math.max(...calls.map(call => call.offset))).toBeLessThan(VIRTUAL_ROWS)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })
})
