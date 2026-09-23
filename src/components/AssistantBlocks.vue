<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { MessageResponse } from "@/components/ai-elements/message"
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import { useI18n } from "vue-i18n"
import type { Block, ToolCallBlock, ToolRun } from "@/stores/conversations"

const props = withDefaults(defineProps<{
  blocks: Block[]
  runs: Record<string, ToolRun>
  /** Key prefix so a rendered subset (e.g. the final summary tail of a turn)
   *  keeps the same keys it had while the full block list was streaming. */
  keyOffset?: number
}>(), { keyOffset: 0 })

function runFor(block: ToolCallBlock): ToolRun | undefined {
  return props.runs[block.callId]
}

const { t } = useI18n()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2.5">
    <template v-for="(block, i) in props.blocks" :key="props.keyOffset + i">
      <!-- assistant text -->
      <MessageResponse
        v-if="block.type === 'text'"
        :content="block.text"
        class="text-sm"
      />

      <!-- thinking -->
      <Reasoning v-else-if="block.type === 'thinking'" :is-streaming="block.streaming" :default-open="block.streaming">
        <ReasoningTrigger />
        <ReasoningContent :content="block.text" />
      </Reasoning>

      <!-- tool call -->
      <Tool v-else-if="block.type === 'toolCall'" class="mb-0 overflow-hidden bg-background/50">
        <ToolHeader
          class="gap-2 px-3 py-2 [&>div]:min-w-0 [&>div]:flex-wrap [&>div>span]:break-all"
          :type="`tool-${block.name}`"
          :state="runFor(block)?.state ?? 'input-streaming'"
        />
        <ToolContent>
          <div class="space-y-2 p-3 text-xs">
            <div v-if="block.argsText">
              <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.input") }}</div>
              <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-40"><pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{ block.argsText }}</pre></ScrollArea>
            </div>
            <div v-if="runFor(block)?.outputText">
              <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.output") }}</div>
              <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-60"><pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{ runFor(block)!.outputText }}</pre></ScrollArea>
            </div>
          </div>
        </ToolContent>
      </Tool>
    </template>
    <slot />
  </div>
</template>
