<script setup lang="ts">
import { useI18n } from "vue-i18n"

/** 划词引用的索引数字标记：绝对定位在划词结束处，点击直接编辑。 */
export interface SelectionAnchorBadge {
  id: string
  index: number
  left: number
  top: number
}

defineProps<{ badges: SelectionAnchorBadge[] }>()
defineEmits<{ edit: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <sup
    v-for="badge in badges"
    :key="badge.id"
    :data-selection-anchor="badge.id"
    class="selection-anchor-badge selection-anchor-overlay"
    :title="t('chat.selectionEdit')"
    :style="{ left: `${badge.left}px`, top: `${badge.top}px` }"
    @click="$emit('edit', badge.id)"
    >{{ badge.index }}</sup
  >
</template>

<style>
/* 划词引用的索引数字标记基础样式（消息内为绝对定位覆盖层，摘要列表内为行内徽标） */
.selection-anchor-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 9999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  user-select: none;
}
/* 消息内覆盖层变体：定位在划词结束处，点击直接编辑 */
.selection-anchor-overlay {
  position: absolute;
  cursor: pointer;
}
</style>
