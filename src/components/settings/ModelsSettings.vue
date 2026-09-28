<script setup lang="ts">
import DragHandle from "@/components/shared/DragHandle.vue"
import SectionHeading from "@/components/shared/SectionHeading.vue"
/** Providers & models page: provider list on the left, provider config and its models on the right. */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { GripVertical } from "@lucide/vue"
import { VueDraggable } from "vue-draggable-plus"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import ProviderSettings from "./ProviderSettings.vue"
import ModelSettings from "./models/ModelSettings.vue"
import { useModelsConfigStore } from "@/stores/modelsConfig"
import type { ProviderEntry } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"

const { t } = useI18n()
const store = useModelsConfigStore()
const ui = useUiStore()

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
})

const providers = computed({
  get: () => Object.entries(store.config.providers ?? {}),
  set: (entries: [string, ProviderEntry][]) => {
    store.config.providers = Object.fromEntries(entries)
  },
})

/** Selected provider key; null while adding a new provider. */
const selected = ref<string | null>(null)
const creating = ref(false)
const reorderBusy = ref(false)
let dragSnapshot: Record<string, ProviderEntry> | null = null

function startDrag() {
  dragSnapshot = { ...store.config.providers }
}

async function finishDrag() {
  const original = dragSnapshot
  dragSnapshot = null
  if (!original || Object.keys(original).every((key, i) => key === providers.value[i]?.[0])) return
  reorderBusy.value = true
  try {
    await store.persist()
  } catch (e) {
    store.config.providers = original
    ui.pushToast(String(e), "error")
  } finally {
    reorderBusy.value = false
  }
}

/** Keep the selection valid when providers change (load/removed externally). */
watch(
  providers,
  list => {
    if (creating.value) return
    const ids = list.map(([id]) => id)
    if (!selected.value || !ids.includes(selected.value)) selected.value = ids[0] ?? null
  },
  { immediate: true },
)

function selectProvider(id: string) {
  creating.value = false
  selected.value = id
}

function startAdd() {
  creating.value = true
  selected.value = null
}

function onSaved(id: string) {
  creating.value = false
  selected.value = id
}

function onDeleted() {
  creating.value = false
  selected.value = providers.value[0]?.[0] ?? null
}
</script>

<template>
  <p class="text-muted-foreground mb-4 text-xs">{{ t("settings.modelsFileHint") }}</p>

  <div
    class="provider-layout grid [grid-template-columns:196px_minmax(0,_1fr)] gap-5 items-start max-[900px]:[grid-template-columns:minmax(0,_1fr)]"
  >
    <aside
      class="provider-list flex flex-col gap-[3px] border-r border-border pr-3 max-[900px]:[border-right:none] max-[900px]:border-b border-border max-[900px]:pr-0 max-[900px]:pb-3"
    >
      <VueDraggable
        v-model="providers"
        class="provider-sortable flex flex-col gap-[3px]"
        handle=".drag-handle"
        :animation="150"
        :disabled="reorderBusy"
        @start="startDrag"
        @end="finishDrag"
      >
        <div
          v-for="[id, p] in providers"
          :key="id"
          class="provider-item flex items-center min-w-0 rounded-[7px] py-[3px] px-1 hover:bg-border"
          :class="{ active: !creating && selected === id }"
        >
          <DragHandle :title="t('settings.dragToReorder')" :aria-label="t('settings.dragToReorder')"
            ><GripVertical :size="14"
          /></DragHandle>
          <button
            type="button"
            class="provider-item-content flex flex-1 flex-col min-w-0 gap-[1px] py-[3px] px-[5px] text-left"
            @click="selectProvider(id)"
          >
            <span
              class="provider-item-name text-xs font-medium overflow-hidden text-ellipsis whitespace-nowrap"
              :title="p.name || id"
              >{{ p.name || id }}</span
            >
            <span class="provider-item-meta flex justify-between gap-2 text-[10px] text-muted-foreground" :title="id">
              <span v-if="p.name && p.name !== id" class="font-mono">{{ id }}</span>
              <span>{{ t("settings.providerModelCount", { count: p.models?.length ?? 0 }) }}</span>
            </span>
          </button>
        </div>
      </VueDraggable>
      <Button variant="outline" size="sm" class="mt-2" :class="{ active: creating }" @click="startAdd">
        + {{ t("settings.providerAdd") }}
      </Button>
    </aside>

    <div class="provider-detail min-w-0 max-[900px]:pt-1">
      <template v-if="creating || selected">
        <SectionHeading>
          {{ creating ? t("settings.providerAdd") : t("settings.providerEdit") }}
        </SectionHeading>
        <ProviderSettings :provider-id="creating ? null : selected" @saved="onSaved" @deleted="onDeleted" />
        <template v-if="!creating && selected">
          <Separator class="my-6" />
          <SectionHeading>{{ t("settings.models") }}</SectionHeading>
          <ModelSettings :provider-id="selected" />
        </template>
      </template>
      <div v-else class="text-muted-foreground py-6 text-sm">
        {{ t("settings.providerEmpty") }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.provider-item.active {
  background: var(--border);
}
.provider-item-meta .font-mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sortable-ghost {
  opacity: 0.45;
  background: var(--border);
}
</style>
