<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AlertCircle, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { formatCodedError } from "@/lib/backendError"
import { readCsvPage } from "@/api/client/projectFiles"
import {
  CSV_MAX_CELL_CHARS,
  CSV_MAX_COLUMNS,
  CSV_OVERSCAN,
  CSV_PAGE_CACHE_ROWS,
  CSV_PAGE_ROWS,
  CSV_ROW_HEIGHT,
  csvBodyHeight,
  csvCellText,
  csvCellWidth,
  csvCells,
  csvColumnLabel,
  csvRenderedColumns,
  csvRowWindow,
  previousScreenStartFor,
  rememberScreenEntry,
  type ScreenStartEntry,
  csvUsesVirtualScroll,
  parseCsvRows,
  type CsvPage,
} from "@/lib/csvTable"

/**
 * CSV/TSV 表格预览。
 *
 * 大文件性能的四条约束：
 * 1. 传输有界：后端 `read_csv_page` 流式解析、每次只回一段（≤500 行，且序列化
 *    字节有硬上限），前端永不持有整份文件；
 * 2. 渲染有界：固定行高 + 绝对定位的虚拟窗口，DOM 里只有视口内的行；可见列数
 *    被 [CSV_MAX_COLUMNS] 截断（后端报的 `columnCount` 可能更大，只用于提示）；
 * 3. 在途有界：**同时最多 2 个**请求。计数只随请求真正结束而减少，刷新不会把它
 *    清零，因此「旧请求还在跑 + 刷新又发两个」不会变成 3；已发出的 offset 也不会
 *    被重复请求；
 * 4. 回滚有界：段缓存按**行数**限制（[CSV_PAGE_CACHE_ROWS]），不把相邻段缝成
 *    一个不断变大的段——那样「段数」上限根本拦不住内存，翻屏步长也会算错。
 *
 * 行数超过 [`CSV_MAX_VIRTUAL_ROWS`] 时单一滚动面的高度会越过浏览器元素上限
 * （Chromium 约 33.5M px），虚拟滚动已无法到达尾部，因此自动改为「一屏 +
 * 上一屏/下一屏」，步长按**实际取回的行数**计算（被字节预算裁短也正确）。
 */
const props = withDefaults(
  defineProps<{
    project: string
    path: string
    /** Bounded text blob; when set, no backend page requests are made. */
    text?: string | null
    /** Bumped when the file changed on disk; reloads in place. */
    revision?: number
    /**
     * How many screen starts the paging history keeps. Only lowered by tests, to
     * exercise the "history evicted past the predecessor" boundary.
     */
    screenHistoryLimit?: number
  }>(),
  { text: undefined, revision: 0, screenHistoryLimit: 2048 },
)
const { t } = useI18n()

/** Requests allowed at the same time (IPC + parse round trips). */
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

/** Loaded row ranges, ordered by offset; one entry per request, never merged. */
const chunks = ref<Chunk[]>([])
/** Client mode: the whole bounded blob, already parsed. */
const clientRows = ref<string[][] | null>(null)
/** Bumped whenever rows arrive so computed windows re-render. */
const tick = ref(0)
const rowsPerChunk = CSV_PAGE_ROWS

const rowCount = computed(() => {
  if (clientRows.value) return clientRows.value.length
  if (totalRows.value != null) return Math.max(0, totalRows.value)
  return chunks.value.reduce((end, chunk) => Math.max(end, chunk.offset + chunk.rows.length), 0)
})

function chunkAt(offset: number): Chunk | undefined {
  return chunks.value.find(chunk => chunk.offset === offset)
}

function rowAt(index: number): string[] | undefined {
  if (clientRows.value) return clientRows.value[index]
  for (const chunk of chunks.value) {
    if (index >= chunk.offset && index < chunk.offset + chunk.rows.length) return chunk.rows[index - chunk.offset]
  }
  return undefined
}

function resetMetadata() {
  header.value = null
  columnCount.value = 0
  totalRows.value = null
  exhausted.value = false
  truncatedColumns.value = false
  truncatedCells.value = false
  budgetTruncated.value = false
}

