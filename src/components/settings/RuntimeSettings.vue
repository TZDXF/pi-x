<script setup lang="ts">
/** Runtime page: locate the pi executable and persist the configured path. */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { detectPi, getConfig, saveConfig, type AppConfig, type PiInfo } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const ui = useUiStore()

const piPath = ref("")
const info = ref<PiInfo | null>(null)
const detecting = ref(false)
const saving = ref(false)

onMounted(async () => {
  try {
    const c: AppConfig = await getConfig()
    piPath.value = c.piPath ?? ""
  } catch {
    piPath.value = ""
  }
})

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
</template>
