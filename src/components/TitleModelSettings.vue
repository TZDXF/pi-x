<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, saveConfig, getModelsConfig } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import ConversationModelSelect from "./ConversationModelSelect.vue"
const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const enabled = ref(false)
const provider = ref("")
const modelId = ref("")
const loading = ref(true)
const saving = ref(false)
const loadError = ref(false)
const customModels = ref<{ provider: string; id: string; name?: string }[]>([])
const models = computed(() => {
  // Use exactly the conversation list when pi is running; custom models remain
  // selectable from settings before opening a project.
  const available = session.models.length ? session.models : customModels.value
  if (provider.value && modelId.value && !available.some(m => m.provider === provider.value && m.id === modelId.value)) {
    return [...available, { provider: provider.value, id: modelId.value }]
  }
  return available
})
const modelKey = computed({
  get: () => provider.value && modelId.value ? `${provider.value}/${modelId.value}` : "",
  set: (key: string) => {
    const separator = key.indexOf("/")
    if (separator < 1) return
    provider.value = key.slice(0, separator)
    modelId.value = key.slice(separator + 1)
  },
})
onMounted(async () => {
  try {
    const config = await getConfig()
    enabled.value = !!config.titleModel
    provider.value = config.titleModel?.provider ?? ""
    modelId.value = config.titleModel?.modelId ?? ""
    try {
      const custom = await getModelsConfig()
      customModels.value = Object.entries(custom.providers).flatMap(([provider, entry]) => (entry.models ?? []).map(m => ({ provider, id: m.id, name: m.name })))
    } catch { /* Runtime models and the saved selection remain available. */ }
  } catch (e) { loadError.value = true; ui.pushToast(String(e), "error") }
  finally { loading.value = false }
})
async function save() {
  if (saving.value || loadError.value || (enabled.value && (!provider.value.trim() || !modelId.value.trim()))) return
  saving.value = true
  try {
    const config = await getConfig()
    await saveConfig({ ...config, titleModel: enabled.value ? { provider: provider.value.trim(), modelId: modelId.value.trim() } : undefined })
    ui.pushToast(t("settings.toastSaved"), "info")
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { saving.value = false }
}
</script>
<template>
  <form class="space-y-4" @submit.prevent="save">
    <fieldset :disabled="loading || saving || loadError" class="space-y-4">
      <label class="flex items-center gap-2 text-sm"><input v-model="enabled" type="checkbox" />{{ t('titleGeneration.enabled') }}</label>
      <p class="text-muted-foreground text-xs">{{ t('titleGeneration.hint') }}</p>
      <template v-if="enabled">
        <div>
          <label for="title-model" class="mb-1 block text-sm">{{ t('titleGeneration.model') }}</label>
          <ConversationModelSelect id="title-model" v-model="modelKey" :models="models"
            :disabled="loading || saving || loadError || !models.length" trigger-class="h-8 w-full text-xs" />
          <p v-if="!loading && !models.length" class="text-muted-foreground mt-2 text-xs">{{ t('titleGeneration.noModels') }}</p>
        </div>
        <p class="text-muted-foreground text-xs">{{ t('titleGeneration.credentials') }}</p>
      </template>
      <button class="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs" type="submit" :disabled="enabled && (!provider.trim() || !modelId.trim())">{{ saving ? t('settings.saving') : t('settings.save') }}</button>
    </fieldset>
  </form>
</template>
