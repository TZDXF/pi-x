<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
/** About page: desktop-only app self-update (stable/preview channels) and Pi self-update controls. */
import { onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getVersion } from "@tauri-apps/api/app"
import { ask } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Markdown } from "vue-stream-markdown"
import { markdownLinkOptions } from "@/lib/linkOptions"
import "vue-stream-markdown/index.css"
import PiXLogo from "@/components/PiXLogo.vue"
import { GithubIcon } from "@/components/ai-elements/open-in-chat/providers/icons"
import { Badge } from "@/components/ui/badge"
import { isDesktop, listen } from "@/api/transport"
import {
  checkPiUpdate,
  detectPi,
  executePiUpdate,
  checkAppUpdate,
  installAppUpdate,
  restartApp,
  getConfig,
  saveConfig,
  APP_UPDATE_PROGRESS_EVENT,
  type PiUpdateStatus,
  type AppUpdateStatus,
  type UpdateChannel,
} from "@/api/piClient"
import { formatCodedError } from "@/lib/backendError"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AcceptableValue } from "reka-ui"

const { t } = useI18n()
const isDevelopment = import.meta.env.DEV

const GITHUB_URL = "https://github.com/TZDXF/pi-x"

// ---- PiX 应用自身更新 ----

interface AppUpdateProgress {
  stage: "download" | "install" | "installed"
  chunkLength?: number
  contentLength?: number | null
}

const appVersion = ref<string | null>(null)
const appChannel = ref<UpdateChannel>("stable")
const appStatus = ref<AppUpdateStatus | null>(null)
const appChecking = ref(false)
const appInstalling = ref(false)
const appInstalled = ref(false)
const appProgress = ref<number | null>(null)
const appError = ref("")
let downloaded = 0
let unlistenProgress: (() => void) | null = null

async function checkApp() {
  if (appChecking.value || appInstalling.value) return
  appChecking.value = true
  appInstalled.value = false
  appStatus.value = null
  appError.value = ""
  try {
    appStatus.value = await checkAppUpdate(appChannel.value)
  } catch (e) {
    appError.value = formatCodedError(t, e)
  } finally {
    appChecking.value = false
  }
}

async function changeChannel(v: AcceptableValue) {
  if (appInstalling.value || v === appChannel.value) return
  appStatus.value = null
  appError.value = ""
  try {
    const channel = v as UpdateChannel
    // 通道偏好持久化后再按新通道检查，保证下次启动的判定一致
    await saveConfig({ ...(await getConfig()), updateChannel: channel })
    appChannel.value = channel
  } catch (e) {
    appError.value = formatCodedError(t, e)
  }
  void checkApp()
}

async function updateApp() {
  if (!appStatus.value?.updateAvailable || appInstalling.value || appChecking.value) return
  const confirmed = await ask(t("appUpdate.confirm", { version: appStatus.value.version }), {
    title: t("appUpdate.title"),
    okLabel: t("appUpdate.install"),
    cancelLabel: t("common.cancel"),
  })
  if (!confirmed) return
  appInstalling.value = true
  appInstalled.value = false
  downloaded = 0
  appProgress.value = 0
  appError.value = ""
  try {
    await installAppUpdate(appChannel.value)
    appInstalled.value = true
  } catch (e) {
    appError.value = formatCodedError(t, e)
  } finally {
    appInstalling.value = false
    appProgress.value = null
  }
}

async function restart() {
  try {
    await restartApp()
  } catch {
    /* 重启即退出进程，Promise 不会正常结算 */
  }
}

function onProgress(e: { payload: AppUpdateProgress }) {
  const p = e.payload
  if (p.stage === "download") {
    downloaded += p.chunkLength ?? 0
    if (p.contentLength) appProgress.value = Math.min(99, Math.round((downloaded / p.contentLength) * 100))
  } else if (p.stage === "install") {
    appProgress.value = 100
  } else if (p.stage === "installed") {
    appInstalled.value = true
  }
}

// ---- Pi 更新（原有逻辑）----

const currentVersion = ref<string | null>(null)
const status = ref<PiUpdateStatus | null>(null)
const checking = ref(false)
const updating = ref(false)
const updated = ref(false)
const error = ref("")

async function check() {
  if (checking.value || updating.value) return
  checking.value = true
  updated.value = false
  status.value = null
  error.value = ""
  try {
    const info = await detectPi()
    currentVersion.value = info.version
    if (!info.found || !info.version) {
      error.value = t("piUpdate.notFound")
      return
    }
    status.value = await checkPiUpdate()
    currentVersion.value = status.value.currentVersion
  } catch (e) {
    error.value = formatCodedError(t, e)
  } finally {
    checking.value = false
  }
}

