<script setup lang="ts">
import DragHandle from '@/components/shared/DragHandle.vue'
import SettingBadge from '@/components/shared/SettingBadge.vue'
/** Model list for one provider: edits its `models` array in pi's models.json.
 *  The add/edit panel lives in ModelEditForm.vue. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { GripVertical, Pencil, Trash2 } from "@lucide/vue"
import { VueDraggable } from "vue-draggable-plus"
import { Button } from "@/components/ui/button"
import type { ModelEntry } from "@/api/piClient"
import { useModelsConfigStore } from "@/stores/modelsConfig"
import { useSessionStore, useUiStore } from "@/stores/conversations"
import ModelEditForm from "./ModelEditForm.vue"
import {
  emptyModelForm,
  modelEntryFromForm,
  modelFormFromEntry,
  type ModelForm,
} from "./modelForm"

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

const editing = ref<ModelForm | null>(null)
/** Index into the models array while editing (null = adding). */
const editingIndex = ref<number | null>(null)
const confirmingDelete = ref<number | null>(null)
const busy = ref(false)
let dragSnapshot: ModelEntry[] | null = null

const existingIds = computed(() => new Set(models.value.map(m => m.id)))

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
  },
)

function startAdd() {
  confirmingDelete.value = null
  editingIndex.value = null
  editing.value = emptyModelForm()
}

function startEdit(index: number, m: ModelEntry) {
  confirmingDelete.value = null
  editingIndex.value = index
  editing.value = modelFormFromEntry(m)
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
    const entry = modelEntryFromForm(f, id)
    const list = [...models.value]
    if (editingIndex.value != null) list[editingIndex.value] = entry
    else list.push(entry)
    provider.value.models = list
    const previous = provider.value.models
    try {
      await store.persist()
    } catch (error) {
      provider.value.models = previous
      throw error
    }
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
    <div v-for="(m, i) in models" :key="m.id" class="model-item group min-w-0 border-b border-border hover:bg-muted focus-within:bg-muted">
      <div class="model-item-summary flex items-center gap-[7px] min-w-0 py-1.5 px-1">
        <DragHandle

          :title="t('settings.dragToReorder')"
          :aria-label="t('settings.dragToReorder')"
        ><GripVertical :size="14" /></DragHandle>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-mono text-xs font-medium" :title="m.id">{{ m.name || m.id }}</span>
            <SettingBadge v-if="m.reasoning" class="shrink-0">{{ t("settings.modelReasoning") }}</SettingBadge>
            <SettingBadge v-if="(m.input ?? ['text']).includes('image')" class="shrink-0">{{ t("settings.modelImage") }}</SettingBadge>
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
        <div v-else class="model-item-actions flex shrink-0 items-center gap-0.5 opacity-[0] [@media(hover:none)]:opacity-[1]">
          <Button variant="ghost" size="icon-xs" :aria-label="t('settings.edit')" :title="t('settings.edit')" :disabled="busy" @click="startEdit(i, m)"><Pencil :size="14" /></Button>
          <Button variant="ghost" size="icon-xs" class="text-destructive" :aria-label="t('settings.delete')" :title="t('settings.delete')" :disabled="busy" @click="confirmingDelete = i"><Trash2 :size="14" /></Button>
        </div>
      </div>
      <ModelEditForm
        v-if="editing && editingIndex === i"
        v-model="editing"
        is-edit
        :provider
        :existing-ids="existingIds"
        :busy
        @save="saveForm"
        @cancel="editing = null"
      />
    </div>
    </VueDraggable>

    <ModelEditForm
      v-if="editing && editingIndex === null"
      v-model="editing"
      :is-edit="false"
      :provider
      :existing-ids="existingIds"
      :busy
      @save="saveForm"
      @cancel="editing = null"
    />

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
<style scoped>
.sortable-ghost {
  opacity: 0.45;
  background: var(--border);
}
.model-item:hover .model-item-actions {
  opacity: 1;
}
.model-item:focus-within .model-item-actions {
  opacity: 1;
}
</style>
