<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  detectPi,
  piRunning,
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
import { isDesktop } from "@/api/transport"
import type { AppConfig, TrustStatus } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useWorkspaceStore } from "@/stores/workspace"
import { useUiStore } from "@/stores/ui"
import WelcomeView from "@/components/WelcomeView.vue"
import TrustDialog from "@/components/TrustDialog.vue"
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue"
import SettingsDialog from "@/components/SettingsDialog.vue"
import { PanelLeft } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import ChatView from "@/components/ChatView.vue"

type Phase = "detecting" | "no-pi" | "pick" | "trust" | "chat" | "down"

const session = useSessionStore()
const workspace = useWorkspaceStore()
const navigating = ref(false)
const pendingResume = ref<string | null>(null)
const ui = useUiStore()
const { t } = useI18n()

const sidebarOpen = ref(true)
const settingsOpen = ref(false)

const phase = ref<Phase>("detecting")
const config = ref<AppConfig>({})
const project = ref("")
const trustInfo = ref<TrustStatus | null>(null)
const lastError = ref<string | null>(null)

const started = ref(false)
const connecting = ref(false)
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

  try {
    const handlers = await Promise.all([
      onPiEvent((ev) => {
        if (ev.type === "extension_ui_request") {
          ui.handleRequest(ev as any)
          return
        }
        session.handleEvent(ev)
      }),
      onPiExit(() => {
        started.value = false
        if (phase.value === "chat" && !connecting.value) phase.value = "down"
      }),
      onPiStderr((line) => ui.pushStderr(line)),
    ])
    if (disposed) {
      handlers.forEach((off) => off())
      return
    }
    unlisteners = handlers

    if (!isDesktop && (await piRunning())) {
      try {
        project.value = config.value.lastProject ?? ""
        started.value = true
        await session.init(project.value)
        await session.loadHistory()
        phase.value = "chat"
      } catch (e) {
        lastError.value = String(e)
        phase.value = "down"
      }
      return
    }
    // Restore the workspace only; start pi when a conversation is opened.
    if (config.value.lastProject) {
      project.value = config.value.lastProject
      await selectProject(project.value)
      return
    }

    const info = await detectPi(config.value.piPath)
    phase.value = info.found ? "pick" : "no-pi"
  } catch (e) {
    lastError.value = String(e)
    phase.value = "down"
  }
})

