<script setup lang="ts">
import { DialogClose, DialogContent, DialogPortal, DialogTitle } from "reka-ui"
import { X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import ImageViewer from "@/components/ImageViewer.vue"

defineProps<{ src: string; alt?: string }>()
</script>

<template>
  <DialogPortal>
    <!-- 非模态预览保留标题栏交互；内容区域拦截点击，避免误操作底层聊天。 -->
    <DialogContent
      :aria-describedby="undefined"
      class="fixed inset-x-0 bottom-0 top-9 z-50 flex flex-col overflow-hidden bg-transparent p-2 pt-10 outline-none"
      @interact-outside.prevent
    >
      <DialogTitle class="sr-only">{{ $t("chat.previewImage") }}</DialogTitle>
      <ImageViewer :src="src" :alt="alt" class="min-h-0 flex-1" />
      <DialogClose as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="absolute right-2 top-2"
          :aria-label="$t('projectFiles.closePreview')"
        >
          <X />
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
