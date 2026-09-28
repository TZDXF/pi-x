<script setup lang="ts">
/** Workspace and file preferences: review file opener and projectless directory. */
import OpenWithSettings from "@/components/settings/OpenWithSettings.vue"
import ProjectlessSettings from "@/components/settings/ProjectlessSettings.vue"
import { isDesktop } from "@/api/transport"
</script>

<template>
  <OpenWithSettings v-if="isDesktop" />
  <ProjectlessSettings />
</template>
