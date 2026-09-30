<script setup lang="ts">
import { FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree"
import type { FileTreeNode } from "@/lib/reviewFileTree"

defineProps<{ nodes: FileTreeNode[] }>()
</script>

<template>
  <template v-for="node in nodes" :key="node.fullPath">
    <FileTreeFolder v-if="!node.file" :path="node.fullPath" :name="node.name" :title="node.fullPath">
      <PackageResourceTree :nodes="node.children" />
    </FileTreeFolder>
    <FileTreeFile v-else :path="node.fullPath" :name="node.name" :title="node.fullPath" />
  </template>
</template>
