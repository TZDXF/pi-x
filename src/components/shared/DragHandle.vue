<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <button :class="cn('drag-handle inline-flex flex-none touch-none cursor-grab items-center justify-center px-0.5 py-1.5 text-muted-foreground active:cursor-grabbing', $props.class)"><slot /></button>
</template>
