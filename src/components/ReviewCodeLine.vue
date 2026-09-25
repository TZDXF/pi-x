<script setup lang="ts">
import { computed } from "vue"
import type { DiffLine } from "@/lib/reviewDiff"
const props = defineProps<{ line: DiffLine | null; side?: "left" | "right"; html?: string; range?: [number, number] }>()
const text = computed(() => props.line?.text.slice(1) ?? "")
</script>

<template>
  <div class="review-code-line flex min-h-5 min-w-0" :class="line ? `review-${line.kind}` : 'review-placeholder'">
    <template v-if="line">
      <span v-if="side !== 'right'" class="review-line-number [flex:0_0_40px] pt-0 pr-2 pb-0 pl-0 text-right text-[color-mix(in_srgb,_var(--muted-foreground)_50%,_transparent)] select-none bg-transparent" aria-hidden="true">{{ line.oldLine }}</span>
      <span v-if="side !== 'left'" class="review-line-number [flex:0_0_40px] pt-0 pr-2 pb-0 pl-0 text-right text-[color-mix(in_srgb,_var(--muted-foreground)_50%,_transparent)] select-none bg-transparent" aria-hidden="true">{{ line.newLine }}</span>
      <code v-if="html" class="review-code-text whitespace-pre pr-3 [font:inherit] [tab-size:4]" v-html="html" />
      <code v-else-if="range" class="review-code-text whitespace-pre pr-3 [font:inherit] [tab-size:4]">{{ text.slice(0, range[0]) }}<span :class="line.kind === 'del' ? 'bg-[rgb(239_68_68/0.28)]' : 'bg-[rgb(34_197_94/0.28)]'">{{ text.slice(range[0], range[1]) }}</span>{{ text.slice(range[1]) }}</code>
      <code v-else class="review-code-text whitespace-pre pr-3 [font:inherit] [tab-size:4]">{{ text || ' ' }}</code>
    </template>
  </div>
</template>

<style scoped>
.review-add {
  background: rgb(34 197 94 / 0.10);
}
.review-del {
  background: rgb(239 68 68 / 0.10);
}
.review-placeholder {
  background: repeating-linear-gradient(135deg, transparent 0 4px, var(--muted) 4px 5px);
}
.review-code-text :deep(span[style]) {
  color: light-dark(var(--shiki-light), var(--shiki-dark));
}
</style>
