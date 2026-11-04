<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Archive, Copy, FileDown, Link, Pencil } from "@lucide/vue"
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"

defineProps<{ remote?: boolean; archived?: boolean }>()
const emit = defineEmits<{ open: []; rename: []; duplicate: []; copyLink: []; export: []; archive: [] }>()
const { t } = useI18n()
</script>

<template>
  <ContextMenuContent v-if="remote">
    <ContextMenuItem @select="emit('open')">
      <Link :size="14" class="size-auto shrink-0" />{{ t("workspace.open") }}
    </ContextMenuItem>
  </ContextMenuContent>
  <ContextMenuContent v-else>
    <ContextMenuItem @select="emit('rename')">
      <Pencil :size="14" class="size-auto shrink-0" />{{ t("workspace.rename") }}
    </ContextMenuItem>
    <ContextMenuItem @select="emit('duplicate')">
      <Copy :size="14" class="size-auto shrink-0" />{{ t("workspace.duplicate") }}
    </ContextMenuItem>
    <ContextMenuItem @select="emit('copyLink')">
      <Link :size="14" class="size-auto shrink-0" />{{ t("workspace.copyLink") }}
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem @select="emit('export')">
      <FileDown :size="14" class="size-auto shrink-0" />{{ t("chat.export") }}
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem @select="emit('archive')">
      <Archive :size="14" class="size-auto shrink-0" />{{ t(archived ? "workspace.restore" : "workspace.archive") }}
    </ContextMenuItem>
  </ContextMenuContent>
</template>
