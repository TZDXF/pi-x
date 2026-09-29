<script setup lang="ts">
import type { PaneGroup, PaneLeaf } from "@/stores/splitView"
import { useI18n } from "vue-i18n"
import { onBeforeUnmount, onMounted, ref } from "vue"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

const props = defineProps<{
  tree: PaneGroup | PaneLeaf
  activeLeafId: string | null
}>()

const emit = defineEmits<{
  activate: [runtimeId: string]
  close: [runtimeId: string]
}>()

defineSlots<{
  "pane-title"?: (props: { runtimeId: string }) => unknown
  pane?: (props: { runtimeId: string; active: boolean }) => unknown
}>()

const { t } = useI18n()
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
  <div ref="el" class="h-full min-w-0">
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
              class="flex h-full min-w-0 flex-col overflow-hidden rounded-md border bg-background"
              :class="child.id === activeLeafId ? 'border-primary' : 'border-border'"
            >
              <header class="flex h-8 shrink-0 items-center gap-2 border-border border-b px-2">
                <div class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  <slot name="pane-title" :runtime-id="child.runtimeId" />
                </div>
                <button
                  type="button"
                  class="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :aria-label="t('split.closePane')"
                  :title="t('split.closePane')"
                  @mousedown.stop
                  @click.stop="emit('close', child.runtimeId)"
                >
                  ×
                </button>
              </header>
              <div class="min-h-0 flex-1 overflow-hidden">
                <slot name="pane" :runtime-id="child.runtimeId" :active="child.id === activeLeafId" />
              </div>
            </section>
          </ResizablePanel>
          <ResizablePanel v-else :id="child.id" :order="index" :default-size="paneSize(tree, index)" class="min-h-0">
            <SplitChatLayout
              :tree="child"
              :active-leaf-id="activeLeafId"
              @activate="runtimeId => emit('activate', runtimeId)"
              @close="runtimeId => emit('close', runtimeId)"
            >
              <template #pane-title="{ runtimeId }">
                <slot name="pane-title" :runtime-id="runtimeId" />
              </template>
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
      class="flex h-full min-w-0 flex-col overflow-hidden rounded-md border bg-background"
      :class="tree.id === activeLeafId ? 'border-primary' : 'border-border'"
    >
      <header class="flex h-8 shrink-0 items-center gap-2 border-border border-b px-2">
        <div class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <slot name="pane-title" :runtime-id="tree.runtimeId" />
        </div>
        <button
          type="button"
          class="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('split.closePane')"
          :title="t('split.closePane')"
          @mousedown.stop
          @click.stop="emit('close', tree.runtimeId)"
        >
          ×
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-hidden">
        <slot name="pane" :runtime-id="tree.runtimeId" :active="tree.id === activeLeafId" />
      </div>
    </section>
  </div>
</template>
