<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { ask, open } from "@tauri-apps/plugin-dialog"
import { deleteHostedSkill, importHostedSkills, listDiscoveredSkills, listHostedSkills, setHostedSkillsEnabled } from "@/api/piClient"
import type { DiscoveredSkill, HostedSkill } from "@/api/piClient"
import { useSessionStore, useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const skills = ref<HostedSkill[]>([])
const discovered = ref<DiscoveredSkill[]>([])
const loading = ref(true)
const busy = ref(false)
const error = ref("")
const loaded = computed(() => session.commands.filter(c => c.source === "skill"))

async function load() {
  loading.value = true
  error.value = ""
  try {
    const [hosted, found] = await Promise.all([
      listHostedSkills(),
      listDiscoveredSkills(session.cwd || null).catch(() => []),
    ])
    skills.value = hosted
    // Hide skills already managed under ~/.pix/skills.
    discovered.value = found.filter(s => !s.hosted)
  } catch (e) { error.value = String(e) }
  finally { loading.value = false }
}

async function chooseSources() {
  try {
    const paths = await open({ multiple: true })
    if (!paths) return
    await runImport(Array.isArray(paths) ? paths : [paths])
  } catch (e) { ui.pushToast(String(e), "error") }
}

async function importLoaded() {
  const sources = loaded.value.flatMap(s => s.path ? [s.path] : [])
  if (sources.length) await runImport(sources)
}

async function runImport(sources: string[], overwrite = false) {
  busy.value = true
  try {
    const result = await importHostedSkills(sources, overwrite)
    if (result.conflicts.length && !overwrite) {
      const names = result.conflicts.join("\n")
      const replace = await ask(t("skillsConfig.overwriteConfirm", { names }), { title: t("skillsConfig.title"), okLabel: t("skillsConfig.overwrite"), cancelLabel: t("common.cancel") })
      if (replace) return await runImport(sources, true)
    }
    if (result.imported.length) {
      ui.pushToast(t("skillsConfig.imported", { count: result.imported.length }), "info")
      await load()
    }
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { busy.value = false }
}

async function toggle(skill: HostedSkill, checked: boolean) {
  const previous = skill.enabled
  skill.enabled = checked
  try {
    await setHostedSkillsEnabled(skills.value.filter(s => s.enabled).map(s => s.path))
    ui.pushToast(t("skillsConfig.enabledSaved"), "info")
  } catch (e) {
    skill.enabled = previous
    ui.pushToast(String(e), "error")
  }
}

async function remove(skill: HostedSkill) {
  const confirmed = await ask(t("skillsConfig.deleteConfirm", { name: skill.name }), { title: t("skillsConfig.title"), okLabel: t("skillsConfig.delete"), cancelLabel: t("common.cancel") })
  if (!confirmed) return
  try {
    await deleteHostedSkill(skill.path)
    await load()
  } catch (e) { ui.pushToast(String(e), "error") }
}

onMounted(load)
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("skillsConfig.title") }}</h2>
    <p class="text-sm text-muted-foreground">{{ t("skillsConfig.description") }}</p>
  </header>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset v-else :disabled="busy" class="min-w-0 space-y-6">
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.hosted") }}</h3>
      <p class="text-xs text-muted-foreground">{{ t("skillsConfig.hostedHint") }}</p>
      <div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="chooseSources">{{ t("skillsConfig.importBtn") }}</Button>
          <Button variant="outline" size="sm" :disabled="!loaded.some(s => s.path)" @click="importLoaded">{{ t("skillsConfig.importLoaded") }}</Button>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">{{ t("skillsConfig.importHint") }}</p>
        <p v-if="!skills.length" class="mt-3 text-sm text-muted-foreground">{{ t("skillsConfig.empty") }}</p>
        <div v-for="skill in skills" :key="skill.path" class="mt-3 flex items-start gap-3 rounded-lg border p-3">
          <Switch :model-value="skill.enabled" :aria-label="t('skillsConfig.enable')" class="mt-0.5" @update:model-value="v => toggle(skill, Boolean(v))" />
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-sm font-medium">{{ skill.name }}</p>
            <p v-if="skill.description" class="text-xs text-muted-foreground">{{ skill.description }}</p>
            <p class="break-all text-xs font-mono text-muted-foreground">{{ skill.path }}</p>
          </div>
          <Button variant="ghost" size="sm" @click="remove(skill)">{{ t("skillsConfig.delete") }}</Button>
        </div>
        <p class="mt-3 text-xs text-amber-600">{{ t("skillsConfig.security") }}</p>
      </div>
    </section>
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.discovered") }} ({{ discovered.length }})</h3>
      <p class="text-xs text-muted-foreground">{{ t("skillsConfig.discoveredHint") }}</p>
      <p v-if="!discovered.length" class="text-sm text-muted-foreground">{{ t("skillsConfig.noDiscovered") }}</p>
      <div v-for="skill in discovered" :key="skill.path" class="flex items-start gap-3 rounded-lg border p-3">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-2">
            <p class="text-sm font-medium">{{ skill.name }}</p>
            <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t(`skillsConfig.scope_${skill.scope}`) }}</span>
          </div>
          <p v-if="skill.description" class="text-xs text-muted-foreground">{{ skill.description }}</p>
          <p class="break-all text-xs font-mono text-muted-foreground">{{ skill.path }}</p>
        </div>
        <Button variant="outline" size="sm" :disabled="busy" @click="runImport([skill.path])">{{ t("skillsConfig.importOne") }}</Button>
      </div>
    </section>
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.loaded") }} ({{ loaded.length }})</h3>
      <p class="text-xs text-muted-foreground">{{ t("skillsConfig.loadedHint") }}</p>
      <p v-if="!loaded.length" class="text-sm text-muted-foreground">{{ t("skillsConfig.noLoaded") }}</p>
      <div v-for="skill in loaded" :key="skill.path ?? skill.name" class="space-y-1 rounded-lg border p-3">
        <p class="text-sm font-medium">{{ skill.name }}</p>
        <p v-if="skill.description" class="text-xs text-muted-foreground">{{ skill.description }}</p>
        <p v-if="skill.path" class="break-all text-xs font-mono text-muted-foreground">{{ skill.path }}</p>
      </div>
    </section>
  </fieldset>
</template>
