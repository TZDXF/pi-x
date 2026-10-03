<script setup lang="ts">
/** Workspace and file preferences: review file opener, project groups, worktree directory and projectless directory. */
import OpenWithSettings from "@/components/settings/OpenWithSettings.vue"
import ProjectGroupSettings from "@/components/settings/ProjectGroupSettings.vue"
import ProjectlessSettings from "@/components/settings/ProjectlessSettings.vue"
import WorktreeDirSettings from "@/components/settings/WorktreeDirSettings.vue"
import { isDesktop } from "@/api/transport"
</script>

<template>
  <OpenWithSettings v-if="isDesktop" />
  <ProjectGroupSettings />
  <WorktreeDirSettings />
  <ProjectlessSettings />
</template>
