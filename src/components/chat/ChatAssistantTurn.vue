<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Copy, GitBranch } from "@lucide/vue"
import { MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message"
import AssistantBlocks from "@/components/AssistantBlocks.vue"
import TurnChangesCard from "@/components/TurnChangesCard.vue"
import type { useTurnChanges } from "@/composables/useTurnChanges"
import { blocksText, hasSummary } from "@/composables/useChatTurnList"
import { formatMessageTime } from "@/lib/format"
import type { AssistantTurn } from "@/lib/responseTurns"
import type { SessionStore } from "@/stores/session"

const props = defineProps<{
  entry: AssistantTurn
  session: SessionStore
  changes: ReturnType<typeof useTurnChanges>
  project: string
  animate: boolean
  processOpened: boolean
}>()
const emit = defineEmits<{
  processOpened: []
  openReview: [path: string]
  fork: [index: number]
  copyText: [text: string]
}>()
const { t } = useI18n()
const {
  changesForTurn,
  artifactsForTurn,
  checkpointForTurn,
  onTurnReverted,
  onTurnRevertedAll,
  turnArtifactsReverted,
} = props.changes

function onProcessToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open) emit("processOpened")
}
</script>

<template>
  <MessageContent>
    <div class="min-w-0 space-y-3">
      <!-- The answer keeps one stable render path: while streaming it
           is the flat block list, on completion only the trailing
           summary stays visible (same keys via keyOffset), so the
           markdown below never remounts and re-flashes. -->
      <details
        v-if="entry.complete && entry.process.length && blocksText(entry.summary).trim()"
        class="response-process border-b border-border pb-3"
        @toggle="onProcessToggle"
      >
        <summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          {{
            entry.durationMs == null
              ? t("chat.durationUnknown")
              : t("chat.executionDuration", { seconds: (entry.durationMs / 1000).toFixed(1) })
          }}
          <template v-if="entry.toolCallCount > 0">
            <span class="mx-1.5" aria-hidden="true">&middot;</span>
            {{ t("chat.toolCallCount", { count: entry.toolCallCount }) }}
          </template>
        </summary>
        <AssistantBlocks
          v-if="processOpened"
          class="mt-3 border-l pl-3"
          :blocks="entry.process"
          :runs="session.runs"
          :animate="false"
          @open-review="emit('openReview', $event)"
        />
      </details>
      <AssistantBlocks
        :animate="animate"
        :blocks="hasSummary(entry) ? entry.summary : entry.blocks"
        :key-offset="hasSummary(entry) ? entry.blocks.length - entry.summary.length : 0"
        :runs="session.runs"
        @open-review="emit('openReview', $event)"
      />
      <TurnChangesCard
        v-if="entry.complete && changesForTurn(entry).length"
        :files="changesForTurn(entry)"
        :artifacts="artifactsForTurn(entry)"
        :was-reverted="turnArtifactsReverted(entry)"
        :project="session.cwd || project"
        :checkpoint="checkpointForTurn(entry)"
        @open-review="emit('openReview', $event)"
        @reverted="onTurnReverted"
        @reverted-all="onTurnRevertedAll(entry)"
      />
    </div>
  </MessageContent>
  <MessageActions
    v-if="entry.complete"
    class="invisible mt-1 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 focus-within:visible focus-within:opacity-100"
  >
    <MessageAction :tooltip="t('chat.fork')" @click="emit('fork', entry.lastIndex)">
      <GitBranch />
    </MessageAction>
    <MessageAction
      :tooltip="t('chat.copyReply')"
      @click="emit('copyText', blocksText(entry.summary.length ? entry.summary : entry.blocks))"
    >
      <Copy />
    </MessageAction>
    <span v-if="entry.timestamp" class="ml-1 self-center text-xs text-muted-foreground">
      {{ formatMessageTime(entry.timestamp) }}
    </span>
  </MessageActions>
</template>
