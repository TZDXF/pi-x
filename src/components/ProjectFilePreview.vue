<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  ArrowLeft,
  Code,
  ExternalLink,
  Eye,
  FileX,
  MessageSquareQuote,
  Plus,
  Table2,
  Trash2,
  WrapText,
} from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { invokeProjectFile } from "@/api/client/projectFiles"
import { isRemoteProject } from "@/lib/ssh"
import { isDesktop } from "@/api/transport"
import { openFileInEditor } from "@/lib/openWith"
import { formatCodedError } from "@/lib/backendError"
import { usePointerDrag } from "@/composables/usePointerDrag"
import { isCsvTableExt, isMarkdownExt } from "@/lib/fileKind"
import { baseName, samePath } from "@/lib/paths"
import type { FilePreview } from "@/lib/projectFiles"
import { highlightFileLines } from "@/lib/filePreviewCode"
import { MAX_SELECTED_TEXT_LENGTH, selectionLineRange, type CodeCommentRange } from "@/lib/codeComments"
import ConversationSelectionMenu from "@/components/chat/ConversationSelectionMenu.vue"
import { CONVERSATION_SELECTION_MAX_TEXT_LENGTH } from "@/lib/conversationSelections"
import type { AuxAskPayload, AuxAskTarget } from "@/lib/auxSelection"
import { askAuxSelection } from "@/lib/auxAsk"
import { activeRuntimeId } from "@/stores/conversations"
import { auxCanOpen, auxInstancesFor } from "@/stores/auxChat"
import { useCodeCommentsStore, type PendingCodeComment } from "@/stores/codeComments"
import { useUiStore } from "@/stores/conversations"
import { Markdown } from "vue-stream-markdown"
import ImageViewer from "@/components/ImageViewer.vue"
import { markdownLinkOptions } from "@/lib/linkOptions"
import { markdownParserOptions } from "@/lib/markdownAutoLink"
import { splitMarkdownFrontmatter } from "@/lib/markdownPreview"
import { markdownImageContextKey, previewImageUrl } from "@/lib/markdownImages"
import MarkdownFrontmatter from "@/components/MarkdownFrontmatter.vue"
import CsvTablePreview from "@/components/CsvTablePreview.vue"
import MarkdownImage from "@/components/MarkdownImage.vue"
import "vue-stream-markdown/index.css"

/**
 * 模板有两个根（`<section>` + 浮动菜单），Vue 3 在 fragment 下**不再自动继承 attrs**：
 * 调用方传的 `data-package-resource-preview`（E2E 定位）与 `class` 会静默丢失。
 * 因此显式关掉隐式透传、把 attrs 只绑到 section 上（菜单是覆盖层，不该接调用方属性）。
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    project: string
    path: string
    /** Open source view at a referenced range, including Markdown and SVG. */
    lineRange?: CodeCommentRange
    /** Custom resource reader; project-only editor and annotation actions are hidden. */
    readFile?: (path: string) => Promise<FilePreview>
    closable?: boolean
    /** Store key for pending code comments; defaults to project. When set and
     *  different, comments carry `root` so the prompt can address the file. */
    commentProject?: string
    /** Bumped by the file tree when the file changed on disk; reloads the content. */
    revision?: number
    /**
     * 所属会话的 runtimeId（TZD-103 划词入口的 aux 归属）。
     * 侧栏按 ChatView 传入；独立打开（资源预览等）时缺省跟随当前激活会话。
     */
    auxParentRuntimeId?: string | null
  }>(),
  { closable: true, revision: 0 },
)
const emit = defineEmits<{ close: []; "insert-code-comment": [comment: PendingCodeComment] }>()
const { t } = useI18n()

