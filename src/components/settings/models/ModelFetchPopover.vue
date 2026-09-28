<script setup lang="ts">
/** Popover listing models discovered from the provider "/models" endpoint;
 *  picking one fills the add-form id/name. */
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Check, ChevronDown, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { FetchedModel, ProviderEntry } from "@/api/piClient"
import { useModelFetch } from "./useModelFetch"

const props = defineProps<{
  provider: ProviderEntry | undefined
  /** Ids already configured; shown checked and disabled. */
  existingIds: Set<string>
}>()
const emit = defineEmits<{ pick: [model: FetchedModel] }>()
const { t } = useI18n()

const open = ref(false)
const { fetched, fetching, fetchError, query, filtered, load } = useModelFetch(() => props.provider)

/** Opening the picker resets the search box and loads the list once. */
watch(open, v => {
  if (!v) return
  query.value = ""
  void load()
})

function pick(m: FetchedModel) {
  emit("pick", m)
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
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
        <Input v-model="query" :placeholder="t('settings.modelFetchSearch')" class="h-7 text-xs" />
        <Button
          variant="ghost"
          size="icon-sm"
          class="shrink-0"
          :disabled="fetching"
          :title="t('settings.modelFetchRefresh')"
          :aria-label="t('settings.modelFetchRefresh')"
          @click="load(true)"
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
      <div v-else-if="fetched && !filtered.length" class="text-muted-foreground px-2 py-3 text-xs">
        {{ fetched.length ? t("settings.modelFetchNoMatch") : t("settings.modelFetchEmpty") }}
      </div>
      <ScrollArea v-else-if="fetched" viewport-class="max-h-60">
        <button
          v-for="m in filtered"
          :key="m.id"
          type="button"
          :disabled="existingIds.has(m.id)"
          :title="m.id"
          class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-50"
          @click="pick(m)"
        >
          <Check v-if="existingIds.has(m.id)" :size="14" class="shrink-0" />
          <span class="min-w-0">
            <span class="block truncate font-mono text-xs">{{ m.id }}</span>
            <span v-if="m.name && m.name !== m.id" class="text-muted-foreground block truncate text-[11px]">{{
              m.name
            }}</span>
          </span>
        </button>
      </ScrollArea>
    </PopoverContent>
  </Popover>
</template>
