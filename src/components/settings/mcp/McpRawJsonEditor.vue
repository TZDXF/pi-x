<script setup lang="ts">
/** Repair path for a mcp.json that no longer parses: raw JSON with an
 *  explicit save; the list view cannot render it. Editing emits the raw
 *  content — the parent owns the draft, validation state and saving. */
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { McpJsonError } from "@/lib/mcpConfig"

defineProps<{
  content: string
  saving: boolean
  dirty: boolean
  /** Parse error of the current draft (why the list view gave up). */
  parseError: McpJsonError
  /** Live diagnostics of the buffer since the last edit. */
  validationError: McpJsonError | null
}>()
defineEmits<{ update: [value: string | number]; save: [] }>()
const { t } = useI18n()

function validationText(e: McpJsonError): string {
  if (e.kind === "parse") {
    const pos = e.line != null ? t("mcpConfig.errorAt", { line: e.line, column: e.column ?? 1 }) : ""
    return `${t("mcpConfig.errors.parse")} ${pos} ${e.message ?? ""}`.trim()
  }
  return t(`mcpConfig.errors.${e.kind}`)
}
</script>

<template>
  <p role="alert" class="text-sm text-destructive">{{ validationText(parseError) }}</p>
  <Textarea
    :model-value="content"
    class="min-h-64 font-mono text-sm"
    spellcheck="false"
    aria-describedby="mcp-json-validation"
    @update:model-value="$emit('update', $event)"
  />
  <p v-if="validationError" id="mcp-json-validation" role="alert" class="text-sm text-destructive">
    {{ validationText(validationError) }}
  </p>
  <div class="flex items-center gap-3">
    <Button :disabled="saving || !dirty || !!validationError" @click="$emit('save')">{{
      t(saving ? "mcpConfig.saving" : "mcpConfig.save")
    }}</Button>
    <span v-if="dirty" class="text-xs text-muted-foreground">{{ t("mcpConfig.unsaved") }}</span>
  </div>
</template>
