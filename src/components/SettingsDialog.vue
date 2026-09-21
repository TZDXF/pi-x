<script setup lang="ts">
/** App settings: custom pi executable path + live detection result. */
import { ref, watch } from "vue"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { detectPi, getConfig, saveConfig, type AppConfig, type PiInfo } from "@/api/piClient"
import { useUiStore } from "@/stores/ui"

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const ui = useUiStore()

const piPath = ref("")
const info = ref<PiInfo | null>(null)
const detecting = ref(false)
const saving = ref(false)

watch(() => props.open, async (o) => {
  if (!o) return
  info.value = null
  try {
    const c: AppConfig = await getConfig()
    piPath.value = c.piPath ?? ""
  }
  catch {
    piPath.value = ""
  }
})

async function detect() {
  detecting.value = true
  try {
    info.value = await detectPi(piPath.value.trim() || undefined)
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
  finally {
    detecting.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const c: AppConfig = await getConfig()
    await saveConfig({ ...c, piPath: piPath.value.trim() || undefined })
    ui.pushToast("Saved — restart the session to apply", "info")
    emit("close")
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => !v && emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <label class="text-sm font-medium">pi executable path</label>
        <Input
          v-model="piPath"
          placeholder="Leave empty to auto-detect on PATH"
          class="font-mono text-xs"
        />
        <p class="text-muted-foreground text-xs">
          On Windows, npm <code>.cmd</code> shims are resolved automatically
          (launched as node + cli.js).
        </p>

        <div class="flex items-center gap-2">
          <button
            class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
            :disabled="detecting"
            @click="detect"
          >
            {{ detecting ? "Detecting…" : "Detect" }}
          </button>
          <span v-if="info" class="text-xs">
            <template v-if="info.found">
              <span class="text-chart-2 font-medium">found</span>
              <span class="text-muted-foreground"> · {{ info.path }}{{ info.version ? ` · ${info.version}` : "" }}</span>
            </template>
            <span v-else class="text-destructive font-medium">not found</span>
          </span>
        </div>

        <div class="mt-2 flex justify-end gap-2">
          <button
            class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
