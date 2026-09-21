<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"
import {
  detectPi,
  getConfig,
  killPi,
  onPiEvent,
  onPiExit,
  onPiStderr,
  rpcRequest,
  saveConfig,
  spawnPi,
  trustSave,
  trustStatus,
} from "@/api/piClient"
import type { AppConfig, TrustStatus } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import WelcomeView from "@/components/WelcomeView.vue"
import TrustDialog from "@/components/TrustDialog.vue"
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue"
import SettingsDialog from "@/components/SettingsDialog.vue"
import { PanelLeft } from "@lucide/vue"
import ChatView from "@/components/ChatView.vue"

type Phase =
  "detecting" | "no-pi" | "pick" | "trust" | "starting" | "chat" | "down"

const session = useSessionStore()
const ui = useUiStore()

const sidebarOpen = ref(true)
const settingsOpen = ref(false)

const phase = ref<Phase>("detecting")
const config = ref<AppConfig>({})
const project = ref("")
const trustInfo = ref<TrustStatus | null>(null)
const lastError = ref<string | null>(null)

let started = false
// event listener lifecycle: always unlisten on unmount, otherwise HMR
// remounts stack duplicate listeners and events get handled N times
let unlisteners: Array<() => void> = []
let disposed = false

onMounted(async () => {
  try {
    config.value = await getConfig()
  } catch {
    config.value = {}
  }

  const handlers = await Promise.all([
    onPiEvent((ev) => {
      if (ev.type === "extension_ui_request") {
        ui.handleRequest(ev as any)
        return
      }
      session.handleEvent(ev)
    }),
    onPiExit(() => {
      if (phase.value === "chat" || phase.value === "starting")
        phase.value = "down"
    }),
    onPiStderr((line) => ui.pushStderr(line)),
  ])
  if (disposed) {
    handlers.forEach((off) => off())
    return
  }
  unlisteners = handlers

  // auto-resume last project on launch
  if (config.value.lastProject) {
    project.value = config.value.lastProject
    await selectProject(project.value)
    return
  }

  const info = await detectPi(config.value.piPath)
  phase.value = info.found ? "pick" : "no-pi"
})

async function selectProject(dir: string) {
  if (started) {
    await killPi()
    started = false
    session.clear()
    ui.clear()
  }
  project.value = dir
  config.value.lastProject = dir
  void saveConfig({ ...config.value })
  const status = await trustStatus(dir)
  if (status.needsDecision) {
    trustInfo.value = status
    phase.value = "trust"
    return
  }
  await start()
}

async function onTrustDecision(trusted: boolean, trustParent: boolean) {
  if (trustInfo.value)
    await trustSave(trustInfo.value!.projectPath, trusted, trustParent)
  if (trusted) await start()
  else phase.value = "pick"
}

async function start() {
  if (started) {
    // restarting after exit: clear stale state first
    started = false
  }
  phase.value = "starting"
  try {
    await spawnPi(project.value)
    started = true
    await session.init(project.value)
    phase.value = "chat"
  } catch (e) {
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  }
}

async function switchProject() {
  await killPi()
  started = false
  session.clear()
  ui.clear()
  phase.value = "pick"
}

async function restartPi() {
  await killPi()
  started = false
  await start()
}

/** Resume a stored session: switch in-process when possible, else restart. */
async function resumeSession(file: string) {
  ui.clear()
  session.clear()
  phase.value = "starting"
  try {
    let switched = false
    if (started) {
      try {
        const res = await rpcRequest<{ cancelled?: boolean }>({
          type: "switch_session",
          sessionPath: file,
        })
        if (res.success && res.data?.cancelled) {
          ui.pushToast("Session switch cancelled by an extension", "info")
          phase.value = "chat"
          return
        }
        switched = res.success
      } catch {
        switched = false
      }
    }
    if (!switched) {
      await killPi()
      await spawnPi(project.value, file)
      started = true
    }
    await session.init(project.value)
    await session.loadHistory()
    phase.value = "chat"
  } catch (e) {
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  }
}

onUnmounted(() => {
  disposed = true
  unlisteners.forEach((off) => off())
  unlisteners = []
})
</script>

<template>
  <div class="desktop-shell">
    <WorkspaceSidebar
      v-show="sidebarOpen"
      :project="project"
      :ready="phase === 'chat'"
      :busy="phase === 'starting' || phase === 'trust'"
      @switch-project="switchProject"
      @select-project="selectProject"
      @resume-session="resumeSession"
      @settings="settingsOpen = true"
      @collapse="sidebarOpen = false"
    />
    <main class="workspace-main">
      <button
        v-if="!sidebarOpen"
        class="sidebar-restore icon-button"
        title="展开侧栏"
        aria-label="展开侧栏"
        @click="sidebarOpen = true"
      >
        <PanelLeft :size="18" />
      </button>
      <WelcomeView
        v-if="phase === 'no-pi' || phase === 'pick' || phase === 'detecting'"
        :phase
        :config
        @configured="phase = 'pick'"
        @project-selected="selectProject"
      />

      <div
        v-else-if="phase === 'trust' && trustInfo"
        class="flex flex-1 items-center justify-center"
      >
        <TrustDialog :info="trustInfo" @done="onTrustDecision" />
      </div>

      <div
        v-else-if="phase === 'starting'"
        class="flex flex-1 items-center justify-center gap-3 text-muted-foreground"
      >
        <span class="size-2 animate-pulse rounded-full bg-primary" />
        <span>Starting pi…</span>
      </div>

      <template v-else-if="phase === 'chat'">
        <ChatView :project="project" />
      </template>

      <div
        v-else-if="phase === 'down'"
        class="flex flex-1 flex-col items-center justify-center gap-4 p-8"
      >
        <p class="text-lg font-medium">pi process exited</p>
        <p
          v-if="lastError"
          class="text-muted-foreground max-w-xl text-center font-mono text-xs"
        >
          {{ lastError }}
        </p>
        <div
          v-if="ui.stderrLines.length"
          class="bg-muted w-full max-w-2xl rounded-md p-3"
        >
          <p class="text-muted-foreground mb-1 text-xs font-medium">
            pi stderr (last lines)
          </p>
          <pre
            class="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap"
            >{{ ui.stderrLines.slice(-12).join("\n") }}</pre>
        </div>
        <div class="flex gap-2">
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm"
            @click="restartPi"
          >
            Restart
          </button>
          <button
            class="border-input hover:bg-accent rounded-md border px-4 py-2 text-sm"
            @click="switchProject"
          >
            Choose another project
          </button>
        </div>
      </div>
    </main>
    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    <!-- global toasts -->
    <div
      class="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
    >
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="pointer-events-auto max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg"
        :class="{
          'bg-background text-foreground': t.kind === 'info',
          'border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100':
            t.kind === 'warning',
          'border-red-500/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100':
            t.kind === 'error',
        }"
      >
        {{ t.message }}
      </div>
    </div>
  </div>
</template>
