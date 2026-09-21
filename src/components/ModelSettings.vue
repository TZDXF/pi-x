<script setup lang="ts">
/** Model management tab: edits each provider's `models` array in pi's models.json. */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Input } from "@/components/ui/input"
import type { ModelEntry } from "@/api/piClient"
import { PROVIDER_API_TYPES, useModelsConfigStore } from "@/stores/modelsConfig"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"

const store = useModelsConfigStore()
const session = useSessionStore()
const ui = useUiStore()
const { t } = useI18n()

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
})

const providerIds = computed(() => Object.keys(store.config.providers ?? {}))
const selectedProvider = ref("")

watch(
  providerIds,
  (ids) => {
    if (!ids.includes(selectedProvider.value)) selectedProvider.value = ids[0] ?? ""
  },
  { immediate: true },
)

const provider = computed(() => store.config.providers[selectedProvider.value])
const models = computed<ModelEntry[]>(() => provider.value?.models ?? [])

interface ModelForm {
  id: string
  name: string
  api: string
  reasoning: boolean
  image: boolean
  contextWindow: string
  maxTokens: string
}

const editing = ref<ModelForm | null>(null)
/** Index into the models array while editing (null = adding). */
const editingIndex = ref<number | null>(null)
const confirmingDelete = ref<number | null>(null)
const busy = ref(false)

function startAdd() {
  editingIndex.value = null
  editing.value = {
    id: "",
    name: "",
    api: "",
    reasoning: false,
    image: true,
    contextWindow: "",
    maxTokens: "",
  }
}

function startEdit(index: number, m: ModelEntry) {
  confirmingDelete.value = null
  editingIndex.value = index
  editing.value = {
    id: m.id,
    name: m.name ?? "",
    api: m.api ?? "",
    reasoning: m.reasoning === true,
    image: (m.input ?? ["text"]).includes("image"),
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
    maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
  }
}

