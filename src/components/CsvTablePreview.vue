<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AlertCircle } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { formatCodedError } from "@/lib/backendError"
import { readCsvPage } from "@/api/client/projectFiles"
import {
  CSV_MAX_CELL_CHARS,
  CSV_MAX_COLUMNS,
  CSV_OVERSCAN,
  CSV_PAGE_CACHE_LIMIT,
  CSV_PAGE_ROWS,
  CSV_ROW_HEIGHT,
  csvBodyHeight,
  csvCellText,
  csvCellWidth,
  csvCells,
  csvColumnLabel,
  csvRenderedColumns,
  csvRowWindow,
  csvUsesVirtualScroll,
  parseCsvRows,
  type CsvPage,
} from "@/lib/csvTable"

/**
 * CSV/TSV 表格预览。
 *
 * 大文件性能的四条约束：
 * 1. 传输有界：后端 `read_csv_page` 流式解析、每次只回一段（≤500 行，且序列化
 *    字节有预算），前端永不持有整份文件；
 * 2. 渲染有界：固定行高 + 绝对定位的虚拟窗口，DOM 里只有视口内的行；可见列数
 *    被 [CSV_MAX_COLUMNS] 截断（后端报的 `columnCount` 可能更大，只用于提示）；
 * 3. 在途有界：**同时最多 2 个**分页请求，窗口移动时丢弃尚未发出的排队请求，
 *    因此快速跳过多个区段也不会堆起 N 个并发；
 * 4. 回滚有界：chunk 缓存有上限（[CSV_PAGE_CACHE_LIMIT]），往回滚动不会让内存
 *    随浏览过的区域线性增长。
 *
 * 行数超过 [`CSV_MAX_VIRTUAL_ROWS`] 时单一滚动面的高度会越过浏览器元素上限
 * （Chromium 约 33.5M px），虚拟滚动已无法到达尾部，因此自动改为「一段一屏 +
 * 上一段/下一段」：渲染规模与请求规模同样与总行数无关。
 */
const props = withDefaults(
  defineProps<{
    project: string
    path: string
    /** Bounded text blob; when set, no backend page requests are made. */
    text?: string | null
    /** Bumped when the file changed on disk; reloads the visible rows in place. */
    revision?: number
  }>(),
  { text: undefined, revision: 0 },
)
const { t } = useI18n()

/** Open pages allowed at the same time (IPC + parse round trips). */
const MAX_INFLIGHT_PAGES = 2

interface Chunk {
  /** Data-row index of `rows[0]`. */
  offset: number
  rows: string[][]
}

const header = ref<string[] | null>(null)
const columnCount = ref(0)
const totalRows = ref<number | null>(null)
const exhausted = ref(false)
const delimiter = ref(",")
const fileBytes = ref(0)
const truncatedColumns = ref(false)
const truncatedCells = ref(false)
const budgetTruncated = ref(false)
const loading = ref(false)
const errorCause = ref<unknown>(null)
const error = computed(() => (errorCause.value == null ? "" : formatCodedError(t, errorCause.value)))

/** Loaded row ranges, ordered by offset (never adjacent-duplicated). */
const chunks = ref<Chunk[]>([])
/** Client mode: the whole bounded blob, already parsed. */
const clientRows = ref<string[][] | null>(null)
/** Bumped whenever rows arrive so computed windows re-render. */
const tick = ref(0)

/** Rows rendered per paged-mode screen and per backend request. */
const rowsPerChunk = CSV_PAGE_ROWS

const rowCount = computed(() => {
  if (clientRows.value) return clientRows.value.length
  if (totalRows.value != null) return Math.max(0, totalRows.value)
  return chunks.value.reduce((end, chunk) => Math.max(end, chunk.offset + chunk.rows.length), 0)
})

function rowAt(index: number): string[] | undefined {
  if (clientRows.value) return clientRows.value[index]
  // Chunks are few (bounded by the cache limit), so a linear scan is cheaper
  // than maintaining an index map that must be rebuilt on every prune.
  for (const chunk of chunks.value) {
    if (index >= chunk.offset && index < chunk.offset + chunk.rows.length) return chunk.rows[index - chunk.offset]
  }
  return undefined
}

