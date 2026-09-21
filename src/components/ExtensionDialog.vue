<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useUiStore } from "@/stores/ui"

const ui = useUiStore()
const { t } = useI18n()
const input = ref("")
const editing = ref("")

const active = computed(() => ui.activeDialog)

// prefill on dialog change
watch(active, (req) => {
  if (!req)
    return
  input.value = req.placeholder ?? ""
  editing.value = req.prefill ?? ""
})

function submitValue(value: string | undefined) {
  if (active.value)
    ui.respond(active.value, { value })
}

function confirm(confirmed: boolean) {
  if (active.value)
    ui.respond(active.value, { confirmed })
}
</script>

<template>
  <Dialog
    :open="!!active"
    @update:open="(v: boolean) => { if (!v && active) ui.respond(active, { cancelled: true }) }"
  >
    <DialogContent v-if="active" class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ active.title ?? "pi" }}</DialogTitle>
        <DialogDescription v-if="active.message">{{ active.message }}</DialogDescription>
      </DialogHeader>

      <!-- select -->
      <div v-if="active.method === 'select'" class="flex flex-col gap-1">
        <button
          v-for="(opt, i) in active.options ?? []"
          :key="i"
          class="hover:bg-accent rounded-md border px-3 py-2 text-left text-sm"
          @click="submitValue(opt)"
        >
          {{ opt }}
        </button>
      </div>

      <!-- confirm -->
      <DialogFooter v-else-if="active.method === 'confirm'" class="gap-2">
        <button
          class="border-input hover:bg-accent rounded-md border px-4 py-2 text-sm"
          @click="confirm(false)"
        >
          {{ t("ext.no") }}
        </button>
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm"
          @click="confirm(true)"
        >
          {{ t("ext.yes") }}
        </button>
      </DialogFooter>

      <!-- input -->
      <div v-else-if="active.method === 'input'" class="space-y-3">
        <input
          v-model="input"
          :placeholder="active.placeholder"
          class="border-input ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-full rounded-md border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
          @keydown.enter.prevent="submitValue(input)"
        />
        <DialogFooter class="gap-2">
          <button
            class="border-input hover:bg-accent rounded-md border px-4 py-2 text-sm"
            @click="ui.respond(active, { cancelled: true })"
          >
            {{ t("ext.cancel") }}
          </button>
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm"
            @click="submitValue(input)"
          >
            {{ t("ext.ok") }}
          </button>
        </DialogFooter>
      </div>

      <!-- editor -->
      <div v-else-if="active.method === 'editor'" class="space-y-3">
        <textarea
          v-model="editing"
          rows="10"
          class="border-input placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border bg-transparent p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2"
        />
        <DialogFooter class="gap-2">
          <button
            class="border-input hover:bg-accent rounded-md border px-4 py-2 text-sm"
            @click="ui.respond(active, { cancelled: true })"
          >
            {{ t("ext.cancel") }}
          </button>
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm"
            @click="submitValue(editing)"
          >
            {{ t("ext.save") }}
          </button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
