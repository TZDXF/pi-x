<script setup lang="ts">
import { DialogClose, DialogContent, DialogPortal, DialogTitle, injectDialogRootContext } from "reka-ui"
import { X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import ImageViewer from "@/components/ImageViewer.vue"

defineProps<{ src: string; alt?: string }>()

const dialog = injectDialogRootContext()

function closePreview() {
  dialog.onOpenChange(false)
}
</script>

<template>
  <DialogPortal>
    <!-- 非模态预览保留标题栏交互；遮罩覆盖聊天区域，点击空白处关闭。 -->
    <DialogContent
      :aria-describedby="undefined"
      class="fixed inset-x-0 bottom-0 top-9 z-50 flex flex-col overflow-hidden bg-black/60 p-2 pt-10 outline-none"
      @interact-outside.prevent
      @escape-key-down.prevent.stop="closePreview"
      @click.self="closePreview"
    >
      <DialogTitle class="sr-only">{{ $t("chat.previewImage") }}</DialogTitle>
      <ImageViewer :src="src" :alt="alt" class="min-h-0 flex-1" @background-click="closePreview" />
      <DialogClose as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="absolute right-2 top-2 bg-background/90"
          :aria-label="$t('projectFiles.closePreview')"
        >
          <X />
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