function applyChunk(page: CsvPage) {
  if (page.offset === 0) {
    // 首页是元数据的唯一来源：总行数/列数/截断标记可能因为文件被改小、改窄而变小，
    // 必须**覆盖**而不是取大（旧实现取 max，于是 8 列缩到 1 列后仍渲染 8 个表头）。
    header.value = page.header
    columnCount.value = Math.max(page.columnCount, page.header?.length ?? 0)
    totalRows.value = page.totalRows
    delimiter.value = page.delimiter
    truncatedColumns.value = page.truncatedColumns
    truncatedCells.value = page.truncatedCells
  } else {
    if (page.header) header.value = page.header
    columnCount.value = Math.max(columnCount.value, page.columnCount, page.header?.length ?? 0)
    truncatedColumns.value ||= page.truncatedColumns
    truncatedCells.value ||= page.truncatedCells
  }
  fileBytes.value = page.fileBytes
  budgetTruncated.value ||= page.budgetTruncated
  if (!page.rows.length) {
    // 空段：该 offset 之后没有数据了。
    exhausted.value = true
    if (page.offset === 0 && totalRows.value == null) totalRows.value = 0
    clampPage()
    tick.value += 1
    return
  }
  chunks.value = [
    ...chunks.value.filter(chunk => chunk.offset !== page.offset),
    { offset: page.offset, rows: page.rows },
  ].sort((a, b) => a.offset - b.offset)
  trimChunks()
  clampPage()
  tick.value += 1
}

/**
 * Keep the chunks the viewport needs, then drop the farthest others until the
 * cached **row count** is back under [`CSV_PAGE_CACHE_ROWS`]. Counting chunks
 * alone was not a bound: adjacent 500-row slices used to be merged into one
 * ever growing chunk, so nine screens stayed resident with no eviction.
 */
