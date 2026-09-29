<script setup lang="ts">
import type { PaneGroup, PaneLeaf } from "@/stores/splitView"
import { onBeforeUnmount, onMounted, ref } from "vue"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

const props = defineProps<{
  tree: PaneGroup | PaneLeaf
  activeLeafId: string | null
}>()

const emit = defineEmits<{
  activate: [runtimeId: string]
}>()

defineSlots<{
  pane?: (props: { runtimeId: string; active: boolean }) => unknown
}>()

const el = ref<HTMLElement | null>(null)

const paneSize = (group: PaneGroup, index: number) => group.sizes?.[index] ?? 100 / group.children.length
/** 用户拖动手柄调整比例后回写 sizes，重挂载（如挂起恢复）时还原布局。 */
const onLayout = (sizes: number[]) => {
  if (props.tree.kind === "group" && sizes.length === props.tree.children.length) props.tree.sizes = sizes
}

const handlePointerDown = (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const runtimeId = target.closest<HTMLElement>("[data-pane-runtime-id]")?.dataset.runtimeId
  if (runtimeId) emit("activate", runtimeId)
}

onMounted(() => el.value?.addEventListener("mousedown", handlePointerDown))
onBeforeUnmount(() => el.value?.removeEventListener("mousedown", handlePointerDown))
</script>

<template>
  <div ref="el" class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <template v-if="tree.kind === 'group'">
      <ResizablePanelGroup :key="tree.id" :direction="tree.direction" @layout="onLayout">
        <template v-for="(child, index) in tree.children" :key="child.id">
          <ResizableHandle v-if="index > 0" />
          <ResizablePanel
            v-if="child.kind === 'leaf'"
            :id="child.id"
            :order="index"
            :default-size="paneSize(tree, index)"
          >
            <section
              data-pane-runtime-id=""
              :data-runtime-id="child.runtimeId"
              class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border bg-background"
              :class="child.id === activeLeafId ? 'border-primary' : 'border-border'"
            >
              <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <slot name="pane" :runtime-id="child.runtimeId" :active="child.id === activeLeafId" />
              </div>
            </section>
          </ResizablePanel>
          <ResizablePanel v-else :id="child.id" :order="index" :default-size="paneSize(tree, index)" class="min-h-0">
            <SplitChatLayout
              :tree="child"
              :active-leaf-id="activeLeafId"
              @activate="runtimeId => emit('activate', runtimeId)"
            >
              <template #pane="{ runtimeId, active }">
                <slot name="pane" :runtime-id="runtimeId" :active="active" />
              </template>
            </SplitChatLayout>
          </ResizablePanel>
        </template>
      </ResizablePanelGroup>
    </template>
    <section
      v-else
      data-pane-runtime-id=""
      :data-runtime-id="tree.runtimeId"
      class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <slot name="pane" :runtime-id="tree.runtimeId" :active="tree.id === activeLeafId" />
      </div>
    </section>
  </div>
</template>
