<script setup lang="ts">
/**
 * Session tree visualization (get_tree RPC).
 *
 * pi sessions are trees: re-prompting from an earlier point branches the
 * conversation. This panel shows every branch; the active leaf's path is
 * highlighted and user-message nodes can be forked from.
 */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { rpcRequest } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import SessionTreeNode from "./SessionTreeNode.vue"

interface TreeEntry {
  type?: string
  id?: string
}
interface TreeNode {
  entry: TreeEntry
  children: TreeNode[]
  label?: string
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ fork: [id: string], close: [] }>()
const ui = useUiStore()
const { t } = useI18n()

const nodes = ref<TreeNode[]>([])
const leafId = ref<string | null>(null)
const loading = ref(false)
const nodeCount = computed(() => {
  let n = 0
  function walk(list: TreeNode[]) {
    for (const item of list) {
      n++
      walk(item.children)
    }
  }
  walk(nodes.value)
  return n
})

watch(() => props.open, (o) => {
  if (o) void load()
})

async function load() {
  loading.value = true
  try {
    const res = await rpcRequest<{ tree: TreeNode[], leafId: string | null }>({ type: "get_tree" })
    if (!res.success)
      throw new Error(res.error ?? "get_tree failed")
    nodes.value = res.data?.tree ?? []
    leafId.value = res.data?.leafId ?? null
  }
  catch (e) {
    ui.pushToast(String(e), "error")
    emit("close")
  }
  finally {
    loading.value = false
  }
}

/** ids on the root→leaf path of the active branch */
const activeIds = computed(() => {
  const set = new Set<string>()
  function dfs(list: TreeNode[], trail: string[]): boolean {
    for (const n of list) {
      const id = n.entry.id ?? ""
      const next = [...trail, id]
      if (id === leafId.value || dfs(n.children, next)) {
        set.add(id)
        for (const t of trail) set.add(t)
        return true
      }
    }
    return false
  }
  dfs(nodes.value, [])
  return set
})
</script>

<template>
  <div class="relative">
    <p v-if="loading" class="text-muted-foreground px-1 py-4 text-center text-xs">
      {{ t("tree.loading") }}
    </p>
    <p v-else-if="!nodes.length" class="text-muted-foreground px-1 py-4 text-center text-xs">
      {{ t("tree.empty") }}
    </p>
    <template v-else>
      <div class="flex flex-col gap-0.5">
        <SessionTreeNode
          v-for="(n, i) in nodes"
          :key="n.entry.id ?? i"
          :node="n"
          :depth="0"
          :active-ids="activeIds"
          @fork="emit('fork', $event)"
        />
      </div>
      <p class="text-muted-foreground mt-3 text-[11px]">
        {{ t("tree.entriesHint", { count: nodeCount }) }}
      </p>
    </template>
  </div>
</template>
