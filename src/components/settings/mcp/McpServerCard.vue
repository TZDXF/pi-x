<script setup lang="ts">
/** One server card of the list view: name/transport/state badges, endpoint
 *  summary, usage estimates, inline tool badges (+N overflow) and the error
 *  pre. The parent owns the document — the card only emits edit/delete and
 *  the request to open the full tool list. */
import { useI18n } from "vue-i18n"
import { Pencil, Trash2 } from "@lucide/vue"
import type { McpServerStatus } from "@/api/piClient"
import { compactNumber } from "@/lib/format"
import { mcpEntryTransport, mcpStateLabelKey, type McpEntryTransport } from "@/lib/mcpConfig"
import type { McpServerLoad, McpServerUsage } from "@/lib/mcpUsage"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export interface McpServerListEntry {
  name: string
  def: Record<string, unknown>
  transport: McpEntryTransport
  status?: McpServerStatus
}

const props = defineProps<{
  entry: McpServerListEntry
  /** Estimated "cost if loaded" of this server, from its tool definitions. */
  load?: McpServerLoad
  /** Estimated context usage of this server in the active session. */
  usage?: McpServerUsage
}>()
defineEmits<{ edit: []; delete: []; openTools: [] }>()
const { t } = useI18n()

function stateBadgeClass(state: string): string {
  if (state === "connected") return "text-green-600 dark:text-green-400"
  if (state === "failed" || state === "disconnected" || state === "closed") return "text-destructive"
  if (state === "needs-auth") return "text-amber-600 dark:text-amber-400"
  return ""
}

function stateLabel(server: McpServerStatus): string {
  const label = mcpStateLabelKey(server.enabled ? server.state : "disabled")
  return label.raw ? t(label.key, { state: label.raw }) : t(label.key)
}

/** Exposure modes pi reports for MCP servers (mcp-servers.js). Unknown values
 *  (future pi versions) fall back to a generic label with the raw value. */
const MCP_EXPOSURES = ["direct", "codemode", "codemode-deferred", "deferred", "hidden"] as const

function exposureLabel(exposure: string): string {
  return (MCP_EXPOSURES as readonly string[]).includes(exposure)
    ? t(`mcpConfig.exposures.${exposure}`)
    : t("mcpConfig.exposureUnknown", { state: exposure })
}

function endpointSummary(def: Record<string, unknown>): string {
  const transport = mcpEntryTransport(def)
  if (transport === "http") return String(def.url ?? "")
  if (transport === "stdio") {
    const args = Array.isArray(def.args) ? def.args.map(String).join(" ") : ""
    return [def.command, args].filter(Boolean).join(" ")
  }
  return JSON.stringify(def)
}

function isServerDisabled(def: Record<string, unknown>): boolean {
  return def.enabled === false
}

/** Tools shown inline before the "+N" overflow into the tools dialog. */
const INLINE_TOOL_LIMIT = 6

function inlineTools(server: McpServerStatus): string[] {
  return server.tools.slice(0, INLINE_TOOL_LIMIT)
}

function overflowToolCount(server: McpServerStatus): number {
  return Math.max(0, server.tools.length - INLINE_TOOL_LIMIT)
}
</script>

<template>
  <div class="rounded-lg border p-3">
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm font-medium">{{ entry.name }}</p>
      <Badge v-if="entry.transport !== 'unknown'" variant="secondary">
        {{ t(`mcpConfig.editor.transports.${entry.transport}`) }}
      </Badge>
      <Badge v-if="isServerDisabled(entry.def)" variant="outline" class="text-muted-foreground">
        {{ t("mcpConfig.state.disabled") }}
      </Badge>
      <span v-if="entry.transport === 'unknown'" class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {{ t("mcpConfig.unknownShape") }}
      </span>
      <template v-if="entry.status">
        <Badge variant="outline" :class="stateBadgeClass(entry.status.enabled ? entry.status.state : 'disabled')">
          {{ stateLabel(entry.status) }}
        </Badge>
        <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {{ t("mcpConfig.exposure") }}: {{ exposureLabel(entry.status.exposure) }}
        </span>
      </template>
      <span class="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7 text-muted-foreground hover:text-foreground"
          :aria-label="t('mcpConfig.edit')"
          :title="t('mcpConfig.edit')"
          @click="$emit('edit')"
        >
          <Pencil :size="14" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7 text-muted-foreground hover:text-destructive"
          :aria-label="t('mcpConfig.delete')"
          :title="t('mcpConfig.delete')"
          @click="$emit('delete')"
        >
          <Trash2 :size="14" />
        </Button>
      </span>
    </div>
    <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
      {{ endpointSummary(entry.def) }}
    </p>
    <p v-if="load" class="mt-1 text-xs text-muted-foreground" :title="t('mcpConfig.loadHint')">
      {{ t("mcpConfig.loadLabel") }}: {{ t("mcpConfig.tokens", { count: compactNumber(load.tokens) }) }} ·
      {{ t("mcpConfig.toolsCount", { count: load.toolCount }) }}
    </p>
    <p v-if="usage && usage.calls > 0" class="mt-1 text-xs text-muted-foreground">
      {{ t("mcpConfig.usageLabel") }}: {{ t("mcpConfig.tokens", { count: compactNumber(usage.tokens) }) }} ·
      {{ t("mcpConfig.toolCalls", { count: usage.calls }) }}
    </p>
    <div v-if="entry.status?.tools.length" class="mt-2 flex items-center gap-1 overflow-hidden whitespace-nowrap">
      <Badge
        v-for="tool in inlineTools(entry.status)"
        :key="tool"
        variant="secondary"
        class="shrink-0 font-mono text-xs font-normal"
      >
        {{ tool }}
      </Badge>
      <button
        v-if="overflowToolCount(entry.status)"
        type="button"
        class="shrink-0 rounded px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        :aria-label="t('mcpConfig.toolsTitle', { name: entry.name })"
        @click="$emit('openTools')"
      >
        +{{ overflowToolCount(entry.status) }}
      </button>
    </div>
    <pre
      v-if="entry.status?.error"
      class="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-destructive"
      >{{ entry.status.error }}</pre>
  </div>
</template>
