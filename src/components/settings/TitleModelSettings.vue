<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, saveConfig, getModelsConfig } from "@/api/piClient"
import { useSessionStore, useUiStore } from "@/stores/conversations"
import ConversationModelSelect from "@/components/ConversationModelSelect.vue"
import { Button } from "@/components/ui/button"

type DefaultMode = "none" | "specific"
type TitleMode = "off" | "default" | "specific"

const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const defaultMode = ref<DefaultMode>("none")
const titleMode = ref<TitleMode>("off")
const provider = ref("")
const modelId = ref("")
const defaultProvider = ref("")
const defaultModelId = ref("")
const translationProvider = ref("")
const translationModelId = ref("")
const loading = ref(true)
const saving = ref(false)
const loadError = ref("")
const customModels = ref<{ provider: string; id: string; name?: string }[]>([])
const models = computed(() => {
  // Keep saved selections visible even when the active conversation offers fewer models.
  const available = session.models.length ? session.models : customModels.value
  const saved = [
    { provider: provider.value, id: modelId.value },
    { provider: defaultProvider.value, id: defaultModelId.value },
  ].filter(
    (model, index, all) =>
      model.provider &&
      model.id &&
      !available.some(item => item.provider === model.provider && item.id === model.id) &&
      all.findIndex(item => item.provider === model.provider && item.id === model.id) === index,
  )
  return saved.length ? [...available, ...saved] : available
})
function splitKey(key: string): [string, string] | null {
  const separator = key.indexOf("/")
  if (separator < 1 || separator === key.length - 1) return null
  return [key.slice(0, separator), key.slice(separator + 1)]
}
const modelKey = computed({
  get: () => (provider.value && modelId.value ? `${provider.value}/${modelId.value}` : ""),
  set: (key: string) => {
    const parts = splitKey(key)
    if (!parts) return
    provider.value = parts[0]
    modelId.value = parts[1]
  },
})
const defaultKey = computed({
  get: () => (defaultProvider.value && defaultModelId.value ? `${defaultProvider.value}/${defaultModelId.value}` : ""),
  set: (key: string) => {
    const parts = splitKey(key)
    if (!parts) return
    defaultMode.value = "specific"
    defaultProvider.value = parts[0]
    defaultModelId.value = parts[1]
  },
})
const translationKey = computed({
  get: () => (translationProvider.value && translationModelId.value ? `${translationProvider.value}/${translationModelId.value}` : ""),
  set: (key: string) => {
    const parts = splitKey(key)
    if (!parts) return
    translationProvider.value = parts[0]
    translationModelId.value = parts[1]
  },
})
const canSave = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !loadError.value &&
    (defaultMode.value !== "specific" || (!!defaultProvider.value.trim() && !!defaultModelId.value.trim())) &&
    (titleMode.value !== "specific" || (!!provider.value.trim() && !!modelId.value.trim())) &&
    (titleMode.value !== "default" || defaultMode.value === "specific"),
)

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    const config = await getConfig()
    titleMode.value = config.titleFollowMain ? "default" : config.titleModel ? "specific" : "off"
    provider.value = config.titleModel?.provider ?? ""
    modelId.value = config.titleModel?.modelId ?? ""
    defaultMode.value = config.defaultModel ? "specific" : "none"
    defaultProvider.value = config.defaultModel?.provider ?? ""
    defaultModelId.value = config.defaultModel?.modelId ?? ""
    translationProvider.value = config.translationModel?.provider ?? ""
    translationModelId.value = config.translationModel?.modelId ?? ""
    try {
      const custom = await getModelsConfig()
      customModels.value = Object.entries(custom.providers ?? {}).flatMap(([provider, entry]) =>
        (entry.models ?? []).map(model => ({ provider, id: model.id, name: model.name })),
      )
    } catch {
      /* Runtime models and saved selections remain available. */
    }
  } catch (error) {
    loadError.value = String(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    const config = await getConfig()
    // Preserve a dedicated selection when switching to the default model.
    const customValid = !!provider.value.trim() && !!modelId.value.trim()
    await saveConfig({
      ...config,
      defaultModel:
        defaultMode.value === "specific"
          ? { provider: defaultProvider.value.trim(), modelId: defaultModelId.value.trim() }
          : undefined,
      titleModel:
        titleMode.value !== "off" && customValid
          ? { provider: provider.value.trim(), modelId: modelId.value.trim() }
          : undefined,
      titleFollowMain: titleMode.value === "default" ? true : undefined,
      translationModel:
        translationProvider.value.trim() && translationModelId.value.trim()
          ? { provider: translationProvider.value.trim(), modelId: translationModelId.value.trim() }
          : undefined,
    })
    ui.pushToast(t("settings.toastSaved"), "info")
  } catch (error) {
    ui.pushToast(String(error), "error")
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="loading" class="text-muted-foreground text-sm">{{ t("titleGeneration.loading") }}</div>
  <div v-else-if="loadError" class="space-y-3" role="alert">
    <p class="text-destructive text-sm">{{ loadError }}</p>
    <Button type="button" variant="outline" @click="load">{{ t("titleGeneration.retry") }}</Button>
  </div>
  <form v-else class="max-w-2xl space-y-6" @submit.prevent="save">
    <fieldset :disabled="saving" class="min-w-0 space-y-6">
      <section class="border-border space-y-3 rounded-lg border p-4">
        <h3 class="text-sm font-medium">{{ t("titleGeneration.defaultModel") }}</h3>
        <p class="text-muted-foreground text-xs">{{ t("titleGeneration.defaultModelHint") }}</p>
        <div class="space-y-2 text-sm">
          <label class="flex cursor-pointer items-center gap-2">
            <input v-model="defaultMode" type="radio" name="default-mode" value="none" class="accent-primary size-4" />
            {{ t("titleGeneration.noDefault") }}
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              v-model="defaultMode"
              type="radio"
              name="default-mode"
              value="specific"
              class="accent-primary size-4"
            />
            {{ t("titleGeneration.chooseModel") }}
          </label>
        </div>
        <div v-if="defaultMode === 'specific'" class="space-y-2 pl-6">
          <label for="default-model" class="block text-xs font-medium">{{ t("titleGeneration.defaultModel") }}</label>
          <ConversationModelSelect
            id="default-model"
            v-model="defaultKey"
            :models="models"
            :disabled="!models.length"
            trigger-class="h-8 w-full text-xs"
          />
          <p v-if="!models.length" class="text-muted-foreground text-xs">{{ t("titleGeneration.noModels") }}</p>
          <p v-else-if="!defaultKey" class="text-destructive text-xs">{{ t("titleGeneration.selectModelHint") }}</p>
        </div>
      </section>

      <section class="border-border space-y-3 rounded-lg border p-4">
        <h3 class="text-sm font-medium">{{ t("titleGeneration.enabled") }}</h3>
        <p class="text-muted-foreground text-xs">{{ t("titleGeneration.hint") }}</p>
        <div class="space-y-3 text-sm">
          <label class="flex cursor-pointer items-center gap-2">
            <input v-model="titleMode" type="radio" name="title-mode" value="off" class="accent-primary size-4" />
            {{ t("titleGeneration.off") }}
          </label>
          <div>
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="titleMode" type="radio" name="title-mode" value="default" class="accent-primary size-4" />
              {{ t("titleGeneration.followMain") }}
            </label>
            <p v-if="titleMode === 'default' && defaultMode === 'none'" class="text-destructive mt-1 pl-6 text-xs">
              {{ t("titleGeneration.followMainHint") }}
            </p>
          </div>
          <div>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="titleMode"
                type="radio"
                name="title-mode"
                value="specific"
                class="accent-primary size-4"
              />
              {{ t("titleGeneration.specificModel") }}
            </label>
            <div v-if="titleMode === 'specific'" class="space-y-2 pt-2 pl-6">
              <label for="title-model" class="block text-xs font-medium">{{ t("titleGeneration.model") }}</label>
              <ConversationModelSelect
                id="title-model"
                v-model="modelKey"
                :models="models"
                :disabled="!models.length"
                trigger-class="h-8 w-full text-xs"
              />
              <p v-if="!models.length" class="text-muted-foreground text-xs">{{ t("titleGeneration.noModels") }}</p>
              <p v-else-if="!modelKey" class="text-destructive text-xs">{{ t("titleGeneration.selectModelHint") }}</p>
              <p class="text-muted-foreground text-xs">{{ t("titleGeneration.credentials") }}</p>
            </div>
          </div>
        </div>
            </section>

      <section class="space-y-3 rounded-lg border border-border p-4">
        <h3 class="text-sm font-medium">{{ t("translation.model") }}</h3>
        <p class="text-muted-foreground text-xs">{{ t("translation.modelHint") }}</p>
        <div class="space-y-2">
          <ConversationModelSelect
            id="translation-model"
            v-model="translationKey"
            :models="models"
            :disabled="!models.length"
            trigger-class="h-8 w-full text-xs"
          />
          <p v-if="!models.length" class="text-muted-foreground text-xs">{{ t("titleGeneration.noModels") }}</p>
        </div></section>
      <Button type="submit" :disabled="!canSave">{{ saving ? t("settings.saving") : t("settings.save") }}</Button>
    </fieldset>
  </form>
</template>
