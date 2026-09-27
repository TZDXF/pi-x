<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft, Code, ExternalLink, Eye, FileX, ImageOff, MessageSquarePlus, WrapText } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { invoke } from "@/api/transport"
import { isDesktop } from "@/api/transport"
import { openFileInEditor } from "@/lib/openWith"
import { formatCodedError } from "@/lib/backendError"
import { isMarkdownExt } from "@/lib/fileKind"
import { baseName } from "@/lib/paths"
import { highlightFileLines } from "@/lib/filePreviewCode"
import { MAX_SELECTED_TEXT_LENGTH, selectionLineRange, type CodeCommentRange } from "@/lib/codeComments"
import { useCodeCommentsStore } from "@/stores/codeComments"
import { Markdown } from "vue-stream-markdown"
import "vue-stream-markdown/index.css"

interface FilePreview {
  kind: "text" | "image" | "binary"
  text: string | null
  truncated: boolean
  mime: string | null
  data: string | null
}
const props = defineProps<{ project: string; path: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const preview = ref<FilePreview | null>(null)
const loading = ref(false)
const error = ref("")
const htmlLines = ref<string[] | null>(null)
// 序号作废旧在途请求，避免切换文件时旧内容闪现到新文件。
let seq = 0
const mdRendered = ref(true)
const svgRendered = ref(true)
const wrap = ref(true)
const zoomed = ref(false)
const imageBroken = ref(false)

const isMarkdown = computed(() => isMarkdownExt(props.path))
const isSvg = computed(() => baseName(props.path).toLowerCase().endsWith(".svg"))
const text = computed(() => (preview.value?.kind === "text" ? preview.value.text ?? "" : ""))
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

async function load() {
  const current = ++seq
  loading.value = true
  error.value = ""
  preview.value = null
  htmlLines.value = null
  mdRendered.value = true
  svgRendered.value = true
  zoomed.value = false
  imageBroken.value = false
  try {
    const result = await invoke<FilePreview>("read_file_preview", { project: props.project, path: props.path })
    if (current !== seq) return
    preview.value = result
    if (result.kind === "text" && result.text) {
      const lines = await highlightFileLines(result.text, props.path)
      if (current === seq) htmlLines.value = lines
    }
  } catch (cause) {
    if (current === seq) error.value = formatCodedError(t, cause)
  } finally {
    if (current === seq) loading.value = false
  }
}
watch(() => [props.project, props.path] as const, load, { immediate: true })

const opening = ref(false)
async function openInEditor() {
  if (opening.value) return
  opening.value = true
  try {
    await openFileInEditor(props.path, props.project)
  } catch (cause) {
    error.value = t("openWith.failed", { error: String(cause) })
  } finally {
    opening.value = false
  }
}

// ---- 代码批注：选中行 → 填写批注 → 挂到 composer 随下一条消息发送 ----
const codeComments = useCodeCommentsStore()
const codeRoot = ref<HTMLElement | null>(null)
const commentOpen = ref(false)
const commentText = ref("")
const commentRange = ref<CodeCommentRange | null>(null)
const commentSelected = ref("")
const annotated = ref<CodeCommentRange[]>([])
const annotatedLines = computed(() => {
  const lines = new Set<number>()
  for (const range of annotated.value)
    for (let line = range.start; line <= range.end; line++) lines.add(line)
  return lines
})

function onSelectionChange() {
  const range = selectionLineRange(codeRoot.value, window.getSelection())
  commentRange.value = range
  // 引用文本按行取自文件内容，避免选区字符串混入行号栏等界面文本。
  if (range) commentSelected.value = codeLines.value.slice(range.start - 1, range.end).join("\n").slice(0, MAX_SELECTED_TEXT_LENGTH)
}
function toggleComment() {
  if (commentOpen.value) {
    closeComment()
    return
  }
  commentOpen.value = true
  // mousedown.prevent 保住了用户已有的选区，这里立即换算成行号。
  onSelectionChange()
  document.addEventListener("selectionchange", onSelectionChange)
}
function closeComment() {
  commentOpen.value = false
  commentText.value = ""
  commentRange.value = null
  commentSelected.value = ""
  document.removeEventListener("selectionchange", onSelectionChange)
}
function confirmComment() {
  const range = commentRange.value
  const body = commentText.value.trim()
  if (!range || !body) return
  codeComments.add(props.project, {
    path: props.path,
    startLine: range.start,
    endLine: range.end,
    selectedText: commentSelected.value,
    comment: body,
  })
  annotated.value = [...annotated.value, range]
  closeComment()
}
// 文件或项目切换后，旧的批注面板与高亮不再对应新内容。
watch(() => [props.project, props.path] as const, () => {
  closeComment()
  annotated.value = []
})
onBeforeUnmount(closeComment)
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col border-r" :aria-label="t('projectFiles.preview')">
    <div class="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5">
      <Button variant="ghost" size="icon-xs" :title="t('projectFiles.closePreview')" :aria-label="t('projectFiles.closePreview')" @click="emit('close')"><ArrowLeft /></Button>
      <h3 class="min-w-0 flex-1 truncate px-1 font-mono text-xs" :title="path">{{ path }}</h3>
      <Button v-if="isMarkdown && preview?.kind === 'text'" variant="ghost" size="icon-xs" :aria-pressed="mdRendered" :title="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')" :aria-label="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')" @click="mdRendered = !mdRendered"><Eye v-if="mdRendered" /><Code v-else /></Button>
      <Button v-if="isSvg && preview?.kind === 'text' && !preview.truncated" variant="ghost" size="icon-xs" :aria-pressed="svgRendered" :title="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')" :aria-label="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')" @click="svgRendered = !svgRendered"><Eye v-if="svgRendered" /><Code v-else /></Button>
      <Button v-if="showCode" variant="ghost" size="icon-xs" :aria-pressed="wrap" :title="t('projectFiles.wrap')" :aria-label="t('projectFiles.wrap')" :class="{ 'bg-accent text-accent-foreground': wrap }" @click="wrap = !wrap"><WrapText /></Button>
      <Button v-if="showCode" variant="ghost" size="icon-xs" :aria-pressed="commentOpen" :title="t('projectFiles.annotate')" :aria-label="t('projectFiles.annotate')" :class="{ 'bg-accent text-accent-foreground': commentOpen }" @mousedown.prevent @click="toggleComment"><MessageSquarePlus /></Button>
      <Button v-if="isDesktop" variant="ghost" size="icon-xs" :disabled="opening" :title="t('openWith.open')" :aria-label="t('openWith.open')" @click="openInEditor"><ExternalLink /></Button>
    </div>
    <div v-if="commentOpen" class="shrink-0 space-y-2 border-b bg-muted/40 px-3 py-2">
      <p class="text-xs text-muted-foreground">
        <template v-if="commentRange">{{ t(commentRange.start === commentRange.end ? 'projectFiles.annotateLine' : 'projectFiles.annotateRange', { line: commentRange.start, start: commentRange.start, end: commentRange.end }) }}</template>
        <template v-else>{{ t('projectFiles.annotateNoSelection') }}</template>
        <span class="ml-1.5">{{ t('projectFiles.annotateHint') }}</span>
      </p>
      <Textarea v-model="commentText" :placeholder="t('projectFiles.annotatePlaceholder')" class="min-h-16 resize-y text-xs" @keydown.esc.stop="closeComment" @keydown.ctrl.enter.prevent="confirmComment" @keydown.meta.enter.prevent="confirmComment" />
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="closeComment">{{ t('projectFiles.annotateCancel') }}</Button>
        <Button size="sm" :disabled="!commentRange || !commentText.trim()" @click="confirmComment">{{ t('projectFiles.annotateConfirm') }}</Button>
      </div>
    </div>
    <p v-if="preview?.truncated" class="shrink-0 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">{{ t('projectFiles.truncated') }}</p>
    <p v-if="error" role="alert" class="shrink-0 break-words border-b px-3 py-1.5 text-xs text-destructive">{{ error }}</p>
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <p v-if="loading" class="p-3 text-xs text-muted-foreground">{{ t('completion.loading') }}</p>
      <template v-else-if="preview">
        <div v-if="preview.kind === 'binary'" class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
          <FileX class="size-6" />
          <p class="text-xs">{{ t('projectFiles.binary') }}</p>
        </div>
        <div v-else-if="imageSrc && !imageBroken" class="flex min-h-0 flex-1 flex-col items-center justify-center p-2" :class="zoomed ? 'overflow-auto' : 'overflow-hidden'">
          <img :src="imageSrc" :alt="path" class="font-mono text-xs" :class="zoomed ? 'max-w-none' : 'max-h-full max-w-full object-contain'" @error="imageBroken = true" @click="zoomed = !zoomed">
        </div>
        <div v-else-if="imageBroken" class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
          <ImageOff class="size-6" />
          <p class="text-xs">{{ t('projectFiles.imageBroken') }}</p>
        </div>
        <div v-else-if="showRenderedMarkdown" class="scrollbar-custom min-h-0 flex-1 overflow-auto px-3 py-2 [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!">
          <Markdown :content="text" class="text-sm" />
        </div>
        <!-- 代码视图：原生滚动而非 ScrollArea，横竖双向滚动直接交给 overflow -->
        <div v-else ref="codeRoot" class="scrollbar-custom min-h-0 min-w-0 flex-1 overflow-auto" :class="wrap ? '' : 'px-3'">
          <div class="w-full py-1 font-mono text-xs" :class="wrap ? '' : 'w-max min-w-full'">
            <div v-for="(line, index) in codeLines" :key="index" class="flex min-w-0" :data-line="index + 1" :class="annotatedLines.has(index + 1) ? 'bg-amber-500/15' : ''">
              <span class="sticky left-0 shrink-0 select-none bg-background py-px pr-2 pl-1 text-right text-muted-foreground/50 [flex:0_0_2.75rem]" aria-hidden="true">{{ index + 1 }}</span>
              <code v-if="htmlLines" class="preview-code min-w-0 flex-1 py-px pr-3 [font:inherit] [tab-size:4]" :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'" v-html="htmlLines[index] ?? ''" />
              <code v-else class="min-w-0 flex-1 py-px pr-3 [font:inherit] [tab-size:4]" :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'">{{ line || " " }}</code>
            </div>
          </div>
        </div>
      </template>
    </div>
  </section>
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