function applyChunk(page: CsvPage) {
  if (page.header) header.value = page.header
  columnCount.value = Math.max(columnCount.value, page.columnCount, page.header?.length ?? 0)
  if (page.offset === 0) totalRows.value = page.totalRows
  if (page.offset === 0) delimiter.value = page.delimiter
  fileBytes.value = Math.max(fileBytes.value, page.fileBytes)
  truncatedColumns.value ||= page.truncatedColumns
  truncatedCells.value ||= page.truncatedCells
  budgetTruncated.value ||= page.budgetTruncated
  if (!page.rows.length) {
    // 越过分页边界：后端没有更多数据。
    exhausted.value = true
    if (totalRows.value == null) totalRows.value = page.offset
    return
  }
  chunks.value = [
    ...chunks.value.filter(chunk => chunk.offset !== page.offset),
    { offset: page.offset, rows: page.rows },
  ].sort((a, b) => a.offset - b.offset)
  chunks.value = mergeChunks(chunks.value)
  trimChunks(page.offset, page.rows.length)
  tick.value += 1
}

/** Merge chunks that became adjacent (a byte-trimmed page is shorter than 500). */
function mergeChunks(list: Chunk[]): Chunk[] {
  const merged: Chunk[] = []
  for (const chunk of list) {
    const last = merged[merged.length - 1]
    if (last && last.offset + last.rows.length === chunk.offset) {
      merged[merged.length - 1] = { offset: last.offset, rows: [...last.rows, ...chunk.rows] }
    } else merged.push(chunk)
  }
  return merged
}

/**
 * Keep the chunk just loaded plus everything inside the desired window, then
 * drop the oldest others. Dropping a chunk the viewport is showing would leave
 * a hole until the next scroll, so the visible window is always protected.
 */
function trimChunks(keepOffset: number, keepRows: number) {
  const desired = { start: desiredWindow.value.start, end: desiredWindow.value.end }
  const protectedChunks = chunks.value.filter(
    chunk => chunk.offset === keepOffset || (chunk.offset < desired.end && chunk.offset + keepRows > desired.start),
  )
  if (chunks.value.length <= CSV_PAGE_CACHE_LIMIT) return
  const protectedSet = new Set(protectedChunks)
  const result: Chunk[] = []
  for (const chunk of chunks.value) {
    if (result.length < CSV_PAGE_CACHE_LIMIT || protectedSet.has(chunk)) result.push(chunk)
  }
  chunks.value = result
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
      // 宽度变化（例如侧栏被拖拽）只影响列裁切，不需要重新取数。
      viewportHeight.value = element.clientHeight
    })
    observer.observe(element)
  },
  { flush: "post" },
)

const virtual = computed(() => csvUsesVirtualScroll(rowCount.value))
/** First row index of the screen shown in paged mode. */
const pageStart = ref(0)
/** Row that maps to `top: 0` inside the scroll surface. */
const baseRow = computed(() => (virtual.value ? 0 : pageStart.value))
const visibleRowCount = computed(() =>
  virtual.value ? rowCount.value : Math.max(0, Math.min(rowsPerChunk, rowCount.value - baseRow.value)),
)
const bodyHeight = computed(() => csvBodyHeight(visibleRowCount.value))

const rowWindow = computed(() => {
  void tick.value
  if (virtual.value) return csvRowWindow(scrollTop.value, viewportHeight.value, rowCount.value)
  // 分页模式仍按视口渲染：滚动面只覆盖当前段，DOM 规模与总行数无关。
  const local = csvRowWindow(scrollTop.value, viewportHeight.value, visibleRowCount.value)
  return { start: baseRow.value + local.start, end: baseRow.value + local.end }
})

const desiredWindow = computed<{ start: number; end: number }>(() => {
  void tick.value
  if (virtual.value) {
    const { start, end } = rowWindow.value
    return { start: Math.max(0, start - CSV_OVERSCAN), end: end + CSV_OVERSCAN }
  }
  return { start: baseRow.value, end: Math.min(baseRow.value + rowsPerChunk, rowCount.value) }
})

const renderedColumns = computed(() =>
  Math.max(1, csvRenderedColumns(Math.max(columnCount.value, header.value?.length ?? 0))),
)

const visibleRows = computed(() => {
  void tick.value
  const { start, end } = rowWindow.value
  const rendered: { index: number; cells: string[] }[] = []
  for (let index = start; index < end; index++) {
    const row = rowAt(index)
    if (!row) continue
    rendered.push({ index, cells: csvCells(row, renderedColumns.value).slice(0, renderedColumns.value) })
  }
  return rendered
})

