<script setup lang="ts">
/** Model list for one provider: edits its `models` array in pi's models.json. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Check, ChevronDown, GripVertical, Pencil, RefreshCw, Trash2 } from "@lucide/vue"
import { VueDraggable } from "vue-draggable-plus"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetchProviderModels, type FetchedModel, type ModelEntry } from "@/api/piClient"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { PROVIDER_API_TYPES, useModelsConfigStore } from "@/stores/modelsConfig"
import { useSessionStore } from "@/stores/conversations"
import { useUiStore } from "@/stores/conversations"

const props = defineProps<{ /** Provider key whose models are managed here. */ providerId: string }>()

const store = useModelsConfigStore()
const session = useSessionStore()
const ui = useUiStore()
const { t } = useI18n()

const provider = computed(() => store.config.providers[props.providerId])
const models = computed<ModelEntry[]>({
  get: () => provider.value?.models ?? [],
  set: list => { if (provider.value) provider.value.models = list },
})

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
let dragSnapshot: ModelEntry[] | null = null

/** Models discovered via the provider "/models" endpoint (null = not fetched yet). */
const fetched = ref<FetchedModel[] | null>(null)
const fetching = ref(false)
const fetchError = ref<string | null>(null)
const existingIds = computed(() => new Set(models.value.map(m => m.id)))
const fetchOpen = ref(false)
const fetchQuery = ref("")
/** Fetched models filtered by the in-popover search box. */
const filteredFetched = computed(() => {
  const list = fetched.value
  if (!list) return []
  const q = fetchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    m => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
  )
})

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
function formatSize(value: number | undefined, fallback: number) {
  return compactNumber.format(value ?? fallback)
}

/** Reset transient state when switching providers. */
watch(
  () => props.providerId,
  () => {
    editing.value = null
    editingIndex.value = null
    confirmingDelete.value = null
    dragSnapshot = null
    fetched.value = null
    fetching.value = false
    fetchError.value = null
    fetchOpen.value = false
    fetchQuery.value = ""
  },
)

/** reka Select forbids empty item values: "inherit" is mapped to an empty api. */
const API_INHERIT = "__inherit__"
const apiValue = computed({
  get: () => (editing.value?.api ? editing.value.api : API_INHERIT),
  set: (v: string) => {
    if (editing.value) editing.value.api = v === API_INHERIT ? "" : v
  },
})

/** Load the provider-advertised model list (once unless forced). */
async function loadRemoteModels(force = false) {
  const p = provider.value
  if (!p || fetching.value) return
  if (!force && fetched.value !== null) return
  if (!p.baseUrl?.trim()) {
    fetched.value = null
    fetchError.value = t("settings.modelFetchNoBaseUrl")
    return
  }
  fetching.value = true
  fetchError.value = null
  try {
    fetched.value = await fetchProviderModels(p)
  } catch (e) {
    fetched.value = null
    fetchError.value = String(e)
  } finally {
    fetching.value = false
  }
}

/** Opening the picker resets the search box and loads the list once. */
watch(fetchOpen, open => {
  if (!open) return
  fetchQuery.value = ""
  loadRemoteModels()
})

/** Fill the form from a discovered model and close the picker. */
function pickFetched(m: FetchedModel) {
  if (editing.value) {
    editing.value.id = m.id
    editing.value.name = m.name ?? ""
  }
  fetchOpen.value = false
}

function startAdd() {
  confirmingDelete.value = null
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
    else if (editingIndex.value !== null && editingIndex.value > index) editingIndex.value--
    await store.persist()
    ui.pushToast(t("settings.toastModelsSaved"), "info")
    session.refreshModels().catch(() => {})
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}

function startDrag() {
  dragSnapshot = [...models.value]
}

