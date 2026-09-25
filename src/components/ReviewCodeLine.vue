<script setup lang="ts">
import { computed } from "vue"
import type { DiffLine } from "@/lib/reviewDiff"
const props = defineProps<{ line: DiffLine | null; side?: "left" | "right"; html?: string; range?: [number, number] }>()
const text = computed(() => props.line?.text.slice(1) ?? "")
</script>

<template>
  <div class="review-code-line" :class="line ? `review-${line.kind}` : 'review-placeholder'">
    <template v-if="line">
      <span v-if="side !== 'right'" class="review-line-number" aria-hidden="true">{{ line.oldLine }}</span>
      <span v-if="side !== 'left'" class="review-line-number" aria-hidden="true">{{ line.newLine }}</span>
      <code v-if="html" class="review-code-text" v-html="html" />
      <code v-else-if="range" class="review-code-text">{{ text.slice(0, range[0]) }}<span :class="line.kind === 'del' ? 'diff-word-del' : 'diff-word-add'">{{ text.slice(range[0], range[1]) }}</span>{{ text.slice(range[1]) }}</code>
      <code v-else class="review-code-text">{{ text || ' ' }}</code>
    </template>
  </div>
</template>
