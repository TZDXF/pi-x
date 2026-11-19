<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AlertCircle } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { formatCodedError } from "@/lib/backendError"
import { readCsvPage } from "@/api/client/projectFiles"
import {
  CSV_OVERSCAN,
  CSV_PAGE_CACHE_LIMIT,
  CSV_PAGE_ROWS,
  CSV_ROW_HEIGHT,
  csvBodyHeight,
  csvCellWidth,
  csvCellText,
  csvCells,
  csvColumnLabel,
  csvPageOf,
  csvPagesForWindow,
  csvRowWindow,
  csvUsesVirtualScroll,
  parseCsvRows,
  type CsvPage,
} from "@/lib/csvTable"

/**
 * CSV/TSV 表格预览。
 *
 * 大文件性能的三条约束：
 * 1. 传输有界：后端 `read_csv_page` 流式解析、每次只回一页（≤1000 行），
 *    前端永不持有整份文件；
 * 2. 渲染有界：固定行高 + 绝对定位的虚拟窗口，DOM 里只有视口内的行，
 *    行数从 1 万增长到 100 万，渲染成本不变；
 * 3. 回滚有界：页缓存有上限（[`CSV_PAGE_CACHE_LIMIT`]），往回滚动不会让
 *    内存随浏览过的区域线性增长。
 *
 * 行数超过 [`CSV_MAX_VIRTUAL_ROWS`] 时单一滚动面的高度会越过浏览器元素上限
 * （Chromium 约 33.5M px），虚拟滚动已无法到达尾部，因此自动改为「一页一屏 +
 * 翻页」：渲染规模与分页请求数与行数无关，只是换了导航方式。
 *
 * `text` 模式（资源/批注预览的 `readFile` 覆盖只给一段有界文本）下，同一套
 * 规则在本地一次解析成全部行，再复用同一个虚拟窗口，不额外分页请求。
 */
const props = withDefaults(
  defineProps<{
    project: string
    path: string
    /** Bounded text blob; when set, no backend page requests are made. */
    text?: string | null
    /** Bumped when the file changed on disk; reloads the visible page. */
    revision?: number
  }>(),
  { text: undefined, revision: 0 },
)
const { t } = useI18n()

const header = ref<string[] | null>(null)
const columnCount = ref(0)
const totalRows = ref<number | null>(null)
const delimiter = ref(",")
const fileBytes = ref(0)
const truncatedColumns = ref(false)
const truncatedCells = ref(false)
const loading = ref(false)
const errorCause = ref<unknown>(null)
const error = computed(() => (errorCause.value == null ? "" : formatCodedError(t, errorCause.value)))

/** Backend mode: data rows by page index, each page holding at most CSV_PAGE_ROWS rows. */
const pages = new Map<number, string[][]>()
/** Client mode: the whole bounded blob, already parsed. */
const clientRows = ref<string[][] | null>(null)
/** Bumped whenever rows arrive so the computed window re-renders. */
const version = ref(0)

const rowCount = computed(() => {
  if (clientRows.value) return clientRows.value.length
  return totalRows.value ?? Math.max(0, ...loadedPageEnds())
})
function loadedPageEnds() {
  if (!pages.size) return [0]
  return [...pages.keys()].map(index => index * CSV_PAGE_ROWS + (pages.get(index)?.length ?? 0))
}

function applyPage(page: CsvPage) {
  const pageIndex = csvPageOf(page.offset)
  if (page.rows.length) pages.set(pageIndex, page.rows)
  else pages.delete(pageIndex)
  if (page.header) header.value = page.header
  columnCount.value = Math.max(columnCount.value, page.columnCount, page.header?.length ?? 0)
  if (page.offset === 0) totalRows.value = page.totalRows
  delimiter.value = page.delimiter
  fileBytes.value = page.fileBytes
  truncatedColumns.value ||= page.truncatedColumns
  truncatedCells.value ||= page.truncatedCells
  prunePages(pageIndex)
  version.value += 1
}

/**
 * Keep page 0, the page just loaded and its neighbours (a window spanning a page
 * boundary needs both), then drop the rest oldest-first. Dropping a page that is
 * currently rendered would leave a hole until the next scroll event.
 */
function prunePages(keep: number) {
  if (pages.size <= CSV_PAGE_CACHE_LIMIT) return
  const protectedPages = new Set([0, keep - 1, keep, keep + 1])
  for (const index of [...pages.keys()]) {
    if (pages.size <= CSV_PAGE_CACHE_LIMIT) break
    if (!protectedPages.has(index)) pages.delete(index)
  }
}

