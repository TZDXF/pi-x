<script setup lang="ts">
/** Provider management tab: edits the `providers` map of pi's models.json. */
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProviderEntry } from "@/api/piClient"
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

const providers = computed(() => Object.entries(store.config.providers ?? {}))

interface ProviderForm {
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  authHeader: boolean
}

const editing = ref<ProviderForm | null>(null)
/** Original provider key while editing (null = adding). */
const editingKey = ref<string | null>(null)
const confirmingDelete = ref<string | null>(null)
const busy = ref(false)

function startAdd() {
  editingKey.value = null
  editing.value = {
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    authHeader: false,
  }
}

function startEdit(id: string, p: ProviderEntry) {
  confirmingDelete.value = null
  editingKey.value = id
  editing.value = {
    id,
    name: p.name ?? "",
    baseUrl: p.baseUrl ?? "",
    api: p.api ?? "openai-completions",
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    authHeader: p.authHeader === true,
  }
}

async function saveForm() {
  const f = editing.value
  if (!f) return
  const id = f.id.trim()
  if (!id) {
    ui.pushToast(t("settings.providerIdRequired"), "error")
    return
  }
  if (!f.baseUrl.trim()) {
    ui.pushToast(t("settings.providerBaseUrlRequired"), "error")
    return
  }
  if (editingKey.value !== id && store.config.providers[id]) {
    ui.pushToast(t("settings.providerIdExists"), "error")
    return
  }
  busy.value = true
  try {
    // Spread the existing entry so unknown fields (headers, compat, oauth,
    // modelOverrides, …) survive the edit.
    const entry: ProviderEntry =
      editingKey.value != null ? { ...store.config.providers[editingKey.value] } : { models: [] }
    entry.baseUrl = f.baseUrl.trim()
    entry.api = f.api
    if (f.name.trim()) entry.name = f.name.trim()
    else delete entry.name
    if (f.apiKey.trim()) entry.apiKey = f.apiKey.trim()
    else delete entry.apiKey
    if (f.authHeader) entry.authHeader = true
    else delete entry.authHeader
    if (editingKey.value != null && editingKey.value !== id)
      delete store.config.providers[editingKey.value]
    store.config.providers[id] = entry
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

async function remove(id: string) {
  busy.value = true
  try {
    delete store.config.providers[id]
    confirmingDelete.value = null
    if (editingKey.value === id) editing.value = null
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
  <div v-if="!providers.length && !editing" class="text-muted-foreground py-6 text-sm">
    {{ t("settings.providerEmpty") }}
  </div>

  <div
    v-for="[id, p] in providers"
    :key="id"
    class="setting-row"
    :class="{ 'opacity-60': editing && editingKey !== id }"
  >
    <div class="min-w-0">
      <h3 class="flex items-center gap-2">
        <span class="truncate">{{ p.name || id }}</span>
        <span
          v-if="p.name && p.name !== id"
          class="text-muted-foreground font-mono text-[10px] font-normal"
          >{{ id }}</span
        >
        <span v-if="p.api" class="setting-badge">{{ p.api }}</span>
      </h3>
      <p class="truncate font-mono text-[11px]">{{ p.baseUrl || "—" }}</p>
      <p>{{ t("settings.providerModelCount", { count: p.models?.length ?? 0 }) }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <template v-if="confirmingDelete === id">
        <span class="text-destructive text-xs">{{ t("settings.providerDeleteConfirm") }}</span>
        <Button
          variant="destructive"
          size="sm"
          :disabled="busy"
          @click="remove(id)"
        >
          {{ t("settings.confirmDelete") }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="confirmingDelete = null">
          {{ t("common.cancel") }}
        </Button>
      </template>
      <template v-else>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :disabled="!!editing"
          @click="startEdit(id, p)"
        >
          {{ t("settings.edit") }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          class="text-destructive"
          :disabled="!!editing"
          @click="confirmingDelete = id"
        >
          {{ t("settings.delete") }}
        </Button>
      </template>
    </div>
  </div>

  <div v-if="editing" class="border-border bg-muted/40 mt-4 space-y-3 rounded-lg border p-4">
    <h3 class="text-sm font-medium">
      {{ editingKey ? t("settings.providerEdit") : t("settings.providerAdd") }}
    </h3>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="provider-id">{{ t("settings.providerId") }}</label>
        <Input
          id="provider-id"
          v-model="editing.id"
          :placeholder="t('settings.providerIdPlaceholder')"
          class="font-mono text-xs"
          :disabled="editingKey !== null"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs" for="provider-name">{{
          t("settings.providerName")
        }}</label>
        <Input id="provider-name" v-model="editing.name" class="text-xs" />
      </div>
    </div>
    <div>
      <label class="mb-1 block text-xs" for="provider-base-url">{{
        t("settings.providerBaseUrl")
      }}</label>
      <Input
        id="provider-base-url"
        v-model="editing.baseUrl"
        placeholder="https://api.example.com/v1"
        class="font-mono text-xs"
      />
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="provider-api">{{ t("settings.providerApi") }}</label>
        <Select v-model="editing.api">
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
          v-model="editing.apiKey"
          :placeholder="t('settings.providerApiKeyPlaceholder')"
          class="font-mono text-xs"
          type="password"
          autocomplete="off"
        />
      </div>
    </div>
    <p class="text-muted-foreground text-xs">{{ t("settings.providerApiKeyHint") }}</p>
    <label class="flex items-center gap-2 text-xs">
      <Checkbox v-model="editing.authHeader" />
      {{ t("settings.providerAuthHeader") }}
    </label>
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
    class="mt-4"
    @click="startAdd"
  >
    + {{ t("settings.providerAdd") }}
  </Button>
</template>