async function finishDrag() {
  const original = dragSnapshot
  dragSnapshot = null
  if (!original || original.every((item, i) => item === models.value[i])) return
  busy.value = true
  try {
    await store.persist()
    session.refreshModels().catch(() => {})
  } catch (e) {
    models.value = original
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!provider" class="text-muted-foreground py-6 text-sm">
    {{ t("settings.modelNoProviders") }}
  </div>

  <template v-else>
    <div v-if="!models.length && !editing" class="text-muted-foreground py-6 text-sm">
      {{ t("settings.modelEmpty") }}
    </div>

    <VueDraggable
      v-model="models"
      handle=".drag-handle"
      :animation="150"
      :disabled="busy || !!editing"
      @start="startDrag"
      @end="finishDrag"
    >
    <div v-for="(m, i) in models" :key="m.id" class="model-item group">
      <div class="model-item-summary">
        <span
          class="drag-handle"
          :title="t('settings.dragToReorder')"
          :aria-label="t('settings.dragToReorder')"
        ><GripVertical :size="14" /></span>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-mono text-xs font-medium" :title="m.id">{{ m.name || m.id }}</span>
            <span v-if="m.reasoning" class="setting-badge shrink-0">{{ t("settings.modelReasoning") }}</span>
            <span v-if="(m.input ?? ['text']).includes('image')" class="setting-badge shrink-0">{{ t("settings.modelImage") }}</span>
          </div>
          <p
            class="text-muted-foreground truncate text-[11px]"
            :title="t('settings.modelSize', { ctx: (m.contextWindow ?? 128000).toLocaleString(), max: (m.maxTokens ?? 16384).toLocaleString() })"
          >
            <template v-if="m.name && m.name !== m.id">{{ m.id }} · </template>
            {{ t("settings.modelSize", { ctx: formatSize(m.contextWindow, 128000), max: formatSize(m.maxTokens, 16384) }) }}
          </p>
        </div>
        <div v-if="confirmingDelete === i" class="flex shrink-0 items-center gap-1">
          <span class="text-destructive text-xs">{{ t("settings.modelDeleteConfirm") }}</span>
          <Button variant="destructive" size="sm" :disabled="busy" @click="remove(i)">{{ t("settings.confirmDelete") }}</Button>
          <Button variant="ghost" size="sm" @click="confirmingDelete = null">{{ t("common.cancel") }}</Button>
        </div>
        <div v-else class="model-item-actions flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" :aria-label="t('settings.edit')" :title="t('settings.edit')" :disabled="busy" @click="startEdit(i, m)"><Pencil :size="14" /></Button>
          <Button variant="ghost" size="icon-xs" class="text-destructive" :aria-label="t('settings.delete')" :title="t('settings.delete')" :disabled="busy" @click="confirmingDelete = i"><Trash2 :size="14" /></Button>
        </div>
      </div>
      <div v-if="editing && editingIndex === i" class="border-border bg-muted/40 space-y-3 border-t p-4">
        <h3 class="text-sm font-medium">{{ t("settings.modelEdit") }}</h3>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1 block text-xs" for="model-id">{{ t("settings.modelId") }}</label>
            <div class="flex items-center gap-1">
              <Input
                id="model-id"
                v-model="editing.id"

                class="font-mono text-xs"
                :disabled="editingIndex !== null"
              />
              <Popover v-if="editingIndex === null" v-model:open="fetchOpen">
                <PopoverTrigger as-child>
                  <Button
                    variant="outline"
                    size="icon"
                    class="shrink-0"
                    :title="t('settings.modelFetchHint')"
                    :aria-label="t('settings.modelFetch')"
                  >
                    <RefreshCw v-if="fetching" :size="14" class="animate-spin" />
                    <ChevronDown v-else :size="14" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" class="w-80 p-2">
                  <div class="mb-2 flex items-center gap-1">
                    <Input
                      v-model="fetchQuery"
                      :placeholder="t('settings.modelFetchSearch')"
                      class="h-7 text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="shrink-0"
                      :disabled="fetching"
                      :title="t('settings.modelFetchRefresh')"
                      :aria-label="t('settings.modelFetchRefresh')"
                      @click="loadRemoteModels(true)"
                    >
                      <RefreshCw :size="14" :class="{ 'animate-spin': fetching }" />
                    </Button>
                  </div>
                  <div v-if="fetching" class="text-muted-foreground px-2 py-3 text-xs">
                    {{ t("settings.modelFetching") }}
                  </div>
                  <div v-else-if="fetchError" class="text-destructive break-all px-2 py-3 text-xs">
                    {{ fetchError }}
                  </div>
                  <div v-else-if="fetched && !filteredFetched.length" class="text-muted-foreground px-2 py-3 text-xs">
                    {{ fetched.length ? t("settings.modelFetchNoMatch") : t("settings.modelFetchEmpty") }}
                  </div>
                  <ScrollArea v-else-if="fetched" viewport-class="max-h-60">
                    <button
                      v-for="m in filteredFetched"
                      :key="m.id"
                      type="button"
                      :disabled="existingIds.has(m.id)"
                      :title="m.id"
                      class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-50"
                      @click="pickFetched(m)"
                    >
                      <Check v-if="existingIds.has(m.id)" :size="14" class="shrink-0" />
                      <span class="min-w-0">
                        <span class="block truncate font-mono text-xs">{{ m.id }}</span>
                        <span v-if="m.name && m.name !== m.id" class="text-muted-foreground block truncate text-[11px]">{{ m.name }}</span>
                      </span>
                    </button>
                  </ScrollArea>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div>
            <label class="mb-1 block text-xs" for="model-name">{{ t("settings.modelName") }}</label>
            <Input id="model-name" v-model="editing.name" class="text-xs" />
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class="mb-1 block text-xs" for="model-api">{{ t("settings.modelApi") }}</label>
            <Select v-model="apiValue">
              <SelectTrigger id="model-api" class="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="API_INHERIT">{{ t("settings.modelApiInherit") }}</SelectItem>
                <SelectItem v-for="api in PROVIDER_API_TYPES" :key="api" :value="api">{{ api }}</SelectItem>
              </SelectContent>
            </Select>
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
            <Checkbox v-model="editing.reasoning" />
            {{ t("settings.modelReasoning") }}
          </label>
          <label class="flex items-center gap-2">
            <Checkbox v-model="editing.image" />
            {{ t("settings.modelImage") }}
          </label>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" type="button" @click="editing = null">
            {{ t("common.cancel") }}
          </Button>
          <Button size="sm" :disabled="busy" @click="saveForm">
            {{ busy ? t("settings.saving") : t("settings.save") }}
          </Button>
        </div>
      </div>
    </div>
    </VueDraggable>

    <div v-if="editing && editingIndex === null" class="border-border bg-muted/40 mt-2 space-y-3 rounded-lg border p-4">
      <h3 class="text-sm font-medium">{{ t("settings.modelAdd") }}</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1 block text-xs" for="model-id">{{ t("settings.modelId") }}</label>
          <div class="flex items-center gap-1">
            <Input
              id="model-id"
              v-model="editing.id"

              class="font-mono text-xs"
              :disabled="editingIndex !== null"
            />
            <Popover v-if="editingIndex === null" v-model:open="fetchOpen">
              <PopoverTrigger as-child>
                <Button
                  variant="outline"
                  size="icon"
                  class="shrink-0"
                  :title="t('settings.modelFetchHint')"
                  :aria-label="t('settings.modelFetch')"
                >
                  <RefreshCw v-if="fetching" :size="14" class="animate-spin" />
                  <ChevronDown v-else :size="14" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-80 p-2">
                <div class="mb-2 flex items-center gap-1">
                  <Input
                    v-model="fetchQuery"
                    :placeholder="t('settings.modelFetchSearch')"
                    class="h-7 text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="shrink-0"
                    :disabled="fetching"
                    :title="t('settings.modelFetchRefresh')"
                    :aria-label="t('settings.modelFetchRefresh')"
                    @click="loadRemoteModels(true)"
                  >
                    <RefreshCw :size="14" :class="{ 'animate-spin': fetching }" />
                  </Button>
                </div>
                <div v-if="fetching" class="text-muted-foreground px-2 py-3 text-xs">
                  {{ t("settings.modelFetching") }}
                </div>
                <div v-else-if="fetchError" class="text-destructive break-all px-2 py-3 text-xs">
                  {{ fetchError }}
                </div>
                <div v-else-if="fetched && !filteredFetched.length" class="text-muted-foreground px-2 py-3 text-xs">
                  {{ fetched.length ? t("settings.modelFetchNoMatch") : t("settings.modelFetchEmpty") }}
                </div>
                <ScrollArea v-else-if="fetched" viewport-class="max-h-60">
                  <button
                    v-for="m in filteredFetched"
                    :key="m.id"
                    type="button"
                    :disabled="existingIds.has(m.id)"
                    :title="m.id"
                    class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-50"
                    @click="pickFetched(m)"
                  >
                    <Check v-if="existingIds.has(m.id)" :size="14" class="shrink-0" />
                    <span class="min-w-0">
                      <span class="block truncate font-mono text-xs">{{ m.id }}</span>
                      <span v-if="m.name && m.name !== m.id" class="text-muted-foreground block truncate text-[11px]">{{ m.name }}</span>
                    </span>
                  </button>
                </ScrollArea>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div>
          <label class="mb-1 block text-xs" for="model-name">{{ t("settings.modelName") }}</label>
          <Input id="model-name" v-model="editing.name" class="text-xs" />
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="mb-1 block text-xs" for="model-api">{{ t("settings.modelApi") }}</label>
          <Select v-model="apiValue">
            <SelectTrigger id="model-api" class="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="API_INHERIT">{{ t("settings.modelApiInherit") }}</SelectItem>
              <SelectItem v-for="api in PROVIDER_API_TYPES" :key="api" :value="api">{{ api }}</SelectItem>
            </SelectContent>
          </Select>
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
          <Checkbox v-model="editing.reasoning" />
          {{ t("settings.modelReasoning") }}
        </label>
        <label class="flex items-center gap-2">
          <Checkbox v-model="editing.image" />
          {{ t("settings.modelImage") }}
        </label>
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" type="button" @click="editing = null">
          {{ t("common.cancel") }}
        </Button>
        <Button size="sm" :disabled="busy" @click="saveForm">
          {{ busy ? t("settings.saving") : t("settings.save") }}
        </Button>
      </div>
    </div>

    <Button
      v-if="!editing"
      variant="outline"
      size="sm"
      class="mt-3"
      @click="startAdd"
    >
      + {{ t("settings.modelAdd") }}
    </Button>
  </template>
</template>
