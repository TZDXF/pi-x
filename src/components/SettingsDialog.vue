<script setup lang="ts">
import PiXLogo from "@/components/PiXLogo.vue"
/** Categorized workspace settings and Pi runtime configuration. */
import { isDesktop } from "@/api/transport"
import { remoteStatus, remoteSet, type RemoteStatus } from "@/api/piClient"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcceptableValue } from "reka-ui"
import { detectPi, getConfig, saveConfig, type AppConfig, type PiInfo } from "@/api/piClient"
import ProviderSettings from "./ProviderSettings.vue"
import ModelSettings from "./ModelSettings.vue"
import AgentSettings from "./AgentSettings.vue"
import SkillSettings from "./SkillSettings.vue"
import TitleModelSettings from "./TitleModelSettings.vue"
import PackageSettings from "./PackageSettings.vue"
import { useUiStore } from "@/stores/ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"

import { theme, setTheme, type ThemePreference } from "@/lib/theme"

const props = defineProps<{ open: boolean; project?: string }>()
const emit = defineEmits<{ close: [] }>()
const ui = useUiStore()

const remote = ref<RemoteStatus>({ enabled: false, port: 1421, urls: [] })
const remoteBusy = ref(false)
async function toggleRemote() {
  remoteBusy.value = true
  try {
    remote.value = await remoteSet(!remote.value.enabled, Number(remote.value.port))
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    remoteBusy.value = false
  }
}
const tab = ref("general")
const { t } = useI18n()
const selectedLocale = ref<Locale>(currentLocale())

function applyLocale(v: Locale) {
  selectedLocale.value = v
  setLocale(v)
}
const windowPreferencesBusy = ref(false)
const minimizeToTray = ref(false)
const closeToTray = ref(false)
async function saveWindowPreferences() {
  windowPreferencesBusy.value = true
  try {
    const c = await getConfig()
    await saveConfig({ ...c, minimizeToTray: minimizeToTray.value, closeToTray: closeToTray.value })
  } catch (e) {
    ui.pushToast(String(e), "error")
    const c = await getConfig().catch(() => null)
    if (c) { minimizeToTray.value = c.minimizeToTray ?? false; closeToTray.value = c.closeToTray ?? false }
  } finally { windowPreferencesBusy.value = false }
}
const piPath = ref("")
const info = ref<PiInfo | null>(null)
const detecting = ref(false)
const saving = ref(false)

watch(
  () => props.open,
  async (o) => {
    if (!o) return
    info.value = null
    try {
      if (isDesktop) remote.value = await remoteStatus()
      const c: AppConfig = await getConfig()
      piPath.value = c.piPath ?? ""
      minimizeToTray.value = c.minimizeToTray ?? false
      closeToTray.value = c.closeToTray ?? false
    } catch {
      piPath.value = ""
    }
  },
)

