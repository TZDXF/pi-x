<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { Thinking, ThinkingContent, ThinkingTrigger } from "@/components/thinking"
import { MessageResponse } from "@/components/ai-elements/message"
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import ToolStatusBadge from "@/components/ai-elements/tool/ToolStatusBadge.vue"
import { Terminal, TerminalContent, TerminalCopyButton } from "@/components/ai-elements/terminal"
import { ChevronRight, SquareTerminal } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { computed, onUnmounted, ref, watch } from "vue"
import { changeForCall } from "@/lib/sessionChanges"
import { processDetail } from "@/lib/processDetail"
import type { Block, ToolCallBlock, ToolRun } from "@/stores/conversations"
import FileTypeIcon from "@/components/FileTypeIcon.vue"

const props = withDefaults(
  defineProps<{
    blocks: Block[]
    runs: Record<string, ToolRun>
    animate?: boolean
    /** Key prefix so a rendered subset (e.g. the final summary tail of a turn)
     *  keeps the same keys it had while the full block list was streaming. */
    keyOffset?: number
  }>(),
  { keyOffset: 0, animate: true },
)

const emit = defineEmits<{ openReview: [path: string] }>()

function runFor(block: ToolCallBlock): ToolRun | undefined {
  return props.runs[block.callId]
}

// ---- tool specialization ----

const BASH_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
  "terminal",
  "run_command",
  "execute_command",
])
function isBash(block: ToolCallBlock): boolean {
  return BASH_TOOLS.has(toolBase(block))
}

