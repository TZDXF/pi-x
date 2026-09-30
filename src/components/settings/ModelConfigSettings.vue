<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, saveConfig, getModelsConfig } from "@/api/piClient"
import { useSessionStore, useUiStore } from "@/stores/conversations"
import ConversationModelSelect from "@/components/ConversationModelSelect.vue"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"

const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const defaultKey = ref("")
const titleChoice = ref("off")
const translationChoice = ref("default")
const loading = ref(true)
const saving = ref(false)
const loadError = ref("")
const customModels = ref<{ provider: string; id: string; name?: string }[]>([])
const models = computed(() => {
  // Keep saved selections visible even when the active conversation offers fewer models.
  const available = session.models.length ? session.models : customModels.value
  const saved: { provider: string; id: string; name?: string }[] = []
  for (const key of [defaultKey.value, modelChoiceKey(titleChoice.value), modelChoiceKey(translationChoice.value)]) {
    const parts = key ? splitKey(key) : null
    if (!parts) continue
    if (available.some(item => item.provider === parts[0] && item.id === parts[1])) continue
    if (saved.some(item => item.provider === parts[0] && item.id === parts[1])) continue
    saved.push({ provider: parts[0], id: parts[1] })
  }
  return saved.length ? [...available, ...saved] : available
})
const modelGroups = computed(() => {
  const grouped = new Map<string, typeof models.value>()
  for (const model of models.value) {
    const list = grouped.get(model.provider) ?? []
    list.push(model)
    grouped.set(model.provider, list)
  }
  return [...grouped.entries()].map(([provider, models]) => ({ provider, models }))
})
function splitKey(key: string): [string, string] | null {
  const separator = key.indexOf("/")
  if (separator < 1 || separator === key.length - 1) return null
  return [key.slice(0, separator), key.slice(separator + 1)]
}
function parseKey(key: string) {
  const parts = splitKey(key)
  return parts ? { provider: parts[0], modelId: parts[1] } : undefined
}
function joinKey(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}
function joinRef(model: { provider: string; modelId: string }) {
  return `${model.provider}/${model.modelId}`
}
// "off" and "default" are reserved choices; anything else is a provider/model key.
function modelChoiceKey(choice: string) {
  return choice.includes("/") ? choice : ""
}
// Without a saved selection the first available model acts as the default.
const effectiveDefaultKey = computed(() => defaultKey.value || (models.value[0] ? joinKey(models.value[0]) : ""))
function choiceLabel(choice: string) {
  if (choice === "off") return t("titleGeneration.off")
  if (choice !== "default" && choice !== "") {
    const model = models.value.find(item => joinKey(item) === choice)
    if (model) return `${model.provider} / ${model.name || model.id}`
    return choice
  }
  return t("titleGeneration.useDefaultModel")
}
const titleChoiceLabel = computed(() => choiceLabel(titleChoice.value))
const translationChoiceLabel = computed(() => choiceLabel(translationChoice.value))
const canSave = computed(() => !loading.value && !saving.value && !loadError.value && !!effectiveDefaultKey.value)

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    const config = await getConfig()
    defaultKey.value = config.defaultModel ? joinRef(config.defaultModel) : ""
    titleChoice.value = config.titleFollowMain ? "default" : config.titleModel ? joinRef(config.titleModel) : "off"
    translationChoice.value = config.translationModel ? joinRef(config.translationModel) : "default"
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
  const defaultModel = parseKey(effectiveDefaultKey.value)
  if (!defaultModel) return
  saving.value = true
  try {
    const config = await getConfig()
    await saveConfig({
      ...config,
      defaultModel,
      titleModel: modelChoiceKey(titleChoice.value) ? parseKey(titleChoice.value) : undefined,
      titleFollowMain: titleChoice.value === "default" ? true : undefined,
      translationModel: modelChoiceKey(translationChoice.value) ? parseKey(translationChoice.value) : undefined,
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
        <ConversationModelSelect
          id="default-model"
          :model-value="effectiveDefaultKey"
          :models="models"
          :disabled="!models.length"
          trigger-class="h-8 w-full text-xs"
          @update:model-value="defaultKey = $event"
        />
        <p v-if="!models.length" class="text-muted-foreground text-xs">{{ t("titleGeneration.noModels") }}</p>
      </section>

      <section class="border-border space-y-3 rounded-lg border p-4">
        <h3 class="text-sm font-medium">{{ t("titleGeneration.enabled") }}</h3>
        <p class="text-muted-foreground text-xs">{{ t("titleGeneration.hint") }}</p>
        <Select
          :model-value="titleChoice"
          @update:model-value="
            value => {
              if (typeof value === 'string') titleChoice = value
            }
          "
        >
          <SelectTrigger id="title-model" class="h-8 w-full text-xs">
            <SelectValue>{{ titleChoiceLabel }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off" class="text-xs">{{ t("titleGeneration.off") }}</SelectItem>
            <SelectItem value="default" class="text-xs">{{ t("titleGeneration.useDefaultModel") }}</SelectItem>
            <SelectGroup v-for="group in modelGroups" :key="group.provider">
              <SelectLabel>{{ group.provider }}</SelectLabel>
              <SelectItem
                v-for="model in group.models"
                :key="model.provider + '/' + model.id"
                :value="model.provider + '/' + model.id"
                class="text-xs"
              >
                {{ model.name || model.id }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p class="text-muted-foreground text-xs">{{ t("titleGeneration.credentials") }}</p>
      </section>

      <section class="border-border space-y-3 rounded-lg border p-4">
        <h3 class="text-sm font-medium">{{ t("translation.model") }}</h3>
        <p class="text-muted-foreground text-xs">{{ t("translation.modelHint") }}</p>
        <Select
          :model-value="translationChoice"
          @update:model-value="
            value => {
              if (typeof value === 'string') translationChoice = value
            }
          "
        >
          <SelectTrigger id="translation-model" class="h-8 w-full text-xs">
            <SelectValue>{{ translationChoiceLabel }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default" class="text-xs">{{ t("titleGeneration.useDefaultModel") }}</SelectItem>
            <SelectGroup v-for="group in modelGroups" :key="group.provider">
              <SelectLabel>{{ group.provider }}</SelectLabel>
              <SelectItem
                v-for="model in group.models"
                :key="model.provider + '/' + model.id"
                :value="model.provider + '/' + model.id"
                class="text-xs"
              >
                {{ model.name || model.id }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p v-if="!models.length" class="text-muted-foreground text-xs">{{ t("titleGeneration.noModels") }}</p>
      </section>
      <Button type="submit" :disabled="!canSave">{{ saving ? t("settings.saving") : t("settings.save") }}</Button>
    </fieldset>
  </form>
</template>
