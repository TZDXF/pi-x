<script setup lang="ts">
/**
 * 文件预览里 Markdown 的 `img` 渲染（TZD-132）。
 *
 * 默认渲染链会按 `defaultOrigin` 做 URL 硬校验：`assets/a.png` 这类相对地址
 * 校验失败，图片直接变成「链接被拦截」的错误占位；就算放行，webview 也只会
 * 按应用自身的源去请求，读不到项目目录。这里改为按当前 md 文件的目录解析成
 * 项目内路径，再经预览后端读成 data URL（CSP 只放行 `'self' data: blob:`，
 * 远端 SSH 项目也走同一条命令）。
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ImageOff } from "@lucide/vue"
import { markdownImageContextKey, resolveMarkdownImageSource } from "@/lib/markdownImages"

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  src?: string | null
  alt?: string | null
  title?: string | null
  /** Comark 节点与渲染器状态，声明出来避免落到 DOM 属性上。 */
  node?: unknown
  nodeKey?: string
  loading?: boolean
}>()

const { t } = useI18n()
const context = inject(markdownImageContextKey, null)
const url = ref("")
const failed = ref(false)
// 地址变化时作废旧的在途读取，避免上一张图串到下一个节点上。
let seq = 0

const source = computed(() => resolveMarkdownImageSource(props.src ?? "", context?.docPath ?? ""))

watch(
  source,
  async target => {
    const current = ++seq
    url.value = ""
    failed.value = false
    if (target.kind === "external") {
      url.value = target.url
      return
    }
    if (target.kind === "blocked" || !context?.load) {
      failed.value = true
      return
    }
    const loaded = await context.load(target.path).catch(() => null)
    if (current !== seq) return
    if (loaded) url.value = loaded
    else failed.value = true
  },
  { immediate: true },
)

onBeforeUnmount(() => ++seq)
</script>

<template>
  <span
    v-if="failed"
    data-markdown-image-missing
    class="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground"
    :title="src ?? undefined"
  >
    <ImageOff class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="min-w-0 break-words">{{ alt || t("projectFiles.imageBroken") }}</span>
  </span>
  <img
    v-else-if="url"
    data-markdown-image
    :src="url"
    :alt="alt ?? ''"
    :title="title || (src ?? undefined)"
    loading="lazy"
    class="my-2 h-auto max-w-full rounded-lg"
  />
  <span v-else class="text-xs text-muted-foreground">{{ alt }}</span>
</template>