function parsedArgs(block: ToolCallBlock): any | null {
  const text = block.argsText || runFor(block)?.argsText
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Command text, tolerating still-streaming (unterminated) JSON arguments. */
function commandOf(block: ToolCallBlock): string {
  const args = parsedArgs(block)
  const direct = args?.command ?? args?.cmd ?? args?.script
  if (typeof direct === "string") return direct
  const match = (block.argsText || "").match(/"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (!match) return ""
  return match[1]!.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"')
}

const COMMAND_PREVIEW_MAX = 120

/** Single-line, length-capped command preview for the collapsed tool header. */
function commandPreview(block: ToolCallBlock): string {
  const collapsed = commandOf(block).replace(/\s+/g, " ").trim()
  return collapsed.length > COMMAND_PREVIEW_MAX ? collapsed.slice(0, COMMAND_PREVIEW_MAX) + "…" : collapsed
}

const READ_TOOLS = new Set(["read", "read_file", "cat", "view", "open_file"])
function isRead(block: ToolCallBlock): boolean {
  return READ_TOOLS.has(toolBase(block))
}

/** File path, tolerating still-streaming (unterminated) JSON arguments. */
function pathOf(block: ToolCallBlock): string {
  const args = parsedArgs(block)
  const direct = args?.path ?? args?.file_path ?? args?.filePath
  if (typeof direct === "string") return direct
  const match = (block.argsText || "").match(/"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (!match) return ""
  return match[1]!.replace(/\\\\/g, "\\").replace(/\\"/g, `"`)
}

function terminalText(block: ToolCallBlock): string {
  const command = commandOf(block)
  const output = runFor(block)?.outputText ?? ""
  return (command ? `$ ${command}\n` : "") + output
}

function isRunning(block: ToolCallBlock): boolean {
  const state = runFor(block)?.state
  return state === "input-streaming" || state === "input-available"
}

// ---- elapsed time ----
// pi's bash tool has NO default timeout (the model may set one explicitly), so
// a runaway command (e.g. `find /`) can run forever — surface the duration.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
const anyRunning = computed(() => props.blocks.some(b => b.type === "toolCall" && isRunning(b)))
watch(
  anyRunning,
  running => {
    if (running && clock === undefined)
      clock = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    if (!running && clock !== undefined) {
      clearInterval(clock)
      clock = undefined
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (clock !== undefined) clearInterval(clock)
})

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function elapsedMs(block: ToolCallBlock): number | null {
  const run = runFor(block)
  // Running only: completed tools hide the duration.
  if (!run?.startedAt || run.completedAt) return null
  return now.value - run.startedAt
}

function elapsedText(block: ToolCallBlock): string {
  const ms = elapsedMs(block)
  // Sub-second commands do not need a visible timer; this also avoids a
  // transient badge for commands that complete almost immediately.
  return ms == null || ms < 1_000 ? "" : formatElapsed(ms)
}

/** Long-running tools stand out: amber past 30s, destructive past 2 minutes. */
function elapsedClass(block: ToolCallBlock): string {
  const ms = elapsedMs(block)
  if (ms != null && ms > 120_000) return "text-destructive"
  if (ms != null && ms > 30_000) return "text-amber-600 dark:text-amber-400"
  return "text-muted-foreground"
}

interface FileCard {
  path: string
  added: number
  removed: number
  written: number
}

// Diff results are cached per callId+argsText: streaming re-renders must not
// re-run the line diff for arguments that have not changed.
const cardCache = new Map<string, { argsText: string; card: FileCard | null }>()
function cardFor(block: ToolCallBlock): FileCard | null {
  const argsText = block.argsText || runFor(block)?.argsText || ""
  const hit = cardCache.get(block.callId)
  if (hit && hit.argsText === argsText) return hit.card
  let card: FileCard | null = null
  const args = parsedArgs(block)
  if (args) {
    const changes = changeForCall(block.callId, block.name, args)
    if (changes.length) {
      card = {
        path: changes[0]!.path,
        added: changes.reduce((sum, change) => sum + change.added, 0),
        removed: changes.reduce((sum, change) => sum + change.removed, 0),
        // Total lines written, shown when the pre-write baseline is unknown.
        written: changes.reduce((sum, change) => sum + change.lines.filter(line => line.kind === "add").length, 0),
      }
    }
  }
  cardCache.set(block.callId, { argsText, card })
  return card
}

function toolBase(block: ToolCallBlock): string {
  return block.name.toLowerCase().split(/[.:/]/).pop()!
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
        :enable-animate="props.animate"
        class="text-sm"
      />

      <!-- thinking: collapsed by default; the trigger streams the latest reasoning line.
           Concise mode hides thinking entirely: only tool calls and answers are shown. -->
      <Thinking v-else-if="block.type === 'thinking' && processDetail === 'detailed'" :is-streaming="block.streaming">
        <ThinkingTrigger :streaming-text="block.text" />
        <ThinkingContent :content="block.text" />
      </Thinking>

      <!-- bash: header shows the command; expanding reveals a terminal-style run -->
      <Tool v-else-if="block.type === 'toolCall' && isBash(block)" class="mb-0 overflow-hidden bg-background/50">
        <ToolHeader
          class="gap-2 px-3 py-2 [&>div]:min-w-0 [&>div>span]:min-w-0 [&>div>span]:truncate [&>div>span]:font-mono [&>div>span]:text-xs [&>div>span]:font-normal"
          :type="`tool-${block.name}`"
          :icon="SquareTerminal"
          :title="commandPreview(block) || undefined"
          :state="runFor(block)?.state ?? 'input-streaming'"
        >
          <template #meta>
            <span
              class="w-12 text-right text-xs tabular-nums"
              :class="elapsedText(block) ? elapsedClass(block) : ''"
              :title="elapsedText(block) ? t('blocks.elapsed') : undefined"
              :aria-label="elapsedText(block) ? t('blocks.elapsed') : undefined"
            >
              {{ elapsedText(block) }}
            </span>
          </template>
        </ToolHeader>
        <ToolContent>
          <div class="p-3">
            <Terminal
              :output="terminalText(block)"
              :is-streaming="isRunning(block)"
              class="group/terminal-output relative rounded-none border-0 bg-transparent text-xs"
            >
              <TerminalContent class="p-0 pr-9 text-xs" />
              <TerminalCopyButton
                class="absolute top-0 right-0 opacity-0 transition-opacity group-hover/terminal-output:opacity-100 focus-visible:opacity-100"
                :title="t('blocks.copyTerminal')"
                :aria-label="t('blocks.copyTerminal')"
              />
            </Terminal>
          </div>
        </ToolContent>
      </Tool>

      <!-- edit/write: file + line-count card; clicking opens the review page at that file -->
      <div
        v-else-if="block.type === 'toolCall' && cardFor(block)"
        class="not-prose w-full rounded-md border bg-background/50"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50"
          :title="t('blocks.openInReview')"
          :aria-label="t('blocks.openInReview')"
          @click="emit('openReview', cardFor(block)!.path)"
        >
          <FileTypeIcon :name="cardFor(block)!.path" class="size-4" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="cardFor(block)!.path">{{
            cardFor(block)!.path
          }}</span>
          <span
            v-if="cardFor(block)!.added || cardFor(block)!.written"
            class="shrink-0 text-xs text-green-600 dark:text-green-400"
            >+{{ cardFor(block)!.added || cardFor(block)!.written }}</span
          >
          <span v-if="cardFor(block)!.removed" class="shrink-0 text-xs text-red-600 dark:text-red-400"
            >-{{ cardFor(block)!.removed }}</span
          >
          <span v-if="elapsedText(block)" class="shrink-0 text-xs tabular-nums" :class="elapsedClass(block)">{{
            elapsedText(block)
          }}</span>
          <ToolStatusBadge :state="runFor(block)?.state ?? 'input-streaming'" />
          <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>

      <!-- other tools: generic collapsible input/output; read shows the file path -->
      <Tool v-else-if="block.type === 'toolCall'" class="mb-0 overflow-hidden bg-background/50">
        <ToolHeader
          class="gap-2 px-3 py-2 [&>div]:min-w-0"
          :class="
            isRead(block)
              ? '[&>div>span]:min-w-0 [&>div>span]:truncate [&>div>span]:font-mono [&>div>span]:text-xs [&>div>span]:font-normal'
              : '[&>div]:flex-wrap [&>div>span]:break-all'
          "
          :type="`tool-${block.name}`"
          :title="isRead(block) ? pathOf(block) || undefined : undefined"
          :state="runFor(block)?.state ?? 'input-streaming'"
        />
        <div
          v-if="elapsedText(block)"
          class="flex items-center justify-end gap-1 px-3 pb-1.5 -mt-1 text-xs tabular-nums"
          :class="elapsedClass(block)"
        >
          {{ elapsedText(block) }}
        </div>
        <ToolContent>
          <div class="space-y-2 p-3 text-xs">
            <div v-if="block.argsText">
              <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.input") }}</div>
              <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-40">
                <pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{ block.argsText }}</pre>
              </ScrollArea>
            </div>
            <div v-if="runFor(block)?.outputText">
              <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.output") }}</div>
              <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-60">
                <pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{
                  runFor(block)!.outputText
                }}</pre>
              </ScrollArea>
            </div>
          </div>
        </ToolContent>
      </Tool>
    </template>
    <slot />
  </div>
</template>