const pending = new Set<number>()
async function ensurePages(indexes: number[]) {
  // 只认「文件切换」这一代：并发的两次 ensurePages（例如快速滚动跨页）不该
  // 互相作废，否则先返回的那一页会被丢弃，窗口里就出现空洞。
  const requested = requestSeq
  for (const index of indexes) {
    if (props.text !== undefined || pages.has(index) || pending.has(index)) continue
    // 已知总行数后不再越过末页请求：统计期间滚到尾部会多打一次空页。
    if (totalRows.value != null && index * CSV_PAGE_ROWS >= totalRows.value) continue
    pending.add(index)
    loading.value = true
    try {
      const page = await readCsvPage(props.project, props.path, index * CSV_PAGE_ROWS, CSV_PAGE_ROWS)
      if (requested !== requestSeq) return
      applyPage(page)
      errorCause.value = null
    } catch (cause) {
      if (requested !== requestSeq) return
      errorCause.value = cause
    } finally {
      pending.delete(index)
      if (requested === requestSeq) loading.value = pending.size > 0
    }
  }
}

// ---- 虚拟窗口：渲染行数只由视口高度决定 ----
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
let observer: ResizeObserver | null = null
watch(
  scroller,
  element => {
    observer?.disconnect()
    if (!element) return
    viewportHeight.value = element.clientHeight
    observer = new ResizeObserver(() => {
      viewportHeight.value = element.clientHeight
    })
    observer.observe(element)
  },
  { flush: "post" },
)

// ---- 加载：序号作废旧的在途请求，避免切换文件时旧内容闪现到新文件 ----
let requestSeq = 0
async function load() {
  ++requestSeq
  pages.clear()
  pending.clear()
  clientRows.value = null
  header.value = null
  columnCount.value = 0
  totalRows.value = null
  truncatedColumns.value = false
  truncatedCells.value = false
  errorCause.value = null
  loading.value = false
  scrollTop.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
  if (props.text !== undefined) {
    if (props.text == null) return
    const parsed = parseCsvRows(props.text, props.path)
    header.value = parsed.header
    clientRows.value = parsed.rows
    columnCount.value = parsed.columnCount
    totalRows.value = parsed.rows.length
    truncatedColumns.value = parsed.truncatedColumns
    truncatedCells.value = parsed.truncatedCells
    delimiter.value = parsed.delimiter
    fileBytes.value = parsed.fileBytes
    version.value += 1
    return
  }
  pageIndex.value = 0
  await ensurePages([0])
}

const virtual = computed(() => csvUsesVirtualScroll(rowCount.value))
/** Page shown in paged mode; also the page the virtual window currently sits on. */
const pageIndex = ref(0)
/** Row index that maps to `top: 0` in the scroll surface. */
const baseRow = computed(() => (virtual.value ? 0 : pageIndex.value * CSV_PAGE_ROWS))
const bodyHeight = computed(() => csvBodyHeight(virtual.value ? rowCount.value : pageRows.value))
const pageCount = computed(() => Math.max(1, Math.ceil(rowCount.value / CSV_PAGE_ROWS)))

function goToPage(index: number) {
  pageIndex.value = Math.min(Math.max(0, index), pageCount.value - 1)
  if (scroller.value) scroller.value.scrollTop = 0
  if (props.text !== undefined) {
    void ensurePages([0])
    return
  }
  void ensurePages([pageIndex.value])
}

/** Rows on the current page in paged mode (`CSV_PAGE_ROWS` except on the last page). */
const pageRows = computed(() => Math.max(0, Math.min(CSV_PAGE_ROWS, rowCount.value - baseRow.value)))
const rowWindow = computed(() => {
  void version.value
  if (virtual.value) return csvRowWindow(scrollTop.value, viewportHeight.value, rowCount.value)
  // 分页模式仍按视口渲染：滚动面只覆盖当前页，DOM 规模与总行数无关。
  const local = csvRowWindow(scrollTop.value, viewportHeight.value, pageRows.value)
  return { start: baseRow.value + local.start, end: baseRow.value + local.end }
})
const visibleRows = computed(() => {
  void version.value
  const { start, end } = rowWindow.value
  const rendered: { index: number; cells: string[] }[] = []
  for (let index = start; index < end; index++) {
    const row = rowAt(index)
    if (!row) continue
    rendered.push({ index, cells: csvCells(row, Math.max(columnCount.value, header.value?.length ?? 0)) })
  }
  return rendered
})
function rowAt(index: number): string[] | undefined {
  if (clientRows.value) return clientRows.value[index]
  const pageIndex = csvPageOf(index)
  return pages.get(pageIndex)?.[index - pageIndex * CSV_PAGE_ROWS]
}

// 内容变更（磁盘刷新）与文件切换共用同一路径：先清空再按需加载。放在全部状态
// 声明之后，避免 immediate 回调在初始化过程中读到尚未定义的状态。
watch(
  () => [props.project, props.path, props.text, props.revision] as const,
  () => void load(),
  {
    immediate: true,
  },
)

function onScroll() {
  const element = scroller.value
  if (!element) return
  scrollTop.value = element.scrollTop
  if (props.text !== undefined) return
  const { start, end } = rowWindow.value
  if (!virtual.value) {
    // 分页模式不随滚动换页：一页即一屏，换页只走翻页按钮。
    void ensurePages([pageIndex.value])
    return
  }
  void ensurePages(csvPagesForWindow(Math.max(0, start - CSV_OVERSCAN), end + CSV_OVERSCAN))
}

