<script setup lang="ts">
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { MessageResponse } from "@/components/ai-elements/message"
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import { useI18n } from "vue-i18n"
import type { Block, ToolCallBlock, ToolRun } from "@/stores/session"

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
      <Reasoning v-else-if="block.type === 'thinking'" :is-streaming="block.streaming">
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
              <pre class="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono whitespace-pre-wrap">{{ block.argsText }}</pre>
            </div>
            <div v-if="runFor(block)?.outputText">
              <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.output") }}</div>
              <pre class="bg-muted max-h-60 overflow-auto rounded-md p-2 font-mono whitespace-pre-wrap">{{ runFor(block)!.outputText }}</pre>
            </div>
          </div>
        </ToolContent>
      </Tool>
    </template>
  </div>
</template>
