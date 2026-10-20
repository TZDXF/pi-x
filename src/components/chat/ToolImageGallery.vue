<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { Dialog } from "@/components/ui/dialog"
import ImagePreviewContent from "./ImagePreviewContent.vue"

defineProps<{ images: string[]; alt: string }>()
const { t } = useI18n()
const preview = ref<string | null>(null)
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <button
      v-for="(src, index) in images"
      :key="index"
      type="button"
      class="overflow-hidden rounded-md border bg-muted/30 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :title="t('chat.previewImage')"
      :aria-label="t('chat.previewImage')"
      @click="preview = src"
    >
      <img :src="src" :alt="alt" class="h-32 w-40 object-contain" loading="lazy" />
    </button>
    <Dialog :open="!!preview" :modal="false" @update:open="preview = null">
      <ImagePreviewContent v-if="preview" :src="preview" :alt="alt" />
    </Dialog>
  </div>
</template>
