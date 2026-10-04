<script setup lang="ts">
/** Full tool list of one server; per-tool usage comes from the active session
 *  (row text is resolved by the parent, which owns the status/usage state). */
import { useI18n } from "vue-i18n"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

defineProps<{
  /** Server whose tools are listed; null closes the dialog. */
  name: string | null
  tools: string[]
  rowText: (tool: string) => string
}>()
defineEmits<{ close: [] }>()
const { t } = useI18n()
</script>

<template>
  <Dialog :open="!!name" @update:open="value => !value && $emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("mcpConfig.toolsTitle", { name: name ?? "" }) }}</DialogTitle>
        <DialogDescription>{{ t("mcpConfig.toolsDialogDesc") }}</DialogDescription>
      </DialogHeader>
      <ul class="max-h-80 space-y-0.5 overflow-auto">
        <li
          v-for="tool in tools"
          :key="tool"
          class="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-muted/50"
        >
          <span class="break-all font-mono text-xs">{{ tool }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ rowText(tool) }}</span>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