// ---- 请求调度：最多 MAX_INFLIGHT_PAGES 个在途请求，窗口移动即重排队 ----
let generation = 0
/** In-flight requests by offset; the range they will cover once they land. */
const inflight = new Map<number, number>()

/** Whether an in-flight request will eventually fill `row`. */
function pendingAt(row: number): boolean {
  for (const [offset, limit] of inflight) {
    if (row >= offset && row < offset + limit) return true
  }
  return false
}

/**
 * Dispatch the first gap the viewport needs that is not already on the way.
 * A gap covered by an in-flight request is not a gap: asking again would just
 * duplicate the same slice (the request already being parsed covers it).
 */
function pump() {
  if (props.text !== undefined || exhausted.value) return
  while (inflight.size < MAX_INFLIGHT_PAGES) {
    const gap = firstPendingGap(desiredWindow.value.start, desiredWindow.value.end)
    if (gap == null) return
    void requestChunk(gap)
  }
}

function firstPendingGap(start: number, end: number): number | null {
  const limit = totalRows.value != null ? Math.min(end, totalRows.value) : end
  for (let row = Math.max(0, start); row < limit; row++) {
    if (rowAt(row) === undefined && !pendingAt(row)) return row
  }
  return null
}

async function requestChunk(offset: number) {
  const startedIn = generation
  inflight.set(offset, rowsPerChunk)
  loading.value = true
  try {
    const page = await readCsvPage(props.project, props.path, offset, rowsPerChunk)
    if (startedIn !== generation) return
    applyChunk(page)
    errorCause.value = null
  } catch (cause) {
    if (startedIn !== generation) return
    errorCause.value = cause
  } finally {
    if (startedIn === generation) {
      inflight.delete(offset)
      loading.value = inflight.size > 0
      pump()
    }
  }
}

// ---- 加载：文件切换重建；磁盘刷新保留当前页/滚动位置 ----
function resetState() {
  generation += 1
  inflight.clear()
  chunks.value = []
  clientRows.value = null
  header.value = null
  columnCount.value = 0
  totalRows.value = null
  exhausted.value = false
  truncatedColumns.value = false
  truncatedCells.value = false
  budgetTruncated.value = false
  errorCause.value = null
  loading.value = false
}

async function load(preservePosition: boolean) {
  // 磁盘刷新必须保留页码/滚动位置**和**元数据：`totalRows` 只在 offset 0 的
  // 那一页返回，刷新若丢掉它，虚拟滚动会退化成只有已加载的几行。
  const previous = {
    header: header.value,
    columnCount: columnCount.value,
    totalRows: totalRows.value,
    delimiter: delimiter.value,
    fileBytes: fileBytes.value,
    truncatedColumns: truncatedColumns.value,
    truncatedCells: truncatedCells.value,
    pageStart: pageStart.value,
    scrollTop: scrollTop.value,
  }
  resetState()
  if (preservePosition) {
    header.value = previous.header
    columnCount.value = previous.columnCount
    totalRows.value = previous.totalRows
    delimiter.value = previous.delimiter
    fileBytes.value = previous.fileBytes
    truncatedColumns.value = previous.truncatedColumns
    truncatedCells.value = previous.truncatedCells
    pageStart.value = previous.pageStart
    scrollTop.value = previous.scrollTop
  } else {
    pageStart.value = 0
    scrollTop.value = 0
  }
  if (scroller.value) scroller.value.scrollTop = scrollTop.value
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
    tick.value += 1
    return
  }
  // 刷新时先取回当前页（页码/滚动位置不变），而不是回到第 1 页。
  const start = preservePosition ? desiredWindow.value.start : 0
  await requestChunk(start >= 0 ? start : 0)
  pump()
}

watch(
  () => [props.project, props.path, props.text] as const,
  () => void load(false),
  { immediate: true },
)
watch(
  () => props.revision,
  () => void load(true),
)

function onScroll() {
  const element = scroller.value
  if (!element) return
  scrollTop.value = element.scrollTop
  // 窗口移动只改变「下一个缺口在哪」，在途请求仍算数。
  pump()
}

// 系统滚动/ResizeObserver 变化后也要补一次，避免空窗口。
watch(desiredWindow, () => pump())

