<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { open } from "@tauri-apps/plugin-dialog"
import { getPiSettings, savePiSettings } from "@/api/piClient"
import { useSessionStore } from "@/stores/conversations"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const skills = ref<string[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const dirty = ref(false)
const loaded = computed(() => session.commands.filter(c => c.source === "skill"))
const key = (path: string) => path.replace(/\\/g, "/")
function add(paths: string[]) {
  for (const path of paths) {
    if (!skills.value.some(s => key(s) === key(path))) skills.value.push(path)
  }
  dirty.value = true
}
async function chooseSkills() {
  try {
    const paths = await open({ multiple: true, filters: [{ name: "Skill Markdown", extensions: ["md"] }] })
    if (paths) add(Array.isArray(paths) ? paths : [paths])
  } catch (e) { ui.pushToast(String(e), "error") }
}
async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    skills.value = [...settings.skills]
    dirty.value = false
  } catch (e) { error.value = String(e) }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  try {
    await savePiSettings({ skills: [...skills.value] })
    dirty.value = false
    ui.pushToast(t("agentConfig.saved"), "info")
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <DialogHeader>
    <DialogTitle>{{ t("skillsConfig.title") }}</DialogTitle>
    <DialogDescription>{{ t("skillsConfig.description") }}</DialogDescription>
  </DialogHeader>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset v-else :disabled="saving" class="min-w-0 space-y-6">
    <section class="space-y-3">
      <p class="text-xs text-muted-foreground">{{ t("agentConfig.autoHint") }}</p>
      <div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="chooseSkills">{{ t("agentConfig.add") }}</Button>
          <Button variant="outline" size="sm" :disabled="!loaded.some(s => s.path)" @click="add(loaded.flatMap(s => s.path ? [s.path] : []))">{{ t("agentConfig.import") }}</Button>
        </div>
        <p v-if="!skills.length" class="text-sm text-muted-foreground">{{ t("agentConfig.none") }}</p>
        <div v-for="(skill, index) in skills" :key="skill" class="flex items-center gap-3 rounded-lg border p-3">
          <span class="min-w-0 flex-1 break-all text-xs font-mono">{{ skill }}</span>
          <Button variant="ghost" size="sm" @click="skills.splice(index, 1); dirty = true">{{ t("agentConfig.remove") }}</Button>
        </div>
        <p class="text-xs text-amber-600">{{ t("agentConfig.security") }}</p>
      </div>
    </section>
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("agentConfig.loaded") }} ({{ loaded.length }})</h3>
      <p class="text-xs text-muted-foreground">{{ t("agentConfig.loadedHint") }}</p>
      <p v-if="!loaded.length" class="text-sm text-muted-foreground">{{ t("agentConfig.noLoaded") }}</p>
      <div v-for="skill in loaded" :key="skill.path ?? skill.name" class="space-y-1 rounded-lg border p-3">
        <p class="text-sm font-medium">{{ skill.name }}</p>
        <p v-if="skill.description" class="text-xs text-muted-foreground">{{ skill.description }}</p>
        <p v-if="skill.path" class="break-all text-xs font-mono text-muted-foreground">{{ skill.path }}</p>
      </div>
    </section>
    <div class="flex items-center gap-3">
      <Button :disabled="saving || !dirty" @click="save">{{ t(saving ? "agentConfig.saving" : "agentConfig.save") }}</Button>
      <span v-if="dirty" class="text-xs text-muted-foreground">{{ t("agentConfig.unsaved") }}</span>
    </div>
  </fieldset>
</template>