async function update() {
  if (!status.value?.updateAvailable || updating.value || checking.value) return
  updating.value = true
  try {
    const confirmed = await ask(t("piUpdate.confirm", { version: status.value.latestVersion }), {
      title: t("piUpdate.title"),
      okLabel: t("piUpdate.update"),
      cancelLabel: t("common.cancel"),
    })
    if (!confirmed) return
    error.value = ""
    await executePiUpdate()
    // The running RPC process keeps its current code; a new session loads the update.
    status.value = null
    updated.value = true
    try {
      currentVersion.value = (await detectPi()).version
    } catch {
      /* Check again manually if probing fails. */
    }
  } catch (e) {
    error.value = formatCodedError(t, e)
  } finally {
    updating.value = false
  }
}

// Release notes may link to docs or issues; open them in the system browser.
function onNotesClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement | null)?.closest("a")
  const href = anchor?.getAttribute("href")
  if (!href || !/^https?:\/\//.test(href)) return
  event.preventDefault()
  void openUrl(href)
}

function openAppRelease() {
  if (appStatus.value?.releaseUrl) void openUrl(appStatus.value.releaseUrl)
}

function openRelease() {
  if (status.value?.releaseUrl) void openUrl(status.value.releaseUrl)
}

onMounted(() => {
  if (!isDesktop) return
  void (async () => {
    try {
      appVersion.value = await getVersion()
    } catch {
      /* 手动检查后可见 */
    }
    try {
      appChannel.value = (await getConfig()).updateChannel ?? "stable"
    } catch {
      /* 默认正式版 */
    }
    unlistenProgress = await listen<AppUpdateProgress>(APP_UPDATE_PROGRESS_EVENT, onProgress)
  })()
})

