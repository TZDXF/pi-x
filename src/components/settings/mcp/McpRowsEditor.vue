<script setup lang="ts">
/** Reusable key/value row editor for MCP server fields (env, headers) and
 *  single-value lists (args). Row ids are shared tracking ids only (see
 *  ./rowIds); the parent interprets keys/values via update:rows. */
import { Plus, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { nextMcpRowId } from "./rowIds"

export interface McpRow {
  id: number
  key: string
  value: string
}

const props = withDefaults(
  defineProps<{
    rows: McpRow[]
    addLabel: string
    keyPlaceholder?: string
    valuePlaceholder?: string
    /** Single-value mode (e.g. command args): hides the key column. */
    single?: boolean
  }>(),
  { single: false, keyPlaceholder: "", valuePlaceholder: "" },
)

const emit = defineEmits<{
  "update:rows": [rows: McpRow[]]
}>()

function update(id: number, patch: Partial<Omit<McpRow, "id">>) {
  emit("update:rows", props.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
}

function remove(id: number) {
  emit("update:rows", props.rows.filter((row) => row.id !== id))
}

function add() {
  emit("update:rows", [...props.rows, { id: nextMcpRowId(), key: "", value: "" }])
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-for="row in rows" :key="row.id" class="flex items-center gap-1.5">
      <Input
        v-if="!single"
        :model-value="row.key"
        class="h-7 w-28 shrink-0 font-mono text-xs"
        :placeholder="keyPlaceholder"
        spellcheck="false"
        @update:model-value="update(row.id, { key: String($event) })"
      />
      <Input
        :model-value="row.value"
        class="h-7 min-w-0 flex-1 font-mono text-xs"
        :placeholder="valuePlaceholder"
        spellcheck="false"
        @update:model-value="update(row.id, { value: String($event) })"
      />
      <Button
        variant="ghost"
        size="icon"
        class="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
        :aria-label="addLabel"
        @click="remove(row.id)"
      >
        <X :size="14" />
      </Button>
    </div>
    <Button variant="outline" size="sm" class="h-7 w-fit gap-1 text-xs" @click="add">
      <Plus :size="12" />
      {{ addLabel }}
    </Button>
  </div>
</template>
