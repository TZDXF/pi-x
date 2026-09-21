<script setup lang="ts">
/**
 * Recursive node renderer for the session tree.
 * Self-references by filename for nested children.
 */
import { computed } from "vue"
import { useI18n } from "vue-i18n"

interface TreeEntry {
  type?: string
  id?: string
  message?: { role?: string, content?: unknown }
}
interface TreeNode {
  entry: TreeEntry
  children: TreeNode[]
  label?: string
}

interface NodeSummary {
  role: string
  text: string
  isUser: boolean
  isMeta: boolean
  forkable: boolean
}

const props = defineProps<{
  node: TreeNode
  depth: number
  activeIds: Set<string>
}>()

const emit = defineEmits<{ fork: [id: string] }>()
const { t } = useI18n()

function firstText(content: unknown): string {
  if (typeof content === "string")
    return content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string")
        return b.text
    }
  }
  return ""
}

const summary = computed<NodeSummary>(() => {
  const e = props.node.entry
  if (e.type === "message" && e.message) {
    const role = e.message.role ?? "message"
    const text = firstText(e.message.content).replace(/\s+/g, " ").trim()
    return {
      role,
      text: text || t("tree.roleMessage", { role }),
      isUser: role === "user",
      isMeta: false,
      forkable: role === "user",
    }
  }
  const metaText = props.node.label
    ?? (e.type === "model_change"
      ? t("tree.modelChanged")
      : e.type === "compaction"
        ? t("tree.contextCompacted")
        : (e.type ?? "entry"))
  return { role: "meta", text: metaText, isUser: false, isMeta: true, forkable: false }
})

const shortened = computed(() => {
  const t = summary.value.text
  return t.length > 90 ? `${t.slice(0, 90)}…` : t
})

const active = computed(() => props.activeIds.has(props.node.entry.id ?? ""))
const badge = computed(() => {
  const r = summary.value.role
  if (r === "user") return "YOU"
  if (r === "assistant") return "AI"
  if (r === "toolResult") return "TOOL"
  return "·"
})
</script>

<template>
  <div>
    <div
      class="group flex items-center gap-2 rounded-md px-2 py-1"
      :class="active ? 'bg-accent/40' : ''"
      :style="{ marginLeft: `${depth * 14}px` }"
    >
      <span
        class="w-10 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold"
        :class="summary.isMeta
          ? 'bg-transparent text-muted-foreground'
          : summary.role === 'user'
            ? 'bg-primary/15 text-primary'
            : summary.role === 'assistant'
              ? 'bg-chart-2/15 text-chart-2'
              : 'bg-muted text-muted-foreground'"
      >
        {{ badge }}
      </span>
      <span
        class="flex-1 truncate text-xs"
        :class="summary.isMeta ? 'text-muted-foreground italic' : 'text-foreground'"
      >
        {{ shortened }}
      </span>
      <span v-if="active" class="text-primary shrink-0 text-[10px]">● {{ t("tree.active") }}</span>
      <button
        v-if="summary.forkable"
        class="border-input text-muted-foreground hover:bg-accent hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] group-hover:block"
        :title="t('tree.forkTitle')"
        @click="node.entry.id && emit('fork', node.entry.id)"
      >
        {{ t("tree.fork") }}
      </button>
    </div>
    <SessionTreeNode
      v-for="(c, i) in node.children"
      :key="c.entry.id ?? i"
      :node="c"
      :depth="depth + 1"
      :active-ids="activeIds"
      @fork="emit('fork', $event)"
    />
  </div>
</template>
