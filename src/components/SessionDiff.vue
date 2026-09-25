<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { foldContextLines, intralineRanges, toSideBySideRows, type DiffLine } from "@/lib/reviewDiff"
import type { FileChange } from "@/lib/sessionChanges"
const ReviewSplitDiff = defineAsyncComponent(() => import("@/components/ReviewSplitDiff.vue"))
import ReviewCodeLine from "@/components/ReviewCodeLine.vue"
/** 稳定引用:内联对象会让 useSplitDiffLayout 的 watch 每次渲染都触发并重置滚动位置 */
const LANDED_DIFF = { truncated: false }
const props = defineProps<{ change: FileChange; split: boolean; word: boolean }>()
const { t } = useI18n()
const splitRatio = ref(0.5)
const currentRowPos = ref(0)
const expanded = ref(new Set<string>())
const limit = ref(400)
const highlighted = shallowRef(new Map<DiffLine, string>())
const lines = computed<DiffLine[]>(() => props.change.lines.map(line => {
  const kind = props.change.unknownBefore ? "ctx" : line.kind === "remove" ? "del" : line.kind === "add" ? "add" : "ctx"
  return { kind, text: `${kind === 'add' ? '+' : kind === 'del' ? '-' : ' '}${line.text}`,
    oldLine: props.change.unknownBefore ? null : line.oldLine ?? null, newLine: line.newLine ?? null }
}))
const ranges = computed(() => props.word ? intralineRanges(lines.value) : new Map<DiffLine, [number, number]>())
const display = computed(() => foldContextLines(lines.value, expanded.value))
const rows = computed(() => toSideBySideRows(display.value))
const visible = computed(() => display.value.slice(0, limit.value))
const visibleRows = computed(() => rows.value.slice(0, limit.value))
const remaining = computed(() => Math.max(0, (props.split && !props.change.unknownBefore ? rows.value.length : display.value.length) - limit.value))
function expand(key: string) { expanded.value = new Set([...expanded.value, key]) }
let version = 0
watch([lines, ranges, () => props.change.path], async () => {
  const current = ++version
  highlighted.value = new Map()
  const source = lines.value, emphasis = ranges.value, path = props.change.path
  // Large changes stay plain text and are paginated instead of blocking the review panel.
  if (source.length > 5000 || source.reduce((sum, line) => sum + line.text.length, 0) > 200_000) return
  try {
    const { highlightDiffLines } = await import("@/lib/reviewHighlight")
    if (current !== version) return
    const result = await highlightDiffLines(source, path, emphasis)
    if (current === version) highlighted.value = result ?? new Map()
  } catch { /* Plain escaped text remains available if highlighting fails. */ }
}, { immediate: true })
watch(() => props.change.id, () => { expanded.value = new Set(); limit.value = 400 })
onBeforeUnmount(() => { version++ })
</script>

<template>
  <div class="review-diff commit-diff">
    <div>
      <ReviewSplitDiff v-if="split && !change.unknownBefore"
        v-model:split-ratio="splitRatio" v-model:current-row-pos="currentRowPos"
        :rows="visibleRows" :landed-diff="LANDED_DIFF" :line-html="highlighted" :word-ranges="ranges"
        class="review-split-pane" @expand-fold="expand" />
      <div v-else class="review-unified">
        <template v-for="(line, index) in visible" :key="index">
          <button v-if="line.kind === 'fold'" type="button" class="review-fold" :aria-label="t('changes.expand', { count: line.count })" :title="t('changes.expand', { count: line.count })" @click="expand(line.key)"><span class="review-fold-wave" /></button>
          <ReviewCodeLine v-else :line="line" :side="change.unknownBefore ? 'right' : undefined" :html="highlighted.get(line)" :range="ranges.get(line)" />
        </template>
      </div>
    </div>
    <button v-if="remaining" type="button" class="review-fold" @click="limit += 400">{{ t('changes.loadMore', { count: remaining }) }}</button>
  </div>
</template>
