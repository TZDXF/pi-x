<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ContextBreakdownPart, McpContextRow } from "@/lib/contextBreakdown"
import { cn } from "@/lib/utils"
import { compactNumber, formatPercent } from "@/lib/format"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  parts: ContextBreakdownPart[]
  servers?: McpContextRow[] | null
  class?: HTMLAttributes["class"]
}>()

const { t } = useI18n()

const rows = computed(() =>
  props.parts.map(part => ({
    ...part,
    label: t(`chat.contextParts.${part.key}`),
    percentText: formatPercent(part.percent),
    tokensText: compactNumber(part.tokens),
  })),
)

const mcpOpen = ref(false)
const expandedServer = ref<string | null>(null)
const mcpRows = computed(() => props.servers ?? [])
const mcpCalls = computed(() => mcpRows.value.reduce((sum, server) => sum + server.calls, 0))
const mcpTokens = computed(() => mcpRows.value.reduce((sum, server) => sum + server.tokens, 0))

function toggleServer(server: string) {
  expandedServer.value = expandedServer.value === server ? null : server
}
</script>

<template>
  <div :class="cn('w-full', props.class)">
    <div class="space-y-1">
      <div v-for="row in rows" :key="row.key" class="flex items-center justify-between gap-3 text-xs">
        <span class="text-muted-foreground">{{ row.label }}</span>
        <span class="font-mono">
          {{ row.percentText }}
          <span class="text-muted-foreground">· {{ row.tokensText }}</span>
        </span>
      </div>

      <template v-if="mcpRows.length">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 text-left text-xs"
          @click="mcpOpen = !mcpOpen"
        >
          <span class="text-muted-foreground">
            <span class="mr-1 inline-block transition-transform" :class="{ 'rotate-90': mcpOpen }">▸</span>
            {{ t("chat.contextMcp.title") }}
          </span>
          <span class="font-mono">
            {{ mcpCalls }} {{ t("chat.contextMcp.calls") }}
            <span class="text-muted-foreground">· {{ compactNumber(mcpTokens) }}</span>
          </span>
        </button>

        <div v-if="mcpOpen" class="ml-1 space-y-1 border-l pl-3">
          <template v-for="server in mcpRows" :key="server.server">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 text-left text-xs"
              @click="toggleServer(server.server)"
            >
              <span class="truncate" :title="server.server">
                <span
                  class="mr-1 inline-block text-muted-foreground transition-transform"
                  :class="{ 'rotate-90': expandedServer === server.server }"
                  >▸</span
                >
                {{ server.server }}
              </span>
              <span class="font-mono">
                {{ formatPercent(server.percent) }}
                <span class="text-muted-foreground">· {{ compactNumber(server.tokens) }}</span>
              </span>
            </button>
            <div v-if="expandedServer === server.server" class="space-y-1 pl-4">
              <div
                v-for="tool in server.tools"
                :key="tool.tool"
                class="flex items-center justify-between gap-3 text-xs"
              >
                <span class="truncate text-muted-foreground" :title="tool.tool">{{ tool.tool }}</span>
                <span class="font-mono">
                  {{ tool.calls }} {{ t("chat.contextMcp.calls") }}
                  <span class="text-muted-foreground">· {{ compactNumber(tool.tokens) }}</span>
                </span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
