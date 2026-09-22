<script setup lang="ts">
/** In-app close confirmation: replaces the native dialog so it can offer
 *  a "do not remind again" checkbox styled like the rest of the app. */
import { onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { closeWindowDecide, onCloseRequested } from "@/api/piClient"
import { isDesktop } from "@/api/transport"
import { useUiStore } from "@/stores/ui"

const { t } = useI18n()
const ui = useUiStore()

const open = ref(false)
const remember = ref(false)
const busy = ref(false)

let unlisten: (() => void) | undefined

onMounted(async () => {
  if (!isDesktop) return
  unlisten = await onCloseRequested(() => {
    open.value = true
  })
})

onUnmounted(() => unlisten?.())

/** Notify the backend even on cancel so its prompt-open guard resets. */
async function decide(action: "tray" | "quit" | "cancel") {
  if (busy.value) return
  busy.value = true
  try {
    await closeWindowDecide(action, remember.value)
    open.value = false
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = false
  }
}

function onOpenChange(v: boolean) {
  if (v) {
    open.value = true
  } else if (open.value) {
    // Closed via Esc/overlay/X: treat as cancel.
    decide("cancel")
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("closeNotice.title") }}</DialogTitle>
        <DialogDescription>{{ t("closeNotice.desc") }}</DialogDescription>
      </DialogHeader>
      <label class="flex items-center gap-2 text-sm select-none">
        <input v-model="remember" type="checkbox" :disabled="busy" />
        {{ t("closeNotice.dontRemind") }}
      </label>
      <DialogFooter class="gap-2 sm:justify-end">
        <Button variant="outline" :disabled="busy" @click="decide('cancel')">
          {{ t("closeNotice.cancel") }}
        </Button>
        <Button variant="outline" :disabled="busy" @click="decide('quit')">
          {{ t("closeNotice.quit") }}
        </Button>
        <Button :disabled="busy" @click="decide('tray')">
          {{ t("closeNotice.minimizeToTray") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
