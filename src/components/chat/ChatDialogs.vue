<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"

defineProps<{
  forkOpen: boolean
  forkMessages: { entryId: string; text: string }[]
  previewImage: string | null
}>()

const emit = defineEmits<{
  "update:forkOpen": [open: boolean]
  fork: [entryId: string]
  "update:previewImage": [image: string | null]
}>()
</script>

<template>
  <!-- fork dialog -->
  <Dialog :open="forkOpen" @update:open="emit('update:forkOpen', $event)">
    <DialogContent class="flex max-h-[70dvh] max-w-lg flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{{ $t("chat.forkTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-muted-foreground text-xs">
        {{ $t("chat.forkDesc") }}
      </p>
      <ScrollArea class="min-h-0" viewport-class="max-h-[45dvh]">
        <div class="flex flex-col gap-1">
          <Button
            type="button"
            v-for="m in forkMessages"
            :key="m.entryId"
            variant="outline"
            class="h-auto justify-start px-3 py-2 text-left text-xs"
            @click="emit('fork', m.entryId)"
          >
            <span class="line-clamp-2">{{ m.text }}</span>
          </Button>
          <p v-if="!forkMessages.length" class="text-muted-foreground text-xs">
            {{ $t("chat.forkEmpty") }}
          </p>
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>

  <!-- image preview dialog -->
  <Dialog :open="!!previewImage" @update:open="emit('update:previewImage', null)">
    <DialogContent class="max-w-4xl p-2">
      <img
        v-if="previewImage"
        :src="previewImage"
        class="max-h-[80dvh] w-full rounded-md object-contain"
        alt="preview"
      />
    </DialogContent>
  </Dialog>
</template>
