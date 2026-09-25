<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <p :class="cn('mt-1.5 text-xs leading-[1.9] text-muted-foreground', $props.class)"><slot /></p>
</template>
