<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { groupModelsByProvider } from "@/lib/modelSelection"
import { ChevronDownIcon } from "@lucide/vue"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"

const props = defineProps<{
  modelValue: string
  thinkingLevel: string
  models: { provider: string; id: string; name?: string }[]
  availableThinking: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  "update:modelValue": [value: string]
  "update:thinkingLevel": [value: string]
}>()

const { t, te } = useI18n()

const selectedModel = computed(() => props.models.find(model => `${model.provider}/${model.id}` === props.modelValue))
const groups = computed(() => groupModelsByProvider(props.models))

/** Slider stops; fall back to the current level so the control stays usable. */
const levels = computed(() => (props.availableThinking.length ? props.availableThinking : [props.thinkingLevel]))
const sliderIndex = computed(() => {
  const idx = levels.value.indexOf(props.thinkingLevel)
  return idx === -1 ? 0 : idx
})

function levelLabel(lv: string) {
  const key = `chat.thinkingLevels.${lv}`
  return te(key) ? t(key) : lv
}

function onModelChange(value: unknown) {
  if (typeof value === "string") emit("update:modelValue", value)
}

function onSliderChange(value: unknown) {
  const idx = Array.isArray(value) ? value[0] : undefined
  if (typeof idx !== "number") return
  const clamped = Math.min(Math.max(Math.round(idx), 0), levels.value.length - 1)
  emit("update:thinkingLevel", levels.value[clamped])
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :disabled="disabled"
        :title="
          selectedModel
            ? `${selectedModel.name || selectedModel.id} ${levelLabel(thinkingLevel)}`
            : t('chat.selectModel')
        "
        class="flex h-8 min-w-0 max-w-60 max-[900px]:max-w-45 items-center gap-1 rounded-lg px-2 text-xs whitespace-nowrap text-foreground outline-none select-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span class="min-w-0 truncate">{{
          selectedModel ? selectedModel.name || selectedModel.id : t("chat.selectModel")
        }}</span>
        <span class="min-w-0 truncate text-muted-foreground">{{ levelLabel(thinkingLevel) }}</span>
        <ChevronDownIcon class="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" :side-offset="0" class="min-w-56">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger class="max-w-56">
          <span class="min-w-0 truncate">{{
            selectedModel
              ? `${selectedModel.name || selectedModel.id} ${levelLabel(thinkingLevel)}`
              : t("chat.selectModel")
          }}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup :model-value="modelValue" @update:model-value="onModelChange">
            <template v-for="(group, gi) in groups" :key="group.provider">
              <DropdownMenuSeparator v-if="gi > 0" />
              <DropdownMenuLabel>{{ group.provider }}</DropdownMenuLabel>
              <DropdownMenuRadioItem
                v-for="model in group.models"
                :key="model.provider + '/' + model.id"
                :value="model.provider + '/' + model.id"
                class="text-xs"
                @select="event => event.preventDefault()"
              >
                {{ model.name || model.id }}
              </DropdownMenuRadioItem>
            </template>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <div class="px-2 pt-1 pb-3" @keydown.left.stop @keydown.right.stop @keydown.up.stop @keydown.down.stop>
        <Slider
          v-if="levels.length > 1"
          :model-value="[sliderIndex]"
          :min="0"
          :max="levels.length - 1"
          :step="1"
          :marks="levels.map(levelLabel)"
          :aria-label="t('chat.thinkingLevel')"
          @update:model-value="onSliderChange"
        />
        <div v-else class="text-center text-xs text-muted-foreground">{{ levelLabel(thinkingLevel) }}</div>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
