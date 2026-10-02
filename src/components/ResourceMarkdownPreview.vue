<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Languages } from "@lucide/vue"
import { Markdown } from "vue-stream-markdown"
import { packageTranslate } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { useContentTranslation } from "@/composables/useContentTranslation"
import { markdownLinkOptions } from "@/lib/linkOptions"
import type { FilePreview } from "@/lib/projectFiles"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"

const props = withDefaults(
  defineProps<{ path: string; project?: string; readFile: (path: string) => Promise<string> }>(),
  { project: "" },
)
const { t, locale } = useI18n()
const ui = useUiStore()
const { translating, translated, translate } = useContentTranslation({
  source: () => [props.path, props.project, props.readFile],
  locale,
  translate: packageTranslate,
  onError: error => ui.pushToast(String(error), "error"),
})
const previewVersion = ref(0)
watch(
  () => [props.path, props.project, props.readFile],
  () => ++previewVersion.value,
  { flush: "sync" },
)
const readResourceFile = computed(() => {
  // Capture the reader, rather than resolving a different resource after awaiting.
  const read = props.readFile
  return async (path: string): Promise<FilePreview> => ({
    kind: "text",
    text: await read(path),
    truncated: false,
    mime: null,
    data: null,
  })
})
</script>

<template>
  <ProjectFilePreview
    :key="previewVersion"
    :project="project"
    :path="path"
    :read-file="readResourceFile"
    :closable="false"
  >
    <template #toolbar="{ text, loading }">
      <Button variant="ghost" size="sm" :disabled="translating || loading || !text.trim()" @click="translate(text)">
        <Spinner v-if="translating" class="size-3" />
        <Languages v-else :size="14" />
        {{ t("packages.translate") }}
      </Button>
    </template>
    <template #after-content>
      <template v-if="translated">
        <div class="my-3 border-t" />
        <Markdown
          :content="translated"
          mode="static"
          :enable-animate="false"
          :link-options="markdownLinkOptions"
          class="text-sm"
        />
      </template>
    </template>
  </ProjectFilePreview>
</template>
