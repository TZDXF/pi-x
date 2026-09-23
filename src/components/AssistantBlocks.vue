<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { MessageResponse } from "@/components/ai-elements/message"
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import { useI18n } from "vue-i18n"
import type { Block, ToolCallBlock, ToolRun } from "@/stores/conversations"

const props = defineProps<{
  blocks: Block[]
  runs: Record<string, ToolRun>
}>()

function runFor(block: ToolCallBlock): ToolRun | undefined {
  return props.runs[block.callId]
}

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-for="(block, i) in props.blocks" :key="i">
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
      <Tool v-else-if="block.type === 'toolCall'">
        <ToolHeader
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
  </div>
</template>
