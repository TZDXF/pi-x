<script setup lang="ts">
defineProps<{ content: string }>()
</script>

<template>
  <div data-markdown-frontmatter class="mb-4 whitespace-pre-wrap break-words text-sm leading-6">{{ content }}</div>
</template>
