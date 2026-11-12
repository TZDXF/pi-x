<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"
import { invokeProjectFile } from "@/api/client/projectFiles"
import { parseCodedError } from "@/lib/backendError"
import { resolveCodeCommentFile } from "@/lib/codeCommentNavigation"
import type { ParsedCodeComment } from "@/lib/codeComments"
import type { FilePreview } from "@/lib/projectFiles"

const props = defineProps<{ comment: ParsedCodeComment | null; roots: string[] }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const target = computed(() => props.comment && resolveCodeCommentFile(props.comment.path, props.roots))
const readFile = computed(() => {
  const file = target.value
  const path = props.comment?.path ?? ""
  return async (): Promise<FilePreview> => {
    if (!file) throw new Error(t("projectFiles.commentFileUnavailable", { path }))
    try {
      return await invokeProjectFile<FilePreview>("read_file_preview", file.project, file.path)
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      const code = parseCodedError(raw)?.code
      if (code === "previewPathInvalid" || code === "projectDirMissing") {
        throw new Error(t("projectFiles.commentFileUnavailable", { path }))
      }
      throw cause
    }
  }
})
</script>

<template>
  <Dialog :open="!!comment" @update:open="!$event && emit('close')">
    <DialogContent v-if="comment" class="flex h-[min(80dvh,48rem)] flex-col sm:max-w-4xl">
      <DialogHeader class="min-w-0 pr-8">
        <DialogTitle class="truncate"
          >{{ comment.path }}:{{ comment.startLine
          }}<template v-if="comment.endLine !== comment.startLine">-{{ comment.endLine }}</template></DialogTitle
        >
        <DialogDescription class="whitespace-pre-wrap break-words max-h-24 overflow-auto">{{
          comment.comment || comment.selectedText
        }}</DialogDescription>
      </DialogHeader>
      <ProjectFilePreview
        v-if="target"
        :key="comment.id + comment.path"
        :project="target.project"
        :path="target.path"
        :read-file="readFile"
        :line-range="{ start: comment.startLine, end: comment.endLine }"
        :closable="false"
      />
      <p v-else role="alert" class="text-sm text-destructive">
        {{ t("projectFiles.commentFileUnavailable", { path: comment.path }) }}
      </p>
    </DialogContent>
  </Dialog>
</template>
