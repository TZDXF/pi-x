<script setup lang="ts">
/** Provider detail editor: edits one entry of pi's models.json `providers` map. */
import { computed, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProviderEntry } from "@/api/piClient"
import { PROVIDER_API_TYPES, useModelsConfigStore } from "@/stores/modelsConfig"
import { useSessionStore } from "@/stores/conversations"
import { useUiStore } from "@/stores/conversations"

const props = defineProps<{ /** Provider key, or null while adding a new one. */ providerId: string | null }>()
const emit = defineEmits<{ saved: [id: string]; deleted: [] }>()

const store = useModelsConfigStore()
const session = useSessionStore()
const ui = useUiStore()
const { t } = useI18n()

const provider = computed(() =>
  props.providerId ? store.config.providers[props.providerId] : undefined,
)

interface ProviderForm {
  name: string
  baseUrl: string
  api: string
  apiKey: string
}

/** New provider id (only editable while adding). */
const newId = ref("")
const form = reactive<ProviderForm>({
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
})
const confirmingDelete = ref(false)
const busy = ref(false)

function loadForm() {
  confirmingDelete.value = false
  newId.value = ""
  const p = provider.value
  form.name = p?.name ?? ""
  form.baseUrl = p?.baseUrl ?? ""
  form.api = p?.api ?? "openai-completions"
  form.apiKey = typeof p?.apiKey === "string" ? p.apiKey : ""
}

watch(() => props.providerId, loadForm, { immediate: true })

async function saveForm() {
  const id = props.providerId ?? newId.value.trim()
  if (!id) {
    ui.pushToast(t("settings.providerIdRequired"), "error")
    return
  }
  if (!form.baseUrl.trim()) {
    ui.pushToast(t("settings.providerBaseUrlRequired"), "error")
    return
  }
  if (props.providerId == null && store.config.providers[id]) {
    ui.pushToast(t("settings.providerIdExists"), "error")
    return
  }
  busy.value = true
  try {
    // Spread the existing entry so unknown fields (headers, compat, oauth,
    // modelOverrides, …) survive the edit.
    const entry: ProviderEntry = provider.value ? { ...provider.value } : { models: [] }
    entry.baseUrl = form.baseUrl.trim()
    entry.api = form.api
    if (form.name.trim()) entry.name = form.name.trim()
    else delete entry.name
    if (form.apiKey.trim()) entry.apiKey = form.apiKey.trim()
    else delete entry.apiKey
    store.config.providers[id] = entry
    await store.persist()
    ui.pushToast(t("settings.toastModelsSaved"), "info")
    // pi re-reads models.json when the model picker opens.
    session.refreshModels().catch(() => {})
    emit("saved", id)
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!props.providerId) return
  busy.value = true
  try {
    delete store.config.providers[props.providerId]
    confirmingDelete.value = false
    await store.persist()
    ui.pushToast(t("settings.toastModelsSaved"), "info")
    session.refreshModels().catch(() => {})
    emit("deleted")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="provider-id">{{ t("settings.providerId") }}</label>
        <Input
          id="provider-id"
          :model-value="props.providerId ?? newId"
          :placeholder="t('settings.providerIdPlaceholder')"
          class="font-mono text-xs"
          :disabled="props.providerId !== null"
          @update:model-value="newId = String($event)"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs" for="provider-name">{{
          t("settings.providerName")
        }}</label>
        <Input id="provider-name" v-model="form.name" class="text-xs" />
      </div>
    </div>
    <div>
      <label class="mb-1 block text-xs" for="provider-base-url">{{
        t("settings.providerBaseUrl")
      }}</label>
      <Input
        id="provider-base-url"
        v-model="form.baseUrl"
        placeholder="https://api.example.com/v1"
        class="font-mono text-xs"
      />
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="provider-api">{{ t("settings.providerApi") }}</label>
        <Select v-model="form.api">
          <SelectTrigger id="provider-api" class="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="api in PROVIDER_API_TYPES" :key="api" :value="api">{{ api }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label class="mb-1 block text-xs" for="provider-key">{{
          t("settings.providerApiKey")
        }}</label>
        <Input
          id="provider-key"
          v-model="form.apiKey"
          class="font-mono text-xs"
          type="password"
          autocomplete="off"
        />
      </div>
    </div>
    <div class="flex justify-end gap-2 pt-1">
      <template v-if="confirmingDelete">
        <span class="text-destructive mr-auto self-center text-xs">{{
          t("settings.providerDeleteConfirm")
        }}</span>
        <Button variant="destructive" size="sm" :disabled="busy" @click="remove">
          {{ t("settings.confirmDelete") }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="confirmingDelete = false">
          {{ t("common.cancel") }}
        </Button>
      </template>
      <template v-else>
        <Button
          v-if="props.providerId"
          variant="outline"
          size="sm"
          type="button"
          class="text-destructive mr-auto"
          :disabled="busy"
          @click="confirmingDelete = true"
        >
          {{ t("settings.delete") }}
        </Button>
        <Button size="sm" :disabled="busy" @click="saveForm">
          {{ busy ? t("settings.saving") : t("settings.save") }}
        </Button>
      </template>
    </div>
  </div>
</template>
