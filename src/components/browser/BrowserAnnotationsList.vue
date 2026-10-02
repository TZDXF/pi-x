<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Copy, Trash2, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import type { PageAnnotation } from "@/lib/previewAnnotations"
defineProps<{ annotations: PageAnnotation[] }>()
defineEmits<{ insert: []; copy: []; clear: []; close: []; delete: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center gap-2 border-b px-2 py-1.5">
    <span class="text-xs font-medium">{{ t("browser.annotations") }}</span>
    <span class="text-xs text-muted-foreground">{{ annotations.length }}</span>
    <div class="ml-auto flex items-center gap-1">
      <Button variant="ghost" size="sm" :disabled="!annotations.length" @click="$emit('insert')">{{
        t("browser.insertToChat")
      }}</Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.copyAnnotations')"
        :disabled="!annotations.length"
        @click="$emit('copy')"
      >
        <Copy class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.clearAnnotations')"
        :disabled="!annotations.length"
        @click="$emit('clear')"
      >
        <Trash2 class="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs" :title="t('sidebarTabs.closeTab')" @click="$emit('close')">
        <X class="size-4" />
      </Button>
    </div>
  </div>
  <div v-if="!annotations.length" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
    {{ t("browser.annotationsEmpty") }}
  </div>
  <div v-else class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
    <div
      v-for="annotation in annotations"
      :key="annotation.id"
      class="group flex items-start gap-2 rounded-md border p-2 text-xs"
    >
      <span
        class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
        >{{ annotation.number }}</span
      >
      <div class="min-w-0 flex-1">
        <div
          class="truncate font-mono text-[10px] text-muted-foreground"
          :title="annotation.kind === 'pin' ? annotation.pin?.selector : undefined"
        >
          {{ annotation.kind === "pin" ? annotation.pin?.selector : t("browser.area") }}
        </div>
        <div v-if="annotation.kind === 'pin' && annotation.pin?.text" class="truncate">
          {{ annotation.pin.text }}
        </div>
        <div class="whitespace-pre-wrap">{{ annotation.comment }}</div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0 opacity-0 group-hover:opacity-100"
        :title="t('browser.deleteAnnotation')"
        @click="$emit('delete', annotation.id)"
      >
        <X class="size-3.5" />
      </Button>
    </div>
  </div>
</template>
