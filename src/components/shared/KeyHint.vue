<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <kbd :class="cn('whitespace-nowrap rounded bg-muted px-1.5 py-[3px] text-[11px]', $props.class)"><slot /></kbd>
</template>
