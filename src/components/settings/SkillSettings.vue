<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { Eye, Trash2 } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { ask } from "@tauri-apps/plugin-dialog"
import {
  deleteHostedSkill,
  listDiscoveredSkills,
  listHostedSkills,
  openHostedSkillsDirectory,
  setHostedSkillsEnabled,
  skillListFiles,
  skillReadFile,
} from "@/api/piClient"
import type { DiscoveredSkill, HostedSkill } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { normalizeSlashes } from "@/lib/paths"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import ResourceMarkdownBrowser from "@/components/ResourceMarkdownBrowser.vue"

const { t } = useI18n()
const ui = useUiStore()
const skills = ref<HostedSkill[]>([])
const discovered = ref<DiscoveredSkill[]>([])
const loading = ref(true)
const error = ref("")

const previewing = ref<string | null>(null)
const listPreviewFiles = computed(() => {
  const path = previewing.value
  return path ? () => skillListFiles(path) : undefined
})
const readPreviewFile = computed(() => {
  const path = previewing.value
  return path ? (relPath: string) => skillReadFile(path, relPath) : undefined
})

function togglePreview(skill: { path: string }) {
  previewing.value = previewing.value === skill.path ? null : skill.path
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    const [hosted, found] = await Promise.all([listHostedSkills(), listDiscoveredSkills()])
    skills.value = hosted
    // Hide skills already managed under ~/.pix/skills.
    discovered.value = found.filter(s => !s.hosted)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function openDirectory() {
  try {
    await openHostedSkillsDirectory()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
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
  const confirmed = await ask(t("skillsConfig.deleteConfirm", { name: skill.name }), {
    title: t("skillsConfig.title"),
    okLabel: t("skillsConfig.delete"),
    cancelLabel: t("common.cancel"),
  })
  if (!confirmed) return
  try {
    await deleteHostedSkill(skill.path)
    if (previewing.value === skill.path) previewing.value = null
    await load()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

function displaySkillPath(path: string): string {
  return normalizeSlashes(path)
}

function sourceLabel(skill: DiscoveredSkill): string {
  if (skill.sourceKind === "packageGlobal")
    return t(`skillsConfig.source.${skill.sourceKind}`, { name: skill.sourceName ?? "?" })
  return t(`skillsConfig.source.${skill.sourceKind}`)
}

onMounted(load)
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("skillsConfig.title") }}</h2>
  </header>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <div v-else class="min-w-0 space-y-6">
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.hosted") }}</h3>
      <div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="openDirectory">{{ t("skillsConfig.openDirectory") }}</Button>
          <Button variant="outline" size="sm" @click="load">{{ t("skillsConfig.refresh") }}</Button>
        </div>
        <p v-if="!skills.length" class="mt-3 text-sm text-muted-foreground">{{ t("skillsConfig.empty") }}</p>
        <div v-for="skill in skills" :key="skill.path" class="mt-3 space-y-2">
          <div class="flex items-center gap-3 rounded-lg border p-3">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-sm font-medium">{{ skill.name }}</p>
                <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{
                  t("skillsConfig.sourceHosted")
                }}</span>
              </div>
              <p class="break-all font-mono text-xs text-muted-foreground" :title="displaySkillPath(skill.path)">
                {{ displaySkillPath(skill.path) }}
              </p>
              <p
                v-if="skill.description"
                class="line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground"
              >
                {{ skill.description }}
              </p>
            </div>
            <Switch
              :model-value="skill.enabled"
              :aria-label="`${t('skillsConfig.enable')} · ${skill.name}`"
              @update:model-value="v => toggle(skill, Boolean(v))"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-pressed="previewing === skill.path"
              :aria-label="`${t('skillsConfig.preview')} · ${skill.name}`"
              :title="t('skillsConfig.preview')"
              @click="togglePreview(skill)"
              ><Eye :size="15"
            /></Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-destructive hover:text-destructive"
              :aria-label="`${t('skillsConfig.delete')} · ${skill.name}`"
              :title="t('skillsConfig.delete')"
              @click="remove(skill)"
              ><Trash2 :size="15"
            /></Button>
          </div>
          <ResourceMarkdownBrowser
            v-if="previewing === skill.path"
            :list-files="listPreviewFiles"
            :read-file="readPreviewFile"
            :empty-text="t('skillsConfig.noPreviewFiles')"
            list-class="w-60"
            class="h-96 rounded-lg border p-1"
          />
        </div>
      </div>
    </section>
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.discovered") }} ({{ discovered.length }})</h3>
      <p v-if="!discovered.length" class="text-sm text-muted-foreground">{{ t("skillsConfig.noDiscovered") }}</p>
      <div v-for="skill in discovered" :key="skill.path" class="space-y-2">
        <div class="flex items-start gap-3 rounded-lg border p-3">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-medium">{{ skill.name }}</p>
              <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{ sourceLabel(skill) }}</span>
            </div>
            <p class="break-all font-mono text-xs text-muted-foreground" :title="displaySkillPath(skill.path)">
              {{ displaySkillPath(skill.path) }}
            </p>
            <p
              v-if="skill.description"
              class="line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground"
            >
              {{ skill.description }}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-pressed="previewing === skill.path"
            :aria-label="`${t('skillsConfig.preview')} · ${skill.name}`"
            :title="t('skillsConfig.preview')"
            @click="togglePreview(skill)"
            ><Eye :size="15"
          /></Button>
        </div>
        <ResourceMarkdownBrowser
          v-if="previewing === skill.path"
          :list-files="listPreviewFiles"
          :read-file="readPreviewFile"
          :empty-text="t('skillsConfig.noPreviewFiles')"
          list-class="w-60"
          class="h-96 rounded-lg border p-1"
        />
      </div>
    </section>
  </div>
</template>
