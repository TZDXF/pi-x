<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getPiSettings, savePiSettings, type PiSettings } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseUpdateCommand } from "@/lib/piPreferences"

const { t } = useI18n()
const ui = useUiStore()
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const saved = ref<PiSettings | null>(null)
const command = ref("")
const collapse = ref(false)
const destination = ref<"auto" | "gist" | "radius">("auto")
const initialCommand = computed(() =>
  saved.value?.selfUpdateCommand ? JSON.stringify(saved.value.selfUpdateCommand) : "",
)
const dirty = computed(
  () =>
    saved.value &&
    (command.value !== initialCommand.value ||
      collapse.value !== (saved.value.collapseChangelog ?? false) ||
      destination.value !== (saved.value.sessionShareDestination ?? "auto")),
)

async function load() {
  loading.value = true
  error.value = ""
  try {
    saved.value = await getPiSettings()
    command.value = initialCommand.value
    collapse.value = saved.value.collapseChangelog ?? false
    destination.value = saved.value.sessionShareDestination ?? "auto"
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!saved.value || saving.value || !dirty.value) return
  const patch: Partial<Pick<PiSettings, "selfUpdateCommand" | "collapseChangelog" | "sessionShareDestination">> = {}
  if (command.value !== initialCommand.value) {
    const parsed = parseUpdateCommand(command.value)
    if (!parsed.ok) {
      ui.pushToast(t("piPreferences.invalidCommand"), "error")
      return
    }
    patch.selfUpdateCommand = parsed.argv
  }
  if (collapse.value !== (saved.value.collapseChangelog ?? false)) patch.collapseChangelog = collapse.value
  if (destination.value !== (saved.value.sessionShareDestination ?? "auto"))
    patch.sessionShareDestination = destination.value
  saving.value = true
  try {
    await savePiSettings(patch)
    saved.value = { ...saved.value, ...patch }
    command.value = initialCommand.value
    ui.pushToast(t("piPreferences.saved"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset v-else :disabled="saving" class="min-w-0 space-y-5">
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="pi-share-destination-label">{{ t("piPreferences.shareDestination") }}</SettingHeading>
        <SettingDescription>{{ t("piPreferences.shareDestinationDesc") }}</SettingDescription>
      </div>
      <Select v-model="destination" :disabled="saved?.sessionShareDestination == null">
        <SelectTrigger class="h-8 w-44 text-xs" aria-labelledby="pi-share-destination-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{{ t("piPreferences.shareAuto") }}</SelectItem>
          <SelectItem value="gist">GitHub Gist</SelectItem>
          <SelectItem value="radius">Radius</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="pi-collapse-changelog-label">{{ t("piPreferences.collapseChangelog") }}</SettingHeading>
        <SettingDescription>{{ t("piPreferences.collapseChangelogDesc") }}</SettingDescription>
      </div>
      <Switch v-model="collapse" aria-labelledby="pi-collapse-changelog-label" />
    </SettingRow>
    <div class="space-y-2">
      <SettingHeading id="pi-update-command-label">{{ t("piPreferences.updateCommand") }}</SettingHeading>
      <SettingDescription id="pi-update-command-desc">{{ t("piPreferences.updateCommandDesc") }}</SettingDescription>
      <p v-pre class="text-xs text-muted-foreground">
        <code>{packageName}</code> · <code>{version}</code> · <code>{installSpec}</code>
      </p>
      <Textarea
        v-model="command"
        class="min-h-20 font-mono text-xs"
        :disabled="!saved?.selfUpdateCommandSupported"
        :placeholder="JSON.stringify(['npm', 'install', '-g', '{installSpec}'])"
        aria-labelledby="pi-update-command-label"
        aria-describedby="pi-update-command-desc"
        spellcheck="false"
      />
      <p v-if="!saved?.selfUpdateCommandSupported" class="text-xs text-muted-foreground">
        {{ t("piPreferences.requires15") }}
      </p>
      <p v-if="saved?.selfUpdateCommandOverridden" role="status" class="text-xs text-amber-600 dark:text-amber-400">
        {{ t("piPreferences.commandOverridden") }}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Button :disabled="!dirty || saving" @click="save">{{
        t(saving ? "agentConfig.saving" : "agentConfig.save")
      }}</Button>
      <span class="text-xs text-muted-foreground">{{ t("piPreferences.hint") }}</span>
    </div>
  </fieldset>
</template>
