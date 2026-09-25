<script setup lang="ts">
import SettingRow from '@/components/shared/SettingRow.vue'
import SettingHeading from '@/components/shared/SettingHeading.vue'
import SettingDescription from '@/components/shared/SettingDescription.vue'
/** About page and desktop-only Pi self-update controls. */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { ask } from "@tauri-apps/plugin-dialog"
import PiXLogo from "@/components/PiXLogo.vue"
import { isDesktop } from "@/api/transport"
import { checkPiUpdate, detectPi, executePiUpdate, type PiUpdateStatus } from "@/api/piClient"
import { Button } from "@/components/ui/button"

const { t } = useI18n()
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
    error.value = String(e)
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
    try { currentVersion.value = (await detectPi()).version } catch { /* Check again manually if probing fails. */ }
  } catch (e) {
    error.value = String(e)
  } finally {
    updating.value = false
  }
}

onMounted(() => { if (isDesktop) void check() })
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading><PiXLogo /></SettingHeading>
      <SettingDescription>{{ t("settings.aboutBody") }}</SettingDescription>
    </div>
  </SettingRow>
  <SettingRow as="section" v-if="isDesktop" aria-labelledby="pi-update-title">
    <div class="min-w-0">
      <SettingHeading id="pi-update-title">{{ t("piUpdate.title") }}</SettingHeading>
      <SettingDescription v-if="currentVersion" aria-live="polite">
        {{ t("piUpdate.current") }} <span class="font-mono text-foreground">{{ currentVersion }}</span>
        <template v-if="status?.updateAvailable">
          <span aria-hidden="true"> → </span><span class="sr-only">{{ t("piUpdate.latest") }}</span><span class="font-mono text-foreground">{{ status.latestVersion }}</span>
        </template>
        <span v-else-if="status"> · {{ t("piUpdate.upToDate") }}</span>
      </SettingDescription>
      <SettingDescription v-if="updated" role="status">{{ t("piUpdate.completed") }}</SettingDescription>
      <SettingDescription v-if="error" role="alert" class="break-words !text-destructive">{{ error }}</SettingDescription>
    </div>
    <div class="flex shrink-0 flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="checking || updating" :aria-label="checking ? t('piUpdate.checking') : undefined" @click="check">
        <span v-if="checking" class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
        {{ t("piUpdate.check") }}
      </Button>
      <Button v-if="status?.updateAvailable" size="sm" :disabled="checking || updating" :aria-label="updating ? t('piUpdate.updating') : undefined" @click="update">
        <span v-if="updating" class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
        {{ t("piUpdate.update") }}
      </Button>
    </div>
  </SettingRow>
  <p v-if="isDesktop" class="text-muted-foreground mt-5 text-xs">{{ t("settings.dataDirectory") }}: ~/.pix</p>
</template>
