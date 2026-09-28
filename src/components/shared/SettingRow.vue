<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"
defineProps<{ class?: HTMLAttributes["class"]; as?: "div" | "section" }>()
</script>

<template>
  <component
    :is="as ?? 'div'"
    :class="
      cn(
        'flex items-center justify-between gap-4 border-b border-border py-[22px] max-[640px]:flex-wrap max-[640px]:gap-3',
        $props.class,
      )
    "
    ><slot
  /></component>
</template>
