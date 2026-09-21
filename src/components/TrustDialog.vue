<script setup lang="ts">
import { ref } from "vue"
import type { TrustStatus } from "@/api/piClient"

const props = defineProps<{ info: TrustStatus }>()

const emit = defineEmits<{
  done: [trusted: boolean, trustParent: boolean]
}>()

const busy = ref(false)

function decide(trusted: boolean, trustParent = false) {
  busy.value = true
  emit("done", trusted, trustParent)
}
</script>

<template>
  <div class="bg-card w-full max-w-lg space-y-5 rounded-xl border p-6 shadow-lg">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold">Trust this project?</h2>
      <p class="text-muted-foreground text-sm">
        <span class="text-foreground font-mono">{{ props.info.projectPath }}</span>
        contains project-local pi resources
        <span class="text-muted-foreground">(.pi settings, extensions, skills, prompts or themes).</span>
      </p>
    </div>

    <div class="border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 rounded-md border p-3 text-sm">
      Trusting allows pi to load these resources and execute project extensions
      when it starts. Only trust projects you own or have reviewed.
    </div>

    <div class="flex flex-col gap-2">
      <button
        :disabled="busy"
        class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2.5 text-sm font-medium disabled:opacity-50"
        @click="decide(true)"
      >
        Trust this folder
      </button>
      <button
        v-if="props.info.parentPath"
        :disabled="busy"
        class="border-input hover:bg-accent rounded-md border px-4 py-2.5 text-sm disabled:opacity-50"
        @click="decide(true, true)"
      >
        Trust parent folder
        <span class="text-muted-foreground font-mono text-xs">({{ props.info.parentPath }})</span>
      </button>
      <button
        :disabled="busy"
        class="border-input hover:bg-accent rounded-md border px-4 py-2.5 text-sm disabled:opacity-50"
        @click="decide(false)"
      >
        Don't trust
        <span class="text-muted-foreground text-xs">(project resources stay disabled)</span>
      </button>
    </div>

    <p class="text-muted-foreground text-xs">
      Decisions are saved to ~/.pi/agent/trust.json — the same store pi's
      terminal UI uses, so both stay in sync.
    </p>
  </div>
</template>
