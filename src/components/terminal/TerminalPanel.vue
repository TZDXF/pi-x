<script setup lang="ts">
import { Channel, invoke } from "@tauri-apps/api/core"
import { listen } from "@/api/transport"
import { nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { Button } from "@/components/ui/button"
import { Plus, SquareTerminal, X } from "@lucide/vue"

interface TermTab {
  id: number
  title: string
  exited: boolean
  exitCode?: number
}

const props = defineProps<{ project: string; visible: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const tabs = ref<TermTab[]>([])
const activeId = ref<number | null>(null)
const panelHeight = ref(320)

const tabEls = new Map<number, HTMLElement>()
interface TermInstance {
  term: Terminal
  fit: FitAddon
  observer: ResizeObserver
  dispose: () => void
}
const instances = new Map<number, TermInstance>()

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function setTabEl(id: number, el: unknown) {
  if (el) tabEls.set(id, el as HTMLElement)
  else tabEls.delete(id)
}

const outputChannels = new Map<number, Channel<string>>()
function mountTerminal(id: number) {
  const el = tabEls.get(id)
  if (!el || instances.has(id)) return

  const term = new Terminal({
    fontSize: 12,
    fontFamily: "Consolas, 'Courier New', Menlo, monospace",
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: "#09090b",
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
      selectionBackground: "#3f3f46",
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  // Keep terminal keystrokes (Esc, shortcuts…) from reaching global handlers.
  term.attachCustomKeyEventHandler(evt => {
    if (evt.type === "keydown") evt.stopPropagation()
    return true
  })

  term.onData(data => {
    void invoke("term_write", { id, data }).catch(() => {})
  })
  term.onResize(({ cols, rows }) => {
    void invoke("term_resize", { id, cols, rows }).catch(() => {})
  })

  const observer = new ResizeObserver(() => {
    if (el.offsetParent === null) return // hidden tab
    try {
      fit.fit()
    } catch {
      /* container not measurable yet */
    }
  })
  observer.observe(el)

  instances.set(id, {
    term,
    fit,
    observer,
    dispose: () => {
      observer.disconnect()
      term.dispose()
    },
  })

  try {
    fit.fit()
  } catch {
    /* ignore initial fit errors */
  }
  term.focus()
}

async function openTerminal() {
  try {
    const channel = new Channel<string>()
    const idPromise = invoke<number>("term_create", {
      cwd: props.project,
      cols: 80,
      rows: 24,
      onOutput: channel,
    })
    const id = await idPromise
    outputChannels.set(id, channel)
    channel.onmessage = encoded => {
      instances.get(id)?.term.write(b64ToBytes(encoded))
    }
    tabs.value.push({ id, title: `#${tabs.value.length + 1}`, exited: false })
    activeId.value = id
    await nextTick()
    mountTerminal(id)
  } catch (e) {
    console.error("term_create failed", e)
  }
}

async function closeTab(id: number) {
  const inst = instances.get(id)
  if (inst) {
    inst.dispose()
    instances.delete(id)
  }
  outputChannels.delete(id)
  tabEls.delete(id)
  tabs.value = tabs.value.filter(tab => tab.id !== id)
  if (activeId.value === id) {
    activeId.value = tabs.value[tabs.value.length - 1]?.id ?? null
    await nextTick()
    fitActive()
  }
  if (!tabs.value.length) emit("close")
  void invoke("term_kill", { id }).catch(() => {})
}

function switchTab(id: number) {
  activeId.value = id
  nextTick(() => {
    fitActive()
    instances.get(id)?.term.focus()
  })
}

function fitActive() {
  if (activeId.value === null) return
  const inst = instances.get(activeId.value)
  if (!inst) return
  try {
    inst.fit.fit()
  } catch {
    /* ignore */
  }
}

function onPanelDblClick() {
  panelHeight.value = panelHeight.value > 320 ? 320 : Math.round(window.innerHeight * 0.6)
}

// ---- divider drag resize ----
let dragStart: { y: number; height: number } | null = null
function onDividerDown(e: MouseEvent) {
  dragStart = { y: e.clientY, height: panelHeight.value }
  window.addEventListener("mousemove", onDividerMove)
  window.addEventListener("mouseup", onDividerUp)
}
function onDividerMove(e: MouseEvent) {
  if (!dragStart) return
  const max = Math.round(window.innerHeight * 0.7)
  panelHeight.value = Math.min(max, Math.max(150, dragStart.height - (e.clientY - dragStart.y)))
}
function onDividerUp() {
  dragStart = null
  window.removeEventListener("mousemove", onDividerMove)
  window.removeEventListener("mouseup", onDividerUp)
  fitActive()
}

watch(
  () => props.visible,
  visible => {
    if (!visible) return
    nextTick(() => {
      fitActive()
      instances.get(activeId.value ?? -1)?.term.focus()
    })
  },
)

watch(
  () => props.project,
  () => {
    // Workspace changed: close stale shells so new ones spawn in the new cwd.
    for (const tab of [...tabs.value]) void closeTab(tab.id)
  },
)

let unlistenExit: (() => void) | null = null
void listen<{ id: number; code: number }>("term://exit", e => {
  const tab = tabs.value.find(tab => tab.id === e.payload.id)
  if (!tab || tab.exited) return
  tab.exited = true
  tab.exitCode = e.payload.code
  instances.get(tab.id)?.term.writeln(
    `\r\n\x1b[2m${t("terminal.exited", { code: e.payload.code })}\x1b[0m`,
  )
}).then(fn => { unlistenExit = fn })

onBeforeUnmount(() => {
  for (const [, inst] of instances) inst.dispose()
  instances.clear()
  for (const tab of tabs.value) void invoke("term_kill", { id: tab.id }).catch(() => {})
  unlistenExit?.()
  window.removeEventListener("mousemove", onDividerMove)
  window.removeEventListener("mouseup", onDividerUp)
})

defineExpose({ openTerminal, hasTerminals: () => tabs.value.length > 0 })
</script>

<template>
  <div class="terminal-dock border-border flex flex-col border-t" :style="{ height: `${panelHeight}px` }">
    <!-- drag handle -->
    <div
      class="border-border hover:bg-primary/10 relative -mt-1 h-2 shrink-0 cursor-row-resize border-t border-transparent"
      @mousedown="onDividerDown"
      @dblclick="onPanelDblClick"
    />

    <!-- tab bar -->
    <div class="bg-background/95 flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs"
          :class="
            tab.id === activeId
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50'
          "
          @click="switchTab(tab.id)"
        >
          <SquareTerminal class="size-3.5" :class="tab.exited ? 'text-muted-foreground/50' : ''" />
          <span :class="{ 'line-through opacity-60': tab.exited }">{{ tab.title }}</span>
          <X
            class="size-3 opacity-0 transition-opacity group-hover:opacity-100"
            :title="t('terminal.closeTab')"
            @click.stop="closeTab(tab.id)"
          />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          :title="t('terminal.new')"
          @click="openTerminal"
        >
          <Plus />
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        :title="t('terminal.hide')"
        @click="emit('close')"
      >
        <X />
      </Button>
    </div>

    <!-- terminal containers (kept mounted, hidden per tab) -->
    <div class="bg-zinc-950 min-h-0 flex-1 p-1">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        :ref="el => setTabEl(tab.id, el)"
        class="h-full w-full"
        :style="{ display: tab.id === activeId ? 'block' : 'none' }"
      />
    </div>
  </div>
</template>
