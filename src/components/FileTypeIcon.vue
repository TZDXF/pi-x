<script setup lang="ts">
import { computed } from "vue"
import { Icon } from "@iconify/vue"
import { fileIcon, folderIcon } from "@/lib/fileIcons"
import { loadVscodeIcons } from "@/lib/vscodeIcons"

/** vscode-icons 风格的文件/目录类型图标；尺寸等样式由使用方透传 class 控制 */
const props = withDefaults(defineProps<{
  /** 文件或目录名，允许带路径（按最后一段解析） */
  name: string
  /** 目录图标；open 表示展开态 */
  dir?: boolean
  open?: boolean
}>(), { dir: false, open: false })

loadVscodeIcons()
const icon = computed(() => (props.dir ? folderIcon(props.name, props.open) : fileIcon(props.name)))
</script>

<template>
  <Icon :icon="icon" class="shrink-0" aria-hidden="true" />
</template>