async function detect() {
  detecting.value = true
  try {
    info.value = await detectPi(piPath.value.trim() || undefined)
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    detecting.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const c: AppConfig = await getConfig()
    await saveConfig({ ...c, piPath: piPath.value.trim() || undefined })
    ui.pushToast(t("settings.toastSaved"), "info")
    emit("close")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => !v && emit('close')">
    <DialogContent class="settings-dialog">
      <Tabs v-model="tab" orientation="vertical" class="contents">
        <nav class="settings-nav" :aria-label="t('settings.nav')">
          <h2>{{ t("settings.title") }}</h2>
          <TabsList variant="line">
            <TabsTrigger value="remote" class="justify-start">{{ t("settings.remote") }}</TabsTrigger>
            <TabsTrigger value="general" class="justify-start">{{ t("settings.general") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="models" class="justify-start">{{ t("settings.providersModels") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="runtime" class="justify-start">{{ t("settings.runtime") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="agent-config" class="justify-start">{{ t("agentConfig.title") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="skills" class="justify-start">{{ t("skillsConfig.title") }}</TabsTrigger>
            <TabsTrigger value="packages" class="justify-start">{{ t("packages.title") }}</TabsTrigger>
            <TabsTrigger value="about" class="justify-start">{{ t("settings.about") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="model-config" class="justify-start">{{ t("titleGeneration.page") }}</TabsTrigger>
          </TabsList>
          <p>{{ t("settings.subtitle") }}</p>
        </nav>
        <ScrollArea :key="tab" class="settings-scroll">
        <TabsContent v-if="isDesktop" value="agent-config" class="settings-body">
          <AgentSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="skills" class="settings-body">
          <SkillSettings />
        </TabsContent>
        <TabsContent value="remote" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.remote") }}</DialogTitle
            ><DialogDescription>{{ t("settings.remoteDesc") }}</DialogDescription></DialogHeader
          >
          <p class="text-sm text-amber-600">{{ t("settings.remoteWarning") }}</p>
          <template v-if="isDesktop">
            <label class="block text-sm" for="remote-port">{{ t("settings.remotePort") }}</label>
            <Input
              id="remote-port"
              v-model="remote.port"
              type="number"
              min="1"
              max="65535"
              :disabled="remote.enabled || remoteBusy"
            />
            <Button
              variant="outline"
              class="h-auto px-4 py-2"
              :disabled="remoteBusy"
              :aria-pressed="remote.enabled"
              @click="toggleRemote"
            >
              {{
                remoteBusy
                  ? t("settings.saving")
                  : remote.enabled
                    ? t("settings.remoteDisable")
                    : t("settings.remoteEnable")
              }}
            </Button>
            <div v-if="remote.enabled" class="space-y-3 text-sm">
              <p>{{ t("settings.remoteLinks") }}</p>
              <Input
                v-for="url in remote.urls"
                :key="url"
                :model-value="url"
                readonly
                :aria-label="t('settings.remoteLinks')"
                class="font-mono text-xs"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <p v-if="!remote.urls.length">{{ t("settings.remoteNoAddress") }}</p>
              <p class="text-muted-foreground">{{ t("settings.remoteFirewall") }}</p>
            </div>
          </template>
          <p v-else class="text-sm">{{ t("settings.remoteDesktopOnly") }}</p>
        </TabsContent>
        <TabsContent value="general" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.generalTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.generalDesc") }}</DialogDescription></DialogHeader
          >
          <template v-if="isDesktop">
            <label class="setting-row">
              <div><h3>{{ t("settings.minimizeToTray") }}</h3><p>{{ t("settings.minimizeToTrayDesc") }}</p></div>
              <input v-model="minimizeToTray" type="checkbox" :disabled="windowPreferencesBusy" @change="saveWindowPreferences" />
            </label>
            <label class="setting-row">
              <div><h3>{{ t("settings.closeToTray") }}</h3><p>{{ t("settings.closeToTrayDesc") }}</p></div>
              <input v-model="closeToTray" type="checkbox" :disabled="windowPreferencesBusy" @change="saveWindowPreferences" />
            </label>
            <p class="text-xs text-muted-foreground">{{ t("settings.dataDirectory") }}: ~/.pix</p>
          </template>
          <div class="setting-row">
            <div>
              <h3 id="theme-label">{{ t("settings.theme") }}</h3>
              <p id="theme-description">{{ t("settings.themeDesc") }}</p>
            </div>
            <Select
              :model-value="theme"
              @update:model-value="(v: AcceptableValue) => setTheme(v as ThemePreference)"
            >
              <SelectTrigger
                class="h-8 w-36 text-xs"
                aria-labelledby="theme-label"
                aria-describedby="theme-description"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">{{ t("settings.themeLight") }}</SelectItem>
                <SelectItem value="dark">{{ t("settings.themeDark") }}</SelectItem>
                <SelectItem value="system">{{ t("settings.themeSystem") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="setting-row">
            <div>
              <h3>{{ t("settings.language") }}</h3>
              <p>{{ t("settings.languageDesc") }}</p>
            </div>
            <Select
              :model-value="selectedLocale"
              @update:model-value="(v: AcceptableValue) => applyLocale(v as Locale)"
            >
              <SelectTrigger class="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in LOCALES" :key="l.value" :value="l.value">
                  {{ l.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="setting-row">
            <div>
              <h3>{{ t("settings.workspaceTitle") }}</h3>
              <p>{{ t("settings.workspaceDesc") }}</p>
            </div>
            <span class="setting-badge">{{ t("settings.workspaceBadge") }}</span>
          </div>
          <div class="setting-row">
            <div>
              <h3>{{ t("settings.sessionsTitle") }}</h3>
              <p>{{ t("settings.sessionsDesc") }}</p>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <h3>{{ t("settings.shortcutsTitle") }}</h3>
              <p>
                {{ t("settings.shortcutSend") }} <kbd>Enter</kbd> ·
                {{ t("settings.shortcutNewline") }} <kbd>Shift + Enter</kbd><br />{{
                  t("settings.shortcutStop")
                }}
                <kbd>Esc</kbd> · {{ t("settings.shortcutFileRef") }} <kbd>@</kbd> ·
                {{ t("settings.shortcutCommands") }} <kbd>/</kbd>
              </p>
            </div>
          </div>
        </TabsContent>
        <TabsContent v-if="isDesktop" value="models" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.providersModelsTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.providersModelsDesc") }}</DialogDescription></DialogHeader
          >
          <p class="text-muted-foreground mb-4 text-xs">{{ t("settings.modelsFileHint") }}</p>
          <h3 class="settings-section">{{ t("settings.providers") }}</h3>
          <ProviderSettings />
          <Separator class="my-6" />
          <h3 class="settings-section">{{ t("settings.models") }}</h3>
          <ModelSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="model-config" class="settings-body">
          <DialogHeader><DialogTitle>{{ t("titleGeneration.page") }}</DialogTitle>
            <DialogDescription>{{ t("titleGeneration.description") }}</DialogDescription></DialogHeader>
          <TitleModelSettings />
        </TabsContent>
        <TabsContent value="packages" class="settings-body">
          <PackageSettings :active="tab === 'packages' && props.open" :project="props.project" />
        </TabsContent>
        <TabsContent value="about" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.aboutTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.aboutDesc") }}</DialogDescription></DialogHeader
          >
          <div class="setting-row">
            <div>
              <h3><PiXLogo /></h3>
              <p>{{ t("settings.aboutBody") }}</p>
            </div>
          </div>
          <p class="text-muted-foreground mt-6 text-xs">
            {{ t("settings.aboutHint") }}
          </p>
        </TabsContent>
        <TabsContent v-if="isDesktop" value="runtime" class="settings-body">
          <DialogHeader>
            <DialogTitle>{{ t("settings.runtimeTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.runtimeDesc") }}</DialogDescription>
          </DialogHeader>

          <div class="flex flex-col gap-3">
            <label for="pi-executable" class="text-sm font-medium">{{
              t("settings.piPath")
            }}</label>
            <Input
              id="pi-executable"
              v-model="piPath"
              :placeholder="t('settings.piPathPlaceholder')"
              class="font-mono text-xs"
            />
            <p class="text-muted-foreground text-xs">
              {{ t("settings.piPathHint", { cmd: ".cmd" }) }}
            </p>

            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                :disabled="detecting"
                @click="detect"
              >
                {{ detecting ? t("settings.detecting") : t("settings.detect") }}
              </Button>
              <span v-if="info" class="text-xs">
                <template v-if="info.found">
                  <span class="text-chart-2 font-medium">{{ t("settings.found") }}</span>
                  <span class="text-muted-foreground">
                    · {{ info.path }}{{ info.version ? ` · ${info.version}` : "" }}</span
                  >
                </template>
                <span v-else class="text-destructive font-medium">{{
                  t("settings.notFound")
                }}</span>
              </span>
            </div>

            <div class="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" type="button" @click="emit('close')">
                {{ t("common.cancel") }}
              </Button>
              <Button size="sm" :disabled="saving" @click="save">
                {{ saving ? t("settings.saving") : t("settings.save") }}
              </Button>
            </div>
          </div>
        </TabsContent>
        </ScrollArea>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
