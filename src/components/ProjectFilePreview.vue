<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft, Code, ExternalLink, Eye, FileX, ImageOff, WrapText } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { invoke } from "@/api/transport"
import { isDesktop } from "@/api/transport"
import { openFileInEditor } from "@/lib/openWith"
import { formatCodedError } from "@/lib/backendError"
import { isMarkdownExt } from "@/lib/fileKind"
import { highlightFileLines } from "@/lib/filePreviewCode"
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
const isSvg = computed(() => props.path.replace(/\\/g, "/").split("/").pop()?.toLowerCase().endsWith(".svg") ?? false)
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
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col border-l" :aria-label="t('projectFiles.preview')">
    <div class="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5">
      <Button variant="ghost" size="icon-xs" :title="t('projectFiles.closePreview')" :aria-label="t('projectFiles.closePreview')" @click="emit('close')"><ArrowLeft /></Button>
      <h3 class="min-w-0 flex-1 truncate px-1 font-mono text-xs" :title="path">{{ path }}</h3>
      <Button v-if="isMarkdown && preview?.kind === 'text'" variant="ghost" size="icon-xs" :aria-pressed="mdRendered" :title="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')" :aria-label="t(mdRendered ? 'projectFiles.source' : 'projectFiles.rendered')" @click="mdRendered = !mdRendered"><Eye v-if="mdRendered" /><Code v-else /></Button>
      <Button v-if="isSvg && preview?.kind === 'text' && !preview.truncated" variant="ghost" size="icon-xs" :aria-pressed="svgRendered" :title="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')" :aria-label="t(svgRendered ? 'projectFiles.source' : 'projectFiles.rendered')" @click="svgRendered = !svgRendered"><Eye v-if="svgRendered" /><Code v-else /></Button>
      <Button v-if="showCode" variant="ghost" size="icon-xs" :aria-pressed="wrap" :title="t('projectFiles.wrap')" :aria-label="t('projectFiles.wrap')" :class="{ 'bg-accent text-accent-foreground': wrap }" @click="wrap = !wrap"><WrapText /></Button>
      <Button v-if="isDesktop" variant="ghost" size="icon-xs" :disabled="opening" :title="t('openWith.open')" :aria-label="t('openWith.open')" @click="openInEditor"><ExternalLink /></Button>
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
        <div v-else-if="showRenderedMarkdown" class="min-h-0 flex-1 overflow-auto px-3 py-2 [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!">
          <Markdown :content="text" class="text-sm" />
        </div>
        <!-- 代码视图：原生滚动而非 ScrollArea，横竖双向滚动直接交给 overflow -->
        <div v-else class="min-h-0 flex-1 overflow-auto" :class="wrap ? '' : 'px-3'">
          <div class="py-1 font-mono text-xs" :class="wrap ? '' : 'w-max min-w-full'">
            <div v-for="(line, index) in codeLines" :key="index" class="flex">
              <span class="sticky left-0 shrink-0 select-none bg-background py-px pr-2 pl-1 text-right text-muted-foreground/50 [flex:0_0_2.75rem]" aria-hidden="true">{{ index + 1 }}</span>
              <code v-if="htmlLines" class="preview-code flex-1 py-px pr-3 [font:inherit] [tab-size:4]" :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'" v-html="htmlLines[index] ?? ''" />
              <code v-else class="flex-1 py-px pr-3 [font:inherit] [tab-size:4]" :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'">{{ line || " " }}</code>
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
</style>