function goToChunkOffset(offset: number) {
  pageStart.value = Math.max(0, offset)
  scrollTop.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
  if (props.text !== undefined) {
    tick.value += 1
    return
  }
  pump()
}

/** Rows in the current paged-mode screen (a byte-trimmed page may be shorter). */
const currentScreenRows = computed(() => {
  const first = chunks.value.find(chunk => chunk.offset === baseRow.value)
  return first ? first.rows.length : rowsPerChunk
})

const canPageBack = computed(() => baseRow.value > 0)
const canPageForward = computed(() => baseRow.value + currentScreenRows.value < rowCount.value)

onBeforeUnmount(() => {
  generation += 1
  observer?.disconnect()
  observer = null
})

// ---- 展示 ----
const totalLabel = computed(() =>
  totalRows.value != null ? t("projectFiles.csvRows", { count: totalRows.value }) : t("projectFiles.csvRowsPending"),
)
const columns = computed(() =>
  Array.from({ length: renderedColumns.value }, (_, index) => ({
    index,
    label: csvColumnLabel(header.value, index),
  })),
)
const cellWidth = computed(() => `${csvCellWidth(renderedColumns.value)}px`)
const fileSize = computed(() => formatBytes(fileBytes.value))
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[exponent]}`
}
const delimiterText = computed(() => (delimiter.value === "\\t" ? "TAB" : delimiter.value))
/** Table intrinsic width: rendered columns × cell width + the row-number gutter. */
const tableWidth = computed(() => renderedColumns.value * csvCellWidth(renderedColumns.value) + 56)
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-csv-preview>
    <p
      v-if="error"
      role="alert"
      class="flex shrink-0 items-start gap-1.5 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <AlertCircle class="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span class="break-words">{{ error }}</span>
    </p>
    <!--
      滚动容器必须保持父容器宽度（min-w-0 + overflow-auto），横滚由**内容**的
      固有宽度撑出来。把 minWidth 加在容器上会让它比 420px 的侧栏还宽，父级再
      用 overflow-hidden 裁掉，横滚条就永远停在 scrollLeft = 0（验收 P1）。
    -->
    <div
      ref="scroller"
      data-csv-scroll
      class="scrollbar-custom min-h-0 w-full min-w-0 flex-1 overflow-auto"
      @scroll="onScroll"
    >
      <div class="min-w-full font-mono text-xs" :style="{ width: `${tableWidth}px` }">
        <!-- 表头独立于虚拟滚动内容：始终吸顶，不随行数增长进入 DOM -->
        <div class="sticky top-0 z-20 flex border-b bg-muted/60">
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
        <div class="relative" :style="{ height: `${bodyHeight}px` }" data-csv-body>
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
      <span>{{ t("projectFiles.csvColumns", { count: renderedColumns }) }}</span>
      <span v-if="truncatedColumns">{{ t("projectFiles.csvColumnOverflow", { limit: CSV_MAX_COLUMNS }) }}</span>
      <span v-if="truncatedCells">{{ t("projectFiles.csvCellTruncated", { limit: CSV_MAX_CELL_CHARS }) }}</span>
      <span v-if="budgetTruncated">{{ t("projectFiles.csvPageTrimmed") }}</span>
      <span>{{ t("projectFiles.csvDelimiter", { delimiter: delimiterText }) }}</span>
      <span>{{ fileSize }}</span>
      <!-- 超过虚拟滚动上限（浏览器元素高度 ~33.5M px）后改为翻页：渲染与请求规模
           都与行数无关，只是把「滚动到底」换成「翻到下一屏」。 -->
      <span v-if="!virtual" class="ml-auto flex items-center gap-2" data-csv-pager>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-1.5 text-[11px]"
          :disabled="!canPageBack || loading"
          data-csv-page-prev
          @click="goToChunkOffset(Math.max(0, baseRow - rowsPerChunk))"
          >{{ t("projectFiles.csvPrevPage") }}</Button
        >
        <span data-csv-page-label>{{
          t("projectFiles.csvPage", { page: Math.floor(baseRow / rowsPerChunk) + 1 })
        }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-1.5 text-[11px]"
          :disabled="!canPageForward || loading"
          data-csv-page-next
          @click="goToChunkOffset(baseRow + currentScreenRows)"
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
