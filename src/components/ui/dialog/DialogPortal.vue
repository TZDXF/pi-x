<script setup lang="ts">
import type { DialogPortalProps } from 'reka-ui'
import { DialogPortal, injectDialogRootContext } from 'reka-ui'
import { ref, watch } from 'vue'

const props = defineProps<DialogPortalProps>()
const rootContext = injectDialogRootContext()
const present = ref(rootContext.open.value)

// Create Teleport's DOM position when opening, rather than when the owning
// component mounts, so equal-z-index dialogs follow their opening order.
watch(rootContext.open, open => {
  if (open) present.value = true
})

function onAfterLeave() {
  if (!rootContext.open.value) present.value = false
}
</script>

<template>
  <DialogPortal v-if="present || props.forceMount || !rootContext.unmountOnHide.value" v-bind="props">
    <!-- Keep the portal until content finishes its exit animation. -->
    <slot :on-after-leave="onAfterLeave" />
  </DialogPortal>
</template>
