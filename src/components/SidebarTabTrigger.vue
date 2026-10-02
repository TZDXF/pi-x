<script setup lang="ts">
import { ref } from "vue"
import { TabsTrigger } from "@/components/ui/tabs"

const props = defineProps<{ value: number; active: boolean }>()
const emit = defineEmits<{ reactivate: [] }>()
const activeOnPointerDown = ref(false)

function click(event: MouseEvent) {
  // Reka activates on mousedown/focus, before click. Remember the pointer's
  // original selection so switching to a terminal is not a second activation.
  const wasActive = event.detail === 0 ? props.active : activeOnPointerDown.value
  activeOnPointerDown.value = false
  if (wasActive) emit("reactivate")
}
</script>

<template>
  <TabsTrigger
    :value="value"
    @pointerdown="activeOnPointerDown = active"
    @pointercancel="activeOnPointerDown = false"
    @click="click"
  >
    <slot />
  </TabsTrigger>
</template>
