<script setup lang="ts">
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
import { Separator } from "@/components/ui/separator"
import { detectPi, getConfig, saveConfig, type AppConfig, type PiInfo } from "@/api/piClient"
import ProviderSettings from "./ProviderSettings.vue"
import ModelSettings from "./ModelSettings.vue"
import TitleModelSettings from "./TitleModelSettings.vue"
import { useUiStore } from "@/stores/ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"

import { theme, setTheme, type ThemePreference } from "@/lib/theme"

const props = defineProps<{ open: boolean }>()
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
      <nav class="settings-nav" :aria-label="t('settings.nav')">
        <h2>{{ t("settings.title") }}</h2>
        <button :class="{ active: tab === 'remote' }" @click="tab = 'remote'">
          {{ t("settings.remote") }}
        </button>
        <button :class="{ active: tab === 'general' }" @click="tab = 'general'">
          {{ t("settings.general") }}</button
        ><button v-if="isDesktop" :class="{ active: tab === 'models' }" @click="tab = 'models'">
          {{ t("settings.providersModels") }}</button
        ><button v-if="isDesktop" :class="{ active: tab === 'runtime' }" @click="tab = 'runtime'">
          {{ t("settings.runtime") }}</button
        ><button :class="{ active: tab === 'about' }" @click="tab = 'about'">
          {{ t("settings.about") }}
        </button>
        <button v-if="isDesktop" :class="{ active: tab === 'model-config' }" @click="tab = 'model-config'">
          {{ t("titleGeneration.page") }}
        </button>
        <p>{{ t("settings.subtitle") }}</p>
      </nav>
      <section class="settings-body">
        <template v-if="tab === 'remote'">
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
            <button
              class="rounded-md border px-4 py-2 text-sm"
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
            </button>
            <div v-if="remote.enabled" class="space-y-3 text-sm">
              <p>{{ t("settings.remoteLinks") }}</p>
              <input
                v-for="url in remote.urls"
                :key="url"
                :value="url"
                readonly
                :aria-label="t('settings.remoteLinks')"
                class="w-full rounded border p-2 font-mono text-xs"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <p v-if="!remote.urls.length">{{ t("settings.remoteNoAddress") }}</p>
              <p class="text-muted-foreground">{{ t("settings.remoteFirewall") }}</p>
            </div>
          </template>
          <p v-else class="text-sm">{{ t("settings.remoteDesktopOnly") }}</p>
        </template>
        <template v-else-if="tab === 'general'">
          <DialogHeader
            ><DialogTitle>{{ t("settings.generalTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.generalDesc") }}</DialogDescription></DialogHeader
          >
          <div class="setting-row">
            <div>
              <h3 id="theme-label">{{ t("settings.theme") }}</h3>
              <p id="theme-description">{{ t("settings.themeDesc") }}</p>
            </div>
            <select
              class="border-input bg-background h-8 rounded-md border px-2 text-xs"
              aria-labelledby="theme-label"
              aria-describedby="theme-description"
              :value="theme"
              @change="setTheme(($event.target as HTMLSelectElement).value as ThemePreference)"
            >
              <option value="light">{{ t("settings.themeLight") }}</option>
              <option value="dark">{{ t("settings.themeDark") }}</option>
              <option value="system">{{ t("settings.themeSystem") }}</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <h3>{{ t("settings.language") }}</h3>
              <p>{{ t("settings.languageDesc") }}</p>
            </div>
            <select
              class="border-input bg-background h-8 rounded-md border px-2 text-xs"
              :value="selectedLocale"
              @change="applyLocale(($event.target as HTMLSelectElement).value as Locale)"
            >
              <option v-for="l in LOCALES" :key="l.value" :value="l.value">
                {{ l.label }}
              </option>
            </select>
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
        </template>
        <template v-else-if="tab === 'models'">
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
        </template>
        <template v-else-if="tab === 'model-config'">
          <DialogHeader><DialogTitle>{{ t("titleGeneration.page") }}</DialogTitle>
            <DialogDescription>{{ t("titleGeneration.description") }}</DialogDescription></DialogHeader>
          <TitleModelSettings />
        </template>
        <template v-else-if="tab === 'about'">
          <DialogHeader
            ><DialogTitle>{{ t("settings.aboutTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.aboutDesc") }}</DialogDescription></DialogHeader
          >
          <div class="setting-row">
            <div>
              <h3>Pi X</h3>
              <p>{{ t("settings.aboutBody") }}</p>
            </div>
          </div>
          <p class="text-muted-foreground mt-6 text-xs">
            {{ t("settings.aboutHint") }}
          </p>
        </template>
        <template v-else>
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
              <button
                class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
                :disabled="detecting"
                @click="detect"
              >
                {{ detecting ? t("settings.detecting") : t("settings.detect") }}
              </button>
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
              <button
                class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
                @click="emit('close')"
              >
                {{ t("common.cancel") }}
              </button>
              <button
                class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs"
                :disabled="saving"
                @click="save"
              >
                {{ saving ? t("settings.saving") : t("settings.save") }}
              </button>
            </div>
          </div>
        </template>
      </section>
    </DialogContent>
  </Dialog>
</template>
