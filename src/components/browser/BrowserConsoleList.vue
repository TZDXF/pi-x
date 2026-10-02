<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Trash2, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import type { ConsoleEntry } from "@/composables/browser/useBrowserConsole"
defineProps<{ entries: ConsoleEntry[] }>()
defineEmits<{ clear: []; close: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center gap-2 border-b px-2 py-1.5">
    <span class="font-sans text-xs font-medium">{{ t("browser.console") }}</span>
    <div class="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.clearAnnotations')"
        :disabled="!entries.length"
        @click="$emit('clear')"
      >
        <Trash2 class="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs" :title="t('sidebarTabs.closeTab')" @click="$emit('close')">
        <X class="size-4" />
      </Button>
    </div>
  </div>
  <div v-if="!entries.length" class="flex flex-1 items-center justify-center font-sans text-xs text-muted-foreground">
    {{ t("browser.consoleEmpty") }}
  </div>
  <div v-else class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="flex gap-2"
      :class="entry.level === 'error' ? 'text-destructive' : entry.level === 'warn' ? 'text-amber-500' : ''"
    >
      <span class="shrink-0 opacity-50">{{ entry.level }}</span>
      <span class="whitespace-pre-wrap break-all">{{ entry.text }}</span>
    </div>
  </div>
</template>