onBeforeUnmount(() => {
  ++requestSeq
  observer?.disconnect()
  observer = null
})

// ---- 展示 ----
const totalLabel = computed(() =>
  totalRows.value != null ? t("projectFiles.csvRows", { count: totalRows.value }) : t("projectFiles.csvRowsPending"),
)
const columns = computed(() => {
  const count = Math.max(columnCount.value, header.value?.length ?? 0)
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: csvColumnLabel(header.value, index),
  }))
})
const cellWidth = computed(() => `${csvCellWidth(Math.max(1, columns.value.length))}px`)
const fileSize = computed(() => formatBytes(fileBytes.value))
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[exponent]}`
}
const delimiterText = computed(() => (delimiter.value === "\\t" ? "TAB" : delimiter.value))
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-csv-preview>
    <p
      v-if="error"
      role="alert"
      class="flex shrink-0 items-start gap-1.5 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <AlertCircle class="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span class="break-words">{{ error }}</span>
    </p>
    <div
      ref="scroller"
      data-csv-scroll
      class="scrollbar-custom min-h-0 min-w-0 flex-1 overflow-auto"
      :style="{ minWidth: `calc(3.5rem + ${columns.length} * ${cellWidth})` }"
      @scroll="onScroll"
    >
      <div class="w-max min-w-full">
        <!-- 表头独立于虚拟滚动内容：始终吸顶，不随行数增长进入 DOM -->
        <div class="sticky top-0 z-20 flex border-b bg-muted/60 font-mono text-xs">
          <div
            class="sticky left-0 z-30 w-14 shrink-0 border-r bg-muted/60 px-2 py-1 text-right text-muted-foreground select-none"
          >
            #
          </div>
          <div
            v-for="column in columns"
            :key="column.index"
            class="shrink-0 truncate border-r px-2 py-1 font-medium"
            :style="{ width: cellWidth }"
            :title="column.label"
            data-csv-header
          >
            {{ column.label }}
          </div>
        </div>
        <div class="relative font-mono text-xs" :style="{ height: `${bodyHeight}px` }" data-csv-body>
          <div
            v-for="row in visibleRows"
            :key="row.index"
            class="absolute inset-x-0 flex"
            :style="{ top: `${(row.index - baseRow) * CSV_ROW_HEIGHT}px`, height: `${CSV_ROW_HEIGHT}px` }"
            :data-csv-row="row.index + 1"
          >
            <div
              class="sticky left-0 z-10 w-14 shrink-0 border-r border-b bg-background px-2 text-right leading-6 text-muted-foreground/60 select-none"
            >
              {{ row.index + 1 }}
            </div>
            <div
              v-for="(cell, index) in row.cells"
              :key="index"
              class="shrink-0 truncate border-r border-b px-2 leading-6"
              :style="{ width: cellWidth }"
              :title="cell"
            >
              {{ csvCellText(cell) || " " }}
            </div>
          </div>
        </div>
      </div>
      <p v-if="loading" class="p-3 font-mono text-xs text-muted-foreground">{{ t("completion.loading") }}</p>
    </div>
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1 text-[11px] text-muted-foreground"
    >
      <span data-csv-rows>{{ totalLabel }}</span>
      <span>{{ t("projectFiles.csvColumns", { count: columns.length }) }}</span>
      <span v-if="truncatedColumns">{{ t("projectFiles.csvColumnOverflow", { limit: 128 }) }}</span>
      <span v-if="truncatedCells">{{ t("projectFiles.csvCellTruncated", { limit: 4096 }) }}</span>
      <span>{{ t("projectFiles.csvDelimiter", { delimiter: delimiterText }) }}</span>
      <span>{{ fileSize }}</span>
      <!-- 超过虚拟滚动上限（浏览器元素高度 ~33.5M px）后改为翻页：渲染与请求规模
           都与行数无关，只是把「滚动到底」换成「翻到下一屏」。 -->
      <span v-if="!virtual" class="ml-auto flex items-center gap-2" data-csv-pager>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-1.5 text-[11px]"
          :disabled="pageIndex === 0 || loading"
          data-csv-page-prev
          @click="goToPage(pageIndex - 1)"
          >{{ t("projectFiles.csvPrevPage") }}</Button
        >
        <span data-csv-page-label>{{ t("projectFiles.csvPage", { page: pageIndex + 1, pages: pageCount }) }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-1.5 text-[11px]"
          :disabled="pageIndex >= pageCount - 1 || loading"
          data-csv-page-next
          @click="goToPage(pageIndex + 1)"
          >{{ t("projectFiles.csvNextPage") }}</Button
        >
      </span>
      <span v-else class="ml-auto">{{ t("projectFiles.csvScrollHint") }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 与 ProjectFilePreview 的代码视图共用同一套滚动条外观 */
.scrollbar-custom {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.scrollbar-custom::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.scrollbar-custom::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-custom::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
</style>
