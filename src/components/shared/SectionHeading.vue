<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <h3 :class="cn('mb-1 text-[13px] font-semibold', $props.class)"><slot /></h3>
</template>
