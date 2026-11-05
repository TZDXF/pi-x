<script setup lang="ts">
import { computed, ref, watch, type HTMLAttributes } from "vue"
import { useI18n } from "vue-i18n"
import type { PopoverContentProps } from "reka-ui"
import { Folder, MessagesSquare, Plus } from "@lucide/vue"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button, type ButtonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceStore } from "@/stores/workspace"

const props = withDefaults(
  defineProps<{
    project: string
    disabled?: boolean
    placeholder?: string
    ariaLabel?: string
    showAll?: boolean
    showProjectless?: boolean
    showOpenProject?: boolean
    triggerVariant?: ButtonVariants["variant"]
    triggerSize?: ButtonVariants["size"]
    triggerClass?: HTMLAttributes["class"]
    contentSide?: PopoverContentProps["side"]
  }>(),
  {
    placeholder: "",
    showProjectless: true,
    showOpenProject: true,
    triggerVariant: "context-chip",
    triggerSize: "content",
    triggerClass: "context-chip",
    contentSide: "top",
  },
)
const emit = defineEmits<{ selectProject: [path: string]; openProject: [] }>()
const workspace = useWorkspaceStore()
const { t } = useI18n()
const open = ref(false)
const query = ref("")

const name = (path: string) => workspace.projectName(path)
const isProjectless = computed(() => !props.project || workspace.isProjectless(props.project))
const projectTitle = computed(() =>
  props.project === "all" ? "" : props.project || (props.placeholder ? "" : workspace.projectless),
)
const projectLabel = computed(() => {
  if (props.showAll && props.project === "all") return t("sessionArchive.filterAll")
  return props.project ? name(props.project) : props.placeholder || t("projectless.name")
})

watch(open, value => {
  if (value) query.value = ""
})
const filteredProjects = computed(() => {
  const paths = workspace.orderedProjects().filter(path => !workspace.isProjectless(path))
  const search = query.value.trim().toLowerCase()
  if (!search) return paths
  return paths.filter(path => name(path).toLowerCase().includes(search) || path.toLowerCase().includes(search))
})
const isSelected = (path: string) => path === workspace.projectRoot(props.project)

function select(path: string) {
  if (props.disabled) return
  open.value = false
  if (path !== props.project) emit("selectProject", path)
}
function openProject() {
  if (props.disabled) return
  open.value = false
  emit("openProject")
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        :variant="triggerVariant"
        :size="triggerSize"
        :class="triggerClass"
        :disabled="disabled"
        :title="projectTitle || undefined"
        :aria-label="ariaLabel"
      >
        <Folder :size="14" class="size-auto shrink-0" />
        <span class="truncate">{{ projectLabel }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent :side="contentSide" align="start" class="w-72 p-2">
      <Input v-model="query" :placeholder="t('workspace.searchProject')" class="h-7 text-xs" />
      <ScrollArea v-if="filteredProjects.length" viewport-class="max-h-64">
        <Button
          v-for="path in filteredProjects"
          :key="path"
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          :aria-current="isSelected(path) ? 'true' : undefined"
          :title="path"
          @click="select(path)"
        >
          <Folder :size="14" class="size-auto shrink-0" />
          <span class="truncate">{{ name(path) }}</span>
          <span v-if="isSelected(path)" class="ml-auto">✓</span>
        </Button>
      </ScrollArea>
      <p v-else-if="query.trim()" class="px-2 py-2 text-xs text-muted-foreground">
        {{ t("workspace.noMatchingProject") }}
      </p>
      <div
        v-if="showAll || (showProjectless && workspace.projectless) || showOpenProject"
        class="border-t border-border pt-1.5"
      >
        <Button
          v-if="showAll"
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          :aria-current="project === 'all' ? 'true' : undefined"
          @click="select('all')"
        >
          <Folder :size="14" class="size-auto shrink-0" />
          <span class="truncate">{{ t("sessionArchive.filterAll") }}</span>
          <span v-if="project === 'all'" class="ml-auto">✓</span>
        </Button>
        <Button
          v-if="showProjectless && workspace.projectless"
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          :aria-current="isProjectless ? 'true' : undefined"
          :title="workspace.projectless"
          @click="select(workspace.projectless)"
        >
          <MessagesSquare :size="14" class="size-auto shrink-0" />
          <span class="truncate">{{ name(workspace.projectless) }}</span>
          <span v-if="isProjectless" class="ml-auto">✓</span>
        </Button>
        <Button
          v-if="showOpenProject"
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          @click="openProject"
        >
          <Plus :size="14" class="size-auto shrink-0" />
          {{ t("sidebar.openProject") }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