function trimChunks() {
  const total = chunks.value.reduce((rows, chunk) => rows + chunk.rows.length, 0)
  if (total <= CSV_PAGE_CACHE_ROWS) return
  const desired = desiredWindow.value
  const isVisible = (chunk: Chunk) => chunk.offset < desired.end && chunk.offset + chunk.rows.length > desired.start
  // 可视段优先且**永远保留**（删掉正在显示的行会立刻出现空洞）；其余按距窗口
  // 远近填充剩余额度。旧实现先按距离排序再按额度裁剪，结果把可视段自己也裁掉了。
  const visible = chunks.value.filter(isVisible)
  let kept = visible.reduce((rows, chunk) => rows + chunk.rows.length, 0)
  const result = [...visible]
  const others = chunks.value
    .filter(chunk => !isVisible(chunk))
    .sort((a, b) => Math.abs(a.offset - desired.start) - Math.abs(b.offset - desired.start))
  for (const chunk of others) {
    if (kept + chunk.rows.length > CSV_PAGE_CACHE_ROWS) break
    kept += chunk.rows.length
    result.push(chunk)
  }
  chunks.value = result.sort((a, b) => a.offset - b.offset)
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

const virtual = computed(() => csvUsesVirtualScroll(rowCount.value))
/** First row index of the screen shown in paged mode. */
const pageStart = ref(0)
/**
 * Length of the screen currently shown in paged mode. Slices can be shorter than
 * [`CSV_PAGE_ROWS`] (the backend trims them to its byte budget), and paging must
 * use the real length both forward and back.
 */
const lastScreenRows = ref(CSV_PAGE_ROWS)
/**
 * Bumped on every (re)load — file switch and revision refresh alike. Screen
 * starts are tagged with it, so a refresh rebuilds the paging history instead of
 * carrying stale boundaries from the previous generation.
 */
const loadGeneration = ref(0)
/**
 * Screen start offsets visited **for the file currently open** (row indexes only,
 * no cell data). Cleared on every file change so a previous file's pagination can
 * never leak into the next one. 0 is recorded too: the first screen must stay a
 * valid back target even after its rows were evicted from the cache.
 *
 * The list grows with how far the user actually paged (8 bytes per screen), so
 * `SCREEN_HISTORY_LIMIT` only guards pathological paging sessions; past it we
 * stop guessing and disable the back button instead of landing on a wrong offset.
 */
const screenHistory = ref<ScreenStartEntry[]>([])
/** Row that maps to `top: 0` inside the scroll surface. */
const baseRow = computed(() => (virtual.value ? 0 : pageStart.value))
/** Rows in the current screen (a byte-trimmed slice can be shorter than 500). */
const currentChunk = computed(() => chunkAt(baseRow.value))
const currentScreenRows = computed(() => currentChunk.value?.rows.length ?? lastScreenRows.value)
watch(currentChunk, chunk => {
  if (chunk?.rows.length) lastScreenRows.value = chunk.rows.length
})
const visibleRowCount = computed(() =>
  virtual.value ? rowCount.value : Math.max(0, Math.min(currentScreenRows.value, rowCount.value - baseRow.value)),
)
const bodyHeight = computed(() => csvBodyHeight(visibleRowCount.value))

const rowWindow = computed(() => {
  void tick.value
  if (virtual.value) return csvRowWindow(scrollTop.value, viewportHeight.value, rowCount.value)
  const local = csvRowWindow(scrollTop.value, viewportHeight.value, visibleRowCount.value)
  return { start: baseRow.value + local.start, end: baseRow.value + local.end }
})

const desiredWindow = computed<{ start: number; end: number }>(() => {
  void tick.value
  const { start, end } = rowWindow.value
  // 两种模式都只取「视口 + overscan」。分页模式曾把整个 500 行屏都算进缺口，
  // 于是后端每次只回 10 行时要连发 50 个请求才允许翻屏（复验 P2）。
  return { start: Math.max(0, start - CSV_OVERSCAN), end: end + CSV_OVERSCAN }
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

/** 文件变小/刷新后把页码与滚动位置钳回有效范围（否则旧页空白、摘要仍是旧值）。 */
function clampPage() {
  const rows = rowCount.value
  if (!virtual.value && pageStart.value > 0 && pageStart.value >= rows) {
    screenHistory.value = []
    pageStart.value = Math.max(0, Math.min(rows - 1, Math.floor((rows - 1) / rowsPerChunk) * rowsPerChunk))
    scrollTop.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
  }
  if (virtual.value) {
    const maxScroll = Math.max(0, csvBodyHeight(rows) - viewportHeight.value)
    if (scrollTop.value > maxScroll) {
      scrollTop.value = maxScroll
      if (scroller.value) scroller.value.scrollTop = maxScroll
    }
  } else if (scroller.value) {
    const maxScroll = Math.max(0, csvBodyHeight(visibleRowCount.value) - viewportHeight.value)
    if (scrollTop.value > maxScroll) {
      scrollTop.value = maxScroll
      scroller.value.scrollTop = maxScroll
    }
  }
}

// ---- 请求调度：最多 MAX_INFLIGHT_PAGES 个在途请求，失败后不自动重试 ----
/**
 * Requests actually in flight, keyed by the offset they cover. This map is
 * **not** cleared on refresh: those requests are still running and still count
 * against the cap (clearing it let a refresh push the peak to 3).
 */
const pending = new Map<number, number>()
/** Set on unmount: no further scheduling, whatever a late request does. */
let unmounted = false
/** Explicit offsets to fetch next (refresh metadata/current screen, paging). */
const queue: number[] = []
let generation = 0

function pendingAt(row: number): boolean {
  for (const [offset, limit] of pending) {
    if (row >= offset && row < offset + limit) return true
  }
  return false
}

function firstPendingGap(start: number, end: number): number | null {
  const limit = totalRows.value != null ? Math.min(end, totalRows.value) : end
  for (let row = Math.max(0, start); row < limit; row++) {
    if (rowAt(row) === undefined && !pendingAt(row)) return row
  }
  return null
}

function pump() {
  // 卸载后 `finally` 里的无条件 pump() 仍会被旧请求触发；必须在这里拦住，
  // 否则组件已经销毁还会继续发请求（复验 P2）。
  if (unmounted || props.text !== undefined) return
  // 失败的请求不再自动重试：否则「永久错误」（例如超 256 MB）会无限循环。
  if (errorCause.value != null) return
  while (pending.size < MAX_INFLIGHT_PAGES) {
    let next: number | null = null
    while (queue.length) {
      const candidate = queue.shift() as number
      if (!pending.has(candidate) && rowAt(candidate) === undefined && !exhaustedAt(candidate)) {
        next = candidate
        break
      }
    }
    if (next == null) next = firstPendingGap(desiredWindow.value.start, desiredWindow.value.end)
    if (next == null || pending.has(next)) return
    void requestChunk(next)
  }
}

/** 已知末页之后不再请求（省一次空页往返）。 */
function exhaustedAt(offset: number): boolean {
  return totalRows.value != null && offset >= totalRows.value
}

async function requestChunk(offset: number) {
  const startedIn = generation
  pending.set(offset, rowsPerChunk)
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
    // 计数只随请求结束而释放，跨代也一样：刷新时旧请求仍在占用名额。
    pending.delete(offset)
    loading.value = pending.size > 0
    // 关键：失败/丢弃的那一代也必须唤醒**当前**排队的缺口。旧实现把 pump()
    // 关在 `startedIn === generation` 里，刷新后旧请求结束时名额已释放、队列
    // 却再没人推，画面就一直空白（复验 P1）。
    pump()
  }
}

function retry() {
  errorCause.value = null
  queue.push(0)
  if (!virtual.value && pageStart.value > 0) queue.push(pageStart.value)
  pump()
}

// ---- 加载：文件切换重建；磁盘刷新保留位置并重新取元数据 ----
function resetState() {
  generation += 1
  queue.length = 0
  chunks.value = []
  clientRows.value = null
  resetMetadata()
  errorCause.value = null
}

function keepMetadata() {
  return {
    header: header.value,
    columnCount: columnCount.value,
    delimiter: delimiter.value,
    fileBytes: fileBytes.value,
    pageStart: pageStart.value,
    scrollTop: scrollTop.value,
  }
}

async function load(preservePosition: boolean) {
  const previous = keepMetadata()
  resetState()
  chunks.value = []
  // 刷新也会改变短页边界（文件变宽/变窄后每屏行数不同），所以新旧两代的屏起点
  // 不能混用：提升代号并把历史重建为「首页」，随后走到的每一屏再各自登记。
  loadGeneration.value += 1
  screenHistory.value = [{ offset: 0, generation: loadGeneration.value }]
  if (preservePosition) {
    header.value = previous.header
    columnCount.value = previous.columnCount
    delimiter.value = previous.delimiter
    fileBytes.value = previous.fileBytes
    pageStart.value = previous.pageStart
    scrollTop.value = previous.scrollTop
  } else {
    // 文件切换：历史已在上方按**新一代**重建（只含首页），上一个文件的屏起点
    // 不会成为当前文件的前驱（复验：切到 b.csv 后「上一屏」落到 a.csv 的 100）。
    pageStart.value = 0
    scrollTop.value = 0
    delimiter.value = ","
    fileBytes.value = 0
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
    clampPage()
    tick.value += 1
    return
  }
  // 刷新时先要回**首页元数据**（总行数/表头可能变，文件也可能被改小），
  // 再要回当前这一屏；两者都不改变页码本身。当前页在新一代里仍是一个**真实
  // 屏起点**（用户正看着它），因此登记到新代历史。
  if (preservePosition && pageStart.value > 0) {
    rememberScreen(pageStart.value)
  }
  queue.push(0)
  if (preservePosition && desiredWindow.value.start > 0) queue.push(desiredWindow.value.start)
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
  pump()
}

watch(desiredWindow, () => pump())

function goToScreen(offset: number) {
  rememberScreen(pageStart.value)
  pageStart.value = Math.max(0, Math.min(offset, Math.max(0, rowCount.value - 1)))
  scrollTop.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
  if (props.text !== undefined) {
    tick.value += 1
    return
  }
  queue.push(pageStart.value)
  tick.value += 1
  pump()
}

/**
 * Exact start of the screen before `baseRow`, or `null` when no exact target is
 * known. Slice lengths vary (the backend trims to its byte budget), so the
 * current screen's length says nothing about the previous one — guessing with it
 * landed one slice short (1800 → 1700 instead of 1600) once the history and the
 * cached predecessor were both gone. When that happens the back button is
 * disabled instead of navigating to a wrong offset.
 */
function previousScreenOffset(): number | null {
  return previousScreenStartFor(screenHistory.value, loadGeneration.value, baseRow.value)
}

/**
 * Record the screen we are leaving, so back-paging can return to its exact start.
 * `0` is recorded like any other start (skipping it made "back to the first
 * screen" fall through to a length guess once the first chunk was evicted).
 */
function rememberScreen(offset: number) {
  screenHistory.value = rememberScreenEntry(screenHistory.value, offset, loadGeneration.value, props.screenHistoryLimit)
}

const canPageBack = computed(() => previousScreenOffset() != null)

/**
 * Back one screen, or do nothing when no exact predecessor is known. The guard
 * lives in the handler as well as the button state: a synthetic click on a
 * disabled control must not move the table to a guessed offset.
 */
function goToPreviousScreen() {
  const target = previousScreenOffset()
  if (target == null) return
  goToScreen(target)
}
const canPageForward = computed(() => baseRow.value + currentScreenRows.value < rowCount.value)

onBeforeUnmount(() => {
  unmounted = true
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
      <!-- 失败后不再自动重试：只给一次显式重试入口。 -->
      <Button variant="ghost" size="sm" class="h-5 shrink-0 px-1.5 text-[11px]" data-csv-retry @click="retry">
        <RefreshCw class="size-3" />{{ t("projectFiles.csvRetry") }}
      </Button>
    </p>
    <!--
      滚动容器必须保持父容器宽度（min-w-0 + overflow-auto），横滚由**内容**的
      固有宽度撑出来。把 minWidth 加在容器上会让它比 420px 的侧栏还宽，父级再
      用 overflow-hidden 裁掉，横滚条就永远停在 scrollLeft = 0。
    -->
    <div
      ref="scroller"
      data-csv-scroll
      class="scrollbar-custom min-h-0 w-full min-w-0 flex-1 overflow-auto"
      @scroll="onScroll"
    >
      <div class="min-w-full font-mono text-xs" :style="{ width: `${tableWidth}px` }">
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
      <span v-if="!virtual" class="ml-auto flex items-center gap-2" data-csv-pager>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-1.5 text-[11px]"
          :disabled="!canPageBack || loading"
          data-csv-page-prev
          @click="goToPreviousScreen()"
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
          @click="goToScreen(baseRow + currentScreenRows)"
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