onUnmounted(() => {
  unlistenProgress?.()
  unlistenProgress = null
})
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading class="flex items-center gap-2">
        <PiXLogo />
        <Badge
          v-if="isDevelopment"
          variant="destructive"
          class="border-destructive/20 bg-transparent text-[11px] dark:border-destructive/30"
        >
          {{ t("app.development") }}
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          :aria-label="t('settings.githubRepo')"
          :title="t('settings.githubRepo')"
          @click="openUrl(GITHUB_URL)"
        >
          <GithubIcon class="size-4" />
        </Button>
      </SettingHeading>
      <SettingDescription>{{ t("settings.aboutBody") }}</SettingDescription>
    </div>
  </SettingRow>
  <SettingRow as="section" v-if="isDesktop" class="flex-wrap" aria-labelledby="app-update-title">
    <div class="min-w-0">
      <SettingHeading id="app-update-title">{{ t("appUpdate.title") }}</SettingHeading>
      <SettingDescription>{{ t("appUpdate.channelDesc") }}</SettingDescription>
      <SettingDescription v-if="appVersion" aria-live="polite">
        {{ t("appUpdate.current") }} <span class="font-mono text-foreground">{{ appVersion }}</span>
        <template v-if="appStatus?.updateAvailable && appStatus.version">
          <span aria-hidden="true"> → </span><span class="sr-only">{{ t("appUpdate.latest") }}</span
          ><span class="font-mono text-foreground">{{ appStatus.version }}</span>
        </template>
        <span v-else-if="appStatus && !appStatus.waitingStable"> · {{ t("appUpdate.upToDate") }}</span>
      </SettingDescription>
      <SettingDescription v-if="appStatus?.waitingStable" role="status" class="break-words">
        {{ t("appUpdate.waitingStable", { current: appStatus.currentVersion, version: appStatus.version }) }}
      </SettingDescription>
      <SettingDescription v-if="appInstalled" role="status">{{ t("appUpdate.installed") }}</SettingDescription>
      <SettingDescription v-if="appError" role="alert" class="break-words !text-destructive">{{
        appError
      }}</SettingDescription>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <Select :model-value="appChannel" :disabled="appInstalling" @update:model-value="changeChannel">
        <SelectTrigger class="h-8 w-28 text-xs" :aria-label="t('appUpdate.channel')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="stable">{{ t("appUpdate.channelStable") }}</SelectItem>
          <SelectItem value="preview">{{ t("appUpdate.channelPreview") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        :disabled="appChecking || appInstalling"
        :aria-label="appChecking ? t('appUpdate.checking') : undefined"
        @click="checkApp"
      >
        <span
          v-if="appChecking"
          class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
        {{ t("appUpdate.check") }}
      </Button>
      <Button
        v-if="appStatus?.updateAvailable && !appInstalled"
        size="sm"
        :disabled="appChecking || appInstalling"
        :aria-label="appInstalling ? t('appUpdate.installing') : undefined"
        @click="updateApp"
      >
        <span
          v-if="appInstalling"
          class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
        {{ t("appUpdate.install") }}
      </Button>
      <Button v-if="appInstalled" size="sm" @click="restart">{{ t("appUpdate.restart") }}</Button>
    </div>
    <div v-if="appInstalling && appProgress !== null" class="mt-3 w-full basis-full">
      <Progress :model-value="appProgress" :aria-label="t('appUpdate.installing')" />
      <p class="text-muted-foreground mt-1 text-xs">{{ t("appUpdate.installing") }} {{ appProgress }}%</p>
    </div>
    <div v-if="appStatus?.updateAvailable && appStatus.releaseNotes && !appInstalled" class="mt-3 w-full basis-full">
      <p class="text-foreground mb-1.5 text-xs font-medium">{{ t("appUpdate.releaseNotes") }}</p>
      <div
        class="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed [&_a]:text-primary [&_a]:underline [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5"
        role="region"
        :aria-label="t('appUpdate.releaseNotes')"
        @click="onNotesClick"
      >
        <Markdown :link-options="markdownLinkOptions" :content="appStatus.releaseNotes" />
      </div>
      <button
        v-if="appStatus.releaseUrl"
        type="button"
        class="text-primary mt-1.5 text-xs underline-offset-2 hover:underline"
        @click="openAppRelease"
      >
        {{ t("appUpdate.viewRelease") }}
      </button>
    </div>
  </SettingRow>
  <SettingRow as="section" v-if="isDesktop" class="flex-wrap" aria-labelledby="pi-update-title">
    <div class="min-w-0">
      <SettingHeading id="pi-update-title">{{ t("piUpdate.title") }}</SettingHeading>
      <SettingDescription v-if="currentVersion" aria-live="polite">
        {{ t("piUpdate.current") }} <span class="font-mono text-foreground">{{ currentVersion }}</span>
        <template v-if="status?.updateAvailable">
          <span aria-hidden="true"> → </span><span class="sr-only">{{ t("piUpdate.latest") }}</span
          ><span class="font-mono text-foreground">{{ status.latestVersion }}</span>
        </template>
        <span v-else-if="status"> · {{ t("piUpdate.upToDate") }}</span>
      </SettingDescription>
      <SettingDescription v-if="updated" role="status">{{ t("piUpdate.completed") }}</SettingDescription>
      <SettingDescription v-if="error" role="alert" class="break-words !text-destructive">{{
        error
      }}</SettingDescription>
    </div>
    <div class="flex shrink-0 flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        :disabled="checking || updating"
        :aria-label="checking ? t('piUpdate.checking') : undefined"
        @click="check"
      >
        <span
          v-if="checking"
          class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
        {{ t("piUpdate.check") }}
      </Button>
      <Button
        v-if="status?.updateAvailable"
        size="sm"
        :disabled="checking || updating"
        :aria-label="updating ? t('piUpdate.updating') : undefined"
        @click="update"
      >
        <span
          v-if="updating"
          class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
        {{ t("piUpdate.update") }}
      </Button>
    </div>
    <div v-if="status?.updateAvailable && status.releaseNotes" class="mt-3 w-full basis-full">
      <p class="text-foreground mb-1.5 text-xs font-medium">{{ t("piUpdate.releaseNotes") }}</p>
      <div
        class="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed [&_a]:text-primary [&_a]:underline [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5"
        role="region"
        :aria-label="t('piUpdate.releaseNotes')"
        @click="onNotesClick"
      >
        <Markdown :link-options="markdownLinkOptions" :content="status.releaseNotes" />
      </div>
      <button
        v-if="status.releaseUrl"
        type="button"
        class="text-primary mt-1.5 text-xs underline-offset-2 hover:underline"
        @click="openRelease"
      >
        {{ t("piUpdate.viewRelease") }}
      </button>
    </div>
  </SettingRow>
  <p v-if="isDesktop" class="text-muted-foreground mt-5 text-xs">{{ t("settings.dataDirectory") }}: ~/.pix</p>
</template>