async function selectProject(dir: string) {
  if (session.isStreaming || workspace.gitBusy || connecting.value) return
  connecting.value = true
  phase.value = "chat"
  try {
    if (started.value) {
      await killPi()
      started.value = false
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
    phase.value = "chat"
    // pi starts lazily on first submit; still fill the model picker now.
    if (!started.value) void session.loadOfflineModels()
  } catch (e) {
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  }
  finally { connecting.value = false }
}

async function onTrustDecision(trusted: boolean, trustParent: boolean) {
  if (trustInfo.value) await trustSave(trustInfo.value!.projectPath, trusted, trustParent)
  if (trusted) {
    phase.value = "chat"
    if (!started.value) void session.loadOfflineModels()
    const file = pendingResume.value
    pendingResume.value = null
    if (file && phase.value === "chat") await resumeSession(file)
  } else {
    pendingResume.value = null
    phase.value = "pick"
  }
}

async function start(): Promise<boolean> {
  if (started.value) return true
  connecting.value = true
  try {
    await spawnPi(project.value)
    await session.init(project.value)
    started.value = true
    await applyDefaultModel()
    return true
  } catch (e) {
    await killPi().catch(() => {})
    started.value = false
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    return false
  } finally {
    connecting.value = false
  }
}

/** Fresh conversations use the configured default model unless the user picked one
 * (desiredModelKey is applied by init). Not sticky: resuming keeps its own model. */
async function applyDefaultModel() {
  if (session.desiredModelKey) return
  try {
    const d = (await getConfig()).defaultModel
    const current = session.currentModel
    if (!d?.provider || !d?.modelId) return
    if (current?.provider === d.provider && current?.id === d.modelId) return
    await rpcRequest({ type: "set_model", provider: d.provider, modelId: d.modelId })
    await session.refreshState()
  } catch (e) {
    console.warn("[pi] failed to apply default model:", e)
  }
}

async function switchProject() {
  if (session.isStreaming || workspace.gitBusy || navigating.value || connecting.value) return
  await killPi()
  started.value = false
  session.clear()
  ui.clear()
  phase.value = "pick"
}

/** Resume a stored session: switch in-process when possible, else restart. */
async function resumeSession(file: string, targetProject?: string) {
  if (session.isStreaming || workspace.gitBusy || navigating.value || connecting.value) return
  if (targetProject && targetProject !== project.value) {
    await selectProject(targetProject)
    if (phase.value !== "chat") {
      if (phase.value === "trust") pendingResume.value = file
      return
    }
  }
  ui.clear()
  phase.value = "chat"
  connecting.value = true
  try {
    let switched = false
    if (started.value) {
      try {
        const res = await rpcRequest<{ cancelled?: boolean }>({
          type: "switch_session",
          sessionPath: file,
        })
        if (res.success && res.data?.cancelled) {
          ui.pushToast(t("app.toastSessionCancelled"), "info")
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
      started.value = true
    }
    session.clear()
    await session.init(project.value)
    await session.loadHistory()
    phase.value = "chat"
  } catch (e) {
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  }
  finally { connecting.value = false }
}

async function newProjectSession(path: string) {
  if (session.isStreaming || workspace.gitBusy || navigating.value || connecting.value) return
  navigating.value = true
  try {
    if (path !== project.value) await selectProject(path)
    if (phase.value === "chat") {
      if (started.value) await session.newSession()
      else session.clear()
    }
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { navigating.value = false }
}

// Removing a project only removes its navigation entry, never files or logs.
async function removeProject(path: string) {
  if (session.isStreaming || workspace.gitBusy || navigating.value || connecting.value) return
  navigating.value = true
  try {
    if (path === project.value) {
      const nextConfig = { ...config.value, lastProject: undefined }
      // Persist before altering UI so a failure does not silently re-open the project.
      await saveConfig(nextConfig)
      await killPi()
      started.value = false
      config.value = nextConfig
      pendingResume.value = null
      trustInfo.value = null
      session.clear()
      ui.clear()
      project.value = ""
      phase.value = "pick"
    }
    workspace.removeProject(path)
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { navigating.value = false }
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
      :busy="navigating || workspace.gitBusy || connecting || phase === 'trust'"
      @switch-project="switchProject"
      @select-project="selectProject"
      @resume-session="resumeSession"
      @new-session="newProjectSession"
      @remove-project="removeProject"
      @settings="settingsOpen = true"
      @collapse="sidebarOpen = false"
    />
    <main class="workspace-main">
      <Button
        v-if="!sidebarOpen"
        variant="ghost"
        size="icon"
        class="sidebar-restore icon-button"
        :title="t('app.expandSidebar')"
        :aria-label="t('app.expandSidebar')"
        @click="sidebarOpen = true"
      >
        <PanelLeft :size="18" />
      </Button>
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

      <template v-else-if="phase === 'chat'">
        <ChatView :project="project" :ensure-started="start" :connecting="connecting" :connected="started" @select-project="selectProject" @open-project="switchProject" />
      </template>

      <div
        v-else-if="phase === 'down'"
        class="flex flex-1 flex-col items-center justify-center gap-4 p-8"
      >
        <p class="text-lg font-medium">{{ t("app.exited") }}</p>
        <p v-if="lastError" class="text-muted-foreground max-w-xl text-center font-mono text-xs">
          {{ lastError }}
        </p>
        <div v-if="ui.stderrLines.length" class="bg-muted w-full max-w-2xl rounded-md p-3">
          <p class="text-muted-foreground mb-1 text-xs font-medium">
            {{ t("app.stderr") }}
          </p>
          <ScrollArea viewport-class="max-h-48"><pre class="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{{
            ui.stderrLines.slice(-12).join("\n")
          }}</pre></ScrollArea>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="switchProject">
            {{ t("app.chooseProject") }}
          </Button>
        </div>
      </div>
    </main>
    <SettingsDialog :open="settingsOpen" :project="project" @close="settingsOpen = false" />
    <!-- global toasts -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
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
