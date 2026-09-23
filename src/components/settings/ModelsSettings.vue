<script setup lang="ts">
/** Providers & models page: provider list on the left, provider config and its models on the right. */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import ProviderSettings from "@/components/ProviderSettings.vue"
import ModelSettings from "@/components/ModelSettings.vue"
import { useModelsConfigStore } from "@/stores/modelsConfig"
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

const providers = computed(() => Object.entries(store.config.providers ?? {}))

/** Selected provider key; null while adding a new provider. */
const selected = ref<string | null>(null)
const creating = ref(false)

/** Keep the selection valid when providers change (load/removed externally). */
watch(
  providers,
  (list) => {
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

  <div class="provider-layout">
    <aside class="provider-list">
      <button
        v-for="[id, p] in providers"
        :key="id"
        type="button"
        class="provider-item"
        :class="{ active: !creating && selected === id }"
        @click="selectProvider(id)"
      >
        <span class="provider-item-name">{{ p.name || id }}</span>
        <span class="provider-item-meta">
          <span v-if="p.name && p.name !== id" class="font-mono">{{ id }}</span>
          <span>{{ t("settings.providerModelCount", { count: p.models?.length ?? 0 }) }}</span>
        </span>
      </button>
      <Button
        variant="outline"
        size="sm"
        class="mt-2"
        :class="{ active: creating }"
        @click="startAdd"
      >
        + {{ t("settings.providerAdd") }}
      </Button>
    </aside>

    <div class="provider-detail">
      <template v-if="creating || selected">
        <h3 class="settings-section">
          {{ creating ? t("settings.providerAdd") : t("settings.providerEdit") }}
        </h3>
        <ProviderSettings
          :provider-id="creating ? null : selected"
          @saved="onSaved"
          @deleted="onDeleted"
        />
        <template v-if="!creating && selected">
          <Separator class="my-6" />
          <h3 class="settings-section">{{ t("settings.models") }}</h3>
          <ModelSettings :provider-id="selected" />
        </template>
      </template>
      <div v-else class="text-muted-foreground py-6 text-sm">
        {{ t("settings.providerEmpty") }}
      </div>
    </div>
  </div>
</template>