function parseSize(raw: string): number | null {
  const v = raw.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

async function saveForm() {
  const f = editing.value
  if (!f || !provider.value) return
  const id = f.id.trim()
  if (!id) {
    ui.pushToast(t("settings.modelIdRequired"), "error")
    return
  }
  const dup = models.value.some(
    (m, i) => m.id === id && i !== editingIndex.value,
  )
  if (dup) {
    ui.pushToast(t("settings.modelIdExists"), "error")
    return
  }
  busy.value = true
  try {
    // Spread the existing entry so unknown fields (cost, compat, headers,
    // samplingParams, thinkingLevelMap, …) survive the edit.
    const entry: ModelEntry =
      editingIndex.value != null ? { ...models.value[editingIndex.value] } : ({} as ModelEntry)
    entry.id = id
    if (f.name.trim()) entry.name = f.name.trim()
    else delete entry.name
    if (f.api) entry.api = f.api
    else delete entry.api
    entry.reasoning = f.reasoning
    entry.input = f.image ? ["text", "image"] : ["text"]
    const ctx = parseSize(f.contextWindow)
    if (ctx != null) entry.contextWindow = ctx
    else delete entry.contextWindow
    const max = parseSize(f.maxTokens)
    if (max != null) entry.maxTokens = max
    else delete entry.maxTokens

    const list = [...models.value]
    if (editingIndex.value != null) list[editingIndex.value] = entry
    else list.push(entry)
    provider.value.models = list
    await store.persist()
    editing.value = null
    ui.pushToast(t("settings.toastModelsSaved"), "info")
    // pi re-reads models.json when the model picker opens.
    session.refreshModels().catch(() => {})
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}

async function remove(index: number) {
  if (!provider.value) return
  busy.value = true
  try {
    const list = [...models.value]
    list.splice(index, 1)
    provider.value.models = list
    confirmingDelete.value = null
    if (editingIndex.value === index) editing.value = null
    await store.persist()
    ui.pushToast(t("settings.toastModelsSaved"), "info")
    session.refreshModels().catch(() => {})
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!providerIds.length" class="text-muted-foreground py-6 text-sm">
    {{ t("settings.modelNoProviders") }}
  </div>

  <template v-else>
    <label class="mb-1 block text-xs" for="model-provider">{{
      t("settings.modelProvider")
    }}</label>
    <select
      id="model-provider"
      v-model="selectedProvider"
      class="border-input bg-background h-8 rounded-md border px-2 text-xs"
    >
      <option v-for="id in providerIds" :key="id" :value="id">
        {{ store.config.providers[id]?.name || id }}
      </option>
    </select>

    <div v-if="!models.length && !editing" class="text-muted-foreground py-6 text-sm">
      {{ t("settings.modelEmpty") }}
    </div>

    <div
      v-for="(m, i) in models"
      :key="m.id"
      class="setting-row"
      :class="{ 'opacity-60': editing && editingIndex !== i }"
    >
      <div class="min-w-0">
        <h3 class="flex items-center gap-2">
          <span class="truncate font-mono">{{ m.id }}</span>
          <span v-if="m.reasoning" class="setting-badge">{{ t("settings.modelReasoning") }}</span>
          <span v-if="(m.input ?? ['text']).includes('image')" class="setting-badge">{{
            t("settings.modelImage")
          }}</span>
        </h3>
        <p>
          <template v-if="m.name && m.name !== m.id">{{ m.name }} · </template>
          {{ t("settings.modelSize", { ctx: m.contextWindow ?? 128000, max: m.maxTokens ?? 16384 }) }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <template v-if="confirmingDelete === i">
          <span class="text-destructive text-xs">{{ t("settings.modelDeleteConfirm") }}</span>
          <button
            class="border-destructive text-destructive hover:bg-destructive/10 rounded-md border px-2.5 py-1 text-xs"
            :disabled="busy"
            @click="remove(i)"
          >
            {{ t("settings.confirmDelete") }}
          </button>
          <button
            class="border-input hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
            @click="confirmingDelete = null"
          >
            {{ t("common.cancel") }}
          </button>
        </template>
        <template v-else>
          <button
            class="border-input hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
            :disabled="!!editing"
            @click="startEdit(i, m)"
          >
            {{ t("settings.edit") }}
          </button>
          <button
            class="border-input text-destructive hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
            :disabled="!!editing"
            @click="confirmingDelete = i"
          >
            {{ t("settings.delete") }}
          </button>
        </template>
      </div>
    </div>

    <div v-if="editing" class="border-border bg-muted/40 mt-4 space-y-3 rounded-lg border p-4">
      <h3 class="text-sm font-medium">
        {{ editingIndex !== null ? t("settings.modelEdit") : t("settings.modelAdd") }}
      </h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1 block text-xs" for="model-id">{{ t("settings.modelId") }}</label>
          <Input
            id="model-id"
            v-model="editing.id"
            :placeholder="t('settings.modelIdPlaceholder')"
            class="font-mono text-xs"
            :disabled="editingIndex !== null"
          />
        </div>
        <div>
          <label class="mb-1 block text-xs" for="model-name">{{ t("settings.modelName") }}</label>
          <Input id="model-name" v-model="editing.name" class="text-xs" />
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="mb-1 block text-xs" for="model-api">{{ t("settings.modelApi") }}</label>
          <select
            id="model-api"
            v-model="editing.api"
            class="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
          >
            <option value="">{{ t("settings.modelApiInherit") }}</option>
            <option v-for="api in PROVIDER_API_TYPES" :key="api" :value="api">{{ api }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs" for="model-ctx">{{
            t("settings.modelContextWindow")
          }}</label>
          <Input id="model-ctx" v-model="editing.contextWindow" placeholder="128000" class="text-xs" />
        </div>
        <div>
          <label class="mb-1 block text-xs" for="model-max">{{
            t("settings.modelMaxTokens")
          }}</label>
          <Input id="model-max" v-model="editing.maxTokens" placeholder="16384" class="text-xs" />
        </div>
      </div>
      <div class="flex items-center gap-5 text-xs">
        <label class="flex items-center gap-2">
          <input v-model="editing.reasoning" type="checkbox" />
          {{ t("settings.modelReasoning") }}
        </label>
        <label class="flex items-center gap-2">
          <input v-model="editing.image" type="checkbox" />
          {{ t("settings.modelImage") }}
        </label>
      </div>
      <p class="text-muted-foreground text-xs">{{ t("settings.modelSizeHint") }}</p>
      <div class="flex justify-end gap-2 pt-1">
        <button
          class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
          @click="editing = null"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs"
          :disabled="busy"
          @click="saveForm"
        >
          {{ busy ? t("settings.saving") : t("settings.save") }}
        </button>
      </div>
    </div>

    <button
      v-if="!editing"
      class="border-input hover:bg-accent mt-4 rounded-md border px-3 py-1.5 text-xs"
      @click="startAdd"
    >
      + {{ t("settings.modelAdd") }}
    </button>
  </template>
</template>