const preview = ref<FilePreview | null>(null)
const loading = ref(false)
const errorCause = ref<unknown>(null)
const openError = ref<unknown>(null)
const error = computed(() => {
  if (openError.value != null) return t("openWith.failed", { error: formatCodedError(t, openError.value) })
  return errorCause.value == null ? "" : formatCodedError(t, errorCause.value)
})
const htmlLines = ref<string[] | null>(null)
// 序号作废旧在途请求，避免切换文件时旧内容闪现到新文件。
let seq = 0
const mdRendered = ref(true)
const svgRendered = ref(true)
const csvRendered = ref(true)
const wrap = ref(true)

const isMarkdown = computed(() => isMarkdownExt(props.path))
/** CSV/TSV：默认表格视图，可切回源码（表格分页由 CsvTablePreview 自行读取） */
const isCsv = computed(() => isCsvTableExt(props.path))
const isSvg = computed(() => baseName(props.path).toLowerCase().endsWith(".svg"))
const text = computed(() => (preview.value?.kind === "text" ? (preview.value.text ?? "") : ""))
const markdownContent = computed(() => splitMarkdownFrontmatter(text.value))
const codeLines = computed(() => text.value.split("\n"))
/** svg 以文本读回后可直接按 data URL 渲染（截断的 svg 不完整，只看源码） */
const imageSrc = computed(() => {
  if (preview.value?.kind === "image") {
    return `data:${preview.value.mime ?? "application/octet-stream"};base64,${preview.value.data ?? ""}`
  }
  if (isSvg.value && svgRendered.value && !preview.value?.truncated && text.value) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(text.value)}`
  }
  return ""
})
const showRenderedMarkdown = computed(() => preview.value?.kind === "text" && isMarkdown.value && mdRendered.value)
const showCode = computed(() => preview.value?.kind === "text" && !showRenderedMarkdown.value && !imageSrc.value)
/**
 * 表格视图。项目模式下不预读文件：512 KB 文本上限对大表毫无意义，整份读回
 * 也会把 IPC 打爆；交给子组件按页取。`readFile` 覆盖只给有界文本时（资源/
 * 批注预览），把已读回的文本交给子组件本地解析，避免多一条读取通道。
 */
const showCsvTable = computed(() => isCsv.value && csvRendered.value)
const csvText = computed(() => (props.readFile ? text.value : undefined))

// ---- Markdown 图片（TZD-132）----
// 渲染器默认的 URL 硬校验会拦掉 `assets/a.png` 这类相对地址，webview 也读不到
// 项目目录里的文件；因此接管 `img`：相对地址按本文件目录解析成项目内路径，
// 再走 `read_file_preview` 读成 data URL（远端 SSH 项目同样适用）。
const markdownComponents = { img: MarkdownImage }
/** 同一张图在一次预览会话内只读一次；文件或路径切换时整表作废。 */
const markdownImageCache = new Map<string, Promise<string | null>>()
function loadMarkdownImage(path: string): Promise<string | null> {
  const cached = markdownImageCache.get(path)
  if (cached) return cached
  const pending = (async () => {
    try {
      const result = props.readFile
        ? await props.readFile(path)
        : await invokeProjectFile<FilePreview>("read_file_preview", props.project, path)
      return previewImageUrl(result, path)
    } catch {
      return null
    }
  })()
  markdownImageCache.set(path, pending)
  return pending
}
provide(markdownImageContextKey, {
  get docPath() {
    return props.path
  },
  load: loadMarkdownImage,
})

async function load(resetView = true) {
  const current = ++seq
  markdownImageCache.clear()
  loading.value = true
  errorCause.value = null
  openError.value = null
  if (resetView) {
    preview.value = null
    htmlLines.value = null
    // dev 的行号定位要求 Markdown/SVG 直接进源码视图；磁盘变更刷新则保留用户当前视图。
    mdRendered.value = !props.lineRange
    svgRendered.value = !props.lineRange
    csvRendered.value = !props.lineRange
  }
  // 项目模式的表格视图由 CsvTablePreview 分页读取，这里既不需要也不该把
  // 整份 CSV 读成一个 512 KB 的文本。
  if (showCsvTable.value && !props.readFile) {
    loading.value = false
    return
  }
  try {
    const result = props.readFile
      ? await props.readFile(props.path)
      : await invokeProjectFile<FilePreview>("read_file_preview", props.project, props.path)
    if (current !== seq) return
    preview.value = result
    if (result.kind === "text" && result.text) {
      const lines = await highlightFileLines(result.text, props.path)
      if (current === seq) htmlLines.value = lines
    }
  } catch (cause) {
    if (current === seq) errorCause.value = cause
  } finally {
    if (current === seq) loading.value = false
  }
}
// 文件/项目切换时重置视图（渲染/源码切换）；仅内容因磁盘变更而刷新时保留当前视图。
watch(
  () => [props.project, props.path, props.readFile] as const,
  () => void load(),
  { immediate: true },
)
watch(
  () => props.revision,
  () => void load(false),
)
/**
 * 表格视图不走 `load()` 的预读，因此从表格切回源码时需要在这里补读一次；
 * 切回表格则无需任何读取（子组件自己分页）。
 */
watch(csvRendered, rendered => {
  if (!rendered && !props.readFile && preview.value == null) void load(false)
})

const opening = ref(false)
async function openInEditor() {
  if (opening.value) return
  opening.value = true
  try {
    await openFileInEditor(props.path, props.project)
  } catch (cause) {
    openError.value = cause
  } finally {
    opening.value = false
  }
}

// ---- 代码批注（复刻 ZCode code-viewer）：行内草稿卡挂到选中行末行下方，
// ---- 已提交批注以内联卡片展示并可删除，随 composer 待发送列表同步。 ----
const codeComments = useCodeCommentsStore()
const ui = useUiStore()
const codeRoot = ref<HTMLElement | null>(null)
watch(
  () => props.lineRange && ([loading.value, showCode.value, props.lineRange, htmlLines.value] as const),
  async () => {
    if (!props.lineRange || loading.value || !showCode.value) return
    await nextTick()
    const line = Math.min(Math.max(1, props.lineRange?.start ?? 1), codeLines.value.length)
    codeRoot.value?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" })
  },
  { flush: "post" },
)
// ---- 划词入口（TZD-103）：复用会话正文那份浮层（mode="code"），只加动作 ----
//
// 与代码批注的关系：批注仍走行号栏的 gutter 拖拽/按钮，浮层只提供"在辅助对话中提问"，
// payload 带 path + 行区间；渲染态 Markdown 没有 [data-line]，只带 path（不猜行号）。
const markdownRoot = ref<HTMLElement | null>(null)
const menuRoot = computed<HTMLElement | null>(() => (showCode.value ? codeRoot.value : markdownRoot.value))
const auxTargets = computed(() => {
  const parentRuntimeId = props.auxParentRuntimeId ?? activeRuntimeId.value
  return parentRuntimeId ? auxInstancesFor(parentRuntimeId) : []
})
const auxCanCreate = computed(() => auxCanOpen())
async function onAuxAsk(payload: AuxAskPayload, target?: AuxAskTarget) {
  const parentRuntimeId = props.auxParentRuntimeId ?? activeRuntimeId.value
  if (!parentRuntimeId) return
  // 投递路由（复用激活实例 / 新建）与失败文案都在 `lib/auxAsk.ts`：这里只转事件。
  await askAuxSelection({
    parentRuntimeId,
    payload,
    target,
    t,
    toast: (message, kind) => ui.pushToast(message, kind),
  })
}
const commentOpen = ref(false)
const commentText = ref("")
const commentRange = ref<CodeCommentRange | null>(null)
const commentSelected = ref("")
const canAnnotate = computed(() => showCode.value && !props.readFile)
/** 批注归属的会话项目；跨目录浏览时 commentProject 是会话目录、project 是被浏览目录。 */
const commentProject = computed(() => props.commentProject ?? props.project)
/** 文件来自会话目录之外时记录其所属目录，发送时改写为带目录前缀的路径。 */
const commentRoot = computed(() =>
  props.commentProject && !samePath(props.commentProject, props.project) ? props.project : undefined,
)
/** 当前文件已确认、待发送的批注：预览侧的内联卡片直接从共享 store 派生。 */
const pendingComments = computed(() =>
  props.commentProject !== undefined && codeComments.project === commentProject.value
    ? codeComments.comments.filter(c => c.path === props.path && (c.root ?? props.project) === props.project)
    : [],
)
/** 批注卡片按"范围末行"归组，插到对应代码行下方（同 ZCode 的 line annotation）。 */
const commentsByEndLine = computed(() => {
  const grouped = new Map<number, typeof pendingComments.value>()
  for (const comment of pendingComments.value) {
    const list = grouped.get(comment.endLine) ?? []
    list.push(comment)
    grouped.set(comment.endLine, list)
  }
  return grouped
})
const annotatedLines = computed(() => {
  const lines = new Set<number>()
  if (props.lineRange)
    for (
      let line = Math.max(1, props.lineRange.start);
      line <= Math.min(props.lineRange.end, codeLines.value.length);
      line++
    )
      lines.add(line)
  for (const comment of pendingComments.value)
    for (let line = comment.startLine; line <= comment.endLine; line++) lines.add(line)
  if (commentRange.value)
    for (let line = commentRange.value.start; line <= commentRange.value.end; line++) lines.add(line)
  // 拖拽进行中只高亮，草稿卡等松手后再出现。
  if (dragRange.value) for (let line = dragRange.value.start; line <= dragRange.value.end; line++) lines.add(line)
  return lines
})

function onSelectionChange() {
  const range = selectionLineRange(codeRoot.value, window.getSelection())
  // 选区塌陷（如在草稿框内点击）不撤销已锚定的草稿，Esc/取消/提交才关闭。
  if (!range) return
  commentRange.value = range
  // 引用文本按行取自文件内容，避免选区字符串混入行号栏等界面文本。
  commentSelected.value = codeLines.value
    .slice(range.start - 1, range.end)
    .join("\n")
    .slice(0, MAX_SELECTED_TEXT_LENGTH)
}
function focusDraft() {
  // 草稿卡在 v-for 里，用标记属性定位其 textarea（ref 在 v-for 中会退化成数组）。
  void nextTick(() => codeRoot.value?.querySelector<HTMLTextAreaElement>("[data-annotate-draft]")?.focus())
}
// ---- gutter 拖拽多行批注（同 ZCode 的 gutter utility）：按住拖动只实时高亮范围，
// ---- 松手才在范围末行下方打开草稿卡；单击（原地松开）即单行批注。 ----
const dragRange = ref<CodeCommentRange | null>(null)
const gutterDrag = usePointerDrag<number>({
  capture: false,
  windowListeners: true,
  onMove: (anchor, event) => {
    // 拖动时取指针下的 [data-line] 行，把高亮范围实时扩展为 anchor→当前行。
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-line]") as HTMLElement | null
    if (!row || !codeRoot.value?.contains(row)) return
    const line = Number(row.dataset.line)
    if (!Number.isFinite(line) || line < 1) return
    dragRange.value = { start: Math.min(anchor, line), end: Math.max(anchor, line) }
  },
  onEnd: () => {
    const range = dragRange.value
    dragRange.value = null
    if (!range) return
    commentOpen.value = true
    commentRange.value = range
    commentSelected.value = codeLines.value
      .slice(range.start - 1, range.end)
      .join("\n")
      .slice(0, MAX_SELECTED_TEXT_LENGTH)
    document.addEventListener("selectionchange", onSelectionChange)
    focusDraft()
  },
  onCancel: () => (dragRange.value = null),
})
function beginGutterDrag(line: number, event: PointerEvent) {
  dragRange.value = { start: line, end: line }
  gutterDrag.start(event, line)
}
function closeComment() {
  commentOpen.value = false
  commentText.value = ""
  commentRange.value = null
  commentSelected.value = ""
  gutterDrag.cancel()
  dragRange.value = null
  document.removeEventListener("selectionchange", onSelectionChange)
}
function confirmComment() {
  const range = commentRange.value
  const body = commentText.value.trim()
  if (!range || !body) return
  const ok = codeComments.add(commentProject.value, {
    path: props.path,
    root: commentRoot.value,
    startLine: range.start,
    endLine: range.end,
    selectedText: commentSelected.value,
    comment: body,
  })
  if (!ok) {
    ui.pushToast(t("projectFiles.annotateFull"), "warning")
    return
  }
  closeComment()
}
function insertCommentIntoComposer(comment: PendingCodeComment) {
  // 由实际持有 composer 的 ChatView 写入并消费 chip；无接收方时保留批注。
  emit("insert-code-comment", comment)
}
function removeComment(id: string) {
  codeComments.remove(id)
}
function commentRangeLabel(start: number, end: number) {
  return t(
    start === end ? "projectFiles.annotateLine" : "projectFiles.annotateRange",
    start === end ? { line: start } : { start, end },
  )
}
// 文件或项目切换后，旧的批注草稿不再对应新内容；已确认批注按路径归属 store，切回时自动恢复。
watch(
  () => [props.project, props.path, props.readFile] as const,
  () => closeComment(),
)
onBeforeUnmount(() => {
  ++seq
  closeComment()
})
</script>

<template>
  <section
    v-bind="$attrs"
    class="flex min-h-0 min-w-0 flex-1 flex-col border-r"
    :aria-label="t('projectFiles.preview')"
  >
    <div class="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5">
      <Button
        v-if="closable"
        variant="ghost"
        size="icon-xs"
        :title="t('projectFiles.closePreview')"
        :aria-label="t('projectFiles.closePreview')"
        @click="emit('close')"
        ><ArrowLeft
      /></Button>
      <h3 class="min-w-0 flex-1 truncate px-1 font-mono text-xs" :title="path">{{ path }}</h3>
      <Button
        v-if="isMarkdown && preview?.kind === 'text'"
        variant="ghost"
        size="icon-xs"
        :aria-pressed="mdRendered"
        :title="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')"
        :aria-label="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')"
        @click="mdRendered = !mdRendered"
        ><Eye v-if="mdRendered" /><Code v-else
      /></Button>
      <Button
        v-if="isCsv"
        variant="ghost"
        size="icon-xs"
        data-csv-toggle
        :aria-pressed="csvRendered"
        :title="t(csvRendered ? 'projectFiles.source' : 'projectFiles.table')"
        :aria-label="t(csvRendered ? 'projectFiles.source' : 'projectFiles.table')"
        @click="csvRendered = !csvRendered"
        ><Table2 v-if="csvRendered" /><Code v-else
      /></Button>
      <Button
        v-if="isSvg && preview?.kind === 'text' && !preview.truncated"
        variant="ghost"
        size="icon-xs"
        :aria-pressed="svgRendered"
        :title="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')"
        :aria-label="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')"
        @click="svgRendered = !svgRendered"
        ><Eye v-if="svgRendered" /><Code v-else
      /></Button>
      <Button
        v-if="showCode"
        variant="ghost"
        size="icon-xs"
        :aria-pressed="wrap"
        :title="t('projectFiles.wrap')"
        :aria-label="t('projectFiles.wrap')"
        :class="{ 'bg-accent text-accent-foreground': wrap }"
        @click="wrap = !wrap"
        ><WrapText
      /></Button>
      <Button
        v-if="isDesktop && !readFile && !isRemoteProject(project)"
        variant="ghost"
        size="icon-xs"
        :disabled="opening"
        :title="t('openWith.open')"
        :aria-label="t('openWith.open')"
        @click="openInEditor"
        ><ExternalLink
      /></Button>
      <slot name="toolbar" :text="text" :loading="loading" />
    </div>
    <p
      v-if="preview?.truncated"
      class="shrink-0 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      {{ t("projectFiles.truncated") }}
    </p>
    <p v-if="error" role="alert" class="shrink-0 break-words border-b px-3 py-1.5 text-xs text-destructive">
      {{ error }}
    </p>
    <!-- isolate：内容区的 z-index（如行号栏 z-10）限制在本子树内，避免压过右侧栏的拖拽手柄（z-2） -->
    <div class="isolate flex min-h-0 flex-1 flex-col overflow-hidden">
      <!-- 表格视图：项目模式下不预读文件（512 KB 上限对大表没有意义，整份读回也会
           压垮 IPC），由子组件按页流式读取；有 readFile 覆盖时走预览内的文本解析。 -->
      <CsvTablePreview
        v-if="showCsvTable && !readFile"
        :project="project"
        :path="path"
        :revision="revision"
        class="min-h-0 flex-1"
      />
      <p v-else-if="loading" class="p-3 text-xs text-muted-foreground">{{ t("completion.loading") }}</p>
      <template v-else-if="preview">
        <div
          v-if="preview.kind === 'binary'"
          class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground"
        >
          <FileX class="size-6" />
          <p class="text-xs">{{ t("projectFiles.binary") }}</p>
        </div>
        <!-- CSV/TSV 表格：虚拟滚动 + 分页读取，与图片一样自管滚动与错误态 -->
        <CsvTablePreview
          v-else-if="showCsvTable"
          :project="project"
          :path="path"
          :text="csvText"
          :revision="revision"
          class="min-h-0 flex-1"
        />
        <!-- 图片/查看器内部自管缩放平移与加载失败态 -->
        <ImageViewer v-else-if="imageSrc" :src="imageSrc" :alt="path" :svg="isSvg" class="min-h-0 flex-1" />
        <div
          v-else-if="showRenderedMarkdown"
          ref="markdownRoot"
          data-file-preview-scroll
          class="scrollbar-custom min-h-0 flex-1 overflow-auto px-3 py-2 [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!"
        >
          <MarkdownFrontmatter v-if="markdownContent.frontmatter !== null" :content="markdownContent.frontmatter" />
          <Markdown
            :content="markdownContent.body"
            mode="static"
            :enable-animate="false"
            :components="markdownComponents"
            :link-options="markdownLinkOptions"
            :parser-options="markdownParserOptions"
            class="text-sm"
          />
          <slot name="after-content" />
        </div>
        <!-- 代码视图：原生滚动而非 ScrollArea，横竖双向滚动直接交给 overflow -->
        <div
          v-else
          ref="codeRoot"
          data-file-preview-scroll
          class="scrollbar-custom min-h-0 min-w-0 flex-1 overflow-auto"
          :class="wrap ? '' : 'px-3'"
        >
          <div class="w-full py-1 font-mono text-xs" :class="wrap ? '' : 'w-max min-w-full'">
            <template v-for="(line, index) in codeLines" :key="index">
              <div
                class="group flex min-w-0"
                :data-line="index + 1"
                :class="annotatedLines.has(index + 1) ? 'bg-amber-500/15' : ''"
              >
                <span
                  class="sticky left-0 z-10 flex shrink-0 select-none items-start justify-end bg-background py-px pr-2 pl-1 text-right text-muted-foreground/50 [flex:0_0_2.75rem]"
                >
                  <!-- hover 行时行号淡出、原位显示批注按钮（同 ZCode 的 gutter utility） -->
                  <span
                    class="transition-opacity"
                    :class="canAnnotate ? 'group-hover:opacity-0' : ''"
                    aria-hidden="true"
                    >{{ index + 1 }}</span
                  >
                  <button
                    v-if="canAnnotate"
                    type="button"
                    class="absolute top-1/2 right-1.5 flex h-4.5 w-4.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    :title="t('projectFiles.annotateAdd')"
                    :aria-label="t('projectFiles.annotateAdd')"
                    @pointerdown.prevent="beginGutterDrag(index + 1, $event)"
                  >
                    <Plus class="size-3" />
                  </button>
                </span>
                <code
                  v-if="htmlLines"
                  class="preview-code min-w-0 flex-1 py-px pr-3 [font:inherit] [tab-size:4]"
                  :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
                  v-html="htmlLines[index] ?? ''"
                />
                <code
                  v-else
                  class="min-w-0 flex-1 py-px pr-3 [font:inherit] [tab-size:4]"
                  :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
                  >{{ line || " " }}</code
                >
              </div>
              <!-- 已确认批注卡片，挂在范围末行下方（同 ZCode 的 line annotation） -->
              <div
                v-for="comment in commentsByEndLine.get(index + 1) ?? []"
                :key="comment.id"
                :data-code-comment-id="comment.id"
                class="my-1 ml-[2.75rem] rounded-lg border bg-background p-2.5 shadow-sm"
              >
                <p class="mb-1 text-xs text-muted-foreground">
                  {{ commentRangeLabel(comment.startLine, comment.endLine) }}
                </p>
                <p class="text-xs leading-relaxed break-words whitespace-pre-wrap">{{ comment.comment }}</p>
                <div class="mt-1.5 flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-1.5 text-xs text-muted-foreground"
                    :title="t('projectFiles.annotateInsert')"
                    :aria-label="t('projectFiles.annotateInsert')"
                    @click="insertCommentIntoComposer(comment)"
                    ><MessageSquareQuote class="size-3.5" />{{ t("projectFiles.annotateInsert") }}</Button
                  >
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-1.5 text-xs text-muted-foreground"
                    :title="t('projectFiles.annotateRemove')"
                    :aria-label="t('projectFiles.annotateRemove')"
                    @click="removeComment(comment.id)"
                    ><Trash2 class="size-3.5" />{{ t("projectFiles.annotateRemove") }}</Button
                  >
                </div>
              </div>
              <!-- 草稿卡片：锚定在选中范围的末行下方，Esc 取消、Ctrl/Cmd+Enter 提交 -->
              <div
                v-if="commentOpen && commentRange?.end === index + 1"
                class="my-1 ml-[2.75rem] rounded-lg border bg-background p-2.5 shadow-sm"
              >
                <p class="mb-1.5 text-xs text-muted-foreground">
                  {{ commentRangeLabel(commentRange.start, commentRange.end) }}
                </p>
                <Textarea
                  v-model="commentText"
                  data-annotate-draft
                  :placeholder="t('projectFiles.annotatePlaceholder')"
                  class="min-h-16 w-full resize-y text-xs"
                  @keydown.esc.stop="closeComment"
                  @keydown.ctrl.enter.prevent="confirmComment"
                  @keydown.meta.enter.prevent="confirmComment"
                />
                <div class="mt-1.5 flex justify-end gap-2">
                  <Button variant="outline" size="sm" class="h-6 text-xs" @click="closeComment">{{
                    t("projectFiles.annotateCancel")
                  }}</Button>
                  <Button size="sm" class="h-6 text-xs" :disabled="!commentText.trim()" @click="confirmComment">{{
                    t("projectFiles.annotateConfirm")
                  }}</Button>
                </div>
              </div>
            </template>
          </div>
          <slot name="after-content" />
        </div>
      </template>
    </div>
  </section>
  <!-- code 模式的同一浮层：只提供"在辅助对话中提问"，定位/翻转/钳制算法与会话正文一致 -->
  <ConversationSelectionMenu
    mode="code"
    :root="menuRoot"
    :path="path"
    :max-text-length="CONVERSATION_SELECTION_MAX_TEXT_LENGTH"
    :aux-targets="auxTargets"
    :aux-can-create="auxCanCreate"
    @aux-ask="onAuxAsk"
  />
</template>

<style scoped>
.preview-code :deep(span[style]) {
  color: light-dark(var(--shiki-light), var(--shiki-dark));
}

/* 与 ScrollArea 组件保持一致的滚动条外观（w-2.5 / rounded-full / bg-border） */
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
.scrollbar-custom::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--border) / 0.8);
  background-clip: padding-box;
  border: 2px solid transparent;
}
.scrollbar-custom::-webkit-scrollbar-corner {
  background: transparent;
}
</style>
