<script setup lang="ts">
/** Dialog asking for the installation target project. The target is always
 *  chosen explicitly, even when a chat project is open. */
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { open } from "@tauri-apps/plugin-dialog"
import { isDesktop } from "@/api/transport"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog"
import { packageNameOf } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"

const props = defineProps<{
  /** Package source pending a project install (empty = dialog closed). */
  source: string
  recentProjects: string[]
  busy: boolean
}>()
const emit = defineEmits<{ confirm: [target: string]; cancel: [] }>()

const ui = useUiStore()
const { t } = useI18n()

const installTarget = ref("")

// Never silently reuse the main UI's project: reset on each new request.
watch(
  () => props.source,
  () => {
    installTarget.value = ""
  },
)

async function browseInstallTarget() {
  try {
    const dir = isDesktop
      ? await open({ directory: true, title: t("packages.chooseProject") })
      : window.prompt(t("packages.projectPathPrompt"))
    if (typeof dir === "string") installTarget.value = dir
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
</script>

<template>
  <Dialog
    :open="!!source"
    @update:open="
      (v: boolean) => {
        if (!v && !busy) emit('cancel')
      }
    "
  >
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("packages.chooseProject") }}</DialogTitle>
        <DialogDescription>{{ t("packages.chooseProjectHint", { name: packageNameOf(source) }) }}</DialogDescription>
      </DialogHeader>
      <Select v-if="recentProjects.length" v-model="installTarget">
        <SelectTrigger class="w-full"><SelectValue :placeholder="t('packages.recentProjects')" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="path in recentProjects" :key="path" :value="path">{{ path }}</SelectItem>
        </SelectContent>
      </Select>
      <div class="flex gap-2">
        <Input
          v-model="installTarget"
          :placeholder="t('packages.projectPathPrompt')"
          class="min-w-0 flex-1 font-mono text-xs"
        />
        <Button v-if="isDesktop" variant="outline" @click="browseInstallTarget">{{
          t("packages.browseProject")
        }}</Button>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('cancel')">{{ t("packages.cancel") }}</Button>
        <Button :disabled="busy || !installTarget.trim()" @click="emit('confirm', installTarget)">
          <Spinner v-if="busy" class="size-3" />
          {{ t("packages.installProject") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
