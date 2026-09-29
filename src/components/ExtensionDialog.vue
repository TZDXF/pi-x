<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { uiFor, activeRuntimeId } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const props = defineProps<{
  /** 所属会话 id；缺省跟随当前激活会话，分屏时由 ChatView 传入所属窗格会话。 */
  sessionId?: string
}>()
const ui = uiFor(props.sessionId ?? activeRuntimeId.value)
const { t } = useI18n()
const input = ref("")
const editing = ref("")

const active = computed(() => ui.activeDialog)

// prefill on dialog change
watch(active, req => {
  if (!req) return
  input.value = req.placeholder ?? ""
  editing.value = req.prefill ?? ""
})

function submitValue(value: string | undefined) {
  if (active.value) ui.respond(active.value, { value })
}

function confirm(confirmed: boolean) {
  if (active.value) ui.respond(active.value, { confirmed })
}
</script>

<template>
  <Dialog
    :open="!!active"
    @update:open="
      (v: boolean) => {
        if (!v && active) ui.respond(active, { cancelled: true })
      }
    "
  >
    <DialogContent v-if="active" class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ active.title ?? "pi" }}</DialogTitle>
        <DialogDescription v-if="active.message">{{ active.message }}</DialogDescription>
      </DialogHeader>

      <!-- select -->
      <ScrollArea v-if="active.method === 'select'" viewport-class="max-h-[50dvh]"
        ><div class="flex flex-col gap-1">
          <Button
            v-for="(opt, i) in active.options ?? []"
            :key="i"
            variant="outline"
            class="h-auto justify-start whitespace-normal break-words px-3 py-2 text-left"
            @click="submitValue(opt)"
          >
            {{ opt }}
          </Button>
        </div></ScrollArea
      >

      <!-- confirm -->
      <DialogFooter v-else-if="active.method === 'confirm'" class="gap-2">
        <Button variant="outline" @click="confirm(false)">
          {{ t("ext.no") }}
        </Button>
        <Button @click="confirm(true)">
          {{ t("ext.yes") }}
        </Button>
      </DialogFooter>

      <!-- input -->
      <div v-else-if="active.method === 'input'" class="space-y-3">
        <Input
          v-model="input"
          :placeholder="active.placeholder"
          class="h-9"
          @keydown.enter.prevent="submitValue(input)"
        />
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="ui.respond(active, { cancelled: true })">
            {{ t("ext.cancel") }}
          </Button>
          <Button @click="submitValue(input)">
            {{ t("ext.ok") }}
          </Button>
        </DialogFooter>
      </div>

      <!-- editor -->
      <div v-else-if="active.method === 'editor'" class="space-y-3">
        <Textarea v-model="editing" rows="10" class="font-mono text-xs" />
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="ui.respond(active, { cancelled: true })">
            {{ t("ext.cancel") }}
          </Button>
          <Button @click="submitValue(editing)">
            {{ t("ext.save") }}
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
